#!/usr/bin/env node
// commons: search, fork and share organizing materials on the Groups Commons.
// One file, no dependencies, Node 18+. Works saved as "commons" or "commons.mjs" (it uses no static imports).
//
//   curl -fsSL __DEFAULT_URL__/cli/commons.mjs -o ~/.local/bin/commons && chmod +x ~/.local/bin/commons

const VERSION = '0.1.0';
const BUILT_IN_URL = '__DEFAULT_URL__'; // the server fills in its own address when it serves this file
const FALLBACK_URL = 'http://localhost:8787';

let fs, os, path, crypto;
let ctx; // { url, token, clientId, cfg }

const HELP = `commons ${VERSION}: shared materials for AI safety groups

Find
  commons search <query> [--category C] [--kind K] [--json]   semantic + keyword search
  commons list [--category C] [--kind K] [--sort hot|best|top|new] [--json]
  commons show <slug> [--json]            everything about one material, including full texts

Use
  commons get <slug> [dir]                download a material into ./<slug>/ to adapt it ("fork" is an alias)
  commons vote <slug> up|down|clear

Share
  commons add <folder>...                 a folder with an item.json and its files (the format "get" writes)
  commons add flyer.pdf --title T --category C [--summary S] [--tags a,b]
  commons add --link https://... --title T [--category demo] [--summary S]
  commons add --text invite.md --title T [--channel email|whatsapp|slack|instagram|doc] [--subject S]
      other options: --group "Your group", --language en, --label "Variant name", --kind template
      Missing title, category and summary are asked for when you run it in a terminal.

Make a template from a finished printable (runs on this computer; nothing is uploaded)
  commons convert <flyer.pdf> [--out <folder>] [--pages N] [--title T] [--logos]
                                          a folder with template.html and item.json; the design is kept, text becomes
                                          editable. Needs poppler (macOS: brew install poppler). --logos marks pictures
                                          that look like logos as the group's logo; check them. A picture (png, jpg,
                                          webp) is not converted: the command says how to rebuild it by hand.
  commons contract                        print the template contract: what makes an HTML file a re-brandable template

Moderate (needs the admin token)
  commons pending [--json]                materials waiting for review
  commons approve <slug>
  commons rm <slug> [--yes]               also works for your own materials
  commons add <folder>... --stats stats.json    set starting votes: { "<slug>": { "up", "down", "uses", "created_at" } }

Setup
  commons login [--url U] [--token T] [--group "Your group"]   saved in ~/.config/commons/config.json
  commons login --user <user name> [--password P]              sign in with an account (needed to host a website)
  commons site publish <folder> --name <name>                  host a built website at /s/<name>/ (after review)
  commons site list | commons site rm <name>
  commons skill install [--dir D]         install the agent skill into ~/.claude/skills/commons
  commons categories

Environment: COMMONS_URL, COMMONS_TOKEN, COMMONS_CONFIG (path of the config file), COMMONS_CACHE (folder for the
downloaded converter, default ~/.cache/commons).
Site: __DEFAULT_URL__`;

// ---------- small helpers ----------
const BOOL = new Set(['json', 'help', 'yes', 'force', 'logos', 'refresh']);
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') opt.help = true;
    else if (a === '-y') opt.yes = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opt[name] = a.slice(eq + 1);
      else if (BOOL.has(name)) opt[name] = true;
      else if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
      else opt[name] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const tty = () => process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (tty() ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (tty() ? `\x1b[2m${s}\x1b[0m` : s);
const out = (s = '') => process.stdout.write(s + '\n');
const note = (s = '') => process.stderr.write(s + '\n');
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
function slugify(text) {
  return (
    String(text || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'material'
  );
}

// ---------- config ----------
const configPath = () => process.env.COMMONS_CONFIG || path.join(os.homedir(), '.config', 'commons', 'config.json');
function saveConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
function openContext(opt) {
  const cfg = readJson(configPath()) || {};
  if (!cfg.client_id) {
    cfg.client_id = crypto.randomUUID();
    saveConfig(cfg);
  }
  const url = String(opt.url || process.env.COMMONS_URL || cfg.url || (BUILT_IN_URL.startsWith('http') ? BUILT_IN_URL : FALLBACK_URL)).replace(/\/+$/, '');
  const token = process.env.COMMONS_TOKEN !== undefined ? process.env.COMMONS_TOKEN.trim() : cfg.token || '';
  ctx = { url, token, clientId: cfg.client_id, cfg, session: cfg.sessions?.[url] || '' };
}
const editKey = (slug) => ctx.cfg.keys?.[ctx.url]?.[slug];
function rememberKey(slug, key) {
  if (!key) return;
  ((ctx.cfg.keys ??= {})[ctx.url] ??= {})[slug] = key;
  saveConfig(ctx.cfg);
}
function forgetKey(slug) {
  if (ctx.cfg.keys?.[ctx.url]?.[slug]) {
    delete ctx.cfg.keys[ctx.url][slug];
    saveConfig(ctx.cfg);
  }
}

// ---------- HTTP ----------
async function call(method, p, { json, body, key, raw } = {}) {
  const headers = { 'X-Client-Id': ctx.clientId, 'User-Agent': `commons-cli/${VERSION}` };
  if (ctx.token) headers['X-Admin-Token'] = ctx.token;
  if (ctx.session) headers['X-Session'] = ctx.session;
  if (key) headers['X-Edit-Key'] = key;
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (body) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  }
  let res;
  try {
    res = await fetch(ctx.url + p, { method, headers, body: payload, signal: AbortSignal.timeout(300000) });
  } catch (e) {
    throw new Error(`Cannot reach ${ctx.url} (${e.cause?.code || e.message}). Set the address with "commons login --url <address>" or COMMONS_URL.`);
  }
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}
const qs = (o) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== true) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};

