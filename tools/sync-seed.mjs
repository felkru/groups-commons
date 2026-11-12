// Brings the live commons in line with the local seed folder, through the CLI (materials are always added that way).
// Usage: node tools/sync-seed.mjs [--kinds text,file,kit,supplier,link,template] [--skip slug,slug] [--dry]
// - uploads every local folder of the chosen kinds (with the simulated stats in seed/_stats.json)
// - removes live materials of the chosen kinds that came from the seed group and no longer exist locally
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'seed');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const kinds = new Set(arg('--kinds', 'text,file,kit,supplier,link,template').split(','));
const skip = new Set(arg('--skip', '').split(',').filter(Boolean));
const dry = process.argv.includes('--dry');
const cli = (...args) => execFileSync('node', [path.join(ROOT, 'cli', 'commons.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const local = new Map();
for (const dir of fs.readdirSync(SEED)) {
  const file = path.join(SEED, dir, 'item.json');
  if (!fs.existsSync(file)) continue;
  const item = JSON.parse(fs.readFileSync(file, 'utf8'));
  local.set(dir, item);
}
const live = JSON.parse(cli('list', '--sort', 'new', '--json')).items || JSON.parse(cli('list', '--sort', 'new', '--json'));
const liveItems = Array.isArray(live) ? live : [];

const toAdd = [...local].filter(([slug, item]) => kinds.has(item.kind) && !skip.has(slug)).map(([slug]) => slug);
const toRemove = liveItems.filter((i) => kinds.has(i.kind) && !local.has(i.slug) && !skip.has(i.slug) && i.simulated && !i.forked_from).map((i) => i.slug);
console.log(`${toAdd.length} to upload, ${toRemove.length} to remove${dry ? ' (dry run)' : ''}`);
if (toRemove.length) console.log('remove:', toRemove.join(', '));
if (dry) process.exit(0);

let failed = 0;
for (let i = 0; i < toAdd.length; i += 10) {
  const batch = toAdd.slice(i, i + 10).map((s) => path.join(SEED, s));
  try {
    const out = cli('add', ...batch, '--stats', path.join(SEED, '_stats.json'));
    process.stdout.write(out.split('\n').filter((l) => /added \(|✗/.test(l)).join('\n') + '\n');
  } catch (e) {
    failed++;
    process.stdout.write(String(e.stdout || '').split('\n').filter((l) => /added \(|✗|failed/.test(l)).join('\n') + '\n' + String(e.stderr || '').split('\n').filter((l) => /✗/.test(l)).join('\n') + '\n');
  }
}
for (const slug of toRemove) {
  try {
    cli('rm', slug, '--yes');
    console.log('removed', slug);
  } catch (e) {
    failed++;
    console.log('could not remove', slug, String(e.stderr || e.message).trim().slice(0, 120));
  }
}
process.exit(failed ? 1 : 0);
