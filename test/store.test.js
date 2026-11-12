// The local store and the small in-memory helpers, without the HTTP server.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

process.env.SESSION_SECRET = 'unit-test-secret';
const { checkFileKey, checkPassword, fileKey, hashPassword, sessions, sign, throttle, verify } = await import('../server/accounts.js');
const { addressKey, boundedMap, isOurs, publicError, sweepDrafts, DRAFT_MAX_AGE_MS } = await import('../server/ops.js');
const { openStore } = await import('../server/store.js');

let dir, store;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-store-'));
  process.env.STORE = 'local';
  process.env.DATA_DIR = dir;
  store = await openStore();
});
after(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local store', () => {
  test('patchItem on a missing item returns null and changes nothing', async () => {
    assert.equal(await store.patchItem('missing', { status: 'published' }), null);
    assert.equal(await store.getItem('missing'), null);
    await store.putItem({ slug: 'real', status: 'draft' });
    assert.equal((await store.patchItem('real', { status: 'pending' })).status, 'pending');
  });
  test('names that every object has are not items, documents or collections', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(await store.getItem(name), null, name);
      assert.equal(await store.patchItem(name, { polluted: true }), null, name);
      assert.equal(await store.getDoc('accounts', name), null, name);
      assert.equal(await store.getDoc(name, 'x'), null, name);
      assert.deepEqual(await store.listDocs(name), []);
      await store.incr(name, 'uses', 1);
      await store.deleteDoc('accounts', name);
      await assert.rejects(store.vote(name, 'client-12345678', 1), { status: 404 });
    }
    assert.equal({}.polluted, undefined);
    assert.equal({}.uses, undefined);
  });
  test('createDoc refuses a taken id', async () => {
    assert.equal(await store.createDoc('accounts', 'anna', { username: 'anna', n: 1 }), true);
    assert.equal(await store.createDoc('accounts', 'anna', { username: 'anna', n: 2 }), false);
    assert.equal((await store.getDoc('accounts', 'anna')).n, 1);
  });
  test('files stay inside the store', async () => {
    await store.putFile('item', 'a/b.txt', Buffer.from('ok'));
    assert.equal((await store.readFile('item', 'a/b.txt')).toString(), 'ok');
    await assert.rejects(store.putFile('item', '../../escape.txt', Buffer.from('x')), /outside the store/);
    await assert.rejects(store.putFile('..', 'escape.txt', Buffer.from('x')), /outside the store/);
    assert.equal(await store.readFile('item', '../../../etc/hosts'), null);
    await assert.rejects(store.deleteItem('..'), /outside the store/);
    assert.equal(await store.fileStream('item', 'a'), null, 'a folder is not a file');
    assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')));
  });
  test('deleteFiles removes one file or a whole folder', async () => {
    await store.putFile('_sites', 'one/index.html', Buffer.from('1'));
    await store.putFile('_sites', 'one/assets/app.js', Buffer.from('2'));
    await store.putFile('_sites', 'two/index.html', Buffer.from('3'));
    await store.deleteFiles('_sites', 'one/assets/app.js');
    assert.equal(await store.readFile('_sites', 'one/assets/app.js'), null);
    assert.ok(await store.readFile('_sites', 'one/index.html'));
    await store.deleteFiles('_sites', 'one/');
    assert.equal(await store.readFile('_sites', 'one/index.html'), null);
    assert.ok(await store.readFile('_sites', 'two/index.html'));
    await assert.rejects(store.deleteFiles('_sites', ''), /prefix/);
  });
  test('close writes the database, and a new store reads it back', async () => {
    await store.putItem({ slug: 'kept', status: 'published', up: 3 });
    await store.close();
    assert.ok(!fs.existsSync(path.join(dir, 'db.json.tmp')));
    const again = await openStore();
    assert.equal((await again.getItem('kept')).up, 3);
    await store.ping();
  });
  test('takeQuota stops at the limit', async () => {
    assert.deepEqual([await store.takeQuota('test', 2), await store.takeQuota('test', 2), await store.takeQuota('test', 2)], [true, true, false]);
  });
});

describe('housekeeping', () => {
  test('drafts older than two days are removed; newer drafts and submitted materials stay', async () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const at = (hoursAgo) => new Date(now - hoursAgo * 3600e3).toISOString();
    await store.putItem({ slug: 'old-draft', status: 'draft', updated_at: at(49) });
    await store.putFile('old-draft', 'a.txt', Buffer.from('x'));
    await store.putItem({ slug: 'new-draft', status: 'draft', updated_at: at(47) });
    await store.putItem({ slug: 'old-pending', status: 'pending', updated_at: at(500) });
    await store.putItem({ slug: 'old-published', status: 'published', updated_at: at(5000) });
    await store.putItem({ slug: 'undated-draft', status: 'draft' });
    const dropped = [];
    assert.equal(await sweepDrafts(store, { now, onDelete: (i) => dropped.push(i.slug) }), 1);
    assert.deepEqual(dropped, ['old-draft']);
    assert.equal(await store.getItem('old-draft'), null);
    assert.equal(await store.readFile('old-draft', 'a.txt'), null);
    for (const slug of ['new-draft', 'old-pending', 'old-published', 'undated-draft']) assert.ok(await store.getItem(slug), slug);
    assert.equal(DRAFT_MAX_AGE_MS, 48 * 3600e3);
  });
});

