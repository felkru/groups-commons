// Materials: the upload protocol, review, visibility, validation, files and the featured flag.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEMPLATE, addMaterial, hasSharp, png, startApp, template, text, visitor } from './helper.js';

let app, mod, anna, ben;
before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
  anna = visitor(app.base);
  ben = visitor(app.base);
});
after(() => app.stop());

describe('upload, review and visibility', () => {
  let slug, key;

  test('a new material starts as a draft with an edit key', async () => {
    const r = await anna.post('/api/items', text('Invitation to a first meetup'));
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'draft');
    assert.equal(r.body.slug, 'invitation-to-a-first-meetup');
    assert.match(r.body.edit_key, /^[0-9a-f]{36}$/);
    ({ slug, edit_key: key } = r.body);
  });

  test('a visitor’s material waits for review after publishing', async () => {
    assert.equal((await anna.post(`/api/items/${slug}/publish`)).status, 403, 'the browser id alone does not allow changes');
    anna.editKey = key;
    const r = await anna.post(`/api/items/${slug}/publish`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
  });

  test('pending: the uploader and moderators see it, nobody else does', async () => {
    assert.equal((await anna.get(`/api/items/${slug}`)).status, 200);
    assert.equal((await mod.get(`/api/items/${slug}`)).status, 200);
    assert.equal((await ben.get(`/api/items/${slug}`)).status, 404);
    const listed = async (v, q = '') => (await v.get(`/api/items${q}`)).body.items.map((i) => i.slug);
    assert.ok((await listed(anna)).includes(slug));
    assert.ok((await listed(mod, '?pending=1')).includes(slug));
    assert.ok(!(await listed(ben)).includes(slug));
    assert.deepEqual(await listed(ben, '?pending=1'), []);
    assert.equal((await anna.get(`/api/items/${slug}`)).body.mine, true);
  });

  test('pending materials cannot be voted on or counted as used', async () => {
    assert.equal((await ben.post(`/api/items/${slug}/vote`, { dir: 1 })).status, 404);
    assert.equal((await ben.post(`/api/items/${slug}/use`)).status, 404);
  });

  test('only moderators approve', async () => {
    assert.equal((await anna.post(`/api/items/${slug}/approve`)).status, 403);
    assert.equal((await ben.post(`/api/items/${slug}/approve`)).status, 403);
    const r = await mod.post(`/api/items/${slug}/approve`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'published');
    assert.equal((await ben.get(`/api/items/${slug}`)).status, 200);
    assert.equal((await mod.post('/api/items/no-such-material/approve')).status, 404);
  });

  test('responses never carry the edit key, the owner id or the embedding', async () => {
    for (const v of [anna, ben, mod]) {
      const one = (await v.get(`/api/items/${slug}`)).body;
      const many = (await v.get('/api/items')).body.items.find((i) => i.slug === slug);
      for (const item of [one, many]) for (const secret of ['edit_key', 'owner', 'emb']) assert.ok(!(secret in item), `${secret} leaked`);
    }
  });

  test('the edit key, not the address, decides who may change a material', async () => {
    assert.equal((await ben.post('/api/items', text('Invitation to a first meetup', { slug }))).status, 409);
    assert.equal((await ben.del(`/api/items/${slug}`)).status, 403);
    assert.equal((await ben.del(`/api/items/${slug}`, { headers: { 'X-Edit-Key': 'wrong' } })).status, 403);
    assert.equal((await ben.put(`/api/items/${slug}/files/a.txt`, 'hello')).status, 403);
    assert.equal((await ben.post(`/api/items/${slug}/publish`)).status, 403);
  });

  test('with auto_slug a taken name gets a number instead of an error', async () => {
    const r = await ben.post('/api/items', { ...text('Invitation to a first meetup'), auto_slug: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.slug, 'invitation-to-a-first-meetup-2');
  });

  test('when the owner changes a published material it goes back to review', async () => {
    const r = await ben.req('POST', '/api/items', { json: text('Invitation to a first meetup', { slug, summary: 'Changed after approval.' }), headers: { 'X-Edit-Key': key } });
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, true);
    assert.equal(r.body.status, 'pending');
    assert.equal((await ben.get(`/api/items/${slug}`)).status, 404);
    await mod.post(`/api/items/${slug}/approve`);
    assert.equal((await ben.get(`/api/items/${slug}`)).body.summary, 'Changed after approval.');
  });

  test('a moderator’s update keeps votes and stays published', async () => {
    await ben.post(`/api/items/${slug}/vote`, { dir: 1 });
    const r = await mod.post('/api/items', text('Invitation to a first meetup', { slug, summary: 'Edited by a moderator.' }));
    assert.equal(r.body.status, 'published');
    const item = (await ben.get(`/api/items/${slug}`)).body;
    assert.equal(item.summary, 'Edited by a moderator.');
    assert.equal(item.up, 1);
  });

  test('the owner deletes with the edit key; the material and its files are gone', async () => {
    const r = await ben.del(`/api/items/${slug}`, { headers: { 'X-Edit-Key': key } });
    assert.equal(r.status, 200);
    assert.equal((await mod.get(`/api/items/${slug}`)).status, 404);
    assert.equal((await mod.del(`/api/items/${slug}`)).status, 404);
  });

  test('a moderator’s material is published at once, with given statistics', async () => {
    const created = await mod.post('/api/items', text('Moderator text'));
    const r = await mod.post(`/api/items/${created.body.slug}/publish`, { stats: { up: 12, down: 2, uses: 40, created_at: '2026-10-01T00:00:00Z' } });
    assert.equal(r.body.status, 'published');
    const item = (await ben.get(`/api/items/${created.body.slug}`)).body;
    assert.deepEqual([item.up, item.down, item.uses, item.score, item.simulated], [12, 2, 40, 10, true]);
    // A visitor cannot set statistics.
    const mine = await ben.post('/api/items', text('Visitor text'));
    await ben.post(`/api/items/${mine.body.slug}/publish`, { stats: { up: 999 } });
    assert.equal((await ben.get(`/api/items/${mine.body.slug}`)).body.up, 0);
  });
});

