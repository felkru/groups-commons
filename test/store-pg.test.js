// The PostgreSQL store on its own (server/store-pg.js). Runs against PGlite, PostgreSQL inside this process, or
// against a real server with PG_TEST=server (see helper.js); in both cases file bytes go to a temporary folder.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FolderFiles } from '../server/files.js';
import { MIGRATIONS, PgStore, SCHEMA_VERSION, connect, ensureSchema, itemRow, pgConfigured, poolDb, sslFrom, toJson } from '../server/store-pg.js';
import { PG_TEST, dropTestStore, useTestStore } from './helper.js';

let dir, db, files, store;
const schema = () => process.env.PG_SCHEMA || '';
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-pg-'));
  useTestStore(dir);
  if (!PG_TEST) process.env.PG_TEST = 'pglite'; // under plain `npm test` too
  db = await connect();
  files = new FolderFiles(path.join(dir, 'files'));
  store = await new PgStore(db, files, { schema: schema() }).init();
});
after(async () => {
  await dropTestStore(store);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('schema', () => {
  test('the tables exist after the first start, with the version written down', async () => {
    assert.equal(SCHEMA_VERSION, MIGRATIONS.at(-1).version);
    assert.deepEqual(await rows('SELECT id, version FROM schema_version'), [{ id: true, version: SCHEMA_VERSION }]);
    for (const table of ['items', 'votes', 'docs', 'quotas', 'files']) assert.equal((await rows(`SELECT to_regclass('${table}') IS NOT NULL AS there`))[0].there, true, table);
  });
  test('starting again, or twice at the same moment, changes nothing', async () => {
    await store.putItem({ slug: 'survives-restart', status: 'draft' });
    const [{ applied_at: first }] = await rows('SELECT applied_at FROM schema_version');
    assert.equal(await ensureSchema(db, schema()), SCHEMA_VERSION);
    assert.deepEqual(await Promise.all([ensureSchema(db, schema()), ensureSchema(db, schema()), new PgStore(db, files, { schema: schema() }).init().then((s) => s.up())]), [SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION]);
    const again = await rows('SELECT version, applied_at FROM schema_version');
    assert.equal(again.length, 1);
    assert.equal(again[0].version, SCHEMA_VERSION);
    assert.equal(+again[0].applied_at, +first, 'the version row was not rewritten');
    assert.equal((await store.getItem('survives-restart')).status, 'draft');
  });
  test('a schema that is newer than this code is left alone', async () => {
    await db.query('UPDATE schema_version SET version = $1', [SCHEMA_VERSION + 5]);
    try {
      assert.equal(await ensureSchema(db, schema()), SCHEMA_VERSION + 5);
    } finally {
      await db.query('UPDATE schema_version SET version = $1', [SCHEMA_VERSION]);
    }
  });
  test('a schema name that is not a plain name is refused', async () => {
    await assert.rejects(ensureSchema(db, 'x; DROP TABLE items'), /PG_SCHEMA/);
  });
  test('the store starts while the database is away, and works once it is back', async () => {
    let down = true;
    const flaky = {
      query: (...a) => (down ? Promise.reject(new Error('connection refused')) : db.query(...a)),
      transaction: (fn) => (down ? Promise.reject(new Error('connection refused')) : db.transaction(fn)),
      end: async () => {},
    };
    const errors = [];
    const original = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    let late;
    try {
      late = await new PgStore(flaky, files, { schema: schema() }).init();
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /initial load failed/);
    await assert.rejects(late.ping(), /connection refused/);
    await assert.rejects(late.allItems(), /connection refused/);
    down = false;
    await late.ping();
    assert.ok((await late.allItems()).some((i) => i.slug === 'survives-restart'));
  });
});

describe('materials', () => {
  test('a record comes back as it went in, and its columns follow it', async () => {
    const emb = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 3);
    const item = { slug: 'round-trip', title: 'Zurück — “quotes” 🎉', kind: 'text', status: 'published', created_at: '2026-10-01T08:00:00.000Z', updated_at: '2026-11-02T09:30:00.000Z', up: 2, down: 0, tags: ['flyer', 'a4'], variants: [{ label: 'English', body: 'line\nbreak' }], owner: undefined, emb, nothing: null };
    await store.putItem(item);
    assert.equal(await store.getItem('round-trip'), item, 'the object that was put is the one in memory');
    const other = await new PgStore(db, files, { schema: schema() }).init();
    const read = await other.getItem('round-trip');
    const { owner, ...defined } = item;
    assert.deepEqual(read, defined, 'undefined fields are left out, everything else is identical (floats included)');
    assert.ok(!('owner' in read));
    const [row] = await rows('SELECT kind, status, created, updated FROM items WHERE slug = $1', ['round-trip']);
    assert.deepEqual({ ...row, created: row.created.toISOString(), updated: row.updated.toISOString() }, { kind: 'text', status: 'published', created: item.created_at, updated: item.updated_at });
    assert.deepEqual(await rows(`SELECT slug FROM items WHERE data -> 'tags' ? 'a4'`), [{ slug: 'round-trip' }], 'tags can be queried');
  });
  test('putItem replaces the whole record', async () => {
    await store.putItem({ slug: 'replaced', status: 'draft', kind: 'file', old_field: 1 });
    await store.putItem({ slug: 'replaced', status: 'pending' });
    assert.deepEqual((await rows('SELECT data, kind, status FROM items WHERE slug = $1', ['replaced']))[0], { data: { slug: 'replaced', status: 'pending' }, kind: null, status: 'pending' });
  });
  test('text the database cannot hold is cleaned, not refused', async () => {
    await store.putItem({ slug: 'odd-text', title: 'nul\u0000here', half: 'broken \ud83d pair', fine: 'a \\u0000 written out' });
    const [{ data }] = await rows('SELECT data FROM items WHERE slug = $1', ['odd-text']);
    assert.deepEqual(data, { slug: 'odd-text', title: 'nulhere', half: 'broken � pair', fine: 'a \\u0000 written out' });
    assert.equal(toJson({ a: undefined, b: [1, undefined] }), '{"b":[1,null]}');
  });
  test('dates that are not dates leave the column empty', () => {
    assert.deepEqual(itemRow('x', { kind: 7, status: 'draft', created_at: 'yesterday', updated_at: '2026-11-12T10:00:00+01:00' }), { slug: 'x', data: { kind: 7, status: 'draft', created_at: 'yesterday', updated_at: '2026-11-12T10:00:00+01:00' }, kind: null, status: 'draft', created: null, updated: '2026-11-12T09:00:00.000Z' });
  });
  test('patchItem sets the given top-level fields and leaves the rest', async () => {
    const item = { slug: 'patched', status: 'draft', kind: 'file', title: 'T', owner: 'acct-anna', author: 'anna', file_list: [{ path: 'a.pdf', size: 1 }], nested: { a: 1, b: 2 }, created_at: '2026-01-01T00:00:00.000Z' };
    await store.putItem(item);
    const out = await store.patchItem('patched', { status: 'published', owner: null, author: undefined, nested: { c: 3 }, file_list: [], updated_at: '2026-11-12T12:00:00.000Z', added: 'x' });
    assert.equal(out, item, 'the object in memory is updated in place: requests under way hold on to it');
    const expected = { slug: 'patched', status: 'published', kind: 'file', title: 'T', owner: null, author: 'anna', file_list: [], nested: { c: 3 }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-11-12T12:00:00.000Z', added: 'x' };
    assert.deepEqual(out, expected);
    const [row] = await rows('SELECT data, kind, status, created, updated FROM items WHERE slug = $1', ['patched']);
    assert.deepEqual(row.data, expected, 'null is stored, undefined changes nothing, objects are replaced and not merged');
    assert.deepEqual([row.kind, row.status, row.created.toISOString(), row.updated.toISOString()], ['file', 'published', '2026-01-01T00:00:00.000Z', '2026-11-12T12:00:00.000Z']);
  });
  test('patchItem returns null for a material that does not exist (any more)', async () => {
    assert.equal(await store.patchItem('never-there', { status: 'published' }), null);
    assert.deepEqual(await rows('SELECT 1 FROM items WHERE slug = $1', ['never-there']), []);
    await store.putItem({ slug: 'deleted-elsewhere', status: 'draft' });
    await db.query('DELETE FROM items WHERE slug = $1', ['deleted-elsewhere']); // another instance
    assert.equal(await store.patchItem('deleted-elsewhere', { status: 'published' }), null);
    assert.equal(await store.getItem('deleted-elsewhere'), null, 'and it is gone from memory');
  });
  test('a patch from another instance is not lost: the patch returns the record as the database has it', async () => {
    const a = store;
    const b = await new PgStore(db, files, { schema: schema() }).init();
    await a.putItem({ slug: 'two-instances', status: 'draft', uses: 0 });
    await b.getItem('two-instances');
    await a.patchItem('two-instances', { preview: 'p.jpg' });
    const seen = await b.patchItem('two-instances', { status: 'pending' });
    assert.deepEqual(seen, { slug: 'two-instances', status: 'pending', uses: 0, preview: 'p.jpg' });
  });
  test('all materials come from one query and are re-read when they are older than the refresh time', async () => {
    const counted = [];
    const counting = { ...db, query: (text, params) => (counted.push(text), db.query(text, params)) };
    const a = await new PgStore(counting, files, { schema: schema(), refreshMs: 400 }).init();
    counted.length = 0;
    const n = (await a.allItems()).length;
    assert.ok(n >= 3);
    await a.allItems();
    await a.getItem('round-trip');
    assert.deepEqual(counted, [], 'answered from memory');
    await store.putItem({ slug: 'made-elsewhere', status: 'published' });
    assert.equal((await a.allItems()).length, n, 'not seen yet');
    assert.equal((await a.getItem('made-elsewhere')).status, 'published', 'a material that is not in memory is looked up');
    await new Promise((r) => setTimeout(r, 450));
    counted.length = 0;
    await a.allItems(); // starts the re-read in the background
    await a.loading;
    assert.deepEqual(counted, ['SELECT slug, data FROM items']);
    assert.equal((await a.allItems()).length, n + 1);
  });
  test('what is written while the materials are being re-read is not overwritten by the older answer', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = { ...db, query: async (text, params) => {
      const out = await db.query(text, params);
      if (text === 'SELECT slug, data FROM items') await gate; // the answer is on its way while the writes below happen
      return out;
    } };
    const a = new PgStore(slow, files, { schema: schema() });
    await db.query(`INSERT INTO items (slug, data) VALUES ('during-a', '{"slug":"during-a","status":"draft","uses":1}'), ('during-b', '{"slug":"during-b","status":"draft"}') ON CONFLICT DO NOTHING`);
    const loading = a.refresh();
    await new Promise((r) => setTimeout(r, 30));
    await a.patchItem('during-a', { status: 'published' });
    await a.deleteItem('during-b');
    await a.putItem({ slug: 'during-c', status: 'pending' });
    release();
    await loading;
    const all = Object.fromEntries((await a.allItems()).map((i) => [i.slug, i.status]));
    assert.equal(all['during-a'], 'published');
    assert.equal(all['during-b'], undefined);
    assert.equal(all['during-c'], 'pending');
  });
  test('deleteItem removes the record, its votes, its file rows and its files', async () => {
    await store.putItem({ slug: 'doomed', status: 'published' });
    await store.putItem({ slug: 'doomed-2', status: 'published' });
    await store.putFile('doomed', 'a/b.txt', Buffer.from('x'), 'text/plain');
    await store.putFile('doomed-2', 'kept.txt', Buffer.from('y'), 'text/plain');
    await store.vote('doomed', 'client-00000001', 1);
    await store.vote('doomed-2', 'client-00000001', 1);
    await store.deleteItem('doomed');
    assert.equal(await store.getItem('doomed'), null);
    assert.deepEqual(await rows(`SELECT slug FROM votes WHERE slug LIKE 'doomed%'`), [{ slug: 'doomed-2' }]);
    assert.deepEqual(await rows(`SELECT owner, path FROM files WHERE owner LIKE 'doomed%'`), [{ owner: 'doomed-2', path: 'kept.txt' }]);
    assert.equal(await store.readFile('doomed', 'a/b.txt'), null);
    assert.equal((await store.readFile('doomed-2', 'kept.txt')).toString(), 'y');
    assert.deepEqual(await store.votesOf('client-00000001'), { 'doomed-2': 1 });
    await store.deleteItem('doomed'); // again: nothing to do, no error
  });
});

describe('votes', () => {
  const totals = async (slug) => (await rows(`SELECT data -> 'up' AS up, data -> 'down' AS down, (SELECT count(*)::int FROM votes v WHERE v.slug = i.slug AND dir = 1) AS ups, (SELECT count(*)::int FROM votes v WHERE v.slug = i.slug AND dir = -1) AS downs FROM items i WHERE slug = $1`, [slug]))[0];
  test('many people voting at the same moment are all counted', async () => {
    await store.putItem({ slug: 'popular', status: 'published', up: 0, down: 0 });
    const results = await many(40, (i) => store.vote('popular', `client-${String(i).padStart(8, '0')}`, i % 4 === 0 ? -1 : 1));
    assert.deepEqual(await totals('popular'), { up: 30, down: 10, ups: 30, downs: 10 });
    assert.ok(results.every((r) => r.up + r.down >= 1 && r.up <= 30 && r.down <= 10 && [1, -1].includes(r.my)));
  });
  test('the same vote sent many times counts once', async () => {
    await store.putItem({ slug: 'double-click', status: 'published', up: 0, down: 0 });
    await many(12, () => store.vote('double-click', 'client-impatient', 1));
    assert.deepEqual(await totals('double-click'), { up: 1, down: 0, ups: 1, downs: 0 });
    assert.deepEqual(await store.vote('double-click', 'client-impatient', 1), { up: 1, down: 0, my: 1 });
  });
  test('changing and withdrawing a vote', async () => {
    await store.putItem({ slug: 'undecided', status: 'published' }); // no totals yet
    assert.deepEqual(await store.vote('undecided', 'client-aaaaaaaa', 1), { up: 1, down: 0, my: 1 });
    assert.deepEqual(await store.vote('undecided', 'client-aaaaaaaa', -1), { up: 0, down: 1, my: -1 });
    assert.deepEqual(await store.votesOf('client-aaaaaaaa'), { undecided: -1 });
    assert.deepEqual(await store.vote('undecided', 'client-aaaaaaaa', 0), { up: 0, down: 0, my: 0 });
    assert.deepEqual(await store.vote('undecided', 'client-aaaaaaaa', 0), { up: 0, down: 0, my: 0 }, 'withdrawing twice');
    assert.deepEqual(await store.votesOf('client-aaaaaaaa'), {});
    assert.deepEqual(await totals('undecided'), { up: 0, down: 0, ups: 0, downs: 0 });
  });
  test('totals that were set by a moderator (seeded statistics) are counted on from', async () => {
    await store.putItem({ slug: 'seeded', status: 'published', up: 120, down: 7, uses: 300 });
    assert.deepEqual(await store.vote('seeded', 'client-bbbbbbbb', 1), { up: 121, down: 7, my: 1 });
    assert.deepEqual(await store.vote('seeded', 'client-bbbbbbbb', -1), { up: 120, down: 8, my: -1 });
    assert.equal((await rows('SELECT data FROM items WHERE slug = $1', ['seeded']))[0].data.uses, 300, 'other fields are untouched');
  });
  test('a vote on a material that does not exist is a 404 and leaves nothing behind', async () => {
    await assert.rejects(store.vote('no-such-material', 'client-cccccccc', 1), { status: 404, expose: true, message: 'No material with that name.' });
    assert.deepEqual(await store.votesOf('client-cccccccc'), {});
    await store.ping(); // the failed transaction was rolled back and the connection is usable
  });
  test('votes and edits at the same moment do not undo each other', async () => {
    await store.putItem({ slug: 'busy', status: 'draft', up: 0, down: 0, uses: 0 });
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) => store.vote('busy', `client-busy-${i}00000`, 1)),
      ...Array.from({ length: 15 }, () => store.incr('busy', 'uses', 1)),
      store.patchItem('busy', { status: 'published' }),
      store.patchItem('busy', { title: 'Busy' }),
    ]);
    const [{ data }] = await rows('SELECT data FROM items WHERE slug = $1', ['busy']);
    assert.deepEqual(data, { slug: 'busy', status: 'published', up: 15, down: 0, uses: 15, title: 'Busy' });
  });
});

