// Votes, use counts, the four sort orders, keyword search and the leaderboard.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMaterial, startApp, text, visitor } from './helper.js';

let app, mod;
before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
});
after(() => app.stop());

const seed = async (title, stats, extra = {}) => {
  const created = await mod.post('/api/items', text(title, extra));
  await mod.post(`/api/items/${created.body.slug}/publish`, { stats });
  return created.body.slug;
};

describe('votes', () => {
  let slug;
  before(async () => {
    ({ slug } = await addMaterial(mod, text('Vote on me')));
  });
  const counts = async () => {
    const i = (await mod.get(`/api/items/${slug}`)).body;
    return [i.up, i.down, i.score];
  };

  test('one vote per visitor; voting again changes or withdraws it', async () => {
    const a = visitor(app.base);
    const b = visitor(app.base);
    assert.deepEqual((await a.post(`/api/items/${slug}/vote`, { dir: 1 })).body, { up: 1, down: 0, my: 1, score: 1 });
    assert.deepEqual((await a.post(`/api/items/${slug}/vote`, { dir: 1 })).body, { up: 1, down: 0, my: 1, score: 1 });
    assert.deepEqual((await b.post(`/api/items/${slug}/vote`, { dir: 1 })).body.score, 2);
    assert.deepEqual((await a.post(`/api/items/${slug}/vote`, { dir: -1 })).body, { up: 1, down: 1, my: -1, score: 0 });
    assert.deepEqual((await a.get('/api/me/votes')).body, { [slug]: -1 });
    assert.deepEqual((await a.post(`/api/items/${slug}/vote`, { dir: 0 })).body, { up: 1, down: 0, my: 0, score: 1 });
    assert.deepEqual((await a.get('/api/me/votes')).body, {});
    assert.deepEqual(await counts(), [1, 0, 1]);
  });
  test('a vote needs a browser id and a direction of 1, 0 or -1', async () => {
    const v = visitor(app.base);
    for (const dir of [2, -2, 'up', null, 0.5]) assert.equal((await v.post(`/api/items/${slug}/vote`, { dir })).status, 400, String(dir));
    for (const id of ['', 'short', 'has space in it', 'x'.repeat(65), 'acct-someone-else', 'under_score_id']) {
      v.id = id;
      assert.equal((await v.post(`/api/items/${slug}/vote`, { dir: 1 })).status, 400, id);
    }
    assert.equal((await visitor(app.base).post('/api/items/no-such-material/vote', { dir: 1 })).status, 404);
    assert.deepEqual(await counts(), [1, 0, 1]);
  });
  test('an account votes once, from whichever browser', async () => {
    const one = visitor(app.base);
    const signup = await one.post('/api/accounts', { username: 'one-voter', password: 'correct horse', group: 'G' });
    one.session = signup.body.token;
    const two = visitor(app.base, { session: signup.body.token });
    await one.post(`/api/items/${slug}/vote`, { dir: 1 });
    await two.post(`/api/items/${slug}/vote`, { dir: 1 });
    assert.deepEqual(await counts(), [2, 0, 2]);
    assert.deepEqual((await two.get('/api/me/votes')).body, { [slug]: 1 });
  });
  test('a use is counted once per visitor', async () => {
    const a = visitor(app.base);
    const b = visitor(app.base);
    await a.post(`/api/items/${slug}/use`);
    await a.post(`/api/items/${slug}/use`);
    await b.post(`/api/items/${slug}/use`);
    assert.equal((await mod.get(`/api/items/${slug}`)).body.uses, 2);
  });
  test('deleting a material removes its votes', async () => {
    const v = visitor(app.base);
    const { slug: gone } = await addMaterial(mod, text('Soon gone'));
    await v.post(`/api/items/${gone}/vote`, { dir: 1 });
    await mod.del(`/api/items/${gone}`);
    assert.deepEqual((await v.get('/api/me/votes')).body, {});
  });
});

