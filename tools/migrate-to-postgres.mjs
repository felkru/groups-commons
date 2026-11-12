#!/usr/bin/env node
// Copies everything the Firestore store holds into PostgreSQL (server/store-pg.js) and builds the `files` table
// from a listing of the bucket. No file bytes are copied: they stay in the bucket, where the new store reads them.
//
//   node tools/migrate-to-postgres.mjs --dry-run     read Firestore and the bucket, print counts, write nothing
//   node tools/migrate-to-postgres.mjs               copy, then verify
//   options:  --prune    also remove rows from Postgres that are no longer in Firestore or the bucket
//                        (materials deleted since an earlier run); without it they make the verification fail
//             --sha256   read every file once to fill the checksum column (otherwise it stays empty until a
//                        file is uploaded again)
//             --force    copy although Postgres was changed after the last run (see the guard in migrate())
//
// Environment: FIRESTORE_DB (default "commons"), BUCKET, and the database as for the server: CLOUDSQL_INSTANCE
// (+ CLOUDSQL_IP_TYPE, default PRIVATE) with PGUSER, PGPASSWORD, PGDATABASE, or DATABASE_URL, or PGHOST...
// Credentials for Firestore, the bucket and the connector are the ambient ones (the job's service account).
//
// It can be run again and again while the site still runs on Firestore: rows are overwritten, never doubled.
// Everything it prints is one plain line per fact, for reading in a job's log. The exit status is 0 when the
// verification found Postgres identical to the source, 1 when it did not (or the database could not be reached),
// 2 when it refused to start.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BucketFiles } from '../server/files.js';
import { PgStore, connect, itemRow, pgConfigured, toJson } from '../server/store-pg.js';

