// Turning a finished printable into a template happens on the organizer's computer: the site only hands out the
// converter and the template contract as files, and "commons convert" runs the converter locally.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADMIN, png, startApp, visitor } from './helper.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POPPLER = ['pdfinfo', 'pdftotext', 'pdftohtml', 'pdffonts', 'pdftocairo', 'pdftoppm'];
const hasPoppler = POPPLER.every((tool) => {
  try {
    execFileSync(tool, ['-v'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
});

// A one-page A5 PDF with a coloured bar and two lines of text in Helvetica (a standard font, not embedded).
function tinyPdf() {
  const content = '0.2 0.35 0.8 rg 0 495 420 100 re f\nBT /F1 30 Tf 0.1 0.1 0.1 rg 40 420 Td (Reading group kickoff) Tj ET\nBT /F1 14 Tf 0.1 0.1 0.1 rg 40 380 Td (Thursday at six, room two) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (Kickoff flyer) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('printables become templates on the organizer’s computer', () => {
  let app, anyone, work, env;
  // Runs the CLI as an organizer would. Returns { code, stdout, stderr }.
  const commons = (args, extra = {}) =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(root, 'cli', 'commons.mjs'), ...args], { cwd: work, env: { ...env, ...extra }, timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    });

  before(async () => {
    app = await startApp();
    anyone = visitor(app.base);
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-convert-test-'));
    fs.writeFileSync(path.join(work, 'config.json'), '{}');
    env = { PATH: process.env.PATH, HOME: work, COMMONS_URL: app.base, COMMONS_CONFIG: path.join(work, 'config.json'), COMMONS_CACHE: path.join(work, 'cache'), COMMONS_TOKEN: '', NO_COLOR: '1' };
  });
  after(async () => {
    await app.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('the server converts nothing', async () => {
    const r = await anyone.req('POST', '/api/convert', { raw: tinyPdf(), type: 'application/pdf' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Unknown API route.' });
    assert.equal((await visitor(app.base, { admin: true }).req('POST', '/api/convert?mode=rebuild', { raw: png(), type: 'image/png' })).status, 404);
    const meta = (await anyone.get('/api/meta')).body;
    assert.ok(!('conversion' in meta));
    assert.deepEqual([meta.semantic_search, meta.logos], [false, false]);
  });

  test('the converter is served as one file that needs only Node’s own modules', async () => {
    const r = await anyone.get('/cli/convert-pdf.mjs');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.match(r.body, /export async function pdfToTemplate\b/);
    assert.equal(r.body, fs.readFileSync(path.join(root, 'server', 'convert-pdf.js'), 'utf8'));
    // Every import is a Node built-in, except sharp, which is optional and loaded only if it is there.
    const imported = [...r.body.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm), ...r.body.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(imported.length > 3);
    assert.deepEqual(imported.filter((name) => !name.startsWith('node:')), ['sharp']);
    // The CLI asks again with the ETag and is told that nothing changed.
    const etag = r.headers.get('etag');
    assert.ok(etag);
    assert.equal((await anyone.get('/cli/convert-pdf.mjs', { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 304);
  });

  test('the template contract is served, and it names everything the editor fills in', async () => {
    const r = await anyone.get('/cli/TEMPLATE.md');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/markdown/);
    assert.ok(r.body.includes(app.base) && !r.body.includes('__DEFAULT_URL__'));
    for (const word of ['class="page"', '@page', '--brand-color', '--brand-font-heading', 'data-edit', 'data-brand=', 'survey_url', 'data-brand-own', 'data-brand-other', 'data-photo', 'data-qr', 'data-logo="wide"', 'data-logo-on="dark"', 'data-logo-slot="event"', 'data-logo-box', 'data-logo-for', '<image data-logo', 'Google Fonts']) {
      assert.ok(r.body.includes(word), word);
    }
    assert.ok(r.body.split('\n').length <= 130, 'the contract stays short');
    // The skill and /llms.txt point assistants to it.
    assert.ok((await anyone.get('/cli/SKILL.md')).body.includes(`${app.base}/cli/TEMPLATE.md`));
    assert.ok((await anyone.get('/llms.txt')).body.includes(`${app.base}/cli/TEMPLATE.md`));
  });

  test('"commons contract" prints the contract, and still has it when the site cannot be reached', async () => {
    const r = await commons(['contract']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^# Template contract/);
    assert.ok(r.stdout.includes('data-brand-other') && r.stdout.includes(app.base));
    const offline = await commons(['contract'], { COMMONS_URL: 'http://127.0.0.1:9' });
    assert.equal(offline.code, 0, offline.stderr);
    assert.match(offline.stdout, /^# Template contract/);
    assert.match(offline.stderr, /copy from/);
    assert.match((await commons(['help'])).stdout, /commons convert <flyer\.pdf>[\s\S]*commons contract/);
  });

  test('a picture is not converted: the CLI tells the assistant how to rebuild it by hand', async () => {
    fs.writeFileSync(path.join(work, 'poster.png'), png());
    const r = await commons(['convert', 'poster.png', '--out', 'poster-out']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /poster\.png is a picture/);
    assert.match(r.stdout, /commons contract/);
    assert.match(r.stdout, /commons add <folder>/);
    assert.ok(!fs.existsSync(path.join(work, 'poster-out')));
    assert.ok(!fs.existsSync(path.join(work, 'cache', 'convert-pdf.mjs')), 'nothing is downloaded for a picture');
    // Other files are refused with a hint, and so is a file that is not there.
    fs.writeFileSync(path.join(work, 'deck.pptx'), 'x');
    assert.match((await commons(['convert', 'deck.pptx'])).stderr, /Export slides and documents as PDF first/);
    assert.match((await commons(['convert', 'missing.pdf'])).stderr, /missing\.pdf not found/);
  });

  test('without poppler the CLI says how to install it', async () => {
    fs.writeFileSync(path.join(work, 'flyer.pdf'), tinyPdf());
    const empty = path.join(work, 'no-tools');
    fs.mkdirSync(empty);
    const r = await commons(['convert', 'flyer.pdf', '--out', 'never'], { PATH: empty });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /brew install poppler/);
    assert.match(r.stderr, /sudo apt install poppler-utils/);
    assert.match(r.stderr, /winget install oschwartz10612\.Poppler/);
    assert.match(r.stderr, /choco install poppler/);
    assert.ok(!fs.existsSync(path.join(work, 'never')));
  });

  test('"commons convert" turns a PDF into a template folder on this computer, and "commons add" shares it', { skip: hasPoppler ? false : 'poppler is not installed' }, async () => {
    fs.writeFileSync(path.join(work, 'kickoff-flyer.pdf'), tinyPdf());
    const r = await commons(['convert', 'kickoff-flyer.pdf', '--out', 'kickoff', '--title', 'Kickoff flyer, A5']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Downloaded the converter/);
    assert.match(r.stdout, /Converted, original design kept/);
    assert.match(r.stdout, /pages: 1, editable texts: [1-9]/);
    assert.match(r.stdout, /Check the logos yourself/);
    assert.match(r.stdout, /commons add kickoff/);
    // The converter was downloaded once into the CLI's cache folder, unchanged.
    const cached = path.join(work, 'cache', 'convert-pdf.mjs');
    assert.equal(fs.readFileSync(cached, 'utf8'), fs.readFileSync(path.join(root, 'server', 'convert-pdf.js'), 'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'cache', 'convert-pdf.json'), 'utf8')).url, app.base);

    const html = fs.readFileSync(path.join(work, 'kickoff', 'template.html'), 'utf8');
    assert.match(html, /<title>Kickoff flyer, A5<\/title>/);
    assert.match(html, /<section class="page"/);
    assert.match(html, /<meta name="commons:page" content="148\.\d+mm 209\.\d+mm">/);
    assert.match(html, /data-edit="[^"]+"[^>]*>Reading group kickoff</);
    assert.match(html, /--brand-color:/);
    assert.ok(!/<script/i.test(html));
    const item = JSON.parse(fs.readFileSync(path.join(work, 'kickoff', 'item.json'), 'utf8'));
    assert.deepEqual([item.kind, item.title, item.category, item.template.path, item.source], ['template', 'Kickoff flyer, A5', 'print', 'template.html', 'adapted']);

    // A second run uses the cached converter; --json gives the report.
    const again = await commons(['convert', 'kickoff-flyer.pdf', '--out', 'kickoff-2', '--logos', '--json']);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(!/Downloaded the converter/.test(again.stderr));
    const report = JSON.parse(again.stdout);
    assert.deepEqual([report.pages, report.method, report.logos_marked], [1, 'kept-original', 0]);
    assert.ok(report.report.text.elements >= 1);
    // After a day the CLI asks the site whether its copy changed: no download when it did not, a new one when it did.
    const stateFile = path.join(work, 'cache', 'convert-pdf.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, checked_at: '2020-01-01T00:00:00.000Z' }));
    const unchanged = await commons(['convert', 'kickoff-flyer.pdf', '--out', 'kickoff-2', '--json']);
    assert.equal(unchanged.code, 0, unchanged.stderr);
    assert.ok(!/Downloaded the converter/.test(unchanged.stderr));
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8')).checked_at) > Date.now() - 60000);
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, etag: 'W/"an-older-copy"', checked_at: '2020-01-01T00:00:00.000Z' }));
    fs.writeFileSync(cached, 'export async function pdfToTemplate() { throw new Error("an older copy"); }\n');
    const changed = await commons(['convert', 'kickoff-flyer.pdf', '--out', 'kickoff-2', '--json']);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stderr, /Downloaded the converter/);
    // Without the site, the copy that is there keeps working.
    fs.writeFileSync(stateFile, JSON.stringify({ url: 'http://127.0.0.1:9', etag: 'W/"x"', checked_at: '2020-01-01T00:00:00.000Z' }));
    const offline = await commons(['convert', 'kickoff-flyer.pdf', '--out', 'kickoff-3'], { COMMONS_URL: 'http://127.0.0.1:9' });
    assert.equal(offline.code, 0, offline.stderr);
    assert.match(offline.stderr, /Could not check for a newer converter/);
    assert.ok(fs.existsSync(path.join(work, 'kickoff-3', 'template.html')));

    // The folder is what "commons add" takes.
    const summary = 'A5 flyer for the first reading group evening of the semester.';
    fs.writeFileSync(path.join(work, 'kickoff', 'item.json'), JSON.stringify({ ...item, summary, group: 'Test Group' }));
    const added = await commons(['add', 'kickoff', '--json'], { COMMONS_TOKEN: ADMIN });
    assert.equal(added.code, 0, added.stderr);
    const [result] = JSON.parse(added.stdout);
    assert.equal(result.status, 'published');
    const stored = (await anyone.get(`/api/items/${result.slug}`)).body;
    assert.deepEqual([stored.kind, stored.template.path, stored.template.format], ['template', 'template.html', 'A5 portrait']);
    assert.equal((await anyone.get(`/files/${result.slug}/template.html`)).body, html);
  });
});