describe('counters, documents, quotas', () => {
  test('incr adds up when called many times at once', async () => {
    await store.putItem({ slug: 'counted', status: 'published', uses: 5 });
    await many(50, () => store.incr('counted', 'uses', 1));
    await store.incr('counted', 'uses', 3);
    await store.incr('counted', 'prints'); // a field that is not there yet
    await store.incr('counted', 'title', 2); // not a number: counted from 0, as the other stores do
    const [{ data }] = await rows('SELECT data FROM items WHERE slug = $1', ['counted']);
    assert.deepEqual(data, { slug: 'counted', status: 'published', uses: 58, prints: 1, title: 2 });
    assert.equal((await store.getItem('counted')).uses, 58);
    await store.incr('not-there', 'uses', 1); // nothing to count, no error
    assert.deepEqual(await rows('SELECT 1 FROM items WHERE slug = $1', ['not-there']), []);
  });
  test('createDoc gives a name to exactly one of many who ask at once', async () => {
    const answers = await many(10, (i) => store.createDoc('accounts', 'wanted-name', { username: 'wanted-name', n: i }));
    assert.equal(answers.filter(Boolean).length, 1);
    const winner = answers.indexOf(true);
    assert.equal((await store.getDoc('accounts', 'wanted-name')).n, winner, 'and the first one is not overwritten');
    assert.equal(await store.createDoc('sites', 'wanted-name', { name: 'wanted-name' }), true, 'the same id in another collection is free');
  });
  test('documents: set, get, list, delete', async () => {
    assert.equal(await store.getDoc('things', 'a'), null);
    assert.deepEqual(await store.listDocs('things'), []);
    await store.setDoc('things', 'b', { name: 'b', n: 1, gone: undefined, list: [{ path: 'x', size: 2 }] });
    await store.setDoc('things', 'a', { name: 'a' });
    await store.setDoc('things', 'b', { name: 'b', n: 2 }); // replaces
    assert.deepEqual(await store.getDoc('things', 'b'), { name: 'b', n: 2 });
    assert.deepEqual(await store.listDocs('things'), [{ name: 'a' }, { name: 'b', n: 2 }]);
    const doc = await store.getDoc('things', 'a');
    doc.changed = true; // what callers do with a document is theirs until they set it
    assert.deepEqual(await store.getDoc('things', 'a'), { name: 'a' });
    await store.deleteDoc('things', 'a');
    await store.deleteDoc('things', 'a');
    assert.equal(await store.getDoc('things', 'a'), null);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      assert.equal(await store.getDoc(name, 'x'), null);
      assert.equal(await store.getDoc('things', name), null);
      assert.deepEqual(await store.listDocs(name), []);
    }
  });
  test('takeQuota hands out exactly the limit, also to many callers at once', async () => {
    const taken = await many(25, () => store.takeQuota('burst', 7));
    assert.equal(taken.filter(Boolean).length, 7);
    assert.equal(await store.takeQuota('burst', 7), false);
    assert.equal(await store.takeQuota('burst', 8), true, 'a higher limit lets one more through');
    assert.equal(await store.takeQuota('other', 1), true, 'counted per name');
    assert.equal(await store.takeQuota('other', 1), false);
    assert.equal(await store.takeQuota('nothing-allowed', 0), false);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await rows(`SELECT day::text AS day, name, used FROM quotas WHERE name IN ('burst', 'other', 'nothing-allowed') ORDER BY name`), [{ day: today, name: 'burst', used: 8 }, { day: today, name: 'other', used: 1 }]);
    await db.query(`UPDATE quotas SET day = day - 1 WHERE name = 'other'`);
    assert.equal(await store.takeQuota('other', 1), true, 'a new day starts from nothing');
  });
});

