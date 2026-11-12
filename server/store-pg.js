// STORE=pg: PostgreSQL is the system of record for everything structured (materials, votes, counters, accounts,
// sites and the other documents, daily quotas, and one row per stored file). The bytes of files stay in the Cloud
// Storage bucket (BUCKET), or in a local folder when no bucket is set: see files.js.
//
// PgStore has the interface described at the top of store.js. It talks to the database through a small object,
//   { query(text, params) -> { rows }, transaction(fn) -> what fn returns, end() }
// where fn gets { query } bound to one connection inside BEGIN / COMMIT. poolDb() wraps a pg.Pool that way and
// pgliteDb() wraps PGlite (PostgreSQL compiled to WebAssembly, used by the tests), so the two are interchangeable.
//
// Search and ranking still run in memory over allItems() (index.js, rank.js): every instance keeps the materials
// in memory and re-reads them every 20 seconds, exactly as the Firestore store did. When that stops being enough,
// this is where the database takes over:
//   - full text: a generated tsvector column on items (title, summary, tags, the text of variants) with a GIN
//     index, queried with websearch_to_tsquery; keywordScore() in index.js becomes ts_rank;
//   - embeddings: CREATE EXTENSION vector, a column `emb vector(n)` filled from data->'emb' with an HNSW index,
//     and ORDER BY emb <=> $query LIMIT n instead of ai.cosine() over every item. Moving the embedding out of
//     `data` also makes votes cheaper: today each vote rewrites the whole record, embedding included.
// Both are one more entry in MIGRATIONS and a search method here; nothing else has to change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BucketFiles, FolderFiles } from './files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notFound = () => Object.assign(new Error('No material with that name.'), { status: 404, expose: true });
const REFRESH_MS = 20000;

// ---- schema ----
// Ids are compared byte by byte (COLLATE "C"): faster, and safe from the operating system's sort rules changing
// under an index. Each entry is applied once, in order, inside one transaction; add new entries, never edit old ones.
export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_version (
         id boolean PRIMARY KEY DEFAULT true CHECK (id),
         version integer NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
      // A material. `data` is the whole record as the application sees it (up, down, uses and the embedding
      // included); kind, status, created and updated repeat fields of it so that they can be indexed and queried.
      `CREATE TABLE IF NOT EXISTS items (
         slug text COLLATE "C" PRIMARY KEY,
         data jsonb NOT NULL,
         kind text,
         status text,
         created timestamptz,
         updated timestamptz
       )`,
      `CREATE INDEX IF NOT EXISTS items_kind_idx ON items (kind)`,
      `CREATE INDEX IF NOT EXISTS items_status_idx ON items (status)`,
      `CREATE INDEX IF NOT EXISTS items_created_idx ON items (created DESC)`,
      // Tags only. A GIN index over all of `data` would index every number of every embedding.
      `CREATE INDEX IF NOT EXISTS items_tags_idx ON items USING gin ((data -> 'tags'))`,
      `CREATE TABLE IF NOT EXISTS votes (
         slug text COLLATE "C" NOT NULL REFERENCES items (slug) ON DELETE CASCADE,
         client_id text COLLATE "C" NOT NULL,
         dir smallint NOT NULL CHECK (dir IN (-1, 1)),
         at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (slug, client_id)
       )`,
      `CREATE INDEX IF NOT EXISTS votes_client_idx ON votes (client_id)`,
      // Everything else that is a record with an id: accounts, sites, ...
      `CREATE TABLE IF NOT EXISTS docs (
         coll text COLLATE "C" NOT NULL,
         id text COLLATE "C" NOT NULL,
         data jsonb NOT NULL,
         updated timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (coll, id)
       )`,
      // Daily caps on paid services (UTC days).
      `CREATE TABLE IF NOT EXISTS quotas (
         day date NOT NULL,
         name text COLLATE "C" NOT NULL,
         used integer NOT NULL DEFAULT 0,
         PRIMARY KEY (day, name)
       )`,
      // One row per stored file. owner is a material's slug, or "_sites" / "_accounts" with the name as the first
      // folder of the path. The bytes are in the bucket at items/<owner>/<path>.
      `CREATE TABLE IF NOT EXISTS files (
         owner text COLLATE "C" NOT NULL,
         path text COLLATE "C" NOT NULL,
         size bigint NOT NULL,
         content_type text,
         sha256 text,
         updated timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (owner, path)
       )`,
    ],
  },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;
