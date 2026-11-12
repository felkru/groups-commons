// tools/migrate-to-postgres.mjs: the Firestore -> rows transformation with made-up snapshots, the comparison,
// and a whole run (copy, run again, prune, the guard, verification) into the PostgreSQL store on PGlite.
// The real Firestore and the real bucket are not involved.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FolderFiles } from '../server/files.js';
import { PgStore, connect } from '../server/store-pg.js';
import { canonical, compare, fileListGaps, fileRows, migrate, normal, plain, rowsFromFirestore, verify } from '../tools/migrate-to-postgres.mjs';
import { PG_TEST, dropTestStore, useTestStore } from './helper.js';

// What Firestore hands out: a snapshot has an id and data().
const snap = (id, data) => ({ id, data: () => ({ ...data }) });
const timestamp = (iso) => ({ toDate: () => new Date(iso), seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 });
const emb = Array.from({ length: 64 }, (_, i) => Math.cos(i) / 7);
const firestore = () => ({
  items: [
    snap('table-sign', { slug: 'table-sign', title: 'Table sign', kind: 'template', status: 'published', created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', up: 4, down: 1, uses: 20, featured_at: null, file_list: [{ path: 'template.html', size: 1200 }, { path: 'logo-square.svg', size: 300 }], emb, tags: ['print'] }),
    snap('welcome-mail', { slug: 'welcome-mail', title: 'Welcome mail', kind: 'text', status: 'pending', created_at: '2026-11-10T08:00:00.000Z', updated_at: '2026-11-10T08:00:00.000Z', up: 0, down: 0, uses: 0, owner: 'acct-anna', variants: [{ label: 'English', body: 'Hi [Name]' }], file_list: [] }),
    snap('old-draft', { slug: 'old-draft', title: 'Draft', kind: 'file', status: 'draft', file_list: [{ path: 'missing.pdf', size: 10 }, { path: 'a.pdf', size: 99 }] }),
  ],
  votes: [
    snap('table-sign__client-00000001', { slug: 'table-sign', client: 'client-00000001', dir: 1, at: '2026-11-02T09:00:00.000Z' }),
    snap('table-sign__acct-anna', { slug: 'table-sign', client: 'acct-anna', dir: -1, at: '2026-11-03T09:00:00.000Z' }),
    snap('welcome-mail__client-00000001', { dir: 1 }), // older shape: only the id says whose it is
    snap('deleted-material__client-00000002', { slug: 'deleted-material', client: 'client-00000002', dir: 1, at: '2026-09-01T00:00:00.000Z' }),
    snap('table-sign__client-00000003', { slug: 'table-sign', client: 'client-00000003', dir: 0 }),
  ],
  accounts: [snap('anna', { username: 'anna', group: 'AI Safety Aachen', role: 'moderator', password: 'salt:hash', created_at: '2026-10-05T12:00:00.000Z', valid_from: 1762000000000 })],
  sites: [snap('aachen', { name: 'aachen', title: 'Aachen', owner: 'acct-anna', status: 'published', multi: true, files: [{ path: 'index.html', size: 500 }], updated_at: '2026-11-05T12:00:00.000Z' })],
  meta: [snap('quota-20261111', { convert: 12, 'embed-query': 340 }), snap('quota-20261112', { convert: 3, broken: 'x' }), snap('health', { ok: true })],
});
const bucket = () => [
  { name: 'items/table-sign/template.html', size: '1200', contentType: 'text/html; charset=utf-8', updated: '2026-10-01T10:00:01.000Z' },
  { name: 'items/table-sign/logo-square.svg', size: '300', contentType: 'image/svg+xml', updated: '2026-10-01T10:00:02.000Z' },
  { name: 'items/old-draft/a.pdf', size: '100', contentType: 'application/pdf', updated: '2026-11-09T10:00:00.000Z' },
  { name: 'items/_sites/aachen/index.html', size: '500', contentType: 'text/html; charset=utf-8', updated: '2026-11-05T12:00:00.000Z' },
  { name: 'items/_sites/aachen/assets/app.js', size: '900', contentType: 'text/javascript; charset=utf-8', updated: '2026-11-05T12:00:00.000Z' },
  { name: 'items/_accounts/anna/brand.json', size: '2048', contentType: 'application/json', updated: '2026-10-06T12:00:00.000Z' },
  { name: 'items/table-sign/', size: '0', contentType: null, updated: '2026-10-01T10:00:00.000Z' }, // a folder marker made in the console
  { name: 'items/stray.txt', size: '5', contentType: 'text/plain', updated: '2026-10-01T10:00:00.000Z' },
];

describe('Firestore documents to rows', () => {
  test('values JSON does not know are converted, and every conversion is noted', () => {
    const notes = [];
    class GeoPoint {
      constructor() {
        this.latitude = 50.77;
        this.longitude = 6.08;
      }
    }
    const out = plain({ s: 'text', n: 1.5, big: 12n, no: null, gone: undefined, t: timestamp('2026-11-12T10:00:00.000Z'), bytes: Buffer.from('hi'), ref: { path: 'items/x', firestore: {} }, vec: { toArray: () => [0.5, 1] }, where: new GeoPoint(), nan: NaN, nested: [{ t: timestamp('2026-01-01T00:00:00.000Z') }], latlng: { latitude: 1, longitude: 2 } }, (n) => notes.push(n.split(' (')[0]));
    assert.deepEqual(out, { s: 'text', n: 1.5, big: 12, no: null, gone: undefined, t: '2026-11-12T10:00:00.000Z', bytes: 'aGk=', ref: 'items/x', vec: [0.5, 1], where: { latitude: 50.77, longitude: 6.08 }, nan: null, nested: [{ t: '2026-01-01T00:00:00.000Z' }], latlng: { latitude: 1, longitude: 2 } });
    assert.deepEqual(notes, ['a timestamp', 'bytes', 'a document reference', 'a vector', 'a geo point', 'a number that is not finite', 'a timestamp']);
    assert.deepEqual(normal({ a: undefined, b: -0, c: 'nul\u0000', d: 1e21 }), { b: 0, c: 'nul', d: 1e21 });
  });
  test('items, votes, quotas and every other collection', () => {
    const { rows, skipped, converted, source } = rowsFromFirestore(firestore());
    assert.deepEqual(source, { accounts: 1, items: 3, meta: 3, sites: 1, votes: 5 });
    assert.deepEqual(rows.items.map(({ data, ...columns }) => columns), [
      { slug: 'table-sign', kind: 'template', status: 'published', created: '2026-10-01T10:00:00.000Z', updated: '2026-11-01T10:00:00.000Z' },
      { slug: 'welcome-mail', kind: 'text', status: 'pending', created: '2026-11-10T08:00:00.000Z', updated: '2026-11-10T08:00:00.000Z' },
      { slug: 'old-draft', kind: 'file', status: 'draft', created: null, updated: null },
    ]);
    assert.deepEqual(rows.items[0].data, firestore().items[0].data(), 'all fields, the embedding and null values included');
    assert.deepEqual(rows.votes, [
      { slug: 'table-sign', client_id: 'client-00000001', dir: 1, at: '2026-11-02T09:00:00.000Z' },
      { slug: 'table-sign', client_id: 'acct-anna', dir: -1, at: '2026-11-03T09:00:00.000Z' },
      { slug: 'welcome-mail', client_id: 'client-00000001', dir: 1, at: null },
    ]);
    assert.deepEqual(skipped, [
      { what: 'vote', id: 'votes/deleted-material__client-00000002', reason: 'its material does not exist (any more)' },
      { what: 'vote', id: 'votes/table-sign__client-00000003', reason: 'not a vote (needs slug, client and dir 1 or -1)' },
      { what: 'quota', id: 'meta/quota-20261112.broken', reason: 'not a count' },
    ]);
    assert.deepEqual(rows.quotas, [{ day: '2026-11-11', name: 'convert', used: 12 }, { day: '2026-11-11', name: 'embed-query', used: 340 }, { day: '2026-11-12', name: 'convert', used: 3 }]);
    assert.deepEqual(rows.docs.map((d) => `${d.coll}/${d.id}`), ['accounts/anna', 'meta/health', 'sites/aachen']);
    assert.deepEqual(rows.docs[0].data, firestore().accounts[0].data());
    assert.deepEqual(converted, []);
  });
  test('a material is kept under its document id, and timestamps in it become text', () => {
    const { rows, skipped, converted } = rowsFromFirestore({ items: [snap('the-id', { slug: 'another-name', status: 'draft', created_at: timestamp('2026-03-01T00:00:00.000Z') })] });
    assert.deepEqual(rows.items, [{ slug: 'the-id', data: { slug: 'another-name', status: 'draft', created_at: '2026-03-01T00:00:00.000Z' }, kind: null, status: 'draft', created: '2026-03-01T00:00:00.000Z', updated: null }]);
    assert.equal(skipped[0].what, 'note');
    assert.deepEqual(converted, [{ id: 'items/the-id', what: 'a timestamp (stored as an ISO date string)' }]);
    assert.deepEqual(rowsFromFirestore({}).rows, { items: [], votes: [], docs: [], quotas: [] });
  });
  test('the bucket listing becomes one row per file', () => {
    const { files, skipped } = fileRows(bucket());
    assert.deepEqual(files.map((f) => `${f.owner} | ${f.path} | ${f.size}`), ['table-sign | template.html | 1200', 'table-sign | logo-square.svg | 300', 'old-draft | a.pdf | 100', '_sites | aachen/index.html | 500', '_sites | aachen/assets/app.js | 900', '_accounts | anna/brand.json | 2048']);
    assert.deepEqual(files[0], { owner: 'table-sign', path: 'template.html', size: 1200, content_type: 'text/html; charset=utf-8', sha256: null, updated: '2026-10-01T10:00:01.000Z' });
    assert.deepEqual(skipped.map((s) => s.id), ['items/table-sign/', 'items/stray.txt']);
    assert.deepEqual(fileRows([{ name: 'other/x/y.txt', size: 1 }]).skipped[0].reason, 'not below items/');
  });
  test('file lists that do not match the bucket are found', () => {
    const { rows } = rowsFromFirestore(firestore());
    assert.deepEqual(fileListGaps(rows.items, fileRows(bucket()).files), [
      { id: 'old-draft/missing.pdf', reason: 'listed by the material, not in the bucket' },
      { id: 'old-draft/a.pdf', reason: 'the material says 99 bytes, the bucket has 100' },
    ]);
  });
});

describe('comparing', () => {
  test('canonical text does not depend on the order of keys', () => {
    assert.equal(canonical({ b: [1, { d: null, c: 'x' }], a: 0.1, gone: undefined }), '{"a":0.1,"b":[1,{"c":"x","d":null}]}');
    assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
    assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
    assert.notEqual(canonical({ a: null }), canonical({}));
  });
  test('missing, extra and different records are told apart', () => {
    assert.deepEqual(compare(new Map([['a', '1'], ['b', '2'], ['c', '3']]), new Map([['a', '1'], ['b', 'x'], ['d', '4']])), { missing: ['c'], extra: ['d'], different: ['b'] });
  });
  test('verification passes only when every record is identical', () => {
    const plan = rowsFromFirestore(firestore());
    plan.rows.files = fileRows(bucket()).files;
    const found = () => structuredClone({ items: plan.rows.items.map(({ slug, data }) => ({ slug, data })), votes: plan.rows.votes, docs: plan.rows.docs, quotas: plan.rows.quotas, files: plan.rows.files });
    const good = verify(plan, found());
    assert.equal(good.ok, true);
    assert.match(good.lines.at(-1), /^verify RESULT OK/);
    assert.match(good.lines.join('\n'), /verify items +3 +3 +0 +0 +0 {2}OK/);
    assert.match(good.lines.join('\n'), /verify votes +5 +3 +0 +0 +0 {2}OK {2}\(2 left out on purpose/);
    assert.match(good.lines.join('\n'), /every item record compared field by field: 3 of 3 identical/);
    assert.ok(good.lines.every((l) => l.startsWith('verify ') && !l.includes('\n')), 'plain lines');

    const cases = {
      'one number of an embedding differs': (f) => (f.items[0].data.emb[40] += 1e-12),
      'a field is missing': (f) => delete f.items[1].data.owner,
      'null became absent': (f) => delete f.items[0].data.featured_at,
      'a material is missing': (f) => f.items.pop(),
      'a material too many': (f) => f.items.push({ slug: 'ghost', data: { slug: 'ghost' } }),
      'a vote points the other way': (f) => (f.votes[0].dir = -1),
      'an account differs': (f) => (f.docs[0].data.role = 'member'),
      'a collection is missing': (f) => (f.docs = f.docs.filter((d) => d.coll !== 'sites')),
      'a collection too many': (f) => f.docs.push({ coll: 'surprise', id: 'x', data: {} }),
      'a quota differs': (f) => (f.quotas[0].used = 13),
      'a file has another size': (f) => (f.files[0].size = 1),
      'a file row is missing': (f) => f.files.shift(),
    };
    for (const [name, damage] of Object.entries(cases)) {
      const f = found();
      damage(f);
      const bad = verify(plan, f);
      assert.equal(bad.ok, false, name);
      assert.match(bad.lines.at(-1), /^verify RESULT FAILED/, name);
      assert.ok(bad.lines.some((l) => / FAIL/.test(l)), name);
    }
  });
});

describe('a whole migration into the PostgreSQL store', () => {
  let dir, store, db;
  const log = [];
  const run = (source, options = {}) => {
    log.length = 0;
    return migrate({ source, store, log: (line) => log.push(line), ...options });
  };
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM votes) AS votes, (SELECT count(*)::int FROM docs WHERE coll <> '_migration') AS docs, (SELECT count(*)::int FROM quotas) AS quotas, (SELECT count(*)::int FROM files) AS files`)).rows[0];
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-migrate-'));
    useTestStore(dir);
    if (!PG_TEST) process.env.PG_TEST = 'pglite';
    db = await connect();
    store = new PgStore(db, new FolderFiles(path.join(dir, 'files')), { schema: process.env.PG_SCHEMA || '' });
  });
  after(async () => {
    await dropTestStore(store);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a dry run prints counts and writes nothing, not even the tables', async () => {
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { dryRun: true }), 0);
    assert.ok(log.includes('source firestore items: 3 documents'));
    assert.ok(log.includes('source bucket: 8 objects'));
    assert.ok(log.includes('plan items=3 votes=3 docs=3 quotas=3 files=6'));
    assert.ok(log.includes('plan docs/accounts: 1'));
    assert.ok(log.includes('skipped votes/deleted-material__client-00000002: its material does not exist (any more)'));
    assert.ok(log.includes('check file lists against the bucket: 2 differences (they exist today and are not caused by the migration)'));
    assert.ok(log.includes('postgres: reachable; the tables do not exist yet (the first real run creates them)'));
    assert.equal(log.at(-1), 'dry run: nothing was written');
    assert.equal((await db.query(`SELECT to_regclass('items') IS NOT NULL AS there`)).rows[0].there, false);
    assert.equal(await migrate({ source: { collections: firestore(), objects: bucket() }, store: null, dryRun: true, log: (l) => log.push(l) }), 0, 'also without a database');
    assert.ok(log.includes('postgres: not looked at (no database in the environment)'));
  });
  test('the first run copies everything and verifies it', async () => {
    assert.equal(await run({ collections: firestore(), objects: bucket() }), 0);
    assert.ok(log.includes('written items=3 votes=3 docs=3 quotas=3 files=6'));
    assert.match(log.at(-1), /^verify RESULT OK/);
    assert.deepEqual(await counts(), { items: 3, votes: 3, docs: 3, quotas: 3, files: 6 });
    // and the store works on what was copied
    const reader = await new PgStore(db, store.files, { schema: process.env.PG_SCHEMA || '' }).init();
    assert.deepEqual(await reader.getItem('table-sign'), firestore().items[0].data());
    assert.deepEqual(await reader.votesOf('client-00000001'), { 'table-sign': 1, 'welcome-mail': 1 });
    assert.equal((await reader.getDoc('accounts', 'anna')).role, 'moderator');
    assert.deepEqual((await reader.listFiles('_sites', 'aachen/')).map((f) => f.path), ['aachen/assets/app.js', 'aachen/index.html']);
    assert.equal(await reader.listDocs('_migration').then((d) => d.length), 1);
    // a dry run now reports what is there
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { dryRun: true }), 0);
    assert.ok(log.includes('postgres: reachable; holds items=3 votes=3 docs=3 quotas=3 files=6'));
  });
  test('running it again changes nothing; changes at the source since then are carried over', async () => {
    assert.equal(await run({ collections: firestore(), objects: bucket() }), 0);
    assert.deepEqual(await counts(), { items: 3, votes: 3, docs: 3, quotas: 3, files: 6 });
    const later = firestore();
    later.items[0] = snap('table-sign', { ...later.items[0].data(), up: 5, title: 'Table sign (new)' });
    later.items.push(snap('brand-new', { slug: 'brand-new', status: 'published', kind: 'link', up: 0, down: 0 }));
    later.votes.push(snap('brand-new__client-00000009', { slug: 'brand-new', client: 'client-00000009', dir: 1, at: '2026-11-12T11:00:00.000Z' }));
    later.votes[1] = snap('table-sign__acct-anna', { slug: 'table-sign', client: 'acct-anna', dir: 1, at: '2026-11-12T11:30:00.000Z' });
    later.meta[1] = snap('quota-20261112', { convert: 9 });
    assert.equal(await run({ collections: later, objects: [...bucket(), { name: 'items/brand-new/link.txt', size: '7', contentType: 'text/plain', updated: '2026-11-12T11:00:00.000Z' }] }), 0);
    assert.deepEqual(await counts(), { items: 4, votes: 4, docs: 3, quotas: 3, files: 7 });
    assert.deepEqual((await db.query(`SELECT data -> 'up' AS up, data ->> 'title' AS title FROM items WHERE slug = 'table-sign'`)).rows, [{ up: 5, title: 'Table sign (new)' }]);
    assert.deepEqual((await db.query(`SELECT dir FROM votes WHERE client_id = 'acct-anna'`)).rows, [{ dir: 1 }]);
    assert.deepEqual((await db.query(`SELECT used FROM quotas WHERE day = '2026-11-12'`)).rows, [{ used: 9 }]);
  });
  test('what was deleted at the source fails the verification until it is pruned', async () => {
    // back to the original three materials: "brand-new", its vote and its file are gone at the source
    assert.equal(await run({ collections: firestore(), objects: bucket() }), 1);
    assert.match(log.at(-1), /^verify RESULT FAILED/);
    assert.ok(log.some((l) => /^verify items +3 +4 +0 +1 +0 {2}FAIL/.test(l)), log.join('\n'));
    assert.ok(log.includes('verify   extra in postgres: items brand-new'));
    assert.ok(log.some((l) => l.includes('--prune')));
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { prune: true }), 0);
    assert.ok(log.includes('pruned items=1 votes=1 docs=0 quotas=0 files=1'), log.join('\n'));
    assert.deepEqual(await counts(), { items: 3, votes: 3, docs: 3, quotas: 3, files: 6 });
  });
  test('checksums are filled on request by reading the files', async () => {
    for (const f of fileRows(bucket()).files.slice(0, 5)) await store.files.putFile(f.owner, f.path, Buffer.from(`${f.owner}/${f.path}`));
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { sha256: true }), 0);
    assert.ok(log.includes('sha256: reading 6 of 6 files (the others have a checksum and did not change)'));
    assert.ok(log.some((l) => l.startsWith('sha256: could not read _accounts/anna/brand.json')));
    const hashed = (await db.query('SELECT count(sha256)::int AS n FROM files')).rows[0].n;
    assert.equal(hashed, 5);
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { sha256: true }), 0);
    assert.ok(log.includes('sha256: reading 1 of 6 files (the others have a checksum and did not change)'));
    assert.equal(await run({ collections: firestore(), objects: bucket() }), 0);
    assert.equal((await db.query('SELECT count(sha256)::int AS n FROM files')).rows[0].n, 5, 'a run without --sha256 keeps them');
  });
  test('once the site writes to Postgres, another run is refused', async () => {
    const live = await new PgStore(db, store.files, { schema: process.env.PG_SCHEMA || '' }).init();
    await live.patchItem('welcome-mail', { status: 'published', updated_at: new Date(Date.now() + 2000).toISOString() });
    await live.vote('table-sign', 'client-00000042', 1);
    const before = await counts();
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { prune: true }), 2);
    assert.ok(log.some((l) => /^refused: Postgres was changed after the last migration .*: 1 materials, 1 votes, 0 documents, 0 files\./.test(l)), log.join('\n'));
    assert.deepEqual(await counts(), before, 'nothing was written or removed');
    assert.equal((await live.getItem('welcome-mail')).status, 'published');
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { dryRun: true }), 0, 'a dry run is always allowed');
    assert.equal(await run({ collections: firestore(), objects: bucket() }, { force: true, prune: true }), 0, '--force copies anyway');
    assert.equal((await db.query(`SELECT status FROM items WHERE slug = 'welcome-mail'`)).rows[0].status, 'pending');
  });
});
