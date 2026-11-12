// Running the service: health, rate limits, headers, compression, error answers, logs and shutdown.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADMIN, addMaterial, startApp, text, visitor } from './helper.js';

let app, mod, anyone;
const hasVideo = fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'intro.mp4'));
before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
  anyone = visitor(app.base);
});
after(() => app.stop());

describe('health', () => {
  test('/api/health answers 200 while the store answers, 503 when it does not', async () => {
    const ok = await anyone.get('/api/health');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.ok, ok.body.store], [true, 'ok']);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const ping = app.store.ping;
    app.store.ping = async () => {
      throw new Error('database unreachable at 10.0.0.5');
    };
    try {
      await new Promise((r) => setTimeout(r, 5100)); // the answer is kept for five seconds
      const down = await anyone.get('/api/health');
      assert.equal(down.status, 503);
      assert.deepEqual([down.body.ok, down.body.store], [false, 'unreachable']);
      assert.ok(!JSON.stringify(down.body).includes('10.0.0.5'));
    } finally {
      app.store.ping = ping;
    }
  });
});

describe('rate limits', () => {
  test('per address and per kind of request; moderators are exempt', async () => {
    const busy = visitor(app.base);
    const signUp = (v, n) => v.post('/api/accounts', { username: `limit-${n}`, password: 'correct horse', group: 'G' });
    for (let n = 0; n < 10; n++) assert.equal((await signUp(busy, n)).status, 201);
    const over = await signUp(busy, 10);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /Too many requests from this address/);
    assert.ok(over.headers.get('retry-after'));
    // Another kind of request from the same address still works, and so does the same request from elsewhere.
    assert.equal((await busy.post('/api/items', text('Still allowed'))).status, 201);
    assert.equal((await signUp(visitor(app.base), 11)).status, 201);
    // A new browser id does not help: the address counts.
    const sameAddress = visitor(app.base, { ip: busy.ip });
    assert.equal((await signUp(sameAddress, 12)).status, 429);
    // The address is the one the proxy appended, not one the client claims.
    const liar = await fetch(`${app.base}/api/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.9, ${busy.ip}` }, body: JSON.stringify({ username: 'limit-13', password: 'correct horse', group: 'G' }) });
    assert.equal(liar.status, 429);
    const moderator = visitor(app.base, { admin: true, ip: busy.ip });
    assert.equal((await signUp(moderator, 14)).status, 201);
  });
  test('an IPv6 customer (a /64) counts as one address', async () => {
    const signUp = (ip, n) => visitor(app.base, { ip }).post('/api/accounts', { username: `v6-${n}`, password: 'correct horse', group: 'G' });
    for (let n = 0; n < 10; n++) assert.equal((await signUp(`2001:db8:1:2:aaaa::${n}`, n)).status, 201);
    assert.equal((await signUp('2001:db8:1:2:bbbb::1', 10)).status, 429);
    assert.equal((await signUp('2001:db8:1:3::1', 11)).status, 201);
  });
});

