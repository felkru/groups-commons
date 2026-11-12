// Hosted group websites at /s/<name>/: publishing, review, what the public sees, headers, deletion.
// (Kept to the behaviour that matters; the details of multi-file sites are still moving.)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEMPLATE, startApp, visitor } from './helper.js';

let app, mod, owner, other, anyone;
const html = TEMPLATE.replace('<title>Table sign</title>', '<title>Template title</title>');

before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
  anyone = visitor(app.base);
  const account = async (username) => {
    const v = visitor(app.base);
    v.session = (await v.post('/api/accounts', { username, password: 'correct horse', group: 'AI Safety Bonn' })).body.token;
    return v;
  };
  owner = await account('site-owner');
  other = await account('other-owner');
});
after(() => app.stop());

describe('a single-page site from the website template', () => {
  test('needs an account, a plain name and a real page', async () => {
    assert.equal((await anyone.post('/api/sites', { name: 'bonn', html })).status, 401);
    assert.equal((await owner.post('/api/sites', { name: 'x', html })).status, 400);
    assert.equal((await owner.post('/api/sites', { name: 'bonn', html: '<html>too short</html>' })).status, 400);
    assert.equal((await owner.post('/api/sites', { name: 'bonn', html: 'no page here '.repeat(40) })).status, 400);
  });

  test('is created pending and is not public', async () => {
    const r = await owner.post('/api/sites', { name: 'AI Safety Bonn', title: 'AI Safety <Bonn>', html: html.replace('</body>', '<script>alert(1)</script></body>') });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.name, r.body.status, r.body.owner], ['ai-safety-bonn', 'pending', 'acct-site-owner']);
    for (const v of [anyone, owner, mod]) {
      for (const path of ['/s/ai-safety-bonn', '/s/ai-safety-bonn/']) {
        const page = await v.get(path);
        assert.equal(page.status, 404, path);
        assert.ok(!String(page.body).includes('Curious about AI safety'));
      }
    }
  });

  test('its owner and moderators can list and read it; nobody else', async () => {
    assert.deepEqual((await owner.get('/api/sites')).body.map((s) => s.name), ['ai-safety-bonn']);
    assert.deepEqual((await mod.get('/api/sites')).body.map((s) => s.name), ['ai-safety-bonn']);
    assert.deepEqual((await other.get('/api/sites')).body, []);
    assert.deepEqual((await anyone.get('/api/sites')).body, []);
    assert.match((await owner.get('/api/sites/ai-safety-bonn/html')).body.html, /Curious about AI safety/);
    assert.equal((await other.get('/api/sites/ai-safety-bonn/html')).status, 403);
    assert.equal((await anyone.get('/api/sites/ai-safety-bonn/html')).status, 403);
    assert.equal((await mod.get('/api/sites/no-such-site/html')).status, 404);
    assert.equal((await mod.get('/api/sites/__proto__/html')).status, 404);
  });

  test('the name belongs to its owner', async () => {
    assert.equal((await other.post('/api/sites', { name: 'ai-safety-bonn', html })).status, 409);
    assert.equal((await other.del('/api/sites/ai-safety-bonn')).status, 403);
    assert.equal((await other.post('/api/sites/ai-safety-bonn/approve')).status, 403);
    assert.equal((await owner.post('/api/sites/ai-safety-bonn/approve')).status, 403);
  });

  test('after approval it is public, sandboxed and marked as hosted', async () => {
    assert.equal((await mod.post('/api/sites/ai-safety-bonn/approve')).body.status, 'published');
    const page = await anyone.get('/s/ai-safety-bonn/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.body, /Curious about AI safety/);
    assert.match(page.body, /Hosted on Groups Commons/);
    assert.match(page.body, /<title>AI Safety &lt;Bonn&gt;<\/title>/);
    assert.ok(!page.body.includes('<script'), 'scripts are stripped from a template site');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /sandbox/);
    assert.ok(!/allow-same-origin/.test(csp), 'a hosted page never shares the site’s origin');
    assert.ok(!/allow-scripts/.test(csp), 'a template site runs no scripts');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.ok(page.headers.get('strict-transport-security'));
    assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
    const bare = await anyone.get('/s/ai-safety-bonn');
    assert.ok([200, 301, 302].includes(bare.status));
    assert.equal((await anyone.get('/s/no-such-site/')).status, 404);
    assert.equal((await anyone.get('/s/__proto__/')).status, 404);
  });

  test('when the owner changes it, it goes back to review', async () => {
    const r = await owner.post('/api/sites', { name: 'ai-safety-bonn', html: html.replace('Curious about AI safety?', 'Changed after approval') });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
    assert.equal((await anyone.get('/s/ai-safety-bonn/')).status, 404);
    await mod.post('/api/sites/ai-safety-bonn/approve');
    assert.match((await anyone.get('/s/ai-safety-bonn/')).body, /Changed after approval/);
  });

  test('taking it down removes the page and its files', async () => {
    assert.equal((await owner.del('/api/sites/ai-safety-bonn')).status, 200);
    assert.equal((await anyone.get('/s/ai-safety-bonn/')).status, 404);
    assert.deepEqual((await mod.get('/api/sites')).body, []);
    assert.equal(await app.store.readFile('_sites', 'ai-safety-bonn/index.html'), null);
    assert.equal((await owner.del('/api/sites/ai-safety-bonn')).status, 404);
  });
});

