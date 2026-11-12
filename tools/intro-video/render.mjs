// Captures video.html frame by frame with headless Chrome.
// Usage: node render.mjs <config.json> <cast.json> <frames dir> [fps] [only-times e.g. 1,5,12]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , cfgPath, castPath, outDir, fpsArg, only] = process.argv;
const fps = Number(fpsArg || 24);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const cast = JSON.parse(fs.readFileSync(castPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=9340', `--user-data-dir=${path.join(here, 'chrome-profile')}`, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40 && !targets; i++) { await sleep(250); targets = await fetch('http://127.0.0.1:9340/json').then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); if (d.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', d.params.exceptionDetails.exception?.description?.slice(0, 300)); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + path.join(here, 'video.html') });
await sleep(1500);
await ev(`setup(${JSON.stringify(cfg)}, ${JSON.stringify(cast)})`);
await sleep(500);
const times = only ? only.split(',').map(Number) : Array.from({ length: Math.round(cfg.duration * fps) }, (_, i) => i / fps);
let n = 0;
for (const t of times) {
  await ev(`setTime(${t})`);
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  fs.writeFileSync(path.join(outDir, only ? `t${String(t).replace('.', '_')}.jpg` : `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(s.result.data, 'base64'));
  n++;
  if (n % 120 === 0) console.log(`${n}/${times.length} frames`);
}
console.log(`done: ${n} frames`);
ws.close(); chrome.kill();
