// Accounts: sign-up, sign-in, sessions, roles, password change and deletion.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { TEMPLATE, addMaterial, startApp, text, visitor } from './helper.js';

let app, mod;
before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
});
after(() => app.stop());

const signUp = async (username, extra = {}) => {
  const v = visitor(app.base);
  const r = await v.post('/api/accounts', { username, password: 'correct horse', group: 'Test Group', ...extra });
  if (r.status === 201) v.session = r.body.token;
  return { v, r };
};
// A token signed like the server signs them, for the cases a browser cannot produce.
const KEY = crypto.createHash('sha256').update('commons-session:test-session-secret').digest();
const forge = (payload, key = KEY) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
};
const whoami = async (session) => (await visitor(app.base, { session }).get('/api/meta')).body.account;

describe('sign-up', () => {
  test('creates an account and signs in', async () => {
    const { r } = await signUp('anna-aachen');
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.body.account).sort(), ['created_at', 'group', 'role', 'username']);
    assert.deepEqual([r.body.account.username, r.body.account.group, r.body.account.role], ['anna-aachen', 'Test Group', 'member']);
    assert.deepEqual(await whoami(r.body.token), { username: 'anna-aachen', group: 'Test Group', role: 'member' });
  });
  test('rules for user name, password and group', async () => {
    for (const username of ['ab', '-abc', 'has space', 'ümlaut', 'x'.repeat(31), '__proto__', '']) assert.equal((await signUp(username)).r.status, 400, username);
    assert.match((await signUp('short-pw', { password: '1234567' })).r.body.error, /at least 8 characters/);
    assert.match((await signUp('no-group', { group: '  ' })).r.body.error, /which group/);
    // Upper case is folded, so "Anna-Aachen" is the same name.
    assert.equal((await signUp('Anna-Aachen')).r.status, 409);
    // Names that every JavaScript object already has are ordinary names here.
    assert.equal((await signUp('constructor')).r.status, 201);
  });
  test('a taken name stays with its owner, also when two ask at once', async () => {
    assert.equal((await signUp('anna-aachen', { password: 'another password' })).r.status, 409);
    const both = await Promise.all([signUp('twice'), signUp('twice')]);
    assert.deepEqual(both.map((b) => b.r.status).sort(), [201, 409]);
  });
  test('the password is stored as a salted hash and never sent back', async () => {
    const stored = await app.store.getDoc('accounts', 'anna-aachen');
    assert.match(stored.password, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
    const list = (await mod.get('/api/accounts')).body;
    assert.ok(list.length >= 2);
    for (const a of list) assert.equal(a.password, undefined);
  });
});

