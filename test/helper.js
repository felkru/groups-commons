// Shared by the tests: starts the app on a free port with the local store in a temporary folder, and small
// helpers for talking to it. Each test file runs in its own process (node --test), so each gets its own app.
//
// `npm run test:pg` runs the same tests against the PostgreSQL store (server/store-pg.js):
//   PG_TEST=pglite   PGlite, PostgreSQL inside the test process; nothing to install or start
//   PG_TEST=server   a real server, from DATABASE_URL or PGHOST / PGUSER / PGPASSWORD / PGDATABASE. Each test file
//                    works in a schema of its own (test_...) and drops it at the end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const ADMIN = 'test-moderator-token';

export const PG_TEST = process.env.PG_TEST || '';
// Points the environment at the store under test, with its data below `dir`.
export function useTestStore(dir, { keep = false } = {}) {
  Object.assign(process.env, { STORE: PG_TEST ? 'pg' : 'local', DATA_DIR: dir });
  delete process.env.BUCKET; // file bytes go to the folder, never to a real bucket
  delete process.env.PGLITE_DIR;
  if (PG_TEST === 'pglite' && keep) process.env.PGLITE_DIR = path.join(dir, 'pglite'); // on disk, so it can be reopened
  if (PG_TEST === 'server') process.env.PG_SCHEMA = `test_${process.pid}_${Date.now().toString(36)}`;
}
// Removes what a test left on a real server. Call it before the store is closed.
export async function dropTestStore(store) {
  if (PG_TEST === 'server') await store.db.query(`DROP SCHEMA IF EXISTS ${process.env.PG_SCHEMA} CASCADE`);
}

export async function startApp(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-test-'));
  useTestStore(dir);
  Object.assign(process.env, { ADMIN_TOKEN: ADMIN, SESSION_SECRET: 'test-session-secret', LOG_FORMAT: 'text', ...env });
  delete process.env.VERTEX;
  delete process.env.PUBLIC_URL;
  const mod = await import('../server/index.js');
  const running = await mod.start(0);
  const base = `http://127.0.0.1:${running.port}`;
  return {
    base,
    dir,
    store: mod.store,
    async stop() {
      await dropTestStore(mod.store);
      await running.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A visitor: a browser id, an address (rate limits count per address; the app trusts the last X-Forwarded-For
// entry, as it does behind Cloud Run) and optionally a session, the moderator token or edit keys.
let visitors = 0;
export function visitor(base, { admin = false, session = '', ip } = {}) {
  const n = ++visitors;
  const v = {
    id: `visitor-${String(n).padStart(4, '0')}-${Math.random().toString(36).slice(2, 10)}`,
    ip: ip || `10.1.${Math.floor(n / 250)}.${(n % 250) + 1}`,
    session,
    admin,
    headers(extra = {}) {
      const h = { 'X-Client-Id': v.id, 'X-Forwarded-For': v.ip, ...extra };
      if (v.session) h['X-Session'] = v.session;
      if (v.admin) h['X-Admin-Token'] = ADMIN;
      if (v.editKey && !h['X-Edit-Key']) h['X-Edit-Key'] = v.editKey; // what the browser remembers for its own uploads
      return h;
    },
    // Returns { status, body (parsed JSON or text), headers }.
    async req(method, url, { json, raw, type, headers = {} } = {}) {
      const h = v.headers(headers);
      let body;
      if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (raw !== undefined) {
        h['Content-Type'] = type || 'application/octet-stream';
        body = raw;
      }
      const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
      const buf = Buffer.from(await res.arrayBuffer());
      let parsed = buf.toString('utf8');
      if ((res.headers.get('content-type') || '').includes('json')) {
        try {
          parsed = JSON.parse(parsed);
        } catch {}
      }
      return { status: res.status, body: parsed, bytes: buf, headers: res.headers };
    },
    get: (url, o) => v.req('GET', url, o),
    post: (url, json = {}, o = {}) => v.req('POST', url, { json, ...o }),
    put: (url, raw, type) => v.req('PUT', url, { raw, type }),
    del: (url, o) => v.req('DELETE', url, o),
  };
  return v;
}

// The three-step upload the web form and the CLI use. Returns { slug, edit_key, status }.
export async function addMaterial(v, meta, files = {}) {
  const created = await v.post('/api/items', { ...meta, auto_slug: true });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const key = { 'X-Edit-Key': created.body.edit_key };
  for (const [p, data] of Object.entries(files)) {
    const up = await v.req('PUT', `/api/items/${created.body.slug}/files/${p}`, { raw: data, headers: key });
    if (up.status !== 200) throw new Error(`upload of ${p} failed: ${up.status} ${JSON.stringify(up.body)}`);
  }
  const done = await v.req('POST', `/api/items/${created.body.slug}/publish`, { json: {}, headers: key });
  if (done.status !== 200) throw new Error(`publish failed: ${done.status} ${JSON.stringify(done.body)}`);
  return { slug: created.body.slug, edit_key: created.body.edit_key, status: done.body.status };
}

export const text = (title, extra = {}) => ({
  title,
  category: 'message',
  kind: 'text',
  summary: `Summary of ${title}.`,
  group: 'Test Group',
  variants: [{ label: 'English', channel: 'email', subject: 'Hello', body: `Body of ${title} with a [Placeholder].` }],
  ...extra,
});

export const TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Table sign</title>
<meta name="commons:page" content="210mm 297mm"><meta name="commons:format" content="A4 portrait">
<style>:root{--brand-color:#8391f6}.page{width:210mm;height:297mm}</style></head>
<body><section class="page"><img data-logo="square" src="logo-square.svg" alt="">
<h1 data-edit="headline">Curious about AI safety?</h1><p data-edit="sub">Join our reading group.</p>
<span data-brand="group_name">AI Safety Aachen</span><img data-qr="join_url" alt="QR code" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></section></body></html>`;

export const template = (title, extra = {}) => ({ title, category: 'print', kind: 'template', summary: `Summary of ${title}.`, group: 'Test Group', template: { path: 'template.html', format: 'A4 portrait' }, ...extra });

// A valid PNG of one colour (no image library needed).
export function png(width = 64, height = 48, rgb = [200, 60, 60]) {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const hasSharp = await import('sharp').then(() => true, () => false);
