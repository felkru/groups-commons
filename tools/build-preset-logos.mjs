// Builds the logo files of the example brand kits from the files each group publishes on its own website.
// Every wide logo is set the way the group's own page header sets it: its mark next to its name, in its typeface
// (loaded from Google Fonts), drawn by headless Chrome on a transparent background.
// Kairos may reuse the groups' logos and materials for its marketing and operations; the files are part of the site,
// not of the public repository (see .gitignore).
// Usage: sh tools/fetch-preset-logos.sh <download folder>
//        node tools/build-preset-logos.mjs <download folder> public/assets/presets
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [, , src, out] = process.argv;
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (name, mime) => `data:${mime};base64,` + fs.readFileSync(path.join(src, name)).toString('base64');
const svgUri = (text) => 'data:image/svg+xml;base64,' + Buffer.from(text).toString('base64');
const text = (name) => fs.readFileSync(path.join(src, name), 'utf8');

const saarland = uri('saarland-logo.png', 'image/png');
const delft = uri('delft-logo.png', 'image/webp');
const delftWhite = uri('delft-logo-white.png', 'image/png');
const durham = uri('durham-logo.svg', 'image/svg+xml');
const chileWhite = svgUri(text('chile-logo.svg'));
const chileNavy = svgUri(text('chile-logo.svg').replace(/(fill|stroke)="white"/g, '$1="#0f172a"'));
const shield = 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';
// AI Safety Cardiff University: the red tile with the white shield outline from its page header and app icon.
const cardiffTile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="6" fill="#b23434"/><svg x="8" y="8" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${shield}"/></svg></svg>`;
fs.writeFileSync(path.join(out, 'cardiff-square.svg'), cardiffTile);
fs.writeFileSync(path.join(out, 'chile-square.svg'), text('chile-logo.svg').replace(/(fill|stroke)="white"/g, '$1="#0f172a"'));
fs.writeFileSync(path.join(out, 'chile-square-light.svg'), text('chile-logo.svg'));
fs.writeFileSync(path.join(out, 'durham-square.svg'), text('durham-logo.svg'));
const cardiff = svgUri(cardiffTile);
// AI Safety Tübingen: the boat mark and the wordmark as published; the wordmark is near-black, white for dark backgrounds.
fs.writeFileSync(path.join(out, 'tuebingen-square.svg'), text('tuebingen-square.svg'));
fs.writeFileSync(path.join(out, 'tuebingen-wide.svg'), text('tuebingen-logo.svg'));
fs.writeFileSync(path.join(out, 'tuebingen-wide-light.svg'), text('tuebingen-logo.svg').replaceAll('#1d1d1b', '#ffffff'));
const tufts = uri('tufts-banner.png', 'image/png');

