// The MCP endpoint (POST /mcp, JSON-RPC 2.0): what assistants use.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEMPLATE, addMaterial, startApp, template, text, visitor } from './helper.js';

let app, mod, client, textSlug, templateSlug, pendingSlug;
let id = 0;
const rpc = async (method, params, v = client) => (await v.post('/mcp', { jsonrpc: '2.0', id: ++id, method, params })).body;
// The text content of a tool result, parsed when it is JSON.
const call = async (name, args, v = client) => {
  const r = await rpc('tools/call', { name, arguments: args }, v);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const out = r.result.content[0].text;
  let data = out;
  try {
    data = JSON.parse(out);
  } catch {}
  return { data, isError: r.result.isError };
};

before(async () => {
  app = await startApp();
  mod = visitor(app.base, { admin: true });
  client = visitor(app.base);
  textSlug = (await addMaterial(mod, text('Professor outreach email', { summary: 'Ask for five minutes in a lecture.' }))).slug;
  templateSlug = (await addMaterial(mod, template('Table sign with QR code'), { 'template.html': TEMPLATE })).slug;
  await mod.post(`/api/items/${templateSlug}/feature`, { featured: true });
  pendingSlug = (await addMaterial(visitor(app.base), text('Unreviewed professor letter'))).slug;
});
after(() => app.stop());

describe('protocol', () => {
  test('initialize answers with the requested version, or the newest one it knows', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(r.jsonrpc, '2.0');
    assert.equal(r.id, id);
    assert.equal(r.result.protocolVersion, '2025-03-26');
    assert.equal(r.result.serverInfo.name, 'groups-commons');
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.match(r.result.instructions, /search_materials/);
    assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  });
  test('tools/list describes the five tools', async () => {
    const { tools } = (await rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name), ['search_materials', 'get_material', 'customize_template', 'get_template_html', 'share_material']);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 40);
    }
    assert.deepEqual(tools.find((t) => t.name === 'share_material').inputSchema.required, ['title', 'kind', 'category', 'summary', 'group']);
  });
  test('ping and the empty lists', async () => {
    assert.deepEqual((await rpc('ping')).result, {});
    assert.deepEqual((await rpc('resources/list')).result, { resources: [] });
    assert.deepEqual((await rpc('prompts/list')).result, { prompts: [] });
  });
  test('notifications get no body', async () => {
    const r = await client.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(r.status, 202);
    assert.equal(r.bytes.length, 0);
  });
  test('errors: unknown method, unknown tool, not JSON-RPC, not JSON', async () => {
    assert.deepEqual((await rpc('tools/destroy')).error, { code: -32601, message: 'Method not found: tools/destroy' });
    assert.equal((await rpc('tools/call', { name: 'drop_database', arguments: {} })).error.code, -32602);
    for (const name of ['constructor', '__proto__', 'toString']) assert.equal((await rpc('tools/call', { name, arguments: {} })).error.code, -32602, name);
    assert.equal((await client.post('/mcp', { id: 1, method: 'ping' })).body.error.code, -32600);
    assert.equal((await client.post('/mcp', { jsonrpc: '2.0', id: 1 })).body.error.code, -32600);
    assert.equal((await client.req('POST', '/mcp', { raw: '{not json', type: 'application/json' })).status, 400);
  });
  test('batches: answers for the calls, nothing for notifications, and an upper bound', async () => {
    const r = await client.post('/mcp', [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }]);
    assert.deepEqual(r.body.map((m) => m.id), ['a', 'b']);
    assert.equal(r.body[1].error.code, -32601);
    assert.equal((await client.post('/mcp', [{ jsonrpc: '2.0', method: 'notifications/initialized' }])).status, 202);
    const many = await client.post('/mcp', Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })));
    assert.equal(many.status, 400);
    assert.equal(many.body.error.code, -32600);
  });
  test('only POST; other sites may call it', async () => {
    const get = await client.get('/mcp');
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
    const options = await client.req('OPTIONS', '/mcp');
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');
  });
});