describe('accounts module', () => {
  test('passwords', () => {
    const stored = hashPassword('correct horse');
    assert.equal(checkPassword('correct horse', stored), true);
    assert.equal(checkPassword('wrong', stored), false);
    assert.notEqual(hashPassword('correct horse'), stored, 'a new salt every time');
    for (const broken of ['', 'nosalt', 'salt:tooshort', `salt:${'z'.repeat(64)}`, null, undefined]) assert.equal(checkPassword('x', broken), false);
  });
  test('tokens', () => {
    const token = sign({ u: 'anna' });
    assert.equal(verify(token).u, 'anna');
    assert.equal(verify(sign({ u: 'anna' }, -1)), null, 'expired');
    assert.equal(verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
    assert.equal(verify(`${token}é`), null);
    for (const junk of [null, undefined, '', 'abc', 'a.b.c', {}, 42]) assert.equal(verify(junk), null);
  });
  test('sessions follow the stored account', async () => {
    const accounts = { anna: { username: 'anna', group: 'G', role: 'member', created_at: new Date(Date.now() - 1000).toISOString() } };
    let reads = 0;
    const s = sessions({ getDoc: async (_, id) => (reads++, accounts[id] || null) }, { ttl: 60000 });
    const token = sign({ u: 'anna', g: 'old group', r: 'moderator' });
    assert.deepEqual(await s.resolve(token), { u: 'anna', g: 'G', r: 'member' });
    await s.resolve(token);
    assert.equal(reads, 1, 'the account is read once, then remembered');
    accounts.anna.valid_from = Date.now() + 1000;
    s.forget('anna');
    assert.equal(await s.resolve(token), null, 'issued before the password change');
    delete accounts.anna;
    s.forget('anna');
    assert.equal(await s.resolve(token), null, 'account deleted');
    assert.equal(await s.resolve(''), null);
    assert.equal(await s.resolve(sign({ u: 'preview', site: 'x' })), null);
  });
  test('throttle', () => {
    const t = throttle({ max: 3, windowMs: 1000 });
    assert.equal(t.blocked('a'), 0);
    t.fail('a');
    t.fail('a');
    assert.equal(t.blocked('a'), 0);
    t.fail('a');
    assert.equal(t.blocked('a'), 1);
    assert.equal(t.blocked('b'), 0);
    t.clear('a');
    assert.equal(t.blocked('a'), 0);
    const small = throttle({ max: 3, windowMs: 1000, entries: 2 });
    for (const name of ['a', 'b', 'c', 'd']) small.fail(name); // more names than it may remember: it does not grow
  });
  test('file keys open one material, for a limited time', () => {
    const key = fileKey('poster');
    assert.equal(checkFileKey(key, 'poster'), true);
    assert.equal(checkFileKey(key, 'other'), false);
    assert.equal(checkFileKey(fileKey('poster', -1), 'poster'), false);
    for (const junk of ['', 'abc', '.', 'zzzz.', null, undefined, `${key}x`]) assert.equal(checkFileKey(junk, 'poster'), false);
  });
});

describe('ops helpers', () => {
  test('a bounded table forgets its oldest entries', () => {
    const m = boundedMap(3);
    for (const k of ['a', 'b', 'c']) m.set(k, 1);
    m.set('a', 2); // used again: now the newest
    m.set('d', 1);
    assert.deepEqual([...m.keys()], ['c', 'a', 'd']);
    for (let i = 0; i < 1000; i++) m.set(`k${i}`, i);
    assert.equal(m.size, 3);
  });
  test('addresses for rate limits', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
    assert.equal(addressKey('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
    assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2');
    assert.equal(addressKey(undefined), '');
  });
  test('what an error may tell the visitor', () => {
    const ours = Object.assign(new Error('That user name is taken.'), { status: 409 });
    assert.deepEqual(publicError(ours), { status: 409, message: 'That user name is taken.' });
    assert.equal(isOurs(new Error('plain')), true);
    const hidden = [new Error('no status'), new TypeError('x is undefined'), Object.assign(new Error('5 NOT_FOUND: projects/p'), { code: 5 }), Object.assign(new Error('ENOENT /srv/data'), { code: 'ENOENT', status: 404 }), Object.assign(new Error('auth'), { status: 401, response: {} }), null, 'a string'];
    for (const e of hidden) assert.deepEqual(publicError(e), { status: 500, message: 'Something went wrong on the server.' });
    assert.deepEqual(publicError({ type: 'entity.too.large', status: 413 }), { status: 413, message: 'That file is too large.' });
    assert.deepEqual(publicError({ type: 'entity.parse.failed', status: 400, message: 'Unexpected token } in JSON at position 9' }), { status: 400, message: 'The request body is not valid JSON.' });
    assert.equal(publicError({ type: 'request.aborted', status: 400 }).status, 400);
    assert.equal(publicError(Object.assign(new URIError('Failed to decode param'), { status: 400 })).status, 400);
  });
});