describe('the site and its static files', () => {
  test('pages come with the security headers', async () => {
    for (const path of ['/', '/privacy', '/m/some-material', '/account']) {
      const r = await anyone.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.body, /<title>Groups Commons/);
      const csp = r.headers.get('content-security-policy');
      for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) assert.ok(csp.includes(part), part);
      assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
      assert.match(r.headers.get('permissions-policy'), /camera=\(\), geolocation=\(\)/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(r.headers.get('x-powered-by'), null);
      assert.equal(r.headers.get('set-cookie'), null);
    }
  });
  test('pages, scripts and styles revalidate; the video and images may be kept', async () => {
    for (const path of ['/', '/app.js', '/styles.css', '/vendor/qrcode.js']) assert.equal((await anyone.get(path)).headers.get('cache-control'), 'no-cache', path);
    // The intro video is not in the public repository (see .gitignore); it is checked wherever it is present.
    for (const path of [...(hasVideo ? ['/assets/intro.mp4', '/assets/intro-poster.jpg'] : []), '/assets/favicon.svg', '/assets/brand/logo-wide.svg']) {
      const r = await anyone.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('cache-control'), /^public, max-age=86400/, path);
    }
    // Revalidating is cheap because every file has an ETag (the browser gets a 304 when nothing changed).
    assert.ok((await anyone.get('/app.js')).headers.get('etag'));
    assert.equal((await anyone.get('/api/meta')).headers.get('cache-control'), 'no-store');
  });
  test('text is compressed, video is not', async () => {
    for (const path of ['/app.js', '/styles.css', '/', '/cli/commons.mjs']) {
      const r = await fetch(app.base + path, { headers: { 'Accept-Encoding': 'gzip' } });
      await r.arrayBuffer();
      assert.equal(r.headers.get('content-encoding'), 'gzip', path);
    }
    if (!hasVideo) return;
    const video = await fetch(`${app.base}/assets/intro.mp4`, { headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-99' } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-encoding'), null);
    assert.equal((await video.arrayBuffer()).byteLength, 100);
  });
  test('unknown files and API routes are 404, not the page', async () => {
    assert.equal((await anyone.get('/nothing.js')).status, 404);
    const api = await anyone.get('/api/nothing');
    assert.equal(api.status, 404);
    assert.deepEqual(api.body, { error: 'Unknown API route.' });
    assert.match((await anyone.get('/robots.txt')).body, /Disallow: \//);
  });
  test('the CLI and the skill are served with this server’s address filled in', async () => {
    const cli = await anyone.get('/cli/commons.mjs');
    assert.equal(cli.status, 200);
    assert.ok(cli.body.includes(app.base));
    assert.ok(!cli.body.includes('__DEFAULT_URL__'));
    assert.ok((await anyone.get('/cli/SKILL.md')).body.includes(app.base));
    // The setup scripts and /llms.txt (their own tests are in tools/): they still answer behind the new middleware.
    const script = await anyone.get('/setup.sh?agent=codex&group=AI%20Safety%20Bonn&website=%24(rm%20-rf)');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/plain/);
    assert.ok(script.body.includes(app.base) && !/__[A-Z_]+__/.test(script.body) && !script.body.includes('rm -rf'));
    assert.ok((await anyone.get('/llms.txt')).body.includes(`${app.base}/mcp`));
  });
  test('/api/meta tells the page who is asking', async () => {
    const meta = (await anyone.get('/api/meta')).body;
    assert.deepEqual([meta.admin, meta.account, meta.semantic_search, meta.mcp], [false, null, false, `${app.base}/mcp`]);
    assert.equal((await mod.get('/api/meta')).body.admin, true);
    const wrong = await anyone.req('GET', '/api/meta', { headers: { 'X-Admin-Token': `${ADMIN}x` } });
    assert.equal(wrong.body.admin, false);
    const bearer = await anyone.req('GET', '/api/meta', { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(bearer.body.admin, true);
  });
});

