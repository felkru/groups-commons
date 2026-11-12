#!/usr/bin/env node
// Checks server/convert-pdf.js against real printables.
//
//   node tools/convert-test.mjs [--out DIR] [--only NAME] [--screenshot] [--legacy] [--max-pages N] [file.pdf ...]
//
// For every PDF it
//   1. converts it and writes <name>.html and <name>.report.json,
//   2. prints the HTML with headless Chrome (the way an organizer exports it) and compares every page with the
//      original page rendered by pdftoppm at the same pixel size: SSIM (ffmpeg) and a picture
//      "original | converted | difference" (<name>-p<N>-compare.png),
//   3. re-brands the template the way the editor does (brand variables as inline style on <html>, other fonts),
//      retypes the first editable line and checks that the print contains the new text in the new fonts and that
//      the brand colour changed (<name>-p<N>-rebrand.png: original | re-branded),
//   4. lints the HTML against the template contract.
// With --screenshot the comparison uses a Chrome screenshot (what the editor shows) instead of the print.
// With --legacy the SVG of pdftocairo is first rewritten into the form cairo 1.16 writes (Debian 12, the production
// image: <symbol id="glyph0-1">, paints in style="..."), to exercise that code path on a machine with cairo 1.18.
// It is an imitation of that format, not the real thing: run this tool once inside the container as well.
//
// Needs: poppler-utils, ffmpeg, Google Chrome. Writes only below --out (default /private/tmp/claude-501/convert-pdf/out).

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pdfToTemplate } from '../server/convert-pdf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'seed');
const DEFAULT_FILES = [
  'welcome-signs-portrait/welcome-signs-portrait.pdf',
  'speaker-time-cards/speaker-time-cards.pdf',
  'buffet-dish-cards/buffet-dish-cards-a4.pdf',
  'blank-name-badges-a4/blank-name-badges-a4.pdf',
  'rollup-banner-print-file/rollup-banner-80x200cm.pdf',
  'wayfinding-signage-pack/wayfinding-signs-all.pdf',
  'semester-overview-deck/semester-overview-deck.pdf',
  'trifold-flyer-print-files/trifold-flyer.pdf',
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
const REBRAND_FONTS = 'https://fonts.googleapis.com/css?family=Playfair+Display:400,500,600,700,800|Space+Grotesk:400,500,600,700,800&display=swap';
const RETYPED = 'Retyped line 42';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args.splice(i, 2)[1];
};
const OUT = path.resolve(flag('--out') || '/private/tmp/claude-501/convert-pdf/out');
const only = flag('--only');
const maxPages = Number(flag('--max-pages')) || undefined;
const screenshot = args.includes('--screenshot') && args.splice(args.indexOf('--screenshot'), 1).length > 0;
const legacy = args.includes('--legacy') && args.splice(args.indexOf('--legacy'), 1).length > 0;
const toCairo116 = (svg) =>
  svg
    .replace(/<g id="glyph-(\d+)-(\d+)">\n(<path d="[^"]*"\/>\n)?<\/g>/g, (_, a, b, d) => `<symbol overflow="visible" id="glyph${a}-${b}">\n${d ? d.replace('<path ', '<path style="stroke:none;" ') : '<path style="stroke:none;" d=""/>\n'}</symbol>`)
    .replace(/xlink:href="#glyph-(\d+)-(\d+)"/g, 'xlink:href="#glyph$1-$2"')
    .replace(/<(g|path|rect)((?:\s(?:fill-rule|clip-rule)="[^"]*")?)\s(fill|stroke)="(rgb\([^)]*\))"\s(?:fill|stroke)-opacity="([^"]*)"/g, (_, tag, rule, prop, rgb, op) => `<${tag}${rule} style="${prop}:${rgb.replace(/, /g, ',')};${prop}-opacity:${op};"`);
const files = (args.length ? args.map((a) => path.resolve(a)) : DEFAULT_FILES).filter((f) => !only || f.includes(only));

function run(cmd, argv, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
  });
}

async function chrome(htmlFile, target, { width, height } = {}) {
  const profile = path.join(OUT, '_chrome-profile');
  const common = ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--virtual-time-budget=20000', '--run-all-compositor-stages-before-draw'];
  const mode = target.endsWith('.pdf') ? [`--print-to-pdf=${target}`, '--no-pdf-header-footer'] : [`--screenshot=${target}`, `--window-size=${width},${height}`, '--force-device-scale-factor=1'];
  await fs.rm(target, { force: true });
  await run(CHROME, [...common, ...mode, pathToFileURL(htmlFile).href], 240000);
  await fs.access(target);
}

async function ssim(a, b) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim', '-f', 'null', '-']);
  const m = /All:([\d.]+)/.exec(stderr);
  return m ? parseFloat(m[1]) : NaN;
}