async function ask(question, fallback) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim() || fallback;
  } finally {
    rl.close();
  }
}

// ---------- find ----------
function printList(items) {
  if (!items.length) return out('Nothing found.');
  for (const i of items) {
    const flags = [i.status === 'pending' ? 'pending review' : '', i.forks ? `${i.forks} fork${i.forks > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
    out(`${String(i.score).padStart(4)} ▲  ${bold(i.slug)}  ${dim(`${i.kind}, ${i.category}${i.uses ? `, used ${i.uses}×` : ''}${flags ? `, ${flags}` : ''}`)}`);
    out(`        ${i.title}`);
    out(`        ${dim(clip(i.summary, 150))}`);
  }
}

async function cmdSearch({ pos, opt }) {
  const q = pos.join(' ').trim();
  if (!q) throw new Error('Usage: commons search <query>');
  const r = await call('GET', `/api/items${qs({ q, category: opt.category, kind: opt.kind })}`);
  if (opt.json) return out(JSON.stringify(r.items, null, 2));
  note(dim(`${r.items.length} of ${r.total} materials match "${q}" (${r.mode} search). Details: commons show <slug>`));
  printList(r.items);
}

async function cmdList({ opt }) {
  const r = await call('GET', `/api/items${qs({ category: opt.category, kind: opt.kind, sort: opt.sort || 'best', pending: opt.pending })}`);
  if (opt.json) return out(JSON.stringify(r.items, null, 2));
  note(dim(`${r.items.length} materials${opt.category ? ` in "${opt.category}"` : ''}, sorted by ${opt.sort || 'best'}.`));
  printList(r.items);
}

async function cmdShow({ pos, opt }) {
  if (!pos[0]) throw new Error('Usage: commons show <slug>');
  const i = await call('GET', `/api/items/${encodeURIComponent(pos[0])}`);
  if (opt.json) return out(JSON.stringify(i, null, 2));
  out(bold(i.title));
  out(`${i.slug} · ${i.kind}, ${i.category} · by ${i.group} · score ${i.score} (${i.up || 0} up, ${i.down || 0} down)${i.simulated ? ' [simulated seed votes]' : ''} · used ${i.uses || 0}×${i.status !== 'published' ? ` · ${i.status}` : ''}`);
  out(`${ctx.url}/m/${i.slug}`);
  if (i.tags?.length) out(`Tags: ${i.tags.join(', ')}`);
  out(`Language: ${i.language} · Source: ${i.source}${i.provenance ? ` (${i.provenance})` : ''}`);
  if (i.parent) out(`Forked from: ${i.parent.slug} ("${i.parent.title}" by ${i.parent.group})`);
  if (i.forks?.length) out(`Forks: ${i.forks.map((f) => `${f.slug} (${f.group})`).join(', ')}`);
  out(`\n${i.summary}`);
  if (i.description) out(`\n${i.description}`);
  if (i.template) out(`\n${bold('Template')} (${i.template.format || 'HTML'}): ${ctx.url}/files/${i.slug}/${encPath(i.template.path)}\nCustomize in the browser: ${ctx.url}/m/${i.slug}`);
  if (i.link) out(`\n${bold(i.link.label || 'Link')}: ${i.link.url}`);
  for (const v of i.variants || []) {
    out(`\n${bold(`--- ${v.label} (${v.channel}, ${v.lang}) ---`)}`);
    if (v.subject) out(`Subject: ${v.subject}\n`);
    out(v.body);
  }
  if (i.kit) {
    out(`\n${bold('Kit')}${i.kit.est_cost ? ` (${i.kit.est_cost})` : ''}`);
    for (const k of i.kit.items) out(`- [ ] ${k.qty ? `${k.qty} × ` : ''}${k.name}${k.note ? `: ${k.note}` : ''}${k.url ? `\n      ${k.url}` : ''}${k.material ? `\n      make it from: commons get ${k.material}` : ''}${k.example ? `\n      example: ${k.example.url}` : ''}${k.order ? `\n      order email, subject: ${k.order.subject || ''}\n${k.order.body.split('\n').map((l) => '        ' + l).join('\n')}` : ''}`);
  }
  if (i.supplier) {
    const s = i.supplier;
    out(`\n${bold('Supplier')}: ${s.name} (${s.type}${s.location ? `, ${s.location}` : ''})`);
    if (s.good_for) out(`Good for: ${s.good_for}`);
    if (s.website) out(`Website: ${s.website}`);
    if (s.request) out(`\n${bold('--- Quote request ---')}\n${s.request.subject ? `Subject: ${s.request.subject}\n\n` : ''}${s.request.body}`);
  }
  const files = (i.file_list || []).filter((f) => !f.path.startsWith('_'));
  if (files.length) {
    out(`\n${bold('Files')}`);
    for (const f of files) out(`  ${f.path} (${size(f.size)})  ${ctx.url}/files/${i.slug}/${encPath(f.path)}`);
  }
  out(dim(`\nAdapt it: commons get ${i.slug}`));
}

// ---------- use ----------
const AUTHOR_FIELDS = ['slug', 'title', 'category', 'kind', 'summary', 'description', 'tags', 'language', 'group', 'source', 'provenance', 'forked_from', 'files', 'preview', 'template', 'variants', 'link', 'kit', 'supplier'];

async function cmdGet({ pos, opt }) {
  const slug = pos[0];
  if (!slug) throw new Error('Usage: commons get <slug> [dir]');
  const i = await call('GET', `/api/items/${encodeURIComponent(slug)}`);
  const dir = path.resolve(pos[1] || i.slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !opt.force) throw new Error(`${dir} already exists and is not empty. Pass another folder or --force.`);
  fs.mkdirSync(dir, { recursive: true });
  const item = {};
  for (const k of AUTHOR_FIELDS) if (i[k] !== undefined) item[k] = i[k];
  if (item.preview?.startsWith('_')) delete item.preview; // generated by the server; it is made again on upload
  fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify(item, null, 2) + '\n');
  const files = (i.file_list || []).filter((f) => !f.path.startsWith('_'));
  for (const f of files) {
    const buf = await call('GET', `/files/${i.slug}/${encPath(f.path)}`, { raw: true });
    const full = path.join(dir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    note(`  ${f.path} (${size(buf.length)})`);
  }
  fs.writeFileSync(path.join(dir, '.commons.json'), JSON.stringify({ origin: i.slug, url: ctx.url, fetched_at: new Date().toISOString() }, null, 2) + '\n');
  await call('POST', `/api/items/${encodeURIComponent(i.slug)}/use`).catch(() => {});
  if (opt.json) return out(JSON.stringify({ slug: i.slug, dir, files: files.map((f) => f.path) }));
  out(`Downloaded "${i.title}" to ${dir} (item.json + ${files.length} file${files.length === 1 ? '' : 's'}).`);
  out(`Adapt it for your group. When your version works, share it back so the next group can build on it:\n  commons add ${path.relative(process.cwd(), dir) || '.'}`);
}

async function cmdVote({ pos }) {
  const dir = { up: 1, down: -1, clear: 0, none: 0 }[pos[1]];
  if (!pos[0] || dir === undefined) throw new Error('Usage: commons vote <slug> up|down|clear');
  const r = await call('POST', `/api/items/${encodeURIComponent(pos[0])}/vote`, { json: { dir } });
  out(`${pos[0]}: score ${r.score} (${r.up} up, ${r.down} down). Your vote: ${dir === 1 ? 'up' : dir === -1 ? 'down' : 'none'}.`);
}

// ---------- share ----------
function walk(dir, rel = '') {
  const found = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...walk(dir, r));
    else if (e.isFile() && r !== 'item.json') found.push(r);
  }
  return found;
}
const extOf = (p) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] || '').toLowerCase();

let metaCache;
const meta = async () => (metaCache ??= await call('GET', '/api/meta'));

async function freeForkSlug(origin) {
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? `${origin.slice(0, 54)}-fork` : `${origin.slice(0, 51)}-fork-${n}`;
    const taken = await call('GET', `/api/items/${slug}`).then(
      () => true,
      (e) => (e.status === 404 ? false : Promise.reject(e)),
    );
    if (!taken || editKey(slug)) return slug;
  }
  throw new Error('Could not find a free name for the fork. Set "slug" in item.json.');
}

// item: the item.json object. files: [{ path, abs }]. Returns { slug, status, updated }.
async function upload(item, files, { stats, autoSlug } = {}) {
  const types = (await meta()).limits.types;
  const skipped = files.filter((f) => !types.includes(extOf(f.path)));
  for (const f of skipped) note(`  skipping ${f.path} (file type not accepted)`);
  files = files.filter((f) => !skipped.includes(f));
  const draft = await call('POST', '/api/items', { json: { ...item, auto_slug: autoSlug || undefined }, key: item.slug ? editKey(item.slug) : undefined });
  rememberKey(draft.slug, draft.edit_key);
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    await call('PUT', `/api/items/${draft.slug}/files/${encPath(f.path)}`, { body: buf, key: draft.edit_key });
    note(`  ${f.path} (${size(buf.length)})`);
  }
  const done = await call('POST', `/api/items/${draft.slug}/publish`, { json: stats ? { stats } : {}, key: draft.edit_key });
  return { slug: draft.slug, status: done.status, updated: !!draft.updated };
}

async function addFolder(dir, stats) {
  const item = readJson(path.join(dir, 'item.json'));
  if (!item) throw new Error(fs.existsSync(path.join(dir, 'item.json')) ? 'item.json is not valid JSON' : 'no item.json in this folder (see "commons help" for the quick forms)');
  const originFile = path.join(dir, '.commons.json');
  const fork = readJson(originFile);
  if (!item.slug) item.slug = slugify(path.basename(path.resolve(dir)));
  if (fork?.origin) {
    if (!item.forked_from) item.forked_from = fork.origin;
    if (fork.shared_as && fork.shared_url === ctx.url) item.slug = fork.shared_as;
    else if (slugify(item.slug) === fork.origin) item.slug = await freeForkSlug(fork.origin);
    if (item.source === 'original' || !item.source) item.source = 'adapted';
  }
  if (!item.group && ctx.cfg.group) item.group = ctx.cfg.group;
  const files = walk(dir).map((p) => ({ path: p, abs: path.join(dir, ...p.split('/')) }));
  const r = await upload(item, files, { stats: stats?.[slugify(item.slug)] });
  if (fork?.origin) fs.writeFileSync(originFile, JSON.stringify({ ...fork, shared_as: r.slug, shared_url: ctx.url }, null, 2) + '\n');
  return r;
}

const safeName = (name) => name.replace(/[^A-Za-z0-9_ .()+&,@-]/g, '-').replace(/^[^A-Za-z0-9_]+/, '') || 'file';

async function quickItem(opt, defaults) {
  const categories = (await meta()).categories;
  const item = { kind: defaults.kind };
  item.title = opt.title || (await ask('Title: ', defaults.title));
  if (!item.title) throw new Error('Pass --title "..."');
  item.category = opt.category || (await ask(`Category (${Object.keys(categories).join(', ')})${defaults.category ? ` [${defaults.category}]` : ''}: `, defaults.category));
  if (!categories[item.category]) throw new Error(`Pass --category with one of: ${Object.keys(categories).join(', ')}`);
  item.summary = opt.summary || (await ask('One or two sentences on what it is and when to use it: ', item.title));
  if (opt.description) item.description = opt.description;
  if (opt.tags) item.tags = String(opt.tags).split(',').map((t) => t.trim()).filter(Boolean);
  if (opt.language) item.language = opt.language;
  item.group = opt.group || ctx.cfg.group;
  if (opt.source) item.source = opt.source;
  return item;
}

async function cmdAdd({ pos, opt }) {
  const stats = opt.stats ? readJson(opt.stats) : null;
  if (opt.stats && !stats) throw new Error(`Cannot read ${opt.stats}`);
  if (stats && !ctx.token) note('Note: --stats is only applied with the admin token.');
  const results = [];
  const run = async (name, fn) => {
    note(bold(name));
    try {
      const r = await fn();
      results.push({ name, ...r });
      note(`  → ${r.updated ? 'updated' : 'added'} as ${r.slug}: ${r.status === 'published' ? 'published' : 'waiting for review'}  ${ctx.url}/m/${r.slug}`);
    } catch (e) {
      results.push({ name, error: e.message });
      note(`  ✗ ${e.message}`);
    }
  };

  const targets = pos.filter((p) => !/^[._]/.test(path.basename(p)) || p === '.' || p === '..');
  const folders = targets.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  const loose = targets.filter((p) => !folders.includes(p));
  for (const dir of folders) await run(dir, () => addFolder(dir, stats));

  if (opt.link) {
    await run(opt.link, async () => {
      const item = await quickItem(opt, { kind: 'link', category: 'demo' });
      item.link = { url: opt.link, label: opt.label };
      return upload(item, [], { autoSlug: true });
    });
  }
  if (opt.text) {
    await run(opt.text, async () => {
      if (!fs.existsSync(opt.text)) throw new Error('file not found');
      const body = fs.readFileSync(opt.text, 'utf8').trim();
      const item = await quickItem(opt, { kind: 'text', category: 'message', title: path.basename(opt.text).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') });
      const channel = opt.channel || (extOf(opt.text) === 'md' ? 'doc' : 'email');
      item.variants = [{ label: opt.label, lang: opt.language, channel, subject: opt.subject, body }];
      return upload(item, [], { autoSlug: true });
    });
  }
  if (loose.length) {
    await run(loose.join(', '), async () => {
      const missing = loose.filter((p) => !fs.existsSync(p));
      if (missing.length) throw new Error(`not found: ${missing.join(', ')}`);
      const files = loose.map((p) => ({ path: safeName(path.basename(p)), abs: p }));
      const html = files.length === 1 && extOf(files[0].path) === 'html';
      const kind = opt.kind || (html ? 'template' : 'file');
      const item = await quickItem(opt, { kind, title: path.basename(loose[0]).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') });
      if (kind === 'template') item.template = { path: files[0].path, format: opt.format };
      else item.files = files.map((f) => ({ path: f.path, label: files.length === 1 ? opt.label : undefined }));
      return upload(item, files, { autoSlug: true });
    });
  }
  if (!results.length) throw new Error('Nothing to add. Usage: commons add <folder>...  |  commons add file.pdf --title T --category C  |  commons add --link URL --title T  |  commons add --text file.md --title T');

  const failed = results.filter((r) => r.error);
  if (opt.json) out(JSON.stringify(results, null, 2));
  else if (results.length > 1 || failed.length) {
    const ok = results.filter((r) => !r.error);
    out(`${ok.length} added (${ok.filter((r) => r.status === 'published').length} published, ${ok.filter((r) => r.status !== 'published').length} waiting for review), ${failed.length} failed.`);
    if (results.length > 1) for (const f of failed) out(`  ✗ ${f.name}: ${f.error}`);
  }
  if (results.some((r) => !r.error && r.status !== 'published')) note('Materials are reviewed before they appear for everyone. You can already see yours on the site.');
  if (failed.length) process.exitCode = 1;
}

// ---------- moderate ----------
async function cmdPending({ opt }) {
  const r = await call('GET', '/api/items?pending=1&sort=new');
  if (opt.json) return out(JSON.stringify(r.items, null, 2));
  if (!ctx.token) note(dim('No admin token set: showing only your own waiting materials.'));
  if (!r.items.length) return out('Nothing is waiting for review.');
  printList(r.items);
  if (ctx.token) out(dim('\nApprove with: commons approve <slug>'));
}

async function cmdApprove({ pos }) {
  if (!pos.length) throw new Error('Usage: commons approve <slug>...');
  for (const slug of pos) {
    await call('POST', `/api/items/${encodeURIComponent(slug)}/approve`);
    out(`${slug}: published  ${ctx.url}/m/${slug}`);
  }
}

async function cmdRm({ pos, opt }) {
  if (!pos.length) throw new Error('Usage: commons rm <slug>... [--yes]');
  for (const slug of pos) {
    if (!opt.yes) {
      const answer = await ask(`Delete "${slug}" and its files from ${ctx.url}? This cannot be undone. [y/N] `, '');
      if (!/^y(es)?$/i.test(answer)) {
        out(process.stdin.isTTY ? `${slug}: kept` : `${slug}: kept (pass --yes to delete without a prompt)`);
        continue;
      }
    }
    await call('DELETE', `/api/items/${encodeURIComponent(slug)}`, { key: editKey(slug) });
    forgetKey(slug);
    out(`${slug}: deleted`);
  }
}

// ---------- setup ----------
async function cmdLogin({ opt }) {
  const cfg = ctx.cfg;
  if (opt.url) cfg.url = String(opt.url).replace(/\/+$/, '');
  if (opt.token !== undefined) cfg.token = String(opt.token).trim() || undefined;
  if (opt.group) cfg.group = opt.group;
  saveConfig(cfg);
  ctx.url = cfg.url || ctx.url;
  if (opt.token !== undefined) ctx.token = cfg.token || '';
  if (opt.user) {
    // An account (user name and password) is what owns a hosted website and its materials.
    const password = opt.password || process.env.COMMONS_PASSWORD || (await ask(`Password for ${opt.user}: `, ''));
    if (!password) throw new Error('Give the password with --password, COMMONS_PASSWORD, or run this in a terminal to be asked.');
    const r = await call('POST', '/api/session', { json: { username: String(opt.user), password: String(password) } });
    (cfg.sessions ??= {})[ctx.url] = r.token;
    ctx.session = r.token;
    saveConfig(cfg);
    out(`Signed in as ${r.account.username} (${r.account.group}${r.account.role === 'moderator' ? ', moderator' : ''}).`);
  }
  const m = await call('GET', '/api/meta');
  out(`Site: ${ctx.url}`);
  out(`Admin token: ${ctx.token ? (m.admin ? 'accepted' : 'NOT accepted by this site') : 'none (your uploads wait for review)'}`);
  if (cfg.group) out(`Group: ${cfg.group}`);
  out(`Semantic search: ${m.semantic_search ? 'on' : 'off (keyword search)'}`);
  out(dim(`Saved in ${configPath()}`));
  if (ctx.token && !m.admin) process.exitCode = 1;
}

// ---------- hosted websites ----------
function walkSite(dir, rel = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walkSite(dir, r));
    else if (entry.isFile()) found.push(r);
  }
  return found;
}
async function cmdSite({ pos, opt }) {
  const [action, target] = pos;
  if (action === 'list') {
    const sites = await call('GET', '/api/sites');
    if (opt.json) return out(JSON.stringify(sites, null, 2));
    if (!sites.length) return out('No websites yet. Publish one with: commons site publish <folder> --name <name>');
    for (const s of sites) out(`${s.name.padEnd(28)} ${s.status === 'published' ? 'live' : 'waiting for review'}   ${ctx.url}/s/${s.name}/`);
    return;
  }
  if (action === 'rm') {
    if (!target) throw new Error('Usage: commons site rm <name>');
    await call('DELETE', `/api/sites/${encodeURIComponent(target)}`);
    return out(`${target}: taken down`);
  }
  if (action !== 'publish' || !target) throw new Error('Usage: commons site publish <folder with index.html> --name <name> [--title "Group name"]\n       commons site list | commons site rm <name>');
  if (!ctx.session && !ctx.token) throw new Error('Sign in first: commons login --user <user name>');
  const dir = path.resolve(target);
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`${dir} has no index.html. Build the site first and point to its output folder (often "dist").`);
  const name = String(opt.name || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(name)) throw new Error('Choose the address with --name <name> (3 to 40 lower-case letters, digits or hyphens). The site will be at /s/<name>/.');
  const files = walkSite(dir);
  // Pages built for the top of a domain point to /assets/... and would miss their files under /s/<name>/.
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const rooted = [...index.matchAll(/(?:href|src)="(\/[^"/][^"]*)"/g)].map((m) => m[1]).filter((u) => !(u === `/s/${name}` || /^[/?#]/.test(u.slice(`/s/${name}`.length)) && u.startsWith(`/s/${name}`)));
  if (rooted.length && !opt.force) {
    throw new Error(`index.html links to "${rooted[0]}", which only works at the top of a domain. Build the site for the address /s/${name}/ (Astro: "npx astro build --base /s/${name}"; Vite: "--base /s/${name}/") and run this again, or pass --force.`);
  }
  note(`Uploading ${files.length} files to ${ctx.url}/s/${name}/ ...`);
  // Hosting leftovers for other platforms (GitHub Pages' CNAME, Netlify's _headers ...) are not part of the pages.
  const sent = [];
  const skipped = [];
  for (const [i, rel] of files.entries()) {
    try {
      await call('PUT', `/api/sites/${name}/files/${rel.split('/').map(encodeURIComponent).join('/')}`, { body: fs.readFileSync(path.join(dir, rel)) });
      sent.push(rel);
    } catch (e) {
      if (!/File type not allowed/i.test(e.message) || /\.(html?|css|m?js)$/i.test(rel)) throw e;
      skipped.push(rel);
    }
    if ((i + 1) % 25 === 0) note(`  ${i + 1}/${files.length}`);
  }
  if (skipped.length) note(`Left out (not a file type a website here can serve): ${skipped.join(', ')}`);
  const r = await call('POST', `/api/sites/${name}/publish`, { json: { files: sent, title: opt.title || ctx.cfg.group || name } });
  if (opt.json) return out(JSON.stringify(r, null, 2));
  if (r.status === 'published') out(`Live: ${r.url}`);
  else {
    out(`Uploaded. It goes live at ${r.url} once a moderator has approved it.`);
    out(`Look at it now (private preview link, valid for two days):\n  ${r.preview_url}`);
  }
}

// ---------- turning a finished printable into a template ----------
// The conversion runs on this computer. The converter is one file of the site (/cli/convert-pdf.mjs: Node built-ins
// and the poppler tools, no AI). It is kept in the cache folder and checked against the site at most once a day.
const cacheDir = () => process.env.COMMONS_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'commons');
const POPPLER_TOOLS = ['pdfinfo', 'pdftotext', 'pdftohtml', 'pdffonts', 'pdftocairo', 'pdftoppm'];
const POPPLER_HELP = `"commons convert" needs the poppler tools (${POPPLER_TOOLS.join(', ')}) and they are not installed. Install them, then run this again:
  macOS:           brew install poppler
  Debian, Ubuntu:  sudo apt install poppler-utils
  Windows:         winget install oschwartz10612.Poppler   (or: choco install poppler)`;
const IMAGE_HELP = (file) => `${path.basename(file)} is a picture: it has no text layer, so it cannot be converted automatically.
Rebuild it by hand as a template, with the picture as the reference:
  1. Read the template contract: commons contract
  2. Write <folder>/template.html that follows it: the same page size, layout, colours and fonts as the picture, the
     group's name as data-brand="group_name", its logo as a data-logo slot, every other text with data-edit, photos as
     data-photo slots (cut them out of the picture into <folder>/photos/, or ask for the original photos).
  3. Add <folder>/item.json: { "title", "category", "kind": "template", "summary", "group", "source": "adapted",
     "template": { "path": "template.html", "format": "A4 portrait" } }
  4. Open template.html next to the picture and compare, then share it: commons add <folder>
If the design also exists as a PDF (an export from Canva, Figma, InDesign, PowerPoint), convert that instead: commons convert <file.pdf>`;

async function missingPoppler() {
  const { execFile } = await import('node:child_process');
  const missing = await Promise.all(POPPLER_TOOLS.map((tool) => new Promise((resolve) => execFile(tool, ['-v'], { timeout: 20000 }, (err) => resolve(err?.code === 'ENOENT' ? tool : null)))));
  return missing.filter(Boolean);
}

// Returns the converter function, from the cached file. Downloads the file when it is missing, came from another
// site, was last checked more than a day ago or --refresh is given; a copy that is already there keeps working offline.
async function loadConverter(refresh) {
  const dir = cacheDir();
  const file = path.join(dir, 'convert-pdf.mjs');
  const stateFile = path.join(dir, 'convert-pdf.json');
  const state = readJson(stateFile) || {};
  const have = fs.existsSync(file) && state.url === ctx.url;
  const checked = Date.parse(state.checked_at || '') || 0;
  if (!have || refresh || Date.now() - checked > 86400000) {
    const address = `${ctx.url}/cli/convert-pdf.mjs`;
    try {
      const headers = { 'User-Agent': `commons-cli/${VERSION}` };
      // "max-age=0" is said out loud: fetch would otherwise add "no-cache" to a request with If-None-Match, and the
      // server then sends the whole file again instead of "304 Not Modified".
      if (have && state.etag && !refresh) Object.assign(headers, { 'If-None-Match': state.etag, 'Cache-Control': 'max-age=0' });
      const res = await fetch(address, { headers, signal: AbortSignal.timeout(60000) });
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const code = await res.text();
        if (!/export (default )?(async )?function pdfToTemplate\b/.test(code)) throw new Error('the site did not answer with the converter; it may run an older version');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.part`, code);
        fs.renameSync(`${file}.part`, file);
        state.etag = res.headers.get('etag') || '';
        state.fetched_at = new Date().toISOString();
        note(dim(`Downloaded the converter to ${file}`));
      }
      Object.assign(state, { url: ctx.url, checked_at: new Date().toISOString() });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    } catch (e) {
      const why = e.cause?.code || e.message;
      if (!have) throw new Error(`Cannot download the converter from ${address} (${why}). Set the site's address with "commons login --url <address>" or COMMONS_URL.`);
      note(dim(`Could not check for a newer converter (${why}); using the copy in ${dir}.`));
    }
  }
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.pdfToTemplate !== 'function') throw new Error(`${file} is not the converter. Delete it and run this again.`);
  return mod.pdfToTemplate;
}