// ---- Firestore values -> what a jsonb column holds (pure) ----
// Firestore knows a few types JSON does not. The application writes none of them, but a document edited by hand
// in the console might have one. `note` is told about each conversion.
export function plain(value, note = () => {}) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    note('a number that is not finite (stored as null)');
    return null;
  }
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((v) => plain(v, note));
  if (typeof value !== 'object') return undefined;
  if (typeof value.toDate === 'function') {
    note('a timestamp (stored as an ISO date string)');
    return value.toDate().toISOString();
  }
  if (value instanceof Uint8Array) {
    note('bytes (stored as base64 text)');
    return Buffer.from(value).toString('base64');
  }
  if (typeof value.toArray === 'function') {
    note('a vector (stored as a list of numbers)');
    return plain(value.toArray(), note);
  }
  if (typeof value.path === 'string' && value.firestore !== undefined) {
    note('a document reference (stored as its path)');
    return value.path;
  }
  if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && Object.keys(value).length <= 2 && value.constructor !== Object) {
    note('a geo point (stored as latitude and longitude)');
    return { latitude: value.latitude, longitude: value.longitude };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plain(v, note);
  return out;
}
// A document's data exactly as Postgres will hand it back.
export const normal = (data, note) => JSON.parse(toJson(plain(data, note)));
const isoOrNull = (v) => {
  const t = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// collections: { name: [snapshot, ...] }, a snapshot being anything with `id` and `data()`.
// Returns rows for PgStore.importRows() plus what was left out and why:
//   items   one row per document of `items`
//   votes   one row per document of `votes` (id "<slug>__<client>", fields slug, client, dir, at)
//   quotas  the counters in the documents meta/quota-YYYYMMDD, one row per day and name
//   docs    every other document of every other collection (accounts, sites, meta/health, ...)
export function rowsFromFirestore(collections) {
  const rows = { items: [], votes: [], docs: [], quotas: [] };
  const skipped = []; // { what, id, reason }
  const converted = []; // { id, what }
  const source = {}; // documents per collection, as found
  const noteFor = (id) => (what) => converted.push({ id, what });
  for (const name of Object.keys(collections).sort()) source[name] = collections[name].length;

  for (const doc of collections.items || []) {
    const data = normal(doc.data(), noteFor(`items/${doc.id}`));
    if (data.slug !== doc.id) skipped.push({ what: 'note', id: `items/${doc.id}`, reason: `its slug field says ${JSON.stringify(data.slug)}; kept under the document id, as the Firestore store read it` });
    rows.items.push(itemRow(doc.id, data));
  }
  const slugs = new Set(rows.items.map((r) => r.slug));

  const votes = new Map();
  for (const doc of collections.votes || []) {
    const d = plain(doc.data()) || {};
    const cut = doc.id.lastIndexOf('__');
    const slug = typeof d.slug === 'string' ? d.slug : cut > 0 ? doc.id.slice(0, cut) : '';
    const client = typeof d.client === 'string' ? d.client : cut > 0 ? doc.id.slice(cut + 2) : '';
    const dir = Number(d.dir);
    if (!slug || !client || ![1, -1].includes(dir)) skipped.push({ what: 'vote', id: `votes/${doc.id}`, reason: 'not a vote (needs slug, client and dir 1 or -1)' });
    else if (!slugs.has(slug)) skipped.push({ what: 'vote', id: `votes/${doc.id}`, reason: 'its material does not exist (any more)' });
    else {
      const key = `${slug}\n${client}`;
      if (votes.has(key)) skipped.push({ what: 'vote', id: `votes/${doc.id}`, reason: 'a second vote of the same visitor on the same material; this one is kept' });
      votes.set(key, { slug, client_id: client, dir, at: isoOrNull(d.at) });
    }
  }
  rows.votes = [...votes.values()];

  for (const name of Object.keys(collections).sort()) {
    if (name === 'items' || name === 'votes') continue;
    for (const doc of collections[name]) {
      const quota = name === 'meta' && /^quota-(\d{4})(\d{2})(\d{2})$/.exec(doc.id);
      if (quota) {
        for (const [counter, used] of Object.entries(doc.data() || {})) {
          if (Number.isFinite(used) && used >= 0) rows.quotas.push({ day: `${quota[1]}-${quota[2]}-${quota[3]}`, name: counter, used: Math.round(used) });
          else skipped.push({ what: 'quota', id: `meta/${doc.id}.${counter}`, reason: 'not a count' });
        }
        continue;
      }
      rows.docs.push({ coll: name, id: doc.id, data: normal(doc.data(), noteFor(`${name}/${doc.id}`)) });
    }
  }
  return { rows, skipped, converted, source };
}

// objects: the bucket listing, [{ name, size, contentType, updated }]. Objects are named items/<owner>/<path>.
export function fileRows(objects, prefix = 'items/') {
  const files = [];
  const skipped = [];
  for (const o of objects) {
    const rest = o.name.startsWith(prefix) ? o.name.slice(prefix.length) : '';
    const cut = rest.indexOf('/');
    if (cut <= 0 || rest.endsWith('/') || cut === rest.length - 1) {
      skipped.push({ what: 'object', id: o.name, reason: rest ? 'a folder marker or a file outside any material' : `not below ${prefix}` });
      continue;
    }
    files.push({ owner: rest.slice(0, cut), path: rest.slice(cut + 1), size: Number(o.size), content_type: o.contentType || null, sha256: o.sha256 || null, updated: isoOrNull(o.updated) });
  }
  return { files, skipped };
}

// What the materials say they have (file_list) against what the bucket has. Differences were there before the
// migration and are not caused by it; they are reported so that they are known.
export function fileListGaps(items, files) {
  const have = new Map(files.map((f) => [`${f.owner}\n${f.path}`, f.size]));
  const gaps = [];
  for (const item of items) {
    for (const f of Array.isArray(item.data.file_list) ? item.data.file_list : []) {
      const size = have.get(`${item.slug}\n${f.path}`);
      if (size === undefined) gaps.push({ id: `${item.slug}/${f.path}`, reason: 'listed by the material, not in the bucket' });
      else if (size !== f.size) gaps.push({ id: `${item.slug}/${f.path}`, reason: `the material says ${f.size} bytes, the bucket has ${size}` });
    }
  }
  return gaps;
}

// ---- comparing (pure) ----
// JSON with the keys of every object in order: two records are equal exactly when these strings are.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
// expected, actual: Map of key -> canonical string. Returns the keys that are missing, extra or different.
export function compare(expected, actual) {
  const out = { missing: [], extra: [], different: [] };
  for (const [k, v] of expected) {
    if (!actual.has(k)) out.missing.push(k);
    else if (actual.get(k) !== v) out.different.push(k);
  }
  for (const k of actual.keys()) if (!expected.has(k)) out.extra.push(k);
  return out;
}
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
// `plan` is what rowsFromFirestore() and fileRows() returned; `found` what Postgres holds now, in the same shape.
// Returns { ok, lines }: one line per collection with the count at the source, the count in Postgres and how
// many records are missing, extra or different. Every record is compared in full, not only counted.
export function verify(plan, found) {
  const checks = [];
  const add = (label, sourceCount, expected, actual, note = '') => checks.push({ label, sourceCount, n: actual.size, ...compare(expected, actual), note });
  const map = (list, key, value) => new Map(list.map((r) => [key(r), canonical(value(r))]));
  const skippedVotes = plan.skipped.filter((s) => s.what === 'vote').length;
  add('items', plan.source.items ?? 0, map(plan.rows.items, (r) => r.slug, (r) => r.data), map(found.items, (r) => r.slug, (r) => r.data));
  add('votes', plan.source.votes ?? 0, map(plan.rows.votes, (r) => `${r.slug} ${r.client_id}`, (r) => r.dir), map(found.votes, (r) => `${r.slug} ${r.client_id}`, (r) => r.dir), skippedVotes ? `${skippedVotes} left out on purpose, listed above` : '');
  const colls = [...new Set([...plan.rows.docs.map((r) => r.coll), ...found.docs.map((r) => r.coll)])].sort();
  for (const coll of colls) {
    const want = plan.rows.docs.filter((r) => r.coll === coll);
    add(`docs/${coll}`, want.length, map(want, (r) => r.id, (r) => r.data), map(found.docs.filter((r) => r.coll === coll), (r) => r.id, (r) => r.data), coll === 'meta' ? 'without the quota documents' : '');
  }
  add('quotas', plan.rows.quotas.length, map(plan.rows.quotas, (r) => `${r.day} ${r.name}`, (r) => r.used), map(found.quotas, (r) => `${day(r.day)} ${r.name}`, (r) => Number(r.used)), 'counters in meta/quota-*');
  add('files', plan.rows.files.length, map(plan.rows.files, (r) => `${r.owner}/${r.path}`, (r) => r.size), map(found.files, (r) => `${r.owner}/${r.path}`, (r) => Number(r.size)), 'objects in the bucket; path and size compared');

  const lines = [`verify ${'collection'.padEnd(22)} ${'source'.padStart(8)} ${'postgres'.padStart(8)} ${'missing'.padStart(8)} ${'extra'.padStart(8)} ${'differ'.padStart(8)}  result`];
  let ok = true;
  for (const c of checks) {
    const good = !c.missing.length && !c.extra.length && !c.different.length;
    ok &&= good;
    lines.push(`verify ${c.label.padEnd(22)} ${String(c.sourceCount).padStart(8)} ${String(c.n).padStart(8)} ${String(c.missing.length).padStart(8)} ${String(c.extra.length).padStart(8)} ${String(c.different.length).padStart(8)}  ${good ? 'OK' : 'FAIL'}${c.note ? `  (${c.note})` : ''}`);
    for (const kind of ['missing', 'extra', 'different']) {
      for (const k of c[kind].slice(0, 20)) lines.push(`verify   ${kind} in postgres: ${c.label} ${k}`);
      if (c[kind].length > 20) lines.push(`verify   ... and ${c[kind].length - 20} more ${kind}`);
    }
  }
  const items = checks[0];
  lines.push(`verify every item record compared field by field: ${items.n - items.different.length - items.extra.length} of ${plan.rows.items.length} identical`);
  if (checks.some((c) => c.extra.length)) lines.push('verify "extra" rows are in Postgres but not at the source (deleted there since an earlier run): run again with --prune to remove them');
  lines.push(`verify RESULT ${ok ? 'OK: Postgres holds exactly what Firestore and the bucket hold' : 'FAILED'}`);
  return { ok, lines };
}

// ---- the migration itself ----
const MARKER = ['_migration', 'firestore']; // a document in `docs` that says when the last run finished
async function readPostgres(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    items: await q('SELECT slug, data FROM items'),
    votes: await q('SELECT slug, client_id, dir FROM votes'),
    docs: await q(`SELECT coll, id, data FROM docs WHERE coll <> '${MARKER[0]}'`),
    quotas: await q('SELECT day::text AS day, name, used FROM quotas'),
    files: await q('SELECT owner, path, size FROM files'),
  };
}
async function hashFiles(store, files, log) {
  const known = new Map((await store.db.query('SELECT owner, path, size, updated, sha256 FROM files WHERE sha256 IS NOT NULL')).rows.map((r) => [`${r.owner}\n${r.path}`, r]));
  const todo = files.filter((f) => {
    const k = known.get(`${f.owner}\n${f.path}`);
    return !(k && Number(k.size) === f.size && new Date(k.updated).toISOString() === f.updated);
  });
  log(`sha256: reading ${todo.length} of ${files.length} files (the others have a checksum and did not change)`);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      try {
        const hash = crypto.createHash('sha256');
        for await (const chunk of await store.files.fileStream(f.owner, f.path)) hash.update(chunk);
        f.sha256 = hash.digest('hex');
      } catch (e) {
        failed++;
        log(`sha256: could not read ${f.owner}/${f.path}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return failed;
}

// source: { collections, objects } (see rowsFromFirestore and fileRows). store: a PgStore, or null for a dry run
// without a database. Returns the exit status.
export async function migrate({ source, store, dryRun = false, prune = false, sha256 = false, force = false, log = console.log }) {
  const plan = rowsFromFirestore(source.collections);
  const listed = fileRows(source.objects);
  plan.rows.files = listed.files;
  plan.skipped.push(...listed.skipped);

  for (const [name, n] of Object.entries(plan.source)) log(`source firestore ${name}: ${n} documents`);
  log(`source bucket: ${source.objects.length} objects`);
  log(`plan items=${plan.rows.items.length} votes=${plan.rows.votes.length} docs=${plan.rows.docs.length} quotas=${plan.rows.quotas.length} files=${plan.rows.files.length}`);
  const perColl = {};
  for (const d of plan.rows.docs) perColl[d.coll] = (perColl[d.coll] || 0) + 1;
  for (const [coll, n] of Object.entries(perColl)) log(`plan docs/${coll}: ${n}`);
  for (const s of plan.skipped) log(`${s.what === 'note' ? 'note' : 'skipped'} ${s.id}: ${s.reason}`);
  for (const c of plan.converted) log(`converted ${c.id}: ${c.what}`);
  const gaps = fileListGaps(plan.rows.items, plan.rows.files);
  for (const g of gaps.slice(0, 50)) log(`warning ${g.id}: ${g.reason}`);
  log(`check file lists against the bucket: ${gaps.length} differences${gaps.length ? ' (they exist today and are not caused by the migration)' : ''}`);

  if (dryRun) {
    if (store) {
      const there = (await store.db.query(`SELECT to_regclass('items') IS NOT NULL AS there`)).rows[0].there;
      if (!there) log('postgres: reachable; the tables do not exist yet (the first real run creates them)');
      else {
        const found = await readPostgres(store.db);
        log(`postgres: reachable; holds items=${found.items.length} votes=${found.votes.length} docs=${found.docs.length} quotas=${found.quotas.length} files=${found.files.length}`);
      }
    } else log('postgres: not looked at (no database in the environment)');
    log('dry run: nothing was written');
    return 0;
  }

  await store.up();
  // The guard: once the site runs on Postgres, its records are newer than Firestore's, and copying again would
  // put the old ones back. The site stamps what it writes; anything stamped after the last run means "in use".
  const marker = await store.getDoc(...MARKER);
  if (marker && !force) {
    const [n] = (
      await store.db.query(
        `SELECT (SELECT count(*)::int FROM items WHERE updated > $1) AS items, (SELECT count(*)::int FROM votes WHERE at > $1) AS votes,
                (SELECT count(*)::int FROM docs WHERE updated > $1 AND coll <> '${MARKER[0]}') AS docs, (SELECT count(*)::int FROM files WHERE updated > $1) AS files`,
        [marker.finished_at],
      )
    ).rows;
    if (n.items + n.votes + n.docs + n.files > 0) {
      log(`refused: Postgres was changed after the last migration (${marker.finished_at}): ${n.items} materials, ${n.votes} votes, ${n.docs} documents, ${n.files} files.`);
      log('refused: the site seems to run on Postgres already. Copying again would overwrite those changes with older data. Nothing was written. (--force copies anyway.)');
      return 2;
    }
  }

  if (sha256) {
    const failed = await hashFiles(store, plan.rows.files, log);
    if (failed) log(`sha256: ${failed} files could not be read; their checksum stays empty`);
  }
  const written = await store.importRows(plan.rows);
  log(`written items=${written.items} votes=${written.votes} docs=${written.docs} quotas=${written.quotas} files=${written.files}`);
  if (prune) {
    const removed = await store.pruneRows({ ...plan.rows, docs: [...plan.rows.docs, { coll: MARKER[0], id: MARKER[1] }] });
    log(`pruned items=${removed.items} votes=${removed.votes} docs=${removed.docs} quotas=${removed.quotas} files=${removed.files}`);
  }
  // The database's own clock, to the microsecond: everything written above is stamped earlier than this.
  const now = (await store.db.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0].now;
  await store.setDoc(...MARKER, { finished_at: now, written });

  const result = verify(plan, await readPostgres(store.db));
  for (const line of result.lines) log(line);
  return result.ok ? 0 : 1;
}

async function main(argv, env) {
  const flags = new Set(argv);
  const known = ['--dry-run', '--prune', '--sha256', '--force'];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length || !env.BUCKET) {
    console.log(unknown.length ? `unknown argument: ${unknown.join(' ')}` : 'BUCKET is not set');
    console.log(`usage: node tools/migrate-to-postgres.mjs [${known.join('] [')}]   (environment: FIRESTORE_DB, BUCKET, and the database as for the server)`);
    return 2;
  }
  const dryRun = flags.has('--dry-run');
  if (!dryRun && !pgConfigured(env)) {
    console.log('no database in the environment: set CLOUDSQL_INSTANCE (with PGUSER, PGPASSWORD, PGDATABASE), DATABASE_URL or PGHOST');
    return 2;
  }
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ databaseId: env.FIRESTORE_DB || 'commons' });
  const files = await new BucketFiles().init(env.BUCKET);
  let store = null;
  try {
    console.log(`reading firestore database ${env.FIRESTORE_DB || 'commons'} and bucket ${env.BUCKET}`);
    const collections = {};
    for (const c of await firestore.listCollections()) collections[c.id] = (await c.get()).docs;
    const objects = await files.list();
    if (pgConfigured(env)) {
      store = new PgStore(await connect(env), files, { schema: env.PG_SCHEMA || '' });
      await store.db.query('SELECT 1');
    }
    return await migrate({ source: { collections, objects }, store, dryRun, prune: flags.has('--prune'), sha256: flags.has('--sha256'), force: flags.has('--force') });
  } finally {
    await store?.close().catch(() => {});
    await firestore.terminate().catch(() => {});
  }
}

const isMain = () => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  main(process.argv.slice(2), process.env).then(
    (status) => process.exit(status),
    (e) => {
      console.log(`failed: ${e.message}${e.code ? ` (${e.code})` : ''}`); // one line; the stack is of no use in a job log
      process.exit(1);
    },
  );
}