describe('files', () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const list = async (owner, prefix) => (await store.listFiles(owner, prefix)).map((f) => f.path);
  test('every stored file has a row: size, type, checksum, time', async () => {
    const started = Date.now() - 5000;
    await store.putFile('with-files', 'docs/guide.pdf', Buffer.from('%PDF-1.7 pretend'), 'application/pdf');
    await store.putFile('with-files', 'note.txt', Buffer.from('héllo'));
    const [pdf, note] = await store.listFiles('with-files');
    assert.deepEqual({ ...pdf, updated: null }, { path: 'docs/guide.pdf', size: 16, content_type: 'application/pdf', sha256: sha('%PDF-1.7 pretend'), updated: null });
    assert.deepEqual({ ...note, updated: null }, { path: 'note.txt', size: 6, content_type: null, sha256: sha('héllo'), updated: null });
    assert.ok(+pdf.updated >= started && +pdf.updated <= Date.now() + 5000);
    assert.equal((await store.readFile('with-files', 'note.txt')).toString(), 'héllo');
    const stream = await store.fileStream('with-files', 'docs/guide.pdf');
    let text = '';
    for await (const chunk of stream) text += chunk;
    assert.equal(text, '%PDF-1.7 pretend');
    // replaced: one row, new values
    await store.putFile('with-files', 'note.txt', Buffer.from('changed'), 'text/plain; charset=utf-8');
    const again = await store.listFiles('with-files');
    assert.equal(again.length, 2);
    assert.deepEqual({ ...again[1], updated: null }, { path: 'note.txt', size: 7, content_type: 'text/plain; charset=utf-8', sha256: sha('changed'), updated: null });
  });
  test('a file that could not be written leaves no row', async () => {
    await assert.rejects(store.putFile('with-files', '../../escape.txt', Buffer.from('x')), /outside the store/);
    await assert.rejects(store.putFile('..', 'escape.txt', Buffer.from('x')), /outside the store/);
    assert.deepEqual(await rows(`SELECT 1 FROM files WHERE path LIKE '%escape%'`), []);
    assert.equal(await store.readFile('with-files', '../../../etc/hosts'), null);
    assert.equal(await store.fileStream('with-files', 'docs'), null, 'a folder is not a file');
    assert.equal(await store.fileStream('with-files', 'missing.txt'), null);
  });
  test('deleteFiles removes one file or one folder, and only that', async () => {
    const paths = ['one/index.html', 'one/assets/app.js', 'one/assets/100%_real.css', 'one-two/index.html', 'one0/index.html', 'one.html', 'on/e.html', 'two/index.html'];
    for (const p of paths) await store.putFile('_sites', p, Buffer.from(p), 'text/html');
    await store.deleteFiles('_sites', 'one/assets/app.js');
    assert.deepEqual(await list('_sites', 'one/'), ['one/assets/100%_real.css', 'one/index.html']);
    await store.deleteFiles('_sites', 'one/');
    assert.deepEqual(await list('_sites'), ['on/e.html', 'one-two/index.html', 'one.html', 'one0/index.html', 'two/index.html']);
    assert.equal(await store.readFile('_sites', 'one/index.html'), null);
    for (const p of await list('_sites')) assert.equal((await store.readFile('_sites', p)).toString(), p);
    await store.deleteFiles('_sites', 'never-there/');
    await store.deleteFiles('_sites', 'never-there.txt');
    await assert.rejects(store.deleteFiles('_sites', ''), /prefix/);
    assert.equal((await list('_sites')).length, 5);
    // files of one owner are not touched by a delete for another
    await store.putFile('_accounts', 'two/brand.json', Buffer.from('{}'), 'application/json');
    await store.deleteFiles('_sites', 'two/');
    assert.deepEqual(await list('_accounts'), ['two/brand.json']);
  });
  test('copyFiles copies the bytes and the rows', async () => {
    await store.putFile('original', 'logo.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    await store.putFile('original', 'img/photo.jpg', Buffer.from('jpeg bytes'), 'image/jpeg');
    await store.putFile('original', 'template.html', Buffer.from('<html>'), 'text/html');
    await store.putFile('copy', 'logo.svg', Buffer.from('an older logo'), 'image/svg+xml'); // is replaced
    await store.copyFiles('original', 'copy', ['logo.svg', 'img/photo.jpg']);
    await store.copyFiles('original', 'copy', []);
    const strip = (l) => l.map(({ updated, ...f }) => f);
    assert.deepEqual(strip(await store.listFiles('copy')), [
      { path: 'img/photo.jpg', size: 10, content_type: 'image/jpeg', sha256: sha('jpeg bytes') },
      { path: 'logo.svg', size: 6, content_type: 'image/svg+xml', sha256: sha('<svg/>') },
    ]);
    assert.equal((await store.readFile('copy', 'img/photo.jpg')).toString(), 'jpeg bytes');
    assert.equal((await store.listFiles('original')).length, 3);
  });
  test('copying a file that has no row yet (stored before the table existed) still gives the copy a row', async () => {
    await files.putFile('legacy', 'old.pdf', Buffer.from('from before')); // straight to the folder, no row
    await store.copyFiles('legacy', 'legacy-copy', ['old.pdf']);
    const [row] = await store.listFiles('legacy-copy');
    assert.deepEqual({ ...row, updated: null }, { path: 'old.pdf', size: 11, content_type: null, sha256: null, updated: null });
  });
});