const SCHEMA_LOCK = 4103776211; // any number: instances that start together take turns creating the tables
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// Creates or upgrades the tables. Safe to run at every start and from several instances at once: the advisory
// lock lets one in at a time, and whoever comes second finds the version row and does nothing.
export async function ensureSchema(db, schema = '') {
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error('PG_SCHEMA must be a plain lower-case name.');
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`);
    if (schema) await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const present = (await tx.query(`SELECT to_regclass('schema_version') IS NOT NULL AS present`)).rows[0].present;
    const before = present ? Number((await tx.query('SELECT version FROM schema_version')).rows[0]?.version || 0) : 0;
    let version = before;
    for (const m of MIGRATIONS) {
      if (m.version <= version) continue;
      for (const sql of m.statements) await tx.query(sql);
      version = m.version;
    }
    if (version !== before) {
      await tx.query('INSERT INTO schema_version (id, version) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now()', [version]);
    }
    return version;
  });
}

// ---- records ----
// jsonb takes neither a NUL character nor half a surrogate pair inside a string: both are dropped or replaced
// here, so that odd text in an upload cannot turn into a database error. Fields that are undefined are left out,
// as Firestore did (ignoreUndefinedProperties).
const cleanText = (k, v) => (typeof v === 'string' && (v.includes('\u0000') || !v.isWellFormed()) ? v.replaceAll('\u0000', '').toWellFormed() : v);
export const toJson = (data) => JSON.stringify(data, cleanText);
const stamp = (v) => {
  const t = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const word = (v) => (typeof v === 'string' ? v : null);
// The columns of `items` that repeat a field of the record: [column, field, how to convert it].
const ITEM_COLUMNS = [
  ['kind', 'kind', word],
  ['status', 'status', word],
  ['created', 'created_at', stamp],
  ['updated', 'updated_at', stamp],
];
// A material as a row of `items`. Also used by tools/migrate-to-postgres.mjs.
export function itemRow(slug, data) {
  const row = { slug, data };
  for (const [column, field, convert] of ITEM_COLUMNS) row[column] = convert(data?.[field]);
  return row;
}
const UPSERT_FILE = `INSERT INTO files (owner, path, size, content_type, sha256, updated) VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (owner, path) DO UPDATE SET size = EXCLUDED.size, content_type = EXCLUDED.content_type, sha256 = EXCLUDED.sha256, updated = EXCLUDED.updated`;
const sha256 = async (buffer) => Buffer.from(await crypto.subtle.digest('SHA-256', buffer)).toString('hex'); // off the main thread
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export class PgStore {
  // db: see the top of this file. files: FolderFiles or BucketFiles. schema: an optional schema name (PG_SCHEMA).
  constructor(db, files, { schema = '', refreshMs = REFRESH_MS } = {}) {
    this.db = db;
    this.files = files;
    this.schemaName = schema;
    this.refreshMs = refreshMs;
    this.cache = new Map();
    this.loadedAt = 0;
    this.ready = false;
    this.schema = null;
    this.loading = null;
    this.touched = null;
  }
  async init() {
    // A database that is not reachable yet must not stop the server from starting: the health check reports it,
    // and the tables are created and the materials read on the first request that gets through.
    await this.refresh().catch((e) => console.error('initial load failed, will retry on the first request:', e.message));
    return this;
  }
  // Resolves once the tables exist. Tried again on the next call if it failed.
  up() {
    return (this.schema ||= ensureSchema(this.db, this.schemaName).catch((e) => {
      this.schema = null;
      throw e;
    }));
  }
  async ping() {
    await Promise.all([this.up().then(() => this.db.query('SELECT 1')), this.files.ping()]);
  }
  async close() {
    await this.db.end();
  }

  // ---- materials ----
  // Materials are few (hundreds), so every instance keeps them in memory and re-reads them periodically: one
  // query, whatever their number. A change made on another instance shows up after at most `refreshMs`.
  refresh() {
    return (this.loading ||= this.load().finally(() => (this.loading = null)));
  }
  async load() {
    await this.up();
    const touched = (this.touched = new Set());
    try {
      const { rows } = await this.db.query('SELECT slug, data FROM items');
      const next = new Map();
      for (const r of rows) next.set(r.slug, r.data);
      // What this instance wrote while the query was running is newer than what the query saw: those materials
      // stay as the cache has them (or stay gone, if they were deleted).
      for (const slug of touched) {
        if (this.cache.has(slug)) next.set(slug, this.cache.get(slug));
        else next.delete(slug);
      }
      this.cache = next;
      this.loadedAt = Date.now();
      this.ready = true;
    } finally {
      this.touched = null;
    }
  }
  async fresh() {
    if (!this.ready) return this.refresh();
    if (Date.now() - this.loadedAt > this.refreshMs) {
      this.loadedAt = Date.now();
      this.refresh().catch((e) => console.error('refresh failed', e.message));
    }
  }
  // Puts what the database returned into the cache. An object that is already there is updated in place, because
  // requests under way hold on to it.
  remember(slug, data) {
    this.touched?.add(slug);
    const cur = this.cache.get(slug);
    if (!cur || cur === data) {
      this.cache.set(slug, data);
      return data;
    }
    for (const k of Object.keys(cur)) if (!Object.hasOwn(data, k)) delete cur[k];
    return Object.assign(cur, data);
  }
  forget(slug) {
    this.touched?.add(slug);
    this.cache.delete(slug);
  }
  async allItems() {
    await this.fresh();
    return [...this.cache.values()];
  }
  async getItem(slug) {
    await this.fresh();
    if (this.cache.has(slug)) return this.cache.get(slug);
    const { rows } = await this.db.query('SELECT data FROM items WHERE slug = $1', [slug]);
    if (!rows.length) return null;
    return this.remember(slug, rows[0].data);
  }
  async putItem(item) {
    await this.up();
    const row = itemRow(item.slug, item);
    await this.db.query(
      `INSERT INTO items (slug, data, kind, status, created, updated) VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, kind = EXCLUDED.kind, status = EXCLUDED.status, created = EXCLUDED.created, updated = EXCLUDED.updated`,
      [row.slug, toJson(item), row.kind, row.status, row.created, row.updated],
    );
    this.touched?.add(item.slug);
    this.cache.set(item.slug, item);
  }
  // Sets the given top-level fields and leaves the others alone (Firestore's update()): a value of null is
  // stored as null, a value of undefined changes nothing. Returns the item, or null when it does not exist.
  async patchItem(slug, patch) {
    await this.up();
    const sets = ['data = data || $2::jsonb'];
    const params = [slug, toJson(patch)];
    for (const [column, field, convert] of ITEM_COLUMNS) {
      if (patch[field] === undefined) continue;
      params.push(convert(patch[field]));
      sets.push(`${column} = $${params.length}`);
    }
    const { rows } = await this.db.query(`UPDATE items SET ${sets.join(', ')} WHERE slug = $1 RETURNING data`, params);
    if (!rows.length) {
      this.forget(slug); // deleted in the meantime, possibly by another instance
      return null;
    }
    return this.remember(slug, rows[0].data);
  }
  async deleteItem(slug) {
    await this.up();
    await this.db.query('DELETE FROM items WHERE slug = $1', [slug]); // its votes go with it (ON DELETE CASCADE)
    this.forget(slug);
    // Bytes first, rows second: a row that is left over after a failure still points at something to clean up.
    await this.files.deleteAll(slug);
    await this.db.query('DELETE FROM files WHERE owner = $1', [slug]);
  }

  // ---- votes and counters ----
  // One transaction: the row lock on the material makes votes on it take turns, so the totals in the record and
  // the rows in `votes` cannot drift apart, and the same vote sent twice counts once.
  async vote(slug, clientId, dir) {
    await this.up();
    const result = await this.db.transaction(async (tx) => {
      const item = (await tx.query(`SELECT data -> 'up' AS up, data -> 'down' AS down FROM items WHERE slug = $1 FOR UPDATE`, [slug])).rows[0];
      if (!item) throw notFound();
      const prev = (await tx.query('SELECT dir FROM votes WHERE slug = $1 AND client_id = $2', [slug, clientId])).rows[0]?.dir || 0;
      const up = (Number(item.up) || 0) + (dir === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
      const down = (Number(item.down) || 0) + (dir === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
      if (dir === 0) await tx.query('DELETE FROM votes WHERE slug = $1 AND client_id = $2', [slug, clientId]);
      else await tx.query('INSERT INTO votes (slug, client_id, dir) VALUES ($1, $2, $3) ON CONFLICT (slug, client_id) DO UPDATE SET dir = EXCLUDED.dir, at = now()', [slug, clientId, dir]);
      await tx.query(`UPDATE items SET data = data || jsonb_build_object('up', $2::numeric, 'down', $3::numeric) WHERE slug = $1`, [slug, up, down]);
      return { up, down, my: dir };
    });
    const cur = this.cache.get(slug);
    if (cur) {
      this.touched?.add(slug);
      Object.assign(cur, { up: result.up, down: result.down });
    }
    return result;
  }
  async votesOf(clientId) {
    await this.up();
    const { rows } = await this.db.query('SELECT slug, dir FROM votes WHERE client_id = $1', [clientId]);
    const out = {};
    for (const r of rows) out[r.slug] = r.dir;
    return out;
  }
  // One statement, so counts from several instances add up.
  async incr(slug, field, n = 1) {
    await this.up();
    const { rows } = await this.db.query(
      `UPDATE items SET data = jsonb_set(data, ARRAY[$2::text],
         to_jsonb((CASE WHEN jsonb_typeof(data -> $2::text) = 'number' THEN (data ->> $2::text)::numeric ELSE 0 END) + $3::numeric))
       WHERE slug = $1 RETURNING data -> $2::text AS value`,
      [slug, field, n],
    );
    const cur = this.cache.get(slug);
    if (cur && rows.length) {
      this.touched?.add(slug);
      cur[field] = Number(rows[0].value);
    }
  }
  // Counts one use against today's cap; false when the cap is reached. One statement: no two callers get the last one.
  async takeQuota(name, limit) {
    await this.up();
    const day = new Date().toISOString().slice(0, 10);
    const { rows } = await this.db.query(
      `INSERT INTO quotas (day, name, used) SELECT $1::date, $2::text, 1 WHERE $3::numeric > 0
       ON CONFLICT (day, name) DO UPDATE SET used = quotas.used + 1 WHERE quotas.used < $3::numeric
       RETURNING used`,
      [day, name, limit],
    );
    return rows.length > 0;
  }

  // ---- other documents (accounts, sites, ...) ----
  async getDoc(coll, id) {
    await this.up();
    const { rows } = await this.db.query('SELECT data FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
    return rows.length ? rows[0].data : null;
  }
  async createDoc(coll, id, data) {
    await this.up();
    const { rows } = await this.db.query('INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (coll, id) DO NOTHING RETURNING id', [coll, id, toJson(data)]);
    return rows.length > 0;
  }
  async setDoc(coll, id, data) {
    await this.up();
    await this.db.query('INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated = now()', [coll, id, toJson(data)]);
  }
  async deleteDoc(coll, id) {
    await this.up();
    await this.db.query('DELETE FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
  }
  async listDocs(coll) {
    await this.up();
    const { rows } = await this.db.query('SELECT data FROM docs WHERE coll = $1 ORDER BY id', [coll]);
    return rows.map((r) => r.data);
  }

  // ---- files: the bytes go to the bucket or the folder, and `files` has a row for each ----
  // Bytes first, then the row: a row always has its bytes.
  async putFile(slug, p, buffer, contentType) {
    const [hash] = await Promise.all([sha256(buffer), this.files.putFile(slug, p, buffer, contentType)]);
    await this.up();
    await this.db.query(UPSERT_FILE, [slug, p, Buffer.byteLength(buffer), contentType ?? null, hash]);
  }
  readFile(slug, p) {
    return this.files.readFile(slug, p);
  }
  fileStream(slug, p) {
    return this.files.fileStream(slug, p);
  }
  // Removes one file, or everything below a folder when the prefix ends in "/".
  async deleteFiles(slug, prefix) {
    if (!prefix) throw new Error('deleteFiles needs a prefix');
    await this.files.deleteFiles(slug, prefix);
    await this.up();
    // "everything that starts with a/b/" as a range the primary key can answer: "/" is followed by "0" in byte order.
    if (prefix.endsWith('/')) await this.db.query('DELETE FROM files WHERE owner = $1 AND path >= $2 AND path < $3', [slug, prefix, `${prefix.slice(0, -1)}0`]);
    else await this.db.query('DELETE FROM files WHERE owner = $1 AND path = $2', [slug, prefix]);
  }
  async copyFiles(from, to, paths) {
    await this.files.copyFiles(from, to, paths);
    if (!paths.length) return;
    await this.up();
    const { rows } = await this.db.query(
      `INSERT INTO files (owner, path, size, content_type, sha256, updated)
       SELECT $2::text, path, size, content_type, sha256, now() FROM files WHERE owner = $1 AND path = ANY($3::text[])
       ON CONFLICT (owner, path) DO UPDATE SET size = EXCLUDED.size, content_type = EXCLUDED.content_type, sha256 = EXCLUDED.sha256, updated = EXCLUDED.updated
       RETURNING path`,
      [from, to, paths],
    );
    // A source file without a row (stored before this table existed): describe the copy from the storage itself.
    const done = new Set(rows.map((r) => r.path));
    for (const p of paths.filter((x) => !done.has(x))) {
      const s = await this.files.stat(to, p);
      if (s) await this.db.query(UPSERT_FILE, [to, p, s.size, s.contentType ?? null, null]);
    }
  }
  // The files of one owner, optionally below a folder ("name/"): [{ path, size, content_type, sha256, updated }].
  async listFiles(owner, prefix = '') {
    await this.up();
    const range = prefix.endsWith('/') ? [prefix, `${prefix.slice(0, -1)}0`] : null;
    const { rows } = await this.db.query(
      `SELECT path, size, content_type, sha256, updated FROM files WHERE owner = $1 ${range ? 'AND path >= $2 AND path < $3' : ''} ORDER BY path`,
      range ? [owner, ...range] : [owner],
    );
    return rows.map((r) => ({ ...r, size: Number(r.size) }));
  }

  // ---- bulk loading (tools/migrate-to-postgres.mjs) ----
  // Writes rows as they are, a few hundred per statement; rows that exist are overwritten, so it can be repeated.
  // rows: { items: [{slug, data, kind, status, created, updated}], votes: [{slug, client_id, dir, at}],
  //         docs: [{coll, id, data}], quotas: [{day, name, used}], files: [{owner, path, size, content_type, sha256, updated}] }
  // Returns how many rows were written per table. Votes for materials that do not exist are left out.
  async importRows(rows, { batch = 500, itemBatch = 40 } = {}) {
    await this.up();
    const written = { items: 0, votes: 0, docs: 0, quotas: 0, files: 0 };
    const run = async (table, list, size, sql) => {
      for (const part of chunks(list || [], size)) written[table] += (await this.db.query(sql, [toJson(part)])).rows.length;
    };
    await run(
      'items',
      rows.items,
      itemBatch,
      `INSERT INTO items (slug, data, kind, status, created, updated)
       SELECT slug, data, kind, status, created, updated FROM jsonb_to_recordset($1::jsonb) AS r(slug text, data jsonb, kind text, status text, created timestamptz, updated timestamptz)
       ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, kind = EXCLUDED.kind, status = EXCLUDED.status, created = EXCLUDED.created, updated = EXCLUDED.updated
       RETURNING 1`,
    );
    await run(
      'votes',
      rows.votes,
      batch,
      `INSERT INTO votes (slug, client_id, dir, at)
       SELECT r.slug, r.client_id, r.dir, COALESCE(r.at, now()) FROM jsonb_to_recordset($1::jsonb) AS r(slug text, client_id text, dir smallint, at timestamptz)
       WHERE EXISTS (SELECT 1 FROM items i WHERE i.slug = r.slug)
       ON CONFLICT (slug, client_id) DO UPDATE SET dir = EXCLUDED.dir, at = EXCLUDED.at
       RETURNING 1`,
    );
    await run(
      'docs',
      rows.docs,
      batch,
      `INSERT INTO docs (coll, id, data)
       SELECT coll, id, data FROM jsonb_to_recordset($1::jsonb) AS r(coll text, id text, data jsonb)
       ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated = now()
       RETURNING 1`,
    );
    await run(
      'quotas',
      rows.quotas,
      batch,
      `INSERT INTO quotas (day, name, used)
       SELECT day, name, used FROM jsonb_to_recordset($1::jsonb) AS r(day date, name text, used integer)
       ON CONFLICT (day, name) DO UPDATE SET used = EXCLUDED.used
       RETURNING 1`,
    );
    // A row that already has a checksum keeps it when the listing brings none and the file has not changed.
    await run(
      'files',
      rows.files,
      batch,
      `INSERT INTO files (owner, path, size, content_type, sha256, updated)
       SELECT owner, path, size, content_type, sha256, COALESCE(updated, now()) FROM jsonb_to_recordset($1::jsonb) AS r(owner text, path text, size bigint, content_type text, sha256 text, updated timestamptz)
       ON CONFLICT (owner, path) DO UPDATE SET size = EXCLUDED.size, content_type = EXCLUDED.content_type, updated = EXCLUDED.updated,
         sha256 = COALESCE(EXCLUDED.sha256, CASE WHEN files.size = EXCLUDED.size AND files.updated = EXCLUDED.updated THEN files.sha256 END)
       RETURNING 1`,
    );
    this.ready = false; // the next read loads the materials again
    return written;
  }
  // Removes every row that is not among `rows` (same shape as for importRows): what was deleted at the source
  // since an earlier import. Returns how many rows were removed per table.
  async pruneRows(rows) {
    await this.up();
    const removed = {};
    const run = async (table, sql, keys) => (removed[table] = (await this.db.query(sql, [toJson(keys)])).rows.length);
    await run('votes', `DELETE FROM votes v WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(slug text, client_id text) WHERE r.slug = v.slug AND r.client_id = v.client_id) RETURNING 1`, (rows.votes || []).map(({ slug, client_id }) => ({ slug, client_id })));
    await run('items', `DELETE FROM items i WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(slug text) WHERE r.slug = i.slug) RETURNING 1`, (rows.items || []).map(({ slug }) => ({ slug })));
    await run('docs', `DELETE FROM docs d WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(coll text, id text) WHERE r.coll = d.coll AND r.id = d.id) RETURNING 1`, (rows.docs || []).map(({ coll, id }) => ({ coll, id })));
    await run('quotas', `DELETE FROM quotas q WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(day date, name text) WHERE r.day = q.day AND r.name = q.name) RETURNING 1`, (rows.quotas || []).map(({ day, name }) => ({ day, name })));
    await run('files', `DELETE FROM files f WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(owner text, path text) WHERE r.owner = f.owner AND r.path = f.path) RETURNING 1`, (rows.files || []).map(({ owner, path: p }) => ({ owner, path: p })));
    this.ready = false;
    return removed;
  }
}

// ---- connections ----
// A pg.Pool behind the small interface PgStore uses.
export function poolDb(pool, onEnd) {
  // Without a listener, an error on an idle connection (the database restarting) would end the process.
  pool.on('error', (e) => console.error('idle database connection failed:', e.message));
  return {
    pool,
    // A connection that sat idle can turn out to be dead when it is next used (the database restarted, or the
    // instance was frozen between requests). Reading again is always safe, so a read is tried a second time on a
    // fresh connection; a write is not, because nobody knows whether the first attempt arrived.
    async query(text, params) {
      try {
        return await pool.query(text, params);
      } catch (e) {
        const answered = e?.severity !== undefined; // the database itself said no: asking again changes nothing
        if (answered || !/^\s*SELECT\b/i.test(text)) throw e;
        return pool.query(text, params);
      }
    },
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => (broken = true));
        throw e;
      } finally {
        client.release(broken); // a connection that could not roll back is closed, not reused
      }
    },
    async end() {
      await pool.end();
      onEnd?.();
    },
  };
}

// PGlite: PostgreSQL in this process, for the tests (PG_TEST=pglite). In memory, or in a folder (PGLITE_DIR).
// One connection, so statements run one after the other; it is a devDependency and never part of the image.
export async function pgliteDb(dir = '', schema = '') {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(dir || undefined);
  await pg.waitReady;
  if (schema) await pg.query(`SET search_path TO ${schema}`);
  return {
    query: (text, params) => pg.query(text, params),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
    end: () => pg.close(),
  };
}

// TLS for connections that do not go through the Cloud SQL connector (which always encrypts and checks the
// instance's certificate itself). PGSSLMODE means what it means for psql:
//   require      encrypt, but do not check the certificate. This is the mode for a bare private IP address: the
//                certificate of a Cloud SQL instance cannot be checked against an address, only against a name.
//                The traffic is encrypted; that the other end really is the instance rests on the private network.
//   verify-ca    encrypt and check that the certificate comes from PGSSLROOTCERT (the instance's server CA file)
//   verify-full  the same, and the host name must match as well
//   disable      no TLS. Anything else (or nothing) is left to pg's own defaults.
// A socket folder as PGHOST (/cloudsql/...) never uses TLS: the socket's other end does the encrypting.
// With DATABASE_URL, an sslmode written in the address itself wins over PGSSLMODE.
export function sslFrom(env = process.env) {
  const mode = (env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable' || (!env.DATABASE_URL && (env.PGHOST || '').startsWith('/'))) return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify-ca' || mode === 'verify-full') {
    const ssl = { rejectUnauthorized: true };
    if (env.PGSSLROOTCERT) ssl.ca = fs.readFileSync(env.PGSSLROOTCERT, 'utf8');
    if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
    return ssl;
  }
  return undefined;
}

// Where the database is, from the environment, in this order:
//   PG_TEST=pglite                        PGlite (tests)
//   DATABASE_URL                          postgres://user:password@host:5432/database
//   CLOUDSQL_INSTANCE (project:region:instance) with PGUSER, PGPASSWORD, PGDATABASE
//                                         through the Cloud SQL connector: TLS with the instance's own certificate
//                                         and IAM-checked access, no proxy process. CLOUDSQL_IP_TYPE says which
//                                         address of the instance to use: PRIVATE (default), PUBLIC or PSC.
//   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
//                                         read by pg itself. PGHOST can be an address, a name or a socket folder
//                                         such as /cloudsql/project:region:instance. See sslFrom() for PGSSLMODE.
// Optional: PG_SCHEMA (keep the tables in that schema instead of "public"), PG_POOL_MAX (default 5).
// The pool is small on purpose: instances x pool has to stay below what the smallest Cloud SQL machine accepts
// (about 25 connections), with room left for the migration tool and psql.
export const pgConfigured = (env = process.env) => !!(env.PG_TEST === 'pglite' || env.DATABASE_URL || env.CLOUDSQL_INSTANCE || env.PGHOST);
// `use` replaces pg.Pool and the connector's class in the tests.
export async function connect(env = process.env, use = {}) {
  const schema = env.PG_SCHEMA || '';
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error('PG_SCHEMA must be a plain lower-case name.');
  if (env.PG_TEST === 'pglite') return pgliteDb(env.PGLITE_DIR, schema);
  const Pool = use.Pool || (await import('pg')).default.Pool;
  const base = {
    max: Math.max(1, Number(env.PG_POOL_MAX) || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    application_name: 'groups-commons',
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  };
  if (env.DATABASE_URL) {
    const ssl = sslFrom(env);
    return poolDb(new Pool({ ...base, ...(ssl === undefined ? {} : { ssl }), connectionString: env.DATABASE_URL }));
  }
  if (env.CLOUDSQL_INSTANCE) {
    const ipType = (env.CLOUDSQL_IP_TYPE || 'PRIVATE').toUpperCase();
    if (!['PRIVATE', 'PUBLIC', 'PSC'].includes(ipType)) throw new Error('CLOUDSQL_IP_TYPE must be PRIVATE, PUBLIC or PSC.');
    const Connector = use.Connector || (await import('@google-cloud/cloud-sql-connector')).Connector;
    const connector = new Connector();
    const options = await connector.getOptions({ instanceConnectionName: env.CLOUDSQL_INSTANCE, ipType });
    return poolDb(new Pool({ ...base, ...options, user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE }), () => connector.close());
  }
  const ssl = sslFrom(env);
  return poolDb(new Pool({ ...base, ...(ssl === undefined ? {} : { ssl }) }));
}

export async function openPgStore(env = process.env) {
  const files = env.BUCKET ? await new BucketFiles().init(env.BUCKET) : new FolderFiles(path.join(env.DATA_DIR || path.join(ROOT, 'data'), 'files'));
  return new PgStore(await connect(env), files, { schema: env.PG_SCHEMA || '' }).init();
}