describe('sign-in', () => {
  test('right and wrong passwords', async () => {
    const v = visitor(app.base);
    const ok = await v.post('/api/session', { username: ' Anna-Aachen ', password: 'correct horse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.account.username, 'anna-aachen');
    for (const body of [{ username: 'anna-aachen', password: 'wrong' }, { username: 'nobody-here', password: 'correct horse' }, { username: '', password: '' }, { username: '__proto__', password: 'x' }, { username: 'a/b', password: 'x' }, {}]) {
      const r = await v.post('/api/session', body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(r.body.error, 'Wrong user name or password.');
    }
  });
  test('five wrong passwords lock the user name for a while, whatever the address', async () => {
    await signUp('locked-out');
    for (let i = 0; i < 5; i++) assert.equal((await visitor(app.base).post('/api/session', { username: 'locked-out', password: `guess ${i}` })).status, 401);
    const blocked = await visitor(app.base).post('/api/session', { username: 'locked-out', password: 'correct horse' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Try again in 15 minutes/);
    // Other accounts are not affected.
    assert.equal((await visitor(app.base).post('/api/session', { username: 'anna-aachen', password: 'correct horse' })).status, 200);
  });
  test('a right password in between resets the count', async () => {
    await signUp('forgetful');
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await visitor(app.base).post('/api/session', { username: 'forgetful', password: 'nope' });
      assert.equal((await visitor(app.base).post('/api/session', { username: 'forgetful', password: 'correct horse' })).status, 200);
    }
  });
});

describe('session tokens', () => {
  const now = () => Date.now();
  test('forged, altered, expired and foreign tokens count as signed out', async () => {
    const good = forge({ u: 'anna-aachen', g: 'Test Group', r: 'member', iat: now(), exp: now() + 60e3 });
    assert.equal((await whoami(good)).username, 'anna-aachen');
    const [body, sig] = good.split('.');
    const moderator = Buffer.from(JSON.stringify({ u: 'anna-aachen', g: 'Test Group', r: 'moderator', iat: now(), exp: now() + 60e3 })).toString('base64url');
    const cases = {
      'signed with another key': forge({ u: 'anna-aachen', r: 'moderator', iat: now(), exp: now() + 60e3 }, crypto.randomBytes(32)),
      'payload swapped': `${moderator}.${sig}`,
      'signature cut': `${body}.${sig.slice(0, -2)}`,
      'no signature': body,
      expired: forge({ u: 'anna-aachen', iat: now() - 120e3, exp: now() - 60e3 }),
      'no expiry': forge({ u: 'anna-aachen' }),
      'no such account': forge({ u: 'never-registered', iat: now(), exp: now() + 60e3 }),
      'not a user name': forge({ u: '../etc', iat: now(), exp: now() + 60e3 }),
      'not an object': forge(null),
      'not base64': '%%%.%%%',
      'non-ASCII signature': `${body}.${'é'.repeat(43)}`,
      empty: '.',
    };
    for (const [name, token] of Object.entries(cases)) {
      const v = visitor(app.base);
      const r = await v.req('GET', '/api/meta', { headers: { 'X-Session': Buffer.from(token, 'utf8').toString('latin1') } });
      assert.equal(r.status, 200, name);
      assert.equal(r.body.account, null, name);
      assert.equal(r.body.admin, false, name);
    }
  });
  test('a role claimed in a token is ignored: the stored account decides', async () => {
    const claim = forge({ u: 'anna-aachen', g: 'Test Group', r: 'moderator', iat: now(), exp: now() + 60e3 });
    assert.equal((await whoami(claim)).role, 'member');
    assert.equal((await visitor(app.base, { session: claim }).get('/api/accounts')).status, 403);
  });
  test('a preview link of a hosted site is not a session', async () => {
    await signUp('preview');
    const preview = forge({ u: 'preview', site: 'some-site', iat: now(), exp: now() + 60e3 });
    assert.equal(await whoami(preview), null);
  });
  test('a token from before the account existed is refused (the name was someone else’s)', async () => {
    const old = forge({ u: 'anna-aachen', iat: now() - 40 * 864e5, exp: now() + 60e3 });
    assert.equal(await whoami(old), null);
    // Tokens from before this check carried no issue time; it is taken from the expiry (30 days).
    assert.equal((await whoami(forge({ u: 'anna-aachen', exp: now() + 30 * 864e5 + 5000 }))).username, 'anna-aachen');
    assert.equal(await whoami(forge({ u: 'anna-aachen', exp: now() + 29 * 864e5 })), null);
  });
  test('a browser id that looks like an account is not accepted', async () => {
    const { v: owner } = await signUp('vote-owner');
    const { slug } = await addMaterial(mod, text('Spoof target'));
    await owner.post(`/api/items/${slug}/vote`, { dir: 1 });
    const spoof = visitor(app.base);
    spoof.id = 'acct-vote-owner';
    assert.equal((await spoof.post(`/api/items/${slug}/vote`, { dir: -1 })).status, 400);
    assert.deepEqual((await spoof.get('/api/me/votes')).body, {});
    assert.equal((await owner.get(`/api/items/${slug}`)).body.up, 1);
  });
});

describe('roles', () => {
  test('only moderators list accounts and change roles', async () => {
    const { v: member } = await signUp('plain-member');
    assert.equal((await member.get('/api/accounts')).status, 403);
    assert.equal((await member.post('/api/accounts/plain-member/role', { role: 'moderator' })).status, 403);
    assert.equal((await member.del('/api/accounts/anna-aachen')).status, 403);
    assert.equal((await mod.post('/api/accounts/nobody-here/role', { role: 'moderator' })).status, 404);
    assert.equal((await mod.post('/api/accounts/__proto__/role', { role: 'moderator' })).status, 404);
    assert.equal({}.role, undefined);
  });
  test('a role change applies to sessions that are already open, in both directions', async () => {
    const { v } = await signUp('rising-star');
    const { slug } = await addMaterial(visitor(app.base), text('Waiting for a moderator'));
    assert.equal((await v.post(`/api/items/${slug}/approve`)).status, 403);
    const up = await mod.post('/api/accounts/rising-star/role', { role: 'moderator' });
    assert.equal(up.body.role, 'moderator');
    assert.equal((await v.get('/api/meta')).body.admin, true);
    assert.equal((await v.post(`/api/items/${slug}/approve`)).status, 200);
    // A moderator account publishes without review and can manage accounts.
    assert.equal((await addMaterial(v, text('By a moderator account'))).status, 'published');
    assert.equal((await v.get('/api/accounts')).status, 200);
    const down = await mod.post('/api/accounts/rising-star/role', { role: 'anything else' });
    assert.equal(down.body.role, 'member');
    assert.equal((await v.get('/api/meta')).body.admin, false);
    assert.equal((await v.get('/api/accounts')).status, 403);
  });
});

describe('what an account owns', () => {
  test('materials can be changed from any device, without an edit key', async () => {
    const { v } = await signUp('owner-one');
    const { slug } = await addMaterial(v, text('Owned by an account'));
    const elsewhere = visitor(app.base);
    elsewhere.session = (await elsewhere.post('/api/session', { username: 'owner-one', password: 'correct horse' })).body.token;
    assert.equal((await elsewhere.get(`/api/items/${slug}`)).body.mine, true);
    assert.equal((await elsewhere.post('/api/items', text('Owned by an account', { slug, summary: 'Edited elsewhere.' }))).status, 200);
    const { v: other } = await signUp('owner-two');
    assert.equal((await other.del(`/api/items/${slug}`)).status, 403);
    assert.equal((await elsewhere.del(`/api/items/${slug}`)).status, 200);
  });
  test('the uploader’s user name is shown to moderators and to the uploader, not to everyone', async () => {
    const { v } = await signUp('shy-author');
    const { slug } = await addMaterial(v, text('Signed material'));
    await mod.post(`/api/items/${slug}/approve`);
    const seenBy = async (who) => [(await who.get(`/api/items/${slug}`)).body.author, (await who.get('/api/items')).body.items.find((i) => i.slug === slug).author];
    assert.deepEqual(await seenBy(mod), ['shy-author', 'shy-author']);
    assert.deepEqual(await seenBy(v), ['shy-author', 'shy-author']);
    assert.deepEqual(await seenBy(visitor(app.base)), [undefined, undefined]);
  });
  test('the brand kit follows the account', async () => {
    const { v } = await signUp('brand-owner');
    assert.equal((await v.get('/api/me/brand')).body, null);
    assert.equal((await v.req('PUT', '/api/me/brand', { json: { group_name: 'AI Safety Bonn', color: '#123456', 'bad key!': 'x', nested: { a: 1 } } })).status, 200);
    assert.deepEqual((await v.get('/api/me/brand')).body, { group_name: 'AI Safety Bonn', color: '#123456' });
    assert.equal((await visitor(app.base).get('/api/me/brand')).status, 401);
  });
});

describe('changing the password', () => {
  test('needs the current password; other sessions end, this one continues', async () => {
    const { v } = await signUp('pw-changer');
    const second = visitor(app.base);
    second.session = (await second.post('/api/session', { username: 'pw-changer', password: 'correct horse' })).body.token;
    assert.equal((await visitor(app.base).post('/api/me/password', { current: 'correct horse', password: 'new password 1' })).status, 401);
    assert.equal((await v.post('/api/me/password', { current: 'wrong', password: 'new password 1' })).status, 401);
    assert.equal((await v.post('/api/me/password', { current: 'correct horse', password: 'short' })).status, 400);
    await new Promise((r) => setTimeout(r, 5));
    const r = await v.post('/api/me/password', { current: 'correct horse', password: 'new password 1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.username, 'pw-changer');
    assert.equal(await whoami(v.session), null, 'the old token of this device');
    assert.equal(await whoami(second.session), null, 'the session on the other device');
    assert.equal((await whoami(r.body.token)).username, 'pw-changer');
    assert.equal((await visitor(app.base).post('/api/session', { username: 'pw-changer', password: 'correct horse' })).status, 401);
    assert.equal((await visitor(app.base).post('/api/session', { username: 'pw-changer', password: 'new password 1' })).status, 200);
  });
  test('wrong current passwords count towards the lock', async () => {
    const { v } = await signUp('pw-guesser');
    for (let i = 0; i < 5; i++) await v.post('/api/me/password', { current: `guess ${i}`, password: 'new password 1' });
    assert.equal((await v.post('/api/me/password', { current: 'correct horse', password: 'new password 1' })).status, 429);
  });
});

describe('deleting an account', () => {
  const siteHtml = TEMPLATE.replace('<title>Table sign</title>', '<title>Our group</title>');
  async function populated(name) {
    const { v } = await signUp(name);
    const live = await addMaterial(v, text(`${name} published text`));
    await mod.post(`/api/items/${live.slug}/approve`);
    const waiting = await addMaterial(v, text(`${name} pending text`));
    const { slug: voted } = await addMaterial(mod, text(`${name} likes this`));
    await v.post(`/api/items/${voted}/vote`, { dir: 1 });
    await v.req('PUT', '/api/me/brand', { json: { group_name: name } });
    const site = await v.post('/api/sites', { name: `${name}-site`, title: 'Our group', html: siteHtml });
    assert.equal(site.status, 201);
    await mod.post(`/api/sites/${name}-site/approve`);
    assert.equal((await v.get(`/s/${name}-site/`)).status, 200);
    return { v, live: live.slug, waiting: waiting.slug, voted };
  }
  async function assertGone(name, { v, waiting, voted }) {
    assert.equal(await whoami(v.session), null, 'session');
    assert.equal(await app.store.getDoc('accounts', name), null);
    assert.equal((await visitor(app.base).post('/api/session', { username: name, password: 'correct horse' })).status, 401);
    assert.equal((await mod.get(`/api/items/${waiting}`)).status, 404, 'unpublished material');
    assert.equal((await mod.get(`/api/items/${voted}`)).body.up, 0, 'vote withdrawn');
    assert.equal((await visitor(app.base).get(`/s/${name}-site/`)).status, 404, 'hosted site');
    assert.equal(await app.store.readFile('_sites', `${name}-site/index.html`), null, 'site files');
    assert.equal(await app.store.readFile('_accounts', `${name}/brand.json`), null, 'brand kit');
    assert.ok(!(await mod.get('/api/sites')).body.some((s) => s.name === `${name}-site`));
  }

  test('needs a session and the password', async () => {
    const { v } = await signUp('stays-here');
    assert.equal((await visitor(app.base).post('/api/me/delete', { password: 'correct horse' })).status, 401);
    assert.equal((await v.post('/api/me/delete', { password: 'wrong' })).status, 401);
    assert.equal((await v.post('/api/me/delete', {})).status, 401);
    assert.equal((await whoami(v.session)).username, 'stays-here');
  });
  test('by default published materials stay, without owner or user name; everything else goes', async () => {
    const data = await populated('leaver-keep');
    assert.equal((await data.v.post('/api/me/delete', { password: 'correct horse' })).status, 200);
    await assertGone('leaver-keep', data);
    const kept = await app.store.getItem(data.live);
    assert.deepEqual([kept.status, kept.owner, kept.author, kept.group], ['published', null, null, 'Test Group']);
    assert.equal((await visitor(app.base).get(`/api/items/${data.live}`)).status, 200);
    // Whoever takes the name later owns nothing of the old account, and old tokens do not work for the new one.
    const { v: next } = await signUp('leaver-keep');
    assert.equal((await next.get(`/api/items/${data.live}`)).body.mine, false);
    assert.equal((await next.del(`/api/items/${data.live}`)).status, 403);
    assert.deepEqual((await next.get('/api/me/votes')).body, {});
    assert.deepEqual((await next.get('/api/sites')).body, []);
    assert.equal(await whoami(data.v.session), null);
  });
  test('on request the published materials are deleted too', async () => {
    const data = await populated('leaver-all');
    assert.equal((await data.v.post('/api/me/delete', { password: 'correct horse', materials: 'delete' })).status, 200);
    await assertGone('leaver-all', data);
    assert.equal((await mod.get(`/api/items/${data.live}`)).status, 404);
  });
  test('a moderator deleting an account does the same clean-up', async () => {
    const data = await populated('removed-by-mod');
    assert.equal((await mod.del('/api/accounts/removed-by-mod')).status, 200);
    await assertGone('removed-by-mod', data);
    assert.equal((await mod.get(`/api/items/${data.live}`)).body.status, 'published');
    assert.ok(!(await mod.get('/api/accounts')).body.some((a) => a.username === 'removed-by-mod'));
  });
});