describe('bulk loading', () => {
  const data = () => ({
    items: [itemRow('bulk-a', { slug: 'bulk-a', status: 'published', kind: 'text', up: 1, down: 0, created_at: '2026-05-01T00:00:00.000Z' }), itemRow('bulk-b', { slug: 'bulk-b', status: 'draft', emb: [0.1, -0.25, 1e-9] })],
    votes: [{ slug: 'bulk-a', client_id: 'client-bulk0001', dir: 1, at: '2026-05-02T10:00:00.000Z' }, { slug: 'bulk-a', client_id: 'acct-anna', dir: -1, at: null }, { slug: 'bulk-missing', client_id: 'client-bulk0001', dir: 1, at: null }],
    docs: [{ coll: 'bulk', id: 'one', data: { n: 1 } }, { coll: 'bulk', id: 'two', data: { n: 2, list: ['a'] } }],
    quotas: [{ day: '2026-11-01', name: 'bulk-convert', used: 12 }],
    files: [{ owner: 'bulk-a', path: 'a.pdf', size: 5000000000, content_type: 'application/pdf', sha256: null, updated: '2026-05-01T00:00:00.000Z' }],
  });
  test('rows are written once however often they are loaded; votes without a material are left out', async () => {
    assert.deepEqual(await store.importRows(data()), { items: 2, votes: 2, docs: 2, quotas: 1, files: 1 });
    await db.query(`UPDATE files SET sha256 = 'abc' WHERE owner = 'bulk-a'`);
    const changed = data();
    changed.items[0] = itemRow('bulk-a', { ...changed.items[0].data, up: 9 });
    changed.docs[0].data.n = 100;
    changed.quotas[0].used = 13;
    assert.deepEqual(await store.importRows(changed, { batch: 1, itemBatch: 1 }), { items: 2, votes: 2, docs: 2, quotas: 1, files: 1 });
    assert.deepEqual(await rows(`SELECT slug, data, kind, status, created FROM items WHERE slug LIKE 'bulk-%' ORDER BY slug`), [
      { slug: 'bulk-a', data: { slug: 'bulk-a', status: 'published', kind: 'text', up: 9, down: 0, created_at: '2026-05-01T00:00:00.000Z' }, kind: 'text', status: 'published', created: new Date('2026-05-01T00:00:00.000Z') },
      { slug: 'bulk-b', data: { slug: 'bulk-b', status: 'draft', emb: [0.1, -0.25, 1e-9] }, kind: null, status: 'draft', created: null },
    ]);
    assert.deepEqual(await rows(`SELECT client_id, dir FROM votes WHERE slug LIKE 'bulk-%' ORDER BY client_id`), [{ client_id: 'acct-anna', dir: -1 }, { client_id: 'client-bulk0001', dir: 1 }]);
    assert.deepEqual(await store.listDocs('bulk'), [{ n: 100 }, { n: 2, list: ['a'] }]);
    assert.deepEqual(await rows(`SELECT day::text AS day, used FROM quotas WHERE name = 'bulk-convert'`), [{ day: '2026-11-01', used: 13 }]);
    const [file] = await store.listFiles('bulk-a');
    assert.deepEqual([file.size, file.sha256, file.updated.toISOString()], [5000000000, 'abc', '2026-05-01T00:00:00.000Z'], 'an unchanged file keeps its checksum; sizes above 2 GB fit');
    assert.equal((await store.getItem('bulk-a')).up, 9, 'the store reads the loaded rows');
  });
  test('pruneRows removes what is not in the given rows', async () => {
    const all = async () => ({
      items: (await rows('SELECT slug FROM items ORDER BY slug')).map((r) => r.slug),
      votes: (await rows('SELECT count(*)::int AS n FROM votes'))[0].n,
      docs: (await rows('SELECT count(*)::int AS n FROM docs'))[0].n,
      quotas: (await rows('SELECT count(*)::int AS n FROM quotas'))[0].n,
      files: (await rows('SELECT count(*)::int AS n FROM files'))[0].n,
    });
    const before = await all();
    assert.ok(before.items.length > 5 && before.docs > 2 && before.files > 5);
    const keep = data();
    keep.items.pop(); // bulk-b was deleted at the source
    const removed = await store.pruneRows(keep);
    assert.equal(removed.items, before.items.length - 1);
    assert.deepEqual(await all(), { items: ['bulk-a'], votes: 2, docs: 2, quotas: 1, files: 1 });
    assert.deepEqual((await store.allItems()).map((i) => i.slug), ['bulk-a']);
  });
});