describe('validation', () => {
  const bad = async (body, pattern) => {
    const r = await anna.post('/api/items', body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, pattern);
  };
  test('required fields, known categories and kinds', async () => {
    await bad({}, /Missing "title"/);
    await bad(text('x', { category: 'nope' }), /Unknown category/);
    await bad(text('x', { kind: 'nope' }), /Unknown kind/);
    await bad(text('x', { summary: '' }), /Missing "summary"/);
    await bad(text('x'.repeat(91)), /too long/);
    await bad(text('x', { variants: [] }), /needs 1-12 entries/);
    await bad(text('x', { variants: [{ body: 'b', channel: 'fax' }] }), /Unknown channel/);
    await bad({ ...text('x'), kind: 'link', link: { url: 'javascript:alert(1)' } }, /http\(s\) URL/);
    await bad({ ...text('x'), kind: 'file' }, /at least one entry/);
    await bad({ ...text('x'), kind: 'file', files: [{ path: '../secret.pdf' }] }, /Invalid file path/);
    await bad({ ...text('x'), kind: 'file', files: [{ path: 'run.exe' }] }, /File type not allowed/);
    await bad({ ...text('x'), kind: 'template', template: { path: 'page.pdf' } }, /must be an \.html file/);
  });
  test('a body that is not JSON, or too large, gets a plain answer', async () => {
    const broken = await anna.req('POST', '/api/items', { raw: '{"title": ', type: 'application/json' });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error, 'The request body is not valid JSON.');
    const huge = await anna.req('POST', '/api/items', { raw: JSON.stringify({ title: 'x'.repeat(2.2e6) }), type: 'application/json' });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error, 'That file is too large.');
  });
  test('unknown fields are dropped', async () => {
    const r = await anna.post('/api/items', { ...text('Clean me'), status: 'published', up: 500, featured: true, owner: 'acct-someone', edit_key: 'x' });
    const item = (await anna.get(`/api/items/${r.body.slug}`)).body;
    assert.deepEqual([item.status, item.up, item.featured], ['draft', 0, undefined]);
  });
  test('names that are not plain names are simply not found', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'A%2Fb', '..%2F..', '-x', 'x'.repeat(80)]) {
      assert.equal((await mod.get(`/api/items/${name}`)).status, 404, name);
      assert.equal((await mod.post(`/api/items/${name}/approve`)).status, 404, name);
      assert.equal((await mod.put(`/api/items/${name}/files/a.txt`, 'x')).status, 404, name);
      assert.equal((await mod.get(`/files/${name}/a.txt`)).status, 404, name);
    }
    assert.equal({}.status, undefined, 'Object.prototype was not touched');
    assert.equal({}.file_list, undefined);
  });
});