describe('front end', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file) => fs.readFileSync(path.join(root, 'public', file), 'utf8');
  test('every script of the site parses', async () => {
    const files = fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 9);
    for (const file of files) {
      const code = await new Promise((resolve) => spawn(process.execPath, ['--check', path.join(root, 'public', file)], { stdio: 'ignore' }).once('exit', resolve));
      assert.equal(code, 0, file);
    }
  });
  test('the privacy page is routed, linked from the footer and names what the operator must fill in', () => {
    assert.match(read('app.js'), /\[\/\^\\\/privacy\\\/\?\$\/, privacyPage, ''\]/);
    assert.match(read('index.html'), /<footer[\s\S]*href="\/privacy"[\s\S]*<\/footer>/);
    const page = read('more.js');
    assert.match(page, /export async function privacyPage/);
    assert.match(page, /TO BE FILLED IN BY THE OPERATOR/);
    for (const fact of ['random browser id', 'salted hash', 'No email address', 'No cookies, with one exception', 'Logs are kept for 30 days', 'Google Fonts', 'removed after two days']) assert.ok(page.includes(fact), fact);
  });
  test('the account page offers a password change and account deletion', () => {
    const page = read('more.js');
    assert.match(page, /api\('\/me\/password', \{ method: 'POST'/);
    assert.match(page, /api\('\/me\/delete', \{ method: 'POST'/);
  });
  test('the site’s own upload code works against the server, and builds addresses that load before review', async () => {
    // public/api.js runs in Node once fetch understands addresses without a host, as it does in a browser.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => realFetch(typeof url === 'string' && url.startsWith('/') ? app.base + url : url, options);
    try {
      const site = await import('../public/api.js');
      const r = await site.uploadItem({ title: 'Uploaded by the page', category: 'print', kind: 'file', summary: 'A poster.', files: [{ path: 'my poster.png' }] }, [{ path: 'my poster.png', data: 'not really a png', type: 'image/png' }]);
      assert.equal(r.status, 'pending');
      assert.equal(site.fileBase(r.slug), `/files/${r.slug}/`, 'no key before the material was loaded');
      const item = await site.api(`/items/${r.slug}`);
      assert.equal(item.mine, true);
      // An <img> or a frame sends no headers: the address alone has to be enough for the uploader.
      const address = site.filePath(r.slug, 'my poster.png');
      assert.match(address, new RegExp(`^/files/~[0-9a-z]+\\.[\\w-]{32}/${r.slug}/my%20poster\\.png$`));
      assert.equal((await realFetch(app.base + address)).status, 200);
      assert.equal((await realFetch(`${app.base}/files/${r.slug}/my%20poster.png`)).status, 404);
      assert.equal((await realFetch(new URL('my%20poster.png', app.base + site.fileBase(r.slug)))).status, 200, 'relative addresses in a template');
      // The list view hands out the key as well; once published, the plain address is used again.
      await mod.post(`/api/items/${r.slug}/approve`);
      await site.api('/items');
      assert.equal(site.filePath(r.slug, 'my poster.png'), `/files/${r.slug}/my%20poster.png`);
      assert.equal((await realFetch(app.base + site.filePath(r.slug, 'my poster.png'))).status, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('errors', () => {
  test('a failing store is answered with a general sentence, not with its details', async () => {
    const { slug } = await addMaterial(mod, text('Unlucky material'));
    const getItem = app.store.getItem;
    const failures = [
      Object.assign(new Error('7 PERMISSION_DENIED: Missing or insufficient permissions for projects/secret-project'), { code: 7 }),
      Object.assign(new (class GaxiosError extends Error {})('Request to https://internal.example/token failed'), { status: 403, config: {}, response: {} }),
      new TypeError("Cannot read properties of undefined (reading 'secret_field')"),
    ];
    try {
      for (const failure of failures) {
        app.store.getItem = async () => {
          throw failure;
        };
        const r = await anyone.get(`/api/items/${slug}`);
        assert.equal(r.status, 500);
        assert.deepEqual(r.body, { error: 'Something went wrong on the server.' });
      }
    } finally {
      app.store.getItem = getItem;
    }
    assert.equal((await anyone.get(`/api/items/${slug}`)).status, 200);
  });
  test('a material deleted during a request is a 404, not a crash', async () => {
    const { slug, edit_key } = await addMaterial(anyone, text('Deleted in between'));
    const getItem = app.store.getItem;
    // The route still finds the material, then it is gone when the change is written.
    app.store.getItem = async (s) => {
      const item = await getItem.call(app.store, s);
      if (s === slug && item) await app.store.deleteItem(slug);
      return item;
    };
    try {
      const upload = await anyone.req('PUT', `/api/items/${slug}/files/a.txt`, { raw: 'x', headers: { 'X-Edit-Key': edit_key } });
      assert.equal(upload.status, 404);
      assert.equal(upload.body.error, 'No material with that name.');
    } finally {
      app.store.getItem = getItem;
    }
    assert.equal(await app.store.patchItem(slug, { status: 'published' }), null);
    assert.equal(await app.store.getItem(slug), null);
    assert.equal((await mod.post(`/api/items/${slug}/approve`)).status, 404);
  });
  test('addresses that cannot be decoded are a 400', async () => {
    const r = await anyone.get('/files/some-material/%E0%A4%A');
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'The address is not valid.' });
  });
});

describe('as a process (node server/index.js)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const launch = (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-proc-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, STORE: 'local', DATA_DIR: dir, PORT: '0', ADMIN_TOKEN: ADMIN, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', (d) => (out.stdout += d));
    child.stderr.on('data', (d) => (out.stderr += d));
    const port = new Promise((resolve, reject) => {
      const look = () => {
        const m = /listening on :(\d+)/.exec(out.stdout);
        if (m) resolve(Number(m[1]));
      };
      child.stdout.on('data', look);
      child.once('exit', (code) => reject(new Error(`exited early (${code}): ${out.stderr}`)));
      setTimeout(() => reject(new Error(`no start within 20 s: ${out.stdout}${out.stderr}`)), 20000).unref();
    });
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, out, port, exit, dir };
  };

  test('logs single-line JSON with a severity, and finishes open requests on SIGTERM', async () => {
    const proc = launch({ LOG_FORMAT: 'json', SESSION_SECRET: '' });
    try {
      const port = await proc.port;
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      // An upload that is still arriving when the signal comes.
      let finish;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first half, '));
          finish = () => {
            controller.enqueue(new TextEncoder().encode('second half'));
            controller.close();
          };
        },
      });
      const created = await (await fetch(`${base}/api/items`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN }, body: JSON.stringify({ title: 'Shutdown test', category: 'ops', kind: 'file', summary: 's', files: [{ path: 'a.txt' }] }) })).json();
      const upload = fetch(`${base}/api/items/${created.slug}/files/a.txt`, { method: 'PUT', headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'text/plain' }, body, duplex: 'half' });
      await new Promise((r) => setTimeout(r, 200));
      proc.child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(proc.child.exitCode, null, 'still running while a request is open');
      await assert.rejects(fetch(`${base}/api/health`), 'no new connections');
      finish();
      const answered = await upload;
      assert.equal(answered.status, 200);
      const { code } = await proc.exit;
      assert.equal(code, 0);
      // The data written just before the exit is on disk.
      const db = JSON.parse(fs.readFileSync(path.join(proc.dir, 'db.json'), 'utf8'));
      assert.deepEqual(db.items[created.slug].file_list, [{ path: 'a.txt', size: 23 }]);
      assert.equal(fs.readFileSync(path.join(proc.dir, 'files', created.slug, 'a.txt'), 'utf8'), 'first half, second half');

      const lines = (proc.out.stdout + proc.out.stderr).trim().split('\n').map((l) => JSON.parse(l));
      for (const l of lines) {
        assert.ok(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(l.severity), l.severity);
        assert.equal(typeof l.message, 'string');
        assert.ok(!Number.isNaN(Date.parse(l.time)));
      }
      assert.ok(lines.some((l) => l.severity === 'INFO' && /listening on :\d+ \(store=local, vertex=off, admin=set\)/.test(l.message)));
      assert.ok(lines.some((l) => l.severity === 'WARNING' && /SESSION_SECRET is not set/.test(l.message)));
      assert.ok(lines.some((l) => l.severity === 'INFO' && /SIGTERM received/.test(l.message)));
      assert.ok(!(proc.out.stdout + proc.out.stderr).includes(ADMIN), 'the moderator token is never logged');
    } finally {
      proc.child.kill('SIGKILL');
      fs.rmSync(proc.dir, { recursive: true, force: true });
    }
  });

  test('a server error is one JSON line with severity ERROR and the stack', async () => {
    const proc = launch({ LOG_FORMAT: 'json', SESSION_SECRET: 's' });
    try {
      const base = `http://127.0.0.1:${await proc.port}`;
      // Make the store fail from outside: its folder disappears, so the health check cannot reach it.
      fs.rmSync(proc.dir, { recursive: true, force: true });
      assert.equal((await fetch(`${base}/api/health`)).status, 503);
      proc.child.kill('SIGTERM');
      await proc.exit;
      const errors = proc.out.stderr.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.severity === 'ERROR');
      const failed = errors.find((l) => /health check failed/.test(l.message));
      assert.ok(failed, proc.out.stderr);
      assert.match(failed.stack_trace, /ENOENT/);
      assert.match(failed['@type'], /ReportedErrorEvent/);
    } finally {
      proc.child.kill('SIGKILL');
      fs.rmSync(proc.dir, { recursive: true, force: true });
    }
  });

  test('without SESSION_SECRET or ADMIN_TOKEN it still starts (sessions then last until the restart)', async () => {
    const proc = launch({ ADMIN_TOKEN: '', LOG_FORMAT: 'text' });
    try {
      const base = `http://127.0.0.1:${await proc.port}`;
      const signup = await fetch(`${base}/api/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'local-dev', password: 'correct horse', group: 'G' }) });
      assert.equal(signup.status, 201);
      const { token } = await signup.json();
      const meta = await (await fetch(`${base}/api/meta`, { headers: { 'X-Session': token } })).json();
      assert.equal(meta.account.username, 'local-dev');
      assert.equal(meta.admin, false);
      assert.match(proc.out.stdout, /^groups-commons listening on :\d+ \(store=local, vertex=off, admin=unset\)$/m);
      proc.child.kill('SIGINT');
      assert.equal((await proc.exit).code, 0);
    } finally {
      proc.child.kill('SIGKILL');
      fs.rmSync(proc.dir, { recursive: true, force: true });
    }
  });
});