// original | converted | difference (white = same)
async function compareImage(a, b, target) {
  await run('ffmpeg', ['-hide_banner', '-y', '-i', a, '-i', b, '-filter_complex', '[0:v]format=rgb24,split=2[a1][a2];[1:v]format=rgb24,split=2[b1][b2];[a2][b2]blend=all_mode=difference,negate[d];[a1][b1][d]hstack=inputs=3,scale=min(iw\\,3000):-2', '-frames:v', '1', '-update', '1', target]);
}
async function sideBySide(list, target) {
  await run('ffmpeg', ['-hide_banner', '-y', ...list.flatMap((f) => ['-i', f]), '-filter_complex', `${list.map((_, i) => `[${i}:v]format=rgb24[v${i}]`).join(';')};${list.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${list.length},scale=min(iw\\,3000):-2`, '-frames:v', '1', '-update', '1', target]);
}

// pdftocairo is the default rasteriser for both sides: pdftoppm (Splash) snaps images to whole pixels, so the same
// picture placed through one more transform lands one pixel off and a perfect copy scores about 0.93.
// Both sides are rendered at the same resolution (never scaled to fit) and then cut or padded to w x h, because the
// page Chrome prints can be a fraction of a point smaller than the original.
async function raster(pdf, page, target, w, h, tool = 'pdftocairo') {
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec((await run('pdfinfo', ['-f', String(page), '-l', String(page), pdf])).stdout.replace(/Page\s+\d+ size/, 'Page size'));
  const dpi = (Math.max(w, h) * 72) / Math.max(+size[1], +size[2], 1);
  const raw = target.replace(/\.png$/, '.raw');
  await run(tool, ['-png', '-f', String(page), '-l', String(page), '-singlefile', '-r', dpi.toFixed(4), pdf, raw]);
  await run('ffmpeg', ['-hide_banner', '-y', '-i', `${raw}.png`, '-vf', `crop=min(iw\\,${w}):min(ih\\,${h}):0:0,pad=${w}:${h}:0:0:white,format=rgb24`, '-frames:v', '1', '-update', '1', target]);
  await fs.rm(`${raw}.png`);
}