describe('files', () => {
  let slug, key;
  before(async () => {
    const r = await anna.post('/api/items', { title: 'Poster files', category: 'print', kind: 'file', summary: 'A poster.', group: 'Test Group', files: [{ path: 'poster.png', label: 'PNG' }, { path: 'notes/readme.txt' }] });
    ({ slug, edit_key: key } = r.body);
    anna.editKey = key;
  });

  test('publishing needs the files the material lists', async () => {
    const r = await anna.post(`/api/items/${slug}/publish`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Upload these files first: poster.png, notes\/readme.txt/);
  });

  test('uploads check path, type, size and emptiness', async () => {
    assert.equal((await anna.put(`/api/items/${slug}/files/poster.png`, png())).status, 200);
    assert.equal((await anna.put(`/api/items/${slug}/files/notes/readme.txt`, 'Print on A3.')).status, 200);
    const cases = [
      ['evil.exe', 'x', /File type not allowed/],
      ['.hidden.txt', 'x', /Invalid file path/],
      ['a/..%2F..%2Fb.txt', 'x', /Invalid file path/],
      ['empty.txt', '', /empty file/],
    ];
    for (const [p, data, pattern] of cases) {
      const r = await anna.put(`/api/items/${slug}/files/${p}`, data);
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, pattern);
    }
    const big = await anna.put(`/api/items/${slug}/files/big.zip`, Buffer.alloc(27 * 1024 * 1024));
    assert.equal(big.status, 413);
  });

  test('active content in HTML and SVG is refused', async () => {
    const refused = {
      'a.html': ['<html><script>alert(1)</script></html>', '<html><SCRIPT src=x></SCRIPT></html>', '<p onclick="x()">hi</p>', '<svg/onload=alert(1)>', '<img src="x"onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<a href=" JavaScript:alert(1)">x</a>', '<iframe src="https://example.org"></iframe>', '<form action="/x"></form>', '<object data="x"></object>', '<embed src="x">', '<meta http-equiv="refresh" content="0;url=https://example.org">'],
      'a.svg': ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<svg onload="alert(1)"></svg>', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
    };
    for (const [name, bodies] of Object.entries(refused)) {
      for (const body of bodies) {
        const r = await anna.put(`/api/items/${slug}/files/${name}`, body);
        assert.equal(r.status, 400, body);
        assert.match(r.body.error, /not allowed/);
      }
    }
    // Harmless HTML and SVG pass, including words that merely look like handlers.
    assert.equal((await anna.put(`/api/items/${slug}/files/ok.svg`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>')).status, 200);
    assert.equal((await anna.put(`/api/items/${slug}/files/ok.html`, '<!doctype html><html><body><p class="one two">Sign up online = easy. Season = autumn.</p><a href="https://example.org/?option=1">x</a></body></html>')).status, 200);
  });

  test('before review, files are served to the uploader, to moderators and with a file key only', async () => {
    assert.equal((await anna.post(`/api/items/${slug}/publish`)).body.status, 'pending');
    assert.equal((await ben.get(`/files/${slug}/poster.png`)).status, 404);
    assert.equal((await anna.get(`/files/${slug}/poster.png`)).status, 200);
    assert.equal((await mod.get(`/files/${slug}/poster.png`)).status, 200);
    const mine = (await anna.get(`/api/items/${slug}`)).body;
    assert.ok(mine.file_key);
    const withKey = await ben.get(`/files/~${mine.file_key}/${slug}/poster.png?w=32`);
    assert.equal(withKey.status, 200);
    assert.match(withKey.headers.get('cache-control'), /^private/);
    assert.equal((await ben.get(`/files/~${mine.file_key}/${slug}/notes/readme.txt`)).body, 'Print on A3.');
    // A key for one material opens no other, and a made-up or expired key opens nothing.
    const other = await addMaterial(anna, { title: 'Other poster', category: 'print', kind: 'file', summary: 'Another.', group: 'Test Group', files: [{ path: 'poster.png' }] }, { 'poster.png': png() });
    assert.equal((await ben.get(`/files/~${mine.file_key}/${other.slug}/poster.png`)).status, 404);
    assert.equal((await ben.get(`/files/~zzzzzzzzz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/${slug}/poster.png`)).status, 404);
    const [, sig] = mine.file_key.split('.');
    assert.equal((await ben.get(`/files/~1.${sig}/${slug}/poster.png`)).status, 404);
  });

  test('once published, files are public, with the headers that keep uploads harmless', async () => {
    await mod.post(`/api/items/${slug}/approve`);
    const item = (await ben.get(`/api/items/${slug}`)).body;
    assert.equal(item.file_key, undefined);
    assert.equal(item.preview, 'poster.png');
    const r = await ben.get(`/files/${slug}/poster.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.deepEqual(r.bytes, png());
    for (const name of ['ok.svg', 'ok.html']) {
      const csp = (await ben.get(`/files/${slug}/${name}`)).headers.get('content-security-policy');
      assert.match(csp, /^sandbox; default-src 'none'/, name);
    }
    const dl = await ben.get(`/files/${slug}/notes/readme.txt?download=1`);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="readme.txt"/);
    assert.equal((await ben.get(`/files/${slug}/missing.png`)).status, 404);
    assert.equal((await ben.get(`/files/${slug}/..%2F..%2Fdb.json`)).status, 404);
  });

  test('thumbnails', async () => {
    const r = await ben.get(`/files/${slug}/poster.png?w=32`);
    assert.equal(r.status, 200);
    if (hasSharp) {
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual([...r.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    } else assert.equal(r.headers.get('content-type'), 'image/png');
    // Only images are resized; a silly width is ignored.
    assert.equal((await ben.get(`/files/${slug}/notes/readme.txt?w=32`)).headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal((await ben.get(`/files/${slug}/poster.png?w=banana`)).headers.get('content-type'), 'image/png');
  });

  test('replacing a file of a published material sends it back to review', async () => {
    const r = await ben.req('PUT', `/api/items/${slug}/files/poster.png`, { raw: png(8, 8), headers: { 'X-Edit-Key': key } });
    assert.equal(r.status, 200);
    assert.equal((await ben.get(`/api/items/${slug}`)).status, 404);
    assert.equal((await ben.get(`/files/${slug}/poster.png`)).status, 404);
    assert.equal((await mod.get(`/api/items/${slug}`)).body.status, 'pending');
  });
});

describe('templates and forks', () => {
  let slug;
  test('a template gets the stock logos it refers to', async () => {
    ({ slug } = await addMaterial(mod, template('Table sign'), { 'template.html': TEMPLATE }));
    const item = (await ben.get(`/api/items/${slug}`)).body;
    assert.equal(item.status, 'published');
    assert.deepEqual(item.file_list.map((f) => f.path).sort(), ['logo-square-light.svg', 'logo-square.svg', 'logo-wide-light.svg', 'logo-wide.svg', 'template.html']);
    assert.match((await ben.get(`/files/${slug}/logo-square.svg`)).headers.get('content-type'), /image\/svg\+xml/);
  });
  test('a fork copies the files, links back and waits for review', async () => {
    const edited = TEMPLATE.replace('Curious about AI safety?', 'Come to our first meetup');
    const r = await anna.post(`/api/items/${slug}/fork`, { html: edited, title: 'Table sign for Bonn', group: 'AI Safety Bonn' });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'pending');
    const fork = (await anna.get(`/api/items/${r.body.slug}`)).body;
    assert.deepEqual([fork.forked_from, fork.source, fork.group, fork.parent.slug], [slug, 'adapted', 'AI Safety Bonn', slug]);
    assert.match((await anna.get(`/files/~${fork.file_key}/${fork.slug}/template.html`)).body, /Come to our first meetup/);
    assert.equal((await anna.get(`/files/~${fork.file_key}/${fork.slug}/logo-wide.svg`)).status, 200);
    await mod.post(`/api/items/${r.body.slug}/approve`);
    assert.deepEqual((await ben.get(`/api/items/${slug}`)).body.forks.map((f) => f.slug), [r.body.slug]);
    assert.equal((await ben.get('/api/items')).body.items.find((i) => i.slug === slug).forks, 1);
  });
  test('a fork with a script, or of something that is not a template, is refused', async () => {
    assert.equal((await anna.post(`/api/items/${slug}/fork`, { html: TEMPLATE.replace('</body>', '<script>x</script></body>') })).status, 400);
    assert.equal((await anna.post(`/api/items/${slug}/fork`, { html: 'short' })).status, 400);
    const plain = await addMaterial(mod, text('Not a template'));
    assert.match((await anna.post(`/api/items/${plain.slug}/fork`, { html: TEMPLATE })).body.error, /Only templates/);
  });
});

describe('featured', () => {
  test('moderators mark and unmark a material', async () => {
    const { slug } = await addMaterial(mod, text('Worth featuring'));
    assert.equal((await anna.post(`/api/items/${slug}/feature`, { featured: true })).status, 403);
    const on = await mod.post(`/api/items/${slug}/feature`, { featured: true });
    assert.deepEqual(on.body, { slug, featured: true });
    const listed = (await ben.get('/api/items')).body.items.find((i) => i.slug === slug);
    assert.equal(listed.featured, true);
    assert.ok(!Number.isNaN(Date.parse(listed.featured_at)));
    const off = await mod.post(`/api/items/${slug}/feature`, { featured: false });
    assert.equal(off.body.featured, false);
    assert.equal((await ben.get(`/api/items/${slug}`)).body.featured, false);
    assert.equal((await mod.post('/api/items/nothing-here/feature', {})).status, 404);
  });
  test('the flag survives an update of the material', async () => {
    const { slug } = await addMaterial(mod, text('Featured and edited'));
    await mod.post(`/api/items/${slug}/feature`, { featured: true });
    await mod.post('/api/items', text('Featured and edited', { slug, summary: 'New summary.' }));
    assert.equal((await ben.get(`/api/items/${slug}`)).body.featured, true);
  });
});

describe('kits', () => {
  test('rows keep material, example and order; the material is resolved when it is published', async () => {
    const sign = await addMaterial(mod, template('Kit table sign'), { 'template.html': TEMPLATE });
    const hidden = await addMaterial(anna, text('Not yet reviewed'));
    const kit = await addMaterial(mod, {
      title: 'Tabling kit',
      category: 'kit',
      kind: 'kit',
      summary: 'What to bring to a fair.',
      group: 'Test Group',
      kit: {
        est_cost: 'about EUR 120',
        items: [
          { name: 'Table sign', qty: 1, material: sign.slug },
          { name: 'Flyers', qty: '150-200', note: 'tri-fold', url: 'https://example.org/shop', example: { url: 'https://example.org/flyer' }, order: { subject: 'Print quote: [Quantity] flyers', body: 'Hello, we need [Quantity] flyers.' } },
          { name: 'Unreviewed thing', material: hidden.slug },
          { name: 'Bad example', example: { label: 'no url' }, order: { subject: 'no body' } },
        ],
      },
    });
    const item = (await ben.get(`/api/items/${kit.slug}`)).body;
    const [sign1, flyers, unreviewed, bare] = item.kit.items;
    assert.deepEqual(sign1, { name: 'Table sign', qty: '1', material: sign.slug, material_info: { title: 'Kit table sign', kind: 'template' } });
    assert.deepEqual(flyers.example, { url: 'https://example.org/flyer', label: 'See an example' });
    assert.deepEqual(flyers.order, { subject: 'Print quote: [Quantity] flyers', body: 'Hello, we need [Quantity] flyers.' });
    assert.equal(flyers.url, 'https://example.org/shop');
    assert.equal(unreviewed.material_info, undefined);
    assert.deepEqual(bare, { name: 'Bad example' });
    // The list view carries a short form.
    const listed = (await ben.get('/api/items?category=kit')).body.items.find((i) => i.slug === kit.slug);
    assert.deepEqual(listed.kit, { est_cost: 'about EUR 120', count: 4, first: ['Table sign', 'Flyers', 'Unreviewed thing', 'Bad example'] });
  });
  test('a kit row with a bad link is refused', async () => {
    const r = await anna.post('/api/items', { title: 'Kit', category: 'kit', kind: 'kit', summary: 's', kit: { items: [{ name: 'x', example: { url: 'ftp://example.org' } }] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /kit.items.example.url/);
  });
});