describe('sort orders', () => {
  const order = async (sort) => (await mod.get(`/api/items?category=ops${sort ? `&sort=${sort}` : ''}`)).body.items.map((i) => i.title);
  before(async () => {
    const ops = { category: 'ops' };
    // title, votes and uses, age: chosen so that every order differs.
    await seed('Old favourite', { up: 100, down: 10, uses: 2000, created_at: '2026-01-10T00:00:00Z' }, ops); // score 90, liked by few of its users
    await seed('Loved by its users', { up: 30, down: 0, uses: 32, created_at: '2026-06-01T00:00:00Z' }, ops); // score 30, nearly everyone liked it
    await seed('Brand new', { up: 3, down: 0, uses: 50, created_at: '2026-11-10T00:00:00Z' }, ops); // score 3
    await seed('Disliked', { up: 1, down: 9, uses: 40, created_at: '2026-09-01T00:00:00Z' }, ops); // score -8
  });
  test('top: upvotes minus downvotes', async () => {
    assert.deepEqual(await order('top'), ['Old favourite', 'Loved by its users', 'Brand new', 'Disliked']);
  });
  test('new: newest first', async () => {
    assert.deepEqual(await order('new'), ['Brand new', 'Disliked', 'Loved by its users', 'Old favourite']);
  });
  test('best: liked by the people who used it', async () => {
    assert.deepEqual(await order('best'), ['Loved by its users', 'Old favourite', 'Brand new', 'Disliked']);
  });
  test('hot: votes, with newer materials ranked higher', async () => {
    // log10(score) plus 1 per 180 days: 3 points in November outrank 90 points from January.
    assert.deepEqual(await order('hot'), ['Loved by its users', 'Brand new', 'Old favourite', 'Disliked']);
  });
  test('best is the default; an unknown order falls back to hot', async () => {
    assert.deepEqual(await order(''), await order('best'));
    assert.deepEqual(await order('sideways'), await order('hot'));
  });
  test('filters by category and kind, with counts per category', async () => {
    const r = (await mod.get('/api/items?category=ops&kind=text')).body;
    assert.equal(r.items.length, 4);
    assert.equal(r.counts.ops, 4);
    assert.equal(r.mode, 'browse');
    assert.equal((await mod.get('/api/items?category=ops&kind=kit')).body.items.length, 0);
  });
});

describe('keyword search', () => {
  before(async () => {
    await seed('Freshers fair checklist', { up: 3 }, { category: 'event', tags: ['tabling'], summary: 'What to bring to the stall.' });
    await seed('Professor outreach email', { up: 9 }, { category: 'message', summary: 'Ask for five minutes in a lecture.', variants: [{ body: 'Dear Professor, may we present our reading group to your students?' }] });
    await seed('Venue booking guide', { up: 1 }, { category: 'event', description: 'How to book a room. Mentions a professor once.' });
  });
  const search = async (q, extra = '') => (await mod.get(`/api/items?q=${encodeURIComponent(q)}${extra}`)).body;

  test('matches title, tags, summary and body, best match first', async () => {
    const r = await search('professor');
    assert.equal(r.mode, 'keyword');
    assert.deepEqual(r.items.map((i) => i.title), ['Professor outreach email', 'Venue booking guide']);
    assert.deepEqual((await search('tabling')).items.map((i) => i.title), ['Freshers fair checklist']);
    assert.deepEqual((await search('students')).items.map((i) => i.title), ['Professor outreach email']);
  });
  test('ignores filler words, case and plural endings', async () => {
    assert.deepEqual((await search('the PROFESSORS and what')).items.map((i) => i.title), ['Professor outreach email', 'Venue booking guide']);
    assert.deepEqual((await search('zzzunknownzzz')).items, []);
    assert.deepEqual((await search('the and for')).items, []);
  });
  test('search combines with filters and a sort order, and counts hits per category', async () => {
    const r = await search('professor', '&category=event');
    assert.deepEqual(r.items.map((i) => i.title), ['Venue booking guide']);
    assert.deepEqual(r.counts, { message: 1, event: 1 });
    assert.deepEqual((await search('professor', '&sort=top')).items.map((i) => i.title), ['Professor outreach email', 'Venue booking guide']);
    assert.deepEqual((await search('professor', '&sort=new')).items.length, 2);
  });
  test('the list view carries a snippet instead of the full text', async () => {
    const item = (await search('students')).items[0];
    assert.match(item.snippet, /Dear Professor/);
    assert.deepEqual(item.variants, [{ label: 'Variant 1', lang: 'en', channel: 'email' }]);
    assert.equal(item.description, undefined);
  });
  test('pending materials are found by their uploader only', async () => {
    const anna = visitor(app.base);
    await addMaterial(anna, text('Xylophone workshop plan'));
    assert.equal((await anna.get('/api/items?q=xylophone')).body.items.length, 1);
    assert.equal((await visitor(app.base).get('/api/items?q=xylophone')).body.items.length, 0);
  });
});

describe('leaderboard', () => {
  test('ranks groups by score and lists this semester’s materials', async () => {
    const r = (await visitor(app.base).get('/api/leaderboard')).body;
    assert.match(r.semester.label, /semester/);
    assert.equal(r.simulated, true);
    assert.equal(r.groups[0].group, 'Test Group');
    assert.ok(r.groups[0].score > 100);
    assert.ok(r.materials.length > 0);
    for (const m of r.materials) assert.equal(m.edit_key, undefined);
  });
});