describe('connections', () => {
  // A pool that records what it is asked, in place of pg.Pool.
  const fakePool = (fail = {}) => {
    const log = [];
    const client = {
      query: async (text) => {
        log.push(text);
        if (fail[text]) throw new Error(`${text} failed`);
        return { rows: [{ ok: 1 }] };
      },
      release: (destroy) => log.push(`release(${destroy ? 'destroy' : 'reuse'})`),
    };
    return { log, on: (event) => log.push(`on(${event})`), connect: async () => client, query: async (text) => (log.push(`pool:${text}`), { rows: [] }), end: async () => log.push('end') };
  };
  test('a transaction commits, and gives its connection back', async () => {
    const pool = fakePool();
    const closed = [];
    const d = poolDb(pool, () => closed.push('connector'));
    assert.equal(await d.transaction(async (tx) => (await tx.query('SELECT 1')).rows[0].ok), 1);
    await d.query('SELECT 2');
    await d.end();
    assert.deepEqual(pool.log, ['on(error)', 'BEGIN', 'SELECT 1', 'COMMIT', 'release(reuse)', 'pool:SELECT 2', 'end']);
    assert.deepEqual(closed, ['connector']);
  });
  test('a read on a dead connection is tried once more; a write, or an answer from the database, is not', async () => {
    const attempts = [];
    const dead = () => new Error('Connection terminated unexpectedly');
    const refused = () => Object.assign(new Error('relation "nope" does not exist'), { severity: 'ERROR', code: '42P01' });
    const pool = (failures) => ({
      on() {},
      query: async (text) => {
        attempts.push(text);
        const failure = failures.shift();
        if (failure) throw failure;
        return { rows: [{ ok: 1 }] };
      },
    });
    assert.deepEqual((await poolDb(pool([dead()])).query('SELECT data FROM docs')).rows, [{ ok: 1 }]);
    await assert.rejects(poolDb(pool([dead(), dead()])).query('  select 1'), /terminated/);
    await assert.rejects(poolDb(pool([dead()])).query('UPDATE items SET data = data'), /terminated/);
    await assert.rejects(poolDb(pool([dead()])).query('INSERT INTO quotas SELECT 1'), /terminated/);
    await assert.rejects(poolDb(pool([refused()])).query('SELECT * FROM nope'), { code: '42P01' });
    assert.deepEqual(attempts, ['SELECT data FROM docs', 'SELECT data FROM docs', '  select 1', '  select 1', 'UPDATE items SET data = data', 'INSERT INTO quotas SELECT 1', 'SELECT * FROM nope']);
  });
  test('a transaction that fails is rolled back and the error passed on', async () => {
    const pool = fakePool();
    await assert.rejects(poolDb(pool).transaction(async (tx) => {
      await tx.query('SELECT 1');
      throw Object.assign(new Error('nope'), { status: 404 });
    }), { message: 'nope', status: 404 });
    assert.deepEqual(pool.log, ['on(error)', 'BEGIN', 'SELECT 1', 'ROLLBACK', 'release(reuse)']);
  });
  test('a connection that cannot roll back is not used again', async () => {
    const pool = fakePool({ 'SELECT 1': true, ROLLBACK: true });
    await assert.rejects(poolDb(pool).transaction((tx) => tx.query('SELECT 1')), /SELECT 1 failed/);
    assert.deepEqual(pool.log, ['on(error)', 'BEGIN', 'SELECT 1', 'ROLLBACK', 'release(destroy)']);
  });
  test('PGSSLMODE', () => {
    assert.equal(sslFrom({}), undefined);
    assert.equal(sslFrom({ PGSSLMODE: 'disable' }), false);
    assert.equal(sslFrom({ PGSSLMODE: 'require', PGHOST: '/cloudsql/proj:us-central1:commons' }), false, 'a socket is not wrapped in TLS');
    assert.deepEqual(sslFrom({ PGSSLMODE: 'require' }), { rejectUnauthorized: false }, 'encrypted, certificate not checked');
    const ca = path.join(dir, 'server-ca.pem');
    fs.writeFileSync(ca, 'PEM');
    const full = sslFrom({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca });
    assert.deepEqual(full, { rejectUnauthorized: true, ca: 'PEM' });
    const chain = sslFrom({ PGSSLMODE: 'verify-ca', PGSSLROOTCERT: ca });
    assert.equal(chain.rejectUnauthorized, true);
    assert.equal(chain.checkServerIdentity('10.1.2.3', {}), undefined, 'the name is not compared');
  });
  test('the environment decides where the database is', async () => {
    assert.equal(pgConfigured({}), false);
    for (const env of [{ DATABASE_URL: 'x' }, { CLOUDSQL_INSTANCE: 'p:r:i' }, { PGHOST: '10.0.0.3' }, { PG_TEST: 'pglite' }]) assert.equal(pgConfigured(env), true);
    // Pools connect on first use, so these open nothing.
    const url = await connect({ DATABASE_URL: 'postgres://app:secret@127.0.0.1:1/commons', PGSSLMODE: 'require', PG_SCHEMA: 'commons' });
    assert.deepEqual([url.pool.options.max, url.pool.options.connectionString, url.pool.options.ssl, url.pool.options.options], [5, 'postgres://app:secret@127.0.0.1:1/commons', { rejectUnauthorized: false }, '-c search_path=commons']);
    await url.end();
    const host = await connect({ PGHOST: '10.0.0.3', PGSSLMODE: 'require', PG_POOL_MAX: '3' });
    assert.deepEqual([host.pool.options.max, host.pool.options.ssl], [3, { rejectUnauthorized: false }]);
    await host.end();
    await assert.rejects(connect({ CLOUDSQL_INSTANCE: 'p:r:i', CLOUDSQL_IP_TYPE: 'internal' }), /CLOUDSQL_IP_TYPE/);
  });
  test('through the Cloud SQL connector: the private address unless told otherwise, and the connector is closed with the pool', async () => {
    const calls = [];
    class Connector {
      async getOptions(o) {
        calls.push(o);
        return { stream: 'a function that opens the TLS socket', ssl: false };
      }
      close() {
        calls.push('connector closed');
      }
    }
    class Pool {
      constructor(options) {
        this.options = options;
      }
      on() {}
      async end() {
        calls.push('pool ended');
      }
    }
    const env = { CLOUDSQL_INSTANCE: 'proj:us-central1:commons', PGUSER: 'commons', PGPASSWORD: 'secret', PGDATABASE: 'commons', DATABASE_URL: '' };
    const d = await connect(env, { Connector, Pool });
    assert.deepEqual(calls, [{ instanceConnectionName: 'proj:us-central1:commons', ipType: 'PRIVATE' }]);
    assert.deepEqual(d.pool.options, { max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, keepAlive: true, application_name: 'groups-commons', stream: 'a function that opens the TLS socket', ssl: false, user: 'commons', password: 'secret', database: 'commons' });
    await d.end();
    assert.deepEqual(calls.slice(1), ['pool ended', 'connector closed']);
    for (const ipType of ['PUBLIC', 'psc']) {
      calls.length = 0;
      await connect({ ...env, CLOUDSQL_IP_TYPE: ipType }, { Connector, Pool });
      assert.equal(calls[0].ipType, ipType.toUpperCase());
    }
    // DATABASE_URL wins over the instance name
    assert.equal((await connect({ ...env, DATABASE_URL: 'postgres://x/y' }, { Connector, Pool })).pool.options.connectionString, 'postgres://x/y');
    await assert.rejects(connect({ DATABASE_URL: 'x', PG_SCHEMA: 'Bad Name' }), /PG_SCHEMA/);
  });
});