// Baselines of the text on a page: Map of y (points, 2 decimals) -> smallest x of a glyph on that baseline.
// Read from the glyph positions pdftocairo writes into an SVG, so it measures the print itself, not a raster.
async function baselines(pdf, page, tmp) {
  await run('pdftocairo', ['-svg', '-f', String(page), '-l', String(page), pdf, tmp]);
  const svg = await fs.readFile(tmp, 'utf8');
  await fs.rm(tmp);
  const map = new Map();
  for (const m of svg.matchAll(/<use xlink:href="#glyph[^"]*" x="([\d.-]+)" y="([\d.-]+)"\/>/g)) {
    const y = Math.round(+m[2] * 100) / 100;
    const cur = map.get(y);
    map.set(y, { x: Math.min(cur?.x ?? Infinity, +m[1]), n: (cur?.n || 0) + 1 });
  }
  return [...map].filter(([, v]) => v.n >= 2).map(([y, v]) => ({ y, x: v.x }));
}
// Largest distance (points) between a baseline of the original and the nearest baseline of the print.
function baselineError(original, printed) {
  let dy = 0;
  let dx = 0;
  let missing = 0;
  for (const o of original) {
    const near = printed.reduce((best, p) => (Math.abs(p.y - o.y) + Math.abs(p.x - o.x) * 0.01 < Math.abs(best.y - o.y) + Math.abs(best.x - o.x) * 0.01 ? p : best), { y: Infinity, x: 0 });
    if (Math.abs(near.y - o.y) > 3) missing++;
    else {
      dy = Math.max(dy, Math.abs(near.y - o.y));
      dx = Math.max(dx, Math.abs(near.x - o.x));
    }
  }
  return { lines: original.length, maxBaselineShiftPt: +dy.toFixed(2), maxLineStartShiftPt: +dx.toFixed(2), linesNotFound: missing };
}