const fonts = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&family=Jost:wght@500&family=Merriweather:wght@700;900&family=Source+Serif+4:wght@700&family=Inter:wght@500&family=Space+Grotesk:wght@600&display=block';
// One lockup: [file, html]. Sizes are the page header's own, scaled so that the mark is 96px high.
const sq = (file, inner, extra = '') => [file, `<div class="sq" style="${extra}">${inner}</div>`];
const lockups = [
  // AI Safety Saarland: header = the logo in a pale green circle, "AI Safety" + "Saarland" in Plus Jakarta Sans 700.
  sq('saarland-square.png', `<img src="${saarland}" style="width:236px">`),
  sq('saarland-square-light.png', `<img src="${saarland}" style="width:196px">`, 'background:#e3efdd;border-radius:50%'),
  ['saarland-wide.png', `<div class="l" style="font:700 40px 'Plus Jakarta Sans';gap:22px"><span class="disc"><img src="${saarland}"></span><span><span style="color:#04281a">AI Safety</span> <span style="color:#40a038">Saarland</span></span></div>`],
  ['saarland-wide-light.png', `<div class="l" style="font:700 40px 'Plus Jakarta Sans';gap:22px"><span class="disc"><img src="${saarland}"></span><span><span style="color:#ffffff">AI Safety</span> <span style="color:#9bc58d">Saarland</span></span></div>`],
  // Delft AI Safety Initiative: the page shows the mark alone; the name is its headline (Futura PT 500, here Jost).
  sq('delft-square.png', `<img src="${delft}" style="width:256px">`),
  sq('delft-square-light.png', `<img src="${delftWhite}" style="width:256px">`),
  ['delft-wide.png', `<div class="l" style="font:500 46px Jost;gap:20px;color:#000000"><img src="${delft}" style="height:96px"><span>Delft AI Safety Initiative</span></div>`],
  ['delft-wide-light.png', `<div class="l" style="font:500 46px Jost;gap:20px;color:#ffffff"><img src="${delftWhite}" style="height:96px"><span>Delft AI Safety Initiative</span></div>`],
  // Durham AI Safety Initiative: header = logo, then three lines in Merriweather, "AI Safety" larger and purple.
  ['durham-wide.png', `<div class="l" style="font:700 32px/1.2 Merriweather;gap:18px;color:#1a1a2e"><img src="${durham}" style="height:96px"><span>Durham<br><span style="font-weight:900;font-size:35px;color:#68246d">AI Safety</span><br>Initiative</span></div>`],
  ['durham-wide-light.png', `<div class="l" style="font:700 32px/1.2 Merriweather;gap:18px;color:#ffffff"><img src="${durham}" style="height:96px"><span>Durham<br><span style="font-weight:900;font-size:35px;color:#b06be8">AI Safety</span><br>Initiative</span></div>`],
  // AI Safety Cardiff University: header = red tile, name in Source Serif 4 700, small spaced line below.
  ['cardiff-wide.png', `<div class="l" style="gap:26px"><img src="${cardiff}" style="height:96px"><span style="display:block"><span style="display:block;font:700 48px/1.15 'Source Serif 4';letter-spacing:-1.2px;color:#0b111e">AI Safety Cardiff University</span><span style="display:block;font:500 25px/1.5 Inter;letter-spacing:2.6px;color:#52637a">FELLOWSHIP &amp; COMMUNITY</span></span></div>`],
  ['cardiff-wide-light.png', `<div class="l" style="gap:26px"><img src="${cardiff}" style="height:96px"><span style="display:block"><span style="display:block;font:700 48px/1.15 'Source Serif 4';letter-spacing:-1.2px;color:#f1f5f9">AI Safety Cardiff University</span><span style="display:block;font:500 25px/1.5 Inter;letter-spacing:2.6px;color:#8596ad">FELLOWSHIP &amp; COMMUNITY</span></span></div>`],
  // AI Safety Initiative @ UC Chile: header = shield, two lines in Space Grotesk 600.
  ['chile-wide.png', `<div class="l" style="font:600 30px/1.4 'Space Grotesk';gap:16px;color:#0f172a"><img src="${chileNavy}" style="height:96px"><span>AI Safety Initiative<br>@ UC Chile</span></div>`],
  ['chile-wide-light.png', `<div class="l" style="font:600 30px/1.4 'Space Grotesk';gap:16px;color:#ffffff"><img src="${chileWhite}" style="height:96px"><span>AI Safety Initiative<br>@ UC Chile</span></div>`],
];
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${fonts}"><style>
html,body{margin:0;background:transparent}
.row{margin:24px;display:block}
.l{display:inline-flex;align-items:center;white-space:nowrap}
.l img{display:block}
.sq{width:256px;height:256px;display:flex;align-items:center;justify-content:center}
.disc{width:96px;height:96px;border-radius:50%;background:#e3efdd;display:flex;align-items:center;justify-content:center;flex:none}
.disc img{width:76px}
</style></head><body>${lockups.map(([file, h]) => `<div class="row"><span data-out="${file}" style="display:inline-block">${h}</span></div>`).join('')}
<canvas id="c" style="display:none"></canvas></body></html>`;
const page = path.join(os.tmpdir(), `commons-logos-${process.pid}.html`);
fs.writeFileSync(page, html);

const port = 9600 + Math.floor(Math.random() * 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-logos-profile-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let k = 0; k < 40 && !targets; k++) { await sleep(250); targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression })).result?.result?.value;
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: 'file://' + page });
  await sleep(1500);
  const loaded = await evaluate(`document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight).join(', '))`);
  console.log('fonts used:', loaded);
  for (const [file] of lockups) {
    const box = await evaluate(`(() => { const b = document.querySelector('[data-out="${file}"]').getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 3 } });
    fs.writeFileSync(path.join(out, file), Buffer.from(shot.result.data, 'base64'));
    console.log(file, Math.round(box.width * 3) + 'x' + Math.round(box.height * 3));
  }
  // Tufts AI Safety Student Association: one banner (mark + TASSA in black). The square is the mark cut out of it,
  // the version for dark backgrounds has the black letters turned white.
  const tuftsOut = await evaluate(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(tufts)}; await img.decode();
    const c = document.getElementById('c'); const W = 1600; const H = Math.round(W * img.height / img.width); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const wide = c.toDataURL('image/png');
    const d = g.getImageData(0, 0, W, H); const p = d.data;
    let x0 = W, x1 = 0, y0 = H, y1 = 0; const blue = {};
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (p[i + 3] > 40 && p[i + 2] > p[i] + 50) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); if (p[i + 3] === 255) { const k = '#' + [p[i], p[i + 1], p[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); blue[k] = (blue[k] || 0) + 1; } } }
    for (let i = 0; i < p.length; i += 4) if (p[i + 3] > 0 && p[i + 2] <= p[i] + 50) { p[i] = 255; p[i + 1] = 255; p[i + 2] = 255; }
    g.putImageData(d, 0, 0); const light = c.toDataURL('image/png');
    const s = Math.max(x1 - x0, y1 - y0) + 1; const k = img.width / W; const side = 768; const pad = 0.1;
    c.width = side; c.height = side; const g2 = c.getContext('2d'); const scale = side * (1 - 2 * pad) / (s * k);
    g2.drawImage(img, x0 * k, y0 * k, (x1 - x0 + 1) * k, (y1 - y0 + 1) * k, (side - (x1 - x0 + 1) * k * scale) / 2, (side - (y1 - y0 + 1) * k * scale) / 2, (x1 - x0 + 1) * k * scale, (y1 - y0 + 1) * k * scale);
    return { wide, light, square: c.toDataURL('image/png'), blue: Object.entries(blue).sort((a, b) => b[1] - a[1]).slice(0, 3) };
  })()`);
  const save = (file, dataUrl) => { fs.writeFileSync(path.join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64')); console.log(file); };
  save('tufts-wide.png', tuftsOut.wide); save('tufts-wide-light.png', tuftsOut.light); save('tufts-square.png', tuftsOut.square);
  ws.close();
} finally { chrome.kill(); await sleep(300); fs.rmSync(page, { force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
