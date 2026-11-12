#!/usr/bin/env node
// Checks server/convert-image.js against real printables that only exist as images.
//
//   node tools/convert-image-test.mjs [--out DIR] [--only NAME] [--fresh] [image.jpg ...]
//
// For every image it
//   1. converts it and writes the template folder <out>/<name>/ (template.html, photos/background.jpg, the default
//      logo files, report.json),
//   2. renders the template with headless Chrome at the pixel size of the original and compares the two:
//      SSIM (ffmpeg) and, for every text block, how far the rendered letters are from the original letters
//      (edges of the ink box, in px of the original; measured on a second render where every block has its own colour),
//   3. re-brands the template the way the editor does (brand variables as inline style on <html>, other fonts) and
//      checks that every text takes the new colour of its variable, that the fonts changed and that the layout holds
//      (text stays on the page, blocks do not run into each other),
//   4. lints the HTML against the template contract,
//   5. writes sheet.jpg: original | converted | re-branded, and compare.png: original | converted | difference.
// The answers of the two models are cached in <out>/_cache/<name>/ so that layout code can be tuned without calling
// them again; --fresh ignores the cache.
//
// Needs: ffmpeg, Google Chrome, Google Cloud application default credentials (unless everything is cached).
// Writes only below --out (default /private/tmp/claude-501/convert-image/out).

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { imageToTemplate } from '../server/convert-image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'seed');
const DEFAULT_FILES = [
  'poster-series-care-shape-together/poster-care.jpg',
  'poster-series-care-shape-together/poster-shape.jpg',
  'poster-series-care-shape-together/poster-together.jpg',
  'poster-series-care-shape-together/poster-back.jpg',
  'instagram-posts-poster-series/instagram-care.jpg',
  'instagram-posts-poster-series/instagram-shape.jpg',
  'instagram-posts-poster-series/instagram-together.jpg',
].map((f) => path.join(SEED, f));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REBRAND = {
  '--brand-color': '#b3261e',
  '--brand-accent': '#1b7f5c',
  '--brand-dark': '#3b1d0e',
  '--brand-light': '#ffe9c7',
  '--brand-on-color': '#ffffff',
  '--brand-on-accent': '#ffffff',
  '--brand-font-heading': "'Playfair Display', Georgia, serif",
  '--brand-font-body': "'Space Grotesk', system-ui, sans-serif",
};
const REBRAND_FONTS = 'https://fonts.googleapis.com/css?family=Playfair+Display:400,500,600,700,800|Space+Grotesk:400,500,600,700&display=swap';
// one colour per text block for the measuring render (told apart by the direction of the colour, so that
// anti-aliased edges on black still count for the right block)
const KEY_COLOURS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0], [0, 128, 255], [128, 255, 0], [255, 0, 128], [128, 0, 255], [0, 255, 128], [255, 255, 255], [255, 128, 128], [128, 255, 128], [128, 128, 255]];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args.splice(i, 2)[1];
};
const OUT = path.resolve(flag('--out') || '/private/tmp/claude-501/convert-image/out');
const only = flag('--only');
const fresh = args.includes('--fresh') && args.splice(args.indexOf('--fresh'), 1).length > 0;
const files = (args.length ? args.map((a) => path.resolve(a)) : DEFAULT_FILES).filter((f) => !only || f.includes(only));

function run(cmd, argv, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
  });
}

// Screenshot of the page at exactly width x height px.
async function chrome(htmlFile, target, width, height) {
  const profile = path.join(OUT, '_chrome-profile');
  await fs.rm(target, { force: true });
  await run(
    CHROME,
    ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--virtual-time-budget=20000', '--run-all-compositor-stages-before-draw', `--screenshot=${target}`, `--window-size=${width},${height + 200}`, '--force-device-scale-factor=1', pathToFileURL(htmlFile).href],
    240000,
  );
  const shot = await fs.readFile(target);
  await sharp(shot).extract({ left: 0, top: 0, width, height }).png().toFile(target);
}

async function ssim(a, b) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]ssim', '-f', 'null', '-']);
  const m = /All:([\d.]+)/.exec(stderr);
  return m ? parseFloat(m[1]) : NaN;
}