// share of pixels within 24 levels of a colour (from a small PPM render)
async function colourShare(pdf, page, colours) {
  const { stdout } = await new Promise((resolve, reject) => execFile('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '300', pdf], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (e, so) => (e ? reject(e) : resolve({ stdout: so }))));
  const head = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(stdout.subarray(0, 40).toString('latin1'));
  if (!head) return colours.map(() => 0);
  const data = stdout.subarray(head[0].length);
  const total = +head[1] * +head[2];
  return colours.map((c) => {
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < total * 3; i += 3) if (Math.abs(data[i] - rgb[0]) < 24 && Math.abs(data[i + 1] - rgb[1]) < 24 && Math.abs(data[i + 2] - rgb[2]) < 24) n++;
    return n / total;
  });
}

function lint(html, pages) {
  const problems = [];
  if (/<script\b/i.test(html)) problems.push('contains <script>');
  if (!/<meta name="commons:page" content="[\d.]+mm [\d.]+mm">/.test(html)) problems.push('commons:page meta missing');
  if (!/<meta name="commons:format"/.test(html)) problems.push('commons:format meta missing');
  if ((html.match(/<section class="page"/g) || []).length !== pages) problems.push('number of <section class="page"> differs from pages');
  for (const v of ['--brand-color', '--brand-accent', '--brand-dark', '--brand-light', '--brand-on-color', '--brand-on-accent', '--brand-font-heading', '--brand-font-body']) if (!new RegExp(`${v}:`).test(html)) problems.push(`${v} not declared`);
  for (const a of ['data-edit', 'data-photo']) {
    const keys = [...html.matchAll(new RegExp(`${a}="([^"]+)"`, 'g'))].map((m) => m[1]);
    if (new Set(keys).size !== keys.length) problems.push(`duplicate ${a} keys`);
  }
  const external = [...html.replace(/data:[^"')]+/g, '').matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('https://fonts.googleapis.com/'));
  if (external.length) problems.push(`external resources: ${external.slice(0, 3).join(', ')}`);
  const ids = [...html.replace(/data:[^"')]+/g, '').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) problems.push('duplicate element ids');
  return problems;
}

const flat = (t) => t.replace(/\s+/g, ' ').trim();
const results = [];
await fs.mkdir(OUT, { recursive: true });
for (const file of files) {
  const name = path.basename(file, '.pdf');
  const dir = path.join(OUT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const row = { file: path.relative(ROOT, file), name };
  results.push(row);
  try {
    const t0 = Date.now();
    const { html, pages, report } = await pdfToTemplate(await fs.readFile(file), { ...(legacy ? { svgFilter: toCairo116 } : {}), ...(maxPages ? { maxPages } : {}) });
    row.ms = Date.now() - t0;
    const htmlFile = path.join(dir, `${name}.html`);
    await fs.writeFile(htmlFile, html);
    await fs.writeFile(path.join(dir, `${name}.report.json`), JSON.stringify(report, null, 2));
    Object.assign(row, {
      pages,
      sourcePages: report.source.pages,
      htmlKb: Math.round(html.length / 1024),
      pdfKb: Math.round(report.source.bytes / 1024),
      textLines: report.text.lines,
      editable: report.text.elements,
      outlinedGlyphs: report.text.glyphsLeftAsOutlines,
      photos: report.images.filter((i) => i.slot).length,
      otherImages: report.images.filter((i) => !i.slot).map((i) => i.kind),
      colours: Object.fromEntries(Object.entries(report.colors.variables).map(([k, v]) => [k, v.original])),
      fonts: report.fonts.filter((f) => f.lines).map((f) => `${f.family} ${f.weight}${f.italic ? 'i' : ''} -> ${f.googleFonts?.available ? f.googleFonts.family + (f.googleFonts.weightAvailable ? '' : ' (weight synthesised)') : 'NOT on Google Fonts'} [${f.role}]`),
      warnings: report.warnings,
      lint: lint(html, pages),
    });

    // ---- fidelity
    const printed = path.join(dir, `${name}.chrome.pdf`);
    await chrome(htmlFile, printed);
    row.ssim = [];
    for (const p of report.pages) {
      const long = 1500;
      const w = p.widthMm >= p.heightMm ? long : Math.round((long * p.widthMm) / p.heightMm);
      const h = p.widthMm >= p.heightMm ? Math.round((long * p.heightMm) / p.widthMm) : long;
      const a = path.join(dir, `${name}-p${p.page}-original.png`);
      const b = path.join(dir, `${name}-p${p.page}-converted.png`);
      await raster(file, p.page, a, w, h);
      const index = report.pages.indexOf(p) + 1;
      if (screenshot) {
        const cssW = Math.round((p.widthMm * 96) / 25.4);
        const cssH = Math.round((p.heightMm * 96) / 25.4);
        const shot = path.join(dir, `${name}-screen.png`);
        if (index === 1) await chrome(htmlFile, shot, { width: cssW, height: 24 + report.pages.length * (cssH + 24) });
        await run('ffmpeg', ['-hide_banner', '-y', '-i', shot, '-vf', `crop=${cssW}:${cssH}:0:${24 + (index - 1) * (cssH + 24)},scale=${w}:${h}:flags=lanczos`, '-frames:v', '1', '-update', '1', b]);
      } else await raster(printed, index, b, w, h);
      row.ssim.push(+(await ssim(a, b)).toFixed(4));
      if (!screenshot) {
        // the same comparison with pdftoppm on both sides, for reference
        const a2 = path.join(dir, `_ppm-a.png`);
        const b2 = path.join(dir, `_ppm-b.png`);
        await raster(file, p.page, a2, w, h, 'pdftoppm');
        await raster(printed, index, b2, w, h, 'pdftoppm');
        (row.ssimPdftoppm ||= []).push(+(await ssim(a2, b2)).toFixed(4));
        await fs.rm(a2);
        await fs.rm(b2);
      }
      await compareImage(a, b, path.join(dir, `${name}-p${p.page}-compare.png`));
      if (p.textLines) (row.baseline ||= []).push(baselineError(await baselines(file, p.page, path.join(dir, '_a.svg')), await baselines(printed, index, path.join(dir, '_b.svg'))));
    }

    // ---- live text in the print: the words of the original are there as text
    const printedText = (await run('pdftotext', [printed, '-'])).stdout;
    row.liveCharacters = printedText.replace(/\s+/g, '').length;

    // ---- re-brand and retype
    let edited = html.replace('<html ', `<html style="${Object.entries(REBRAND).map(([k, v]) => `${k}:${v}`).join(';')}" `).replace('</head>', `<link rel="stylesheet" href="${REBRAND_FONTS.replace(/&/g, '&amp;')}"></head>`);
    const firstEdit = /(<div data-edit="[^"]+">)([^<]*)/.exec(edited);
    if (firstEdit) edited = edited.replace(firstEdit[0], firstEdit[1] + RETYPED);
    const rebrandFile = path.join(dir, `${name}.rebrand.html`);
    await fs.writeFile(rebrandFile, edited);
    const rebrandPdf = path.join(dir, `${name}.rebrand.pdf`);
    await chrome(rebrandFile, rebrandPdf);
    const rebrandText = (await run('pdftotext', ['-f', '1', '-l', '1', rebrandPdf, '-'])).stdout;
    const rebrandFonts = (await run('pdffonts', [rebrandPdf])).stdout;
    const original = row.colours['--brand-color'];
    const shares = original ? [await colourShare(printed, 1, [original, REBRAND['--brand-color']]), await colourShare(rebrandPdf, 1, [original, REBRAND['--brand-color']])] : null;
    row.rebrand = {
      retyped: firstEdit ? flat(rebrandText).includes(RETYPED) && !flat(rebrandText).includes(flat(firstEdit[2].split('\n')[0]) || '\u0000') : null,
      retypedFrom: firstEdit ? firstEdit[2].split('\n')[0] : null,
      fonts: [...new Set([...rebrandFonts.matchAll(/\+?(PlayfairDisplay|SpaceGrotesk)/g)].map((m) => m[1]))],
      brandColourShare: shares ? { before: { original: +shares[0][0].toFixed(4), new: +shares[0][1].toFixed(4) }, after: { original: +shares[1][0].toFixed(4), new: +shares[1][1].toFixed(4) } } : null,
    };
    for (const p of report.pages.slice(0, 3)) {
      const index = report.pages.indexOf(p) + 1;
      const a = path.join(dir, `${name}-p${p.page}-original.png`);
      const c = path.join(dir, `${name}-p${p.page}-rebranded.png`);
      const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', a])).stdout.trim().split(',').map(Number);
      await raster(rebrandPdf, index, c, w, h);
      await sideBySide([a, c], path.join(dir, `${name}-p${p.page}-rebrand.png`));
    }
  } catch (e) {
    row.error = e.message;
    console.error(`FAILED ${name}: ${e.stack || e.message}`);
  }
  const s = row.ssim?.length ? `ssim ${row.ssim.join(' ')}${row.ssimPdftoppm ? ` (pdftoppm on both sides: ${row.ssimPdftoppm.join(' ')})` : ''}` : '';
  console.log(`${name}: ${row.error ? 'ERROR ' + row.error : `${row.pages}/${row.sourcePages} pages, ${row.editable} editable (${row.textLines} lines), ${row.photos} photo slot(s), ${row.htmlKb} KB, ${row.ms} ms, ${s}`}`);
}
await fs.rm(path.join(OUT, '_chrome-profile'), { recursive: true, force: true });
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nResults: ${path.join(OUT, 'results.json')}`);
for (const r of results) {
  if (r.error) continue;
  console.log(`\n== ${r.name}`);
  console.log(`   colours ${JSON.stringify(r.colours)}`);
  console.log(`   fonts   ${r.fonts.join('; ') || '-'}`);
  console.log(`   rebrand ${JSON.stringify(r.rebrand)}`);
  if (r.baseline) console.log(`   text position vs original, per page (pt): ${r.baseline.map((b) => `baseline ≤${b.maxBaselineShiftPt}, line start ≤${b.maxLineStartShiftPt}${b.linesNotFound ? `, ${b.linesNotFound} of ${b.lines} lines not found` : ''}`).join(' | ')}`);
  if (r.outlinedGlyphs) console.log(`   glyphs left as outlines: ${r.outlinedGlyphs}`);
  if (r.otherImages.length) console.log(`   other images: ${r.otherImages.join(', ')}`);
  if (r.lint.length) console.log(`   LINT: ${r.lint.join('; ')}`);
  for (const w of r.warnings) console.log(`   ! ${w}`);
}