async function cmdConvert({ pos, opt }) {
  const usage = 'Usage: commons convert <flyer.pdf> [--out <folder>] [--pages N] [--title T] [--logos]\nThe PDF is converted on this computer (no AI, nothing is uploaded): the artwork stays as it is and the text becomes editable.';
  const file = pos[0];
  if (!file) throw new Error(usage);
  if (!fs.existsSync(file)) throw new Error(`${file} not found.\n${usage}`);
  const kind = path.extname(file).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(kind)) {
    // A picture needs judgement (what is text, what is a photo, which font): that is work for the assistant.
    out(IMAGE_HELP(file));
    process.exitCode = 2;
    return;
  }
  if (kind !== 'pdf') throw new Error('Give a PDF. Export slides and documents as PDF first (PowerPoint, Keynote, Canva, Figma: "Export as PDF").');
  const missing = await missingPoppler();
  if (missing.length) throw new Error(POPPLER_HELP);
  const pdfToTemplate = await loadConverter(opt.refresh);
  const base = path.basename(file, path.extname(file));
  const dir = path.resolve(opt.out || slugify(base) + '-template');
  note(`Converting ${path.basename(file)} on this computer ...`);
  let r;
  try {
    r = await pdfToTemplate(fs.readFileSync(file), { maxPages: Math.min(30, parseInt(opt.pages, 10) || 12), qr: 'placeholder', title: String(opt.title || '').slice(0, 90) || undefined, markLogos: !!opt.logos });
  } catch (e) {
    if (/is not installed/.test(e.message)) throw new Error(POPPLER_HELP);
    throw new Error(`This PDF could not be converted: ${String(e.message).slice(0, 300)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'template.html'), r.html);
  for (const f of r.files || []) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.buffer);
  }
  const format = /commons:format" content="([^"]{1,60})"/.exec(r.html)?.[1];
  const itemFile = path.join(dir, 'item.json');
  if (!fs.existsSync(itemFile)) {
    const title = opt.title || base.replace(/[_-]+/g, ' ');
    fs.writeFileSync(itemFile, JSON.stringify({ slug: slugify(title), title, category: opt.category || 'print', kind: 'template', summary: 'TODO: one or two sentences on what this is and when it worked well.', group: ctx.cfg.group || 'TODO: your group', source: 'adapted', provenance: 'Converted from our own PDF; the original design is kept.', template: { path: 'template.html', format } }, null, 2) + '\n');
  }
  const rep = r.report || {};
  const slots = (prefix) => (rep.images || []).filter((i) => String(i.slot || '').startsWith(prefix)).length;
  const logos = slots('data-logo');
  if (opt.json) return out(JSON.stringify({ dir, method: 'kept-original', pages: r.pages, logos_marked: logos, report: rep }, null, 2));
  const near = path.relative(process.cwd(), dir) || '.';
  const shown = near.startsWith('..') ? dir : near; // a folder elsewhere is named in full
  const texts = rep.text?.elements ?? 0;
  const photos = slots('data-photo');
  out(`Converted, original design kept: ${dir}`);
  out(`  pages: ${r.pages}, editable texts: ${texts}, photo slots: ${photos}, logo slots: ${logos}, QR placeholders: ${slots('data-qr')}, template.html: ${size(Buffer.byteLength(r.html))}`);
  for (const w of rep.warnings || []) out(`  note: ${w}`);
  // Large pictures with a soft mask are only merged by sharp, which the converter finds when it is installed next to it.
  if ((rep.warnings || []).some((w) => /could not be merged with their mask/.test(w)) && !fs.existsSync(path.join(cacheDir(), 'node_modules', 'sharp'))) out(`  To merge them, install sharp next to the converter and convert again: npm install --prefix "${cacheDir()}" sharp`);
  if (!texts) out(`This PDF has no text that could be made editable (a scan, or an export that turned the page into a picture), so the template is
only that picture. Export the design again with live text, or rebuild it by hand from the contract: commons contract`);
  out(`Next:
  1. Open ${path.join(shown, 'template.html')} in a browser and compare it with the original.
  2. Check the logos yourself; the converter cannot know whose they are. ${logos ? `--logos marked ${logos} picture${logos === 1 ? '' : 's'} as the group's logo (data-logo): make sure each one is.` : photos ? 'Every picture is a photo slot (data-photo) for now.' : 'It found no separate pictures: a logo that is drawn from shapes, or part of a larger picture, is still in the artwork.'}
     The group's own logo: data-logo="wide" or "square" in place of data-photo. An event's logo: data-logo plus data-logo-slot="event".
     Logos of partners and sponsors stay photo slots. The group's name in a text: data-brand="group_name". Details: commons contract
  3. Fill in title and summary in ${path.join(shown, 'item.json')}, and take out private names and links.
  4. Share it: commons add ${shown}`);
}

async function cmdContract() {
  const cached = path.join(cacheDir(), 'TEMPLATE.md');
  let text;
  try {
    text = (await call('GET', '/cli/TEMPLATE.md', { raw: true })).toString('utf8');
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('the site did not answer with the contract; it may run an older version');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, text);
  } catch (e) {
    if (!fs.existsSync(cached)) throw e;
    note(dim(`Could not reach the site (${e.message}); this is the copy from ${cached}.`));
    text = fs.readFileSync(cached, 'utf8');
  }
  out(text.trimEnd());
}

async function cmdSkill({ pos, opt }) {
  if (pos[0] !== 'install') throw new Error('Usage: commons skill install [--dir <skills folder>]');
  const dir = path.join(opt.dir ? path.resolve(opt.dir) : path.join(os.homedir(), '.claude', 'skills'), 'commons');
  const text = await call('GET', '/cli/SKILL.md', { raw: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  out(`Installed the skill at ${path.join(dir, 'SKILL.md')}. Claude Code picks it up in new sessions.`);
}

async function cmdCategories({ opt }) {
  const m = await meta();
  if (opt.json) return out(JSON.stringify(m.categories, null, 2));
  for (const [id, label] of Object.entries(m.categories)) out(`${id.padEnd(10)} ${label}`);
}

const COMMANDS = {
  search: cmdSearch,
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  get: cmdGet,
  fork: cmdGet,
  vote: cmdVote,
  add: cmdAdd,
  pending: cmdPending,
  approve: cmdApprove,
  rm: cmdRm,
  login: cmdLogin,
  site: cmdSite,
  convert: cmdConvert,
  contract: cmdContract,
  skill: cmdSkill,
  categories: cmdCategories,
};

async function main() {
  // Output piped into a command that stops reading (for example `| head -1`) is not an error.
  process.stdout.on('error', (e) => (e.code === 'EPIPE' ? process.exit(0) : null));
  [fs, os, path, crypto] = await Promise.all(['node:fs', 'node:os', 'node:path', 'node:crypto'].map((m) => import(m)));
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' || name === 'version') return out(VERSION);
  if (!name || name === 'help' || name === '--help' || name === '-h') return out(HELP);
  const cmd = COMMANDS[name];
  if (!cmd) throw new Error(`Unknown command "${name}". Run "commons help".`);
  const args = parseArgs(rest);
  if (args.opt.help) return out(HELP);
  openContext(args.opt);
  await cmd(args);
}

main().catch((e) => {
  process.stderr.write(`commons: ${e.message}\n`);
  process.exit(1);
});
