// Opens a material link (as Claude hands it out) and saves one page of the customized template as an image.
// Usage: node capture_material.mjs <url> <out.png> [page index]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , url, out, pageArg] = process.argv;
const index = Number(pageArg || 0);
const profile = path.join(here, 'chrome-profile-capture-' + Date.now());
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9341', `--user-data-dir=${profile}`, '--window-size=1500,1400', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40 && !targets; i++) { await sleep(250); targets = await fetch('http://127.0.0.1:9341/json').then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(17000);
const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const f = document.querySelector('.stage iframe');
  if (!f || !f.contentDocument) return null;
  const fr = f.getBoundingClientRect();
  const s = fr.width / f.offsetWidth;
  const pages = f.contentDocument.querySelectorAll('.page');
  const pg = pages[Math.min(${index}, pages.length - 1)].getBoundingClientRect();
  const d = f.contentDocument;
  return { clip: { x: fr.x + pg.x * s + window.scrollX, y: fr.y + pg.y * s + window.scrollY, width: pg.width * s, height: pg.height * s }, pages: pages.length,
    group: d.querySelector('[data-brand="group_name"]')?.textContent, color: d.documentElement.style.getPropertyValue('--brand-color'), font: d.documentElement.style.getPropertyValue('--brand-font-heading') };
})()` });
const v = r.result.result.value;
if (!v) { console.log('no template frame found'); ws.close(); chrome.kill(); process.exit(1); }
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...v.clip, scale: 1.4 } });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ out, pages: v.pages, group: v.group, color: v.color, font: v.font, size: [Math.round(v.clip.width), Math.round(v.clip.height)] }));
ws.close(); chrome.kill();