describe('a built site, uploaded file by file', () => {
  const put = (v, name, path, data) => v.put(`/api/sites/${name}/files/${path}`, data);

  test('uploads need an account and stay within the site', async () => {
    assert.equal((await put(anyone, 'built', 'index.html', '<html></html>')).status, 401);
    assert.equal((await put(owner, 'built', '..%2Fother%2Findex.html', 'x')).status, 400);
    assert.equal((await put(owner, 'built', 'run.php', 'x')).status, 400);
    assert.equal((await put(owner, 'Not A Name', 'index.html', 'x')).status, 400);
  });

  test('publish, review, serve; a change after approval takes the site offline until it is reviewed again', async () => {
    assert.equal((await put(owner, 'built', 'index.html', '<!doctype html><html><body><h1>Built site</h1><script src="app.js"></script></body></html>')).status, 200);
    assert.equal((await put(owner, 'built', 'app.js', 'console.log("hi")')).status, 200);
    assert.equal((await put(other, 'built', 'index.html', '<html>mine now</html>')).status, 409);
    assert.equal((await anyone.get('/s/built/')).status, 404, 'a draft is not public');
    const published = await owner.post('/api/sites/built/publish', { files: ['index.html', 'app.js'], title: 'Built' });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'pending');
    assert.equal((await anyone.get('/s/built/')).status, 404, 'pending is not public');
    assert.equal((await anyone.get('/s/built/app.js')).status, 404);

    await mod.post('/api/sites/built/approve');
    const page = await anyone.get('/s/built/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Built site/);
    assert.ok(!/allow-same-origin/.test(page.headers.get('content-security-policy')));
    const script = await anyone.get('/s/built/app.js');
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await anyone.get('/s/built/missing.js')).status, 404);

    assert.equal((await put(owner, 'built', 'index.html', '<!doctype html><html><body><h1>Swapped after approval</h1></body></html>')).status, 200);
    assert.equal((await anyone.get('/s/built/')).status, 404);
    assert.equal((await mod.get('/api/sites')).body.find((s) => s.name === 'built').status, 'pending');
  });

  test('a moderator’s own upload stays live', async () => {
    await mod.post('/api/sites/built/approve');
    await mod.post('/api/accounts/other-owner/role', { role: 'moderator' });
    assert.equal((await put(other, 'built', 'index.html', '<!doctype html><html><body><h1>Fixed by a moderator</h1></body></html>')).status, 200);
    assert.match((await anyone.get('/s/built/')).body, /Fixed by a moderator/);
  });

  test('taking it down deletes every file', async () => {
    assert.equal((await owner.del('/api/sites/built')).status, 200);
    assert.equal((await anyone.get('/s/built/')).status, 404);
    assert.equal(await app.store.readFile('_sites', 'built/index.html'), null);
    assert.equal(await app.store.readFile('_sites', 'built/app.js'), null);
  });
});