function lint(html) {
  const problems = [];
  if (/<script\b/i.test(html)) problems.push('contains <script>');
  if (!/<meta name="commons:page" content="[\d.]+(mm|px) [\d.]+(mm|px)">/.test(html)) problems.push('commons:page meta missing');
  if (!/<meta name="commons:format"/.test(html)) problems.push('commons:format meta missing');
  if ((html.match(/<section class="page"/g) || []).length !== 1) problems.push('expected one <section class="page">');
  for (const v of ['--brand-color', '--brand-accent', '--brand-dark', '--brand-light', '--brand-on-color', '--brand-on-accent', '--brand-font-heading', '--brand-font-body']) if (!new RegExp(`${v}:`).test(html)) problems.push(`${v} not declared`);
  for (const a of ['data-edit', 'data-photo']) {
    const keys = [...html.matchAll(new RegExp(`${a}="([^"]+)"`, 'g'))].map((m) => m[1]);
    if (new Set(keys).size !== keys.length) problems.push(`duplicate ${a} keys`);
  }
  if (!/<img[^>]+data-photo="background"[^>]+src="photos\/background\.jpg"/.test(html)) problems.push('background photo slot missing');
  const external = [...html.replace(/data:[^"')]+/g, '').matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('https://fonts.googleapis.com/'));
  if (external.length) problems.push(`external resources: ${external.slice(0, 3).join(', ')}`);
  const literal = [...html.replace(/:root{[^}]*}/, '').replace(/data:[^"')]+/g, '').matchAll(/color:\s*(#[0-9a-f]{3,8})/gi)].map((m) => m[1]).filter((c) => !/^#(fff|000|ffffff|000000)$/i.test(c));
  if (literal.length) problems.push(`literal text colours: ${[...new Set(literal)].join(', ')}`);
  return problems;
}

const inject = (html, { css = '', rootStyle = '', link = '' }) =>
  html.replace('<html ', `<html ${rootStyle ? `style="${rootStyle}" ` : ''}`).replace('</head>', `${link ? `<link rel="stylesheet" href="${link.replace(/&/g, '&amp;')}">` : ''}<style>${css}</style></head>`);

// Ink boxes of every text block in a "key" render (black page, each block in its own colour).
async function keyBoxes(file, texts, W, H) {
  const { data } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const dirs = KEY_COLOURS.map((c) => {
    const n = Math.hypot(...c);
    return c.map((v) => v / n);
  });
  const boxes = texts.map(() => ({ x0: W, y0: H, x1: -1, y1: -1, n: 0 }));
  const owner = new Int16Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = (y * W + x) * 3;
    const r = data[q];
    const g = data[q + 1];
    const b = data[q + 2];
    if (Math.max(r, g, b) < 128) continue; // at least half covered
    const n = Math.hypot(r, g, b);
    let best = 0;
    let bestDot = -1;
    for (let i = 0; i < Math.min(dirs.length, texts.length); i++) {
      const dot = (r * dirs[i][0] + g * dirs[i][1] + b * dirs[i][2]) / n;
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
    const bx = boxes[best];
    bx.n++;
    owner[y * W + x] = best;
    if (x < bx.x0) bx.x0 = x;
    if (x > bx.x1) bx.x1 = x;
    if (y < bx.y0) bx.y0 = y;
    if (y > bx.y1) bx.y1 = y;
  }
  return { boxes: boxes.map((b) => (b.n ? { x: b.x0, y: b.y0, w: b.x1 + 1 - b.x0, h: b.y1 + 1 - b.y0 } : null)), owner };
}

const keyCss = (texts) =>
  `.bg,.logo,.qr{visibility:hidden!important}.page,body{background:#000!important}` + texts.map((t, i) => `[data-edit="${t.key}"]{color:rgb(${KEY_COLOURS[i % KEY_COLOURS.length].join(',')})!important}`).join('');

const results = [];
await fs.mkdir(OUT, { recursive: true });
for (const file of files) {
  const name = path.basename(file).replace(/\.\w+$/, '');
  const dir = path.join(OUT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'photos'), { recursive: true });
  const row = { file: path.relative(ROOT, file), name };
  results.push(row);
  try {
    const cacheDir = path.join(OUT, '_cache', name);
    if (fresh) await fs.rm(cacheDir, { recursive: true, force: true });
    const source = await fs.readFile(file);
    const t0 = Date.now();
    const { html, files: outFiles, report } = await imageToTemplate(source, /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', { cacheDir });
    row.ms = Date.now() - t0;
    const W = report.source.width;
    const H = report.source.height;
    const htmlFile = path.join(dir, 'template.html');
    await fs.writeFile(htmlFile, html);
    for (const f of outFiles) await fs.writeFile(path.join(dir, f.path), f.buffer);
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    for (const logo of ['logo-wide.svg', 'logo-wide-light.svg', 'logo-square.svg', 'logo-square-light.svg']) await fs.copyFile(path.join(ROOT, 'public', 'assets', 'brand', logo), path.join(dir, logo));
    Object.assign(row, {
      size: [W, H],
      page: report.page.size,
      modelCalls: report.models.calls,
      timings: report.timings,
      texts: report.texts.length,
      editable: report.editable,
      logos: report.logos.length,
      qrCodes: report.qrCodes.length,
      background: { px: [report.background.width, report.background.height], kb: Math.round(report.background.bytes / 1024), quality: report.background.quality, repainted: report.background.repaintedShare, repaintedFirstPass: report.background.repaintedShareBeforeTightening },
      fonts: { heading: report.fonts.heading?.family, body: report.fonts.body?.family },
      colours: Object.fromEntries(Object.entries(report.colors.variables).map(([k, v]) => [k, v.value])),
      warnings: report.warnings,
      lint: lint(html),
    });

    // ---- fidelity: the page at the original's pixel size
    const sized = `body{margin:0!important;background:#fff!important}.page{margin:0!important;width:${W}px!important;height:${H}px!important}`;
    const original = path.join(dir, 'original.png');
    await sharp(source).rotate().flatten({ background: '#ffffff' }).png().toFile(original);
    const render = async (label, opts) => {
      const f = path.join(dir, `_${label}.html`);
      await fs.writeFile(f, inject(html, opts));
      const png = path.join(dir, `${label}.png`);
      await chrome(f, png, W, H);
      await fs.rm(f);
      return png;
    };
    const converted = await render('converted', { css: sized });
    row.ssim = +(await ssim(original, converted)).toFixed(4);
    const convertedKey = await render('converted-key', { css: sized + keyCss(report.texts) });
    const base = await keyBoxes(convertedKey, report.texts, W, H);
    row.blocks = report.texts.map((t, i) => {
      const b = base.boxes[i];
      const [x, y, w, h] = t.box.px;
      if (!b) return { key: t.key, error: 'not rendered' };
      return { key: t.key, text: t.lines.join(' / ').slice(0, 40), fontPx: t.fontSizePx, weight: t.weight, left: b.x - x, right: b.x + b.w - (x + w), top: b.y - y, bottom: b.y + b.h - (y + h) };
    });
    const worst = Math.max(0, ...row.blocks.map((b) => (b.error ? 999 : Math.max(Math.abs(b.left), Math.abs(b.right), Math.abs(b.top), Math.abs(b.bottom)))));
    row.worstEdgePx = worst;

    // ---- re-brand
    const rootStyle = Object.entries(REBRAND).map(([k, v]) => `${k}:${v}`).join(';');
    const rebranded = await render('rebranded', { css: sized, rootStyle, link: REBRAND_FONTS });
    const rebrandedKey = await render('rebranded-key', { css: sized + keyCss(report.texts), rootStyle, link: REBRAND_FONTS });
    const re = await keyBoxes(rebrandedKey, report.texts, W, H);
    const reData = (await sharp(rebranded).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    const keyData = (await sharp(rebrandedKey).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const checks = report.texts.map((t, i) => {
      const b = re.boxes[i];
      if (!b) return { key: t.key, ok: false, why: 'not rendered' };
      // colour of the fully covered letter pixels in the re-branded render
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        const p = y * W + x;
        if (re.owner[p] !== i || Math.max(keyData[p * 3], keyData[p * 3 + 1], keyData[p * 3 + 2]) < 250) continue;
        sum[0] += reData[p * 3];
        sum[1] += reData[p * 3 + 1];
        sum[2] += reData[p * 3 + 2];
        n++;
      }
      const seen = sum.map((v) => Math.round(v / Math.max(1, n)));
      const variable = /var\((--[a-z-]+)\)/.exec(t.colourCss)?.[1];
      const want = variable ? unhex(REBRAND[variable]) : null;
      const colourOk = want ? Math.hypot(seen[0] - want[0], seen[1] - want[1], seen[2] - want[2]) < 40 : null;
      const before = base.boxes[i];
      const widthChange = before ? b.w / before.w : null;
      const onPage = b.x > 0 && b.y > 0 && b.x + b.w < W && b.y + b.h < H;
      return { key: t.key, variable, colourOk, widthChange: widthChange && +widthChange.toFixed(3), onPage, shift: before ? [Math.round(b.x + b.w / 2 - (before.x + before.w / 2)), Math.round(b.y + b.h / 2 - (before.y + before.h / 2))] : null, box: b };
    });
    // blocks whose boxes run into each other after re-branding, unless they already do in the original design
    const cross = (a, b) => a && b && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2;
    const overlaps = [];
    for (let i = 0; i < checks.length; i++) for (let j = i + 1; j < checks.length; j++) {
      if (cross(checks[i].box, checks[j].box) && !cross(base.boxes[i], base.boxes[j])) overlaps.push(`${checks[i].key} x ${checks[j].key}`);
    }
    row.rebrand = {
      coloursFollow: checks.every((c) => c.colourOk !== false),
      fontsChanged: (() => {
        // share of letter pixels that are not the same in the two renders
        let ink = 0;
        let moved = 0;
        for (let p = 0; p < W * H; p++) {
          if (base.owner[p] < 0 && re.owner[p] < 0) continue;
          ink++;
          if (base.owner[p] !== re.owner[p]) moved++;
        }
        return ink > 0 && moved / ink > 0.1;
      })(),
      allOnPage: checks.every((c) => c.onPage),
      overlaps,
      blocks: checks.map(({ box, ...c }) => c),
    };

    // ---- pictures to look at
    const hh = 1300;
    const ww = Math.round((hh * W) / H);
    const tiles = await Promise.all([original, converted, rebranded].map((f) => sharp(f).resize(ww, hh, { fit: 'fill' }).toBuffer()));
    await sharp({ create: { width: ww * 3 + 20, height: hh, channels: 3, background: '#888888' } })
      .composite(tiles.map((input, i) => ({ input, left: i * (ww + 10), top: 0 })))
      .jpeg({ quality: 88 })
      .toFile(path.join(dir, 'sheet.jpg'));
    await run('ffmpeg', ['-hide_banner', '-y', '-i', original, '-i', converted, '-filter_complex', '[0:v]format=rgb24,split=2[a1][a2];[1:v]format=rgb24,split=2[b1][b2];[a2][b2]blend=all_mode=difference,negate[d];[a1][b1][d]hstack=inputs=3,scale=min(iw\\,3000):-2', '-frames:v', '1', '-update', '1', path.join(dir, 'compare.png')]);
    // blink test for the eye: the converted text in red over the original
    const keyGrey = await sharp(convertedKey).greyscale().threshold(60).toColourspace('b-w').raw().toBuffer();
    const overlay = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) if (keyGrey[i]) overlay.set([255, 0, 0, 120], i * 4);
    const laid = await sharp(original).composite([{ input: overlay, raw: { width: W, height: H, channels: 4 } }]).png({ compressionLevel: 1 }).toBuffer();
    await sharp(laid).resize(1500, 1500, { fit: 'inside' }).jpeg({ quality: 85 }).toFile(path.join(dir, 'overlay.jpg'));
  } catch (e) {
    row.error = e.message;
    console.error(`FAILED ${name}: ${e.stack || e.message}`);
  }
  console.log(
    `${name}: ${row.error ? 'ERROR ' + row.error : `ssim ${row.ssim}, ${row.texts} text block(s), ${row.logos} logo(s), ${row.qrCodes} QR, worst text edge ${row.worstEdgePx} px, background ${row.background.px.join('x')} ${row.background.kb} KB q${row.background.quality} (${Math.round(row.background.repainted * 100)}% repainted), ${row.ms} ms, ${row.modelCalls} model call(s)`}`,
  );
}
await fs.rm(path.join(OUT, '_chrome-profile'), { recursive: true, force: true });
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nResults: ${path.join(OUT, 'results.json')}`);
for (const r of results) {
  if (r.error) continue;
  console.log(`\n== ${r.name}  (${r.size.join(' x ')} px -> ${r.page})`);
  console.log(`   fonts   heading ${r.fonts.heading}, body ${r.fonts.body}`);
  console.log(`   colours ${JSON.stringify(r.colours)}`);
  for (const b of r.blocks) console.log(`   ${b.key.padEnd(14)} ${b.error || `${String(b.fontPx).padStart(6)} px w${b.weight}  edges L${b.left} R${b.right} T${b.top} B${b.bottom}   "${b.text}"`}`);
  console.log(`   rebrand colours follow: ${r.rebrand.coloursFollow}, fonts changed: ${r.rebrand.fontsChanged}, all on page: ${r.rebrand.allOnPage}, overlaps: ${r.rebrand.overlaps.join(', ') || 'none'}`);
  if (r.lint.length) console.log(`   LINT: ${r.lint.join('; ')}`);
  for (const w of r.warnings) console.log(`   ! ${w}`);
}