describe('tools', () => {
  test('search_materials finds published materials only', async () => {
    const { data } = await call('search_materials', { query: 'professor' });
    assert.equal(data.search, 'keyword');
    assert.deepEqual(data.materials.map((m) => m.slug), [textSlug]);
    assert.equal(data.materials[0].url, `${app.base}/m/${textSlug}`);
    assert.ok(!JSON.stringify(data).includes(pendingSlug));
  });
  test('search_materials without a query lists the best rated, with filters', async () => {
    const all = (await call('search_materials', {})).data;
    assert.equal(all.search, 'best rated');
    assert.equal(all.count, 2);
    const print = (await call('search_materials', { category: 'print', limit: 1 })).data;
    assert.deepEqual(print.materials.map((m) => m.slug), [templateSlug]);
    assert.equal(print.materials[0].featured_by_moderators, true);
    assert.equal(print.materials[0].format, 'A4 portrait');
  });
  test('get_material returns the full text and counts a use', async () => {
    const { data } = await call('get_material', { slug: textSlug });
    assert.equal(data.versions[0].body, 'Body of Professor outreach email with a [Placeholder].');
    assert.match(data.how_to_customize, /Placeholders/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await mod.get(`/api/items/${textSlug}`)).body.uses, 1);
  });
  test('get_material on a template lists its editable and brand fields', async () => {
    const { data } = await call('get_material', { slug: templateSlug });
    assert.deepEqual(data.editable_fields, [{ key: 'headline', text: 'Curious about AI safety?' }, { key: 'sub', text: 'Join our reading group.' }]);
    assert.deepEqual(data.brand_fields_used, ['group_name', 'join_url']);
  });
  test('customize_template builds a link with the brand and the known edits', async () => {
    const { data } = await call('customize_template', { slug: templateSlug, brand: { group_name: 'AI Safety Bonn', color: '#0055aa', empty: '  ', number: 5 }, edits: { headline: 'Come along', unknown_field: 'x' } });
    const url = new URL(data.open_url);
    assert.equal(url.origin + url.pathname, `${app.base}/m/${templateSlug}`);
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.deepEqual(JSON.parse(hash.get('brand')), { group_name: 'AI Safety Bonn', color: '#0055aa' });
    assert.deepEqual(JSON.parse(hash.get('edits')), { headline: 'Come along' });
    assert.deepEqual(data.ignored_edit_keys, ['unknown_field']);
    assert.deepEqual(data.applied, { brand: ['group_name', 'color'], edits: ['headline'] });
  });
  test('get_template_html returns the file', async () => {
    const { data } = await call('get_template_html', { slug: templateSlug });
    assert.equal(data, TEMPLATE);
  });
  test('share_material goes to review and is then readable', async () => {
    const shared = (await call('share_material', { title: 'WhatsApp reminder for volunteers', kind: 'text', category: 'message', summary: 'A short reminder.', group: 'AI Safety Bonn', variants: [{ channel: 'whatsapp', body: 'See you at [Time]!' }] })).data;
    assert.equal(shared.status, 'pending');
    assert.match(shared.note, /after a moderator approved it/);
    assert.equal((await call('get_material', { slug: shared.slug })).isError, true, 'not public before review');
    const stored = (await mod.get(`/api/items/${shared.slug}`)).body;
    assert.deepEqual([stored.status, stored.source, stored.provenance], ['pending', 'original', 'Shared through an AI assistant.']);
    await mod.post(`/api/items/${shared.slug}/approve`);
    assert.equal((await call('get_material', { slug: shared.slug })).data.versions[0].channel, 'whatsapp');
  });
  test('share_material takes a template with its HTML, and refuses scripts', async () => {
    const meta = { title: 'Shared sign', kind: 'template', category: 'print', summary: 'A sign.', group: 'AI Safety Bonn', forked_from: templateSlug };
    const ok = (await call('share_material', { ...meta, template_html: TEMPLATE })).data;
    assert.equal(ok.status, 'pending');
    const stored = (await mod.get(`/api/items/${ok.slug}`)).body;
    assert.deepEqual([stored.template.format, stored.source, stored.forked_from], ['A4 portrait', 'adapted', templateSlug]);
    const bad = await call('share_material', { ...meta, template_html: TEMPLATE.replace('</body>', '<script>x</script></body>') });
    assert.equal(bad.isError, true);
    assert.match(bad.data, /<script> is not allowed/);
  });
  test('tool errors come back as results the assistant can read', async () => {
    const cases = [
      ['get_material', { slug: 'no-such-thing' }, /No material with the slug/],
      ['get_material', { slug: pendingSlug }, /No material with the slug/],
      ['get_material', {}, /No material with the slug/],
      ['customize_template', { slug: textSlug }, /not a customizable template/],
      ['get_template_html', { slug: textSlug }, /No customizable template/],
      ['share_material', { title: 'x', kind: 'file', category: 'print', summary: 's', group: 'g' }, /kind must be one of/],
      ['share_material', { title: 'x', kind: 'template', category: 'print', summary: 's', group: 'g' }, /needs template_html/],
      ['share_material', { kind: 'text', category: 'message', summary: 's', group: 'g' }, /Missing "title"/],
    ];
    for (const [name, args, pattern] of cases) {
      const r = await call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.data, pattern);
    }
  });
  test('an internal failure is not described to the assistant', async () => {
    const original = app.store.readFile;
    app.store.readFile = async () => {
      throw Object.assign(new Error('7 PERMISSION_DENIED: Missing permissions on projects/secret-project/databases/commons'), { code: 7 });
    };
    try {
      const r = await call('get_template_html', { slug: templateSlug });
      assert.equal(r.isError, true);
      assert.equal(r.data, 'The commons could not answer right now.');
    } finally {
      app.store.readFile = original;
    }
  });
  test('sharing through an assistant has the same hourly allowance as the web form', async () => {
    const eager = visitor(app.base);
    const meta = (n) => ({ title: `Bulk ${n}`, kind: 'link', category: 'demo', summary: 's', group: 'g', link: { url: 'https://example.org' } });
    for (let n = 0; n < 60; n++) assert.equal((await call('share_material', meta(n), eager)).isError, false, `call ${n}`);
    const over = await call('share_material', meta(61), eager);
    assert.equal(over.isError, true);
    assert.match(over.data, /Too many requests/);
  });
});
