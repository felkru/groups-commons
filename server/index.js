// Groups Commons: API + static site.
//
// Upload protocol (used by the web form and by the CLI):
//   1. POST /api/items                 item.json            -> { slug, edit_key, status: "draft" }
//   2. PUT  /api/items/:slug/files/*   raw file bytes        (X-Edit-Key or admin token)
//   3. POST /api/items/:slug/publish                         -> "published" (admin) or "pending" (everyone else)

import './log.js'; // first: turns console output into structured log lines on Cloud Run
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { USERNAME, checkFileKey, checkPassword, fileKey, hashPassword, publicAccount, sessionFor, sessions, sign, throttle, verify } from './accounts.js';
import * as ai from './ai.js';
import { CATEGORIES, Invalid, MAX_FILES, MAX_FILE_BYTES, MAX_ITEM_BYTES, MIME, checkActiveContent, checkPath, ext, requiredFiles, searchText, slugify, validateItem } from './ingest.js';
import { mountMcp } from './mcp.js';
import { addressKey, boundedMap, commonHeaders, handleSignals, health, isMain, publicError, serve, staticHeaders, sweepDrafts } from './ops.js';
import { dropThumbnails, officeToPdf, pdfFirstPage, pdfPages, thumbnail } from './preview.js';
import { score, sortItems } from './rank.js';
import { mountSetup } from './setup.js';
import { openStore } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const store = await openStore();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Cloud Run appends the real client address as the last X-Forwarded-For entry
app.use(compression()); // text responses only; images, video and archives pass through as they are
app.use(commonHeaders);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
// Names in addresses reach the store as document ids and folder names: anything that is not a plain name is "not found".
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const plainName = (re, message) => (req, res, next, value) => (re.test(value) ? next() : next(fail(404, message)));
app.param('slug', plainName(SLUG, 'No material with that name.'));
// The signed-in account is looked up once per request, so a deleted account or a changed password ends its sessions.
const signedIn = sessions(store);
app.use(wrap(async (req, res, next) => {
  req._account = await signedIn.resolve(req.get('x-session'));
  next();
}));
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
// The signed-in account, if any: { u: user name, g: group, r: role }.
const account = (req) => req._account || null;
// Moderators: whoever holds the moderator token, and accounts that were given the moderator role.
const isAdmin = (req) => {
  const t = req.get('x-admin-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return (!!ADMIN_TOKEN && !!t && safeEq(t, ADMIN_TOKEN)) || account(req)?.r === 'moderator';
};
// Who votes and owns materials: the account when signed in, otherwise the browser's random id.
const clientId = (req) => {
  const a = account(req);
  if (a) return `acct-${a.u}`;
  const id = req.get('x-client-id') || '';
  return /^[A-Za-z0-9-]{8,64}$/.test(id) && !id.startsWith('acct-') ? id : null;
};
const canEdit = (req, item) => isAdmin(req) || (!!item.owner && item.owner.startsWith('acct-') && item.owner === clientId(req)) || (!!item.edit_key && safeEq(req.get('x-edit-key') || '', item.edit_key));
const canSee = (req, item) => item.status === 'published' || isAdmin(req) || (!!item.owner && item.owner === clientId(req));

// ---- rate limits (per address, in memory; global daily caps live in the store) ----
const buckets = boundedMap(100000); // at most this many counters; the oldest go first
// Counts one request; false when the address is over its limit.
const take = (req, name, max, windowMs = 3600e3) => {
  if (isAdmin(req)) return true;
  const key = `${name}:${addressKey(req.ip)}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) buckets.set(key, (b = { n: 0, reset: now + windowMs }));
  return ++b.n <= max;
};
const TOO_MANY = 'Too many requests from this address. Try again in a while.';
const limit = (name, max, windowMs = 3600e3) => (req, res, next) => {
  if (!take(req, name, max, windowMs)) return res.status(429).set('Retry-After', '600').json({ error: TOO_MANY });
  next();
};
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 600e3).unref();

// ---- views ----
function view(item, req, full = false) {
  const { emb, edit_key, owner, ...out } = item;
  out.score = score(item);
  out.mine = !!owner && owner === clientId(req);
  if (!out.mine && !isAdmin(req)) delete out.author; // the uploader's user name is for the moderation page, not for everyone
  // Files of a material that is not published are not public; whoever may see it gets a key for their addresses.
  if (item.status !== 'published' && canSee(req, item)) out.file_key = fileKey(item.slug);
  if (full) return out;
  delete out.description;
  if (out.variants) {
    out.snippet = (item.variants[0].body || '').replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`|]+/g, ' ').replace(/-{3,}/g, ' ').replace(/\s+/g, ' ').trim();
    // Cut at a word, never in the middle of one.
    if (out.snippet.length > 260) out.snippet = out.snippet.slice(0, 261).replace(/\s+\S*$/, '').replace(/[\s,;:–-]+$/, '') + ' …';
    out.variants = item.variants.map(({ label, lang, channel }) => ({ label, lang, channel }));
  }
  if (out.kit) out.kit = { est_cost: item.kit.est_cost, count: item.kit.items.length, first: item.kit.items.slice(0, 5).map((k) => k.name) };
  if (out.supplier) out.supplier = { ...item.supplier, request: item.supplier.request ? { subject: item.supplier.request.subject } : undefined };
  delete out.file_list;
  return out;
}

// ---- search: keyword score blended with embedding similarity ----
const qcache = new Map();
async function queryEmbedding(q) {
  if (!ai.enabled) return null;
  if (qcache.has(q)) return qcache.get(q);
  if (!(await store.takeQuota('embed-query', 20000))) return null;
  try {
    const e = await ai.embed(q, 'RETRIEVAL_QUERY');
    if (qcache.size > 500) qcache.delete(qcache.keys().next().value);
    qcache.set(q, e);
    return e;
  } catch (err) {
    console.warn('query embedding failed:', err.message);
    return null;
  }
}
const STOP = new Set('the and for with from that this what when where who how our your you are was can not but about into out any all get need want some something have has use used using its their them they'.split(' '));
const stem = (t) => (t.length > 3 ? t.replace(/(ies|es|s)$/, '') : t);
function keywordScore(item, tokens) {
  if (!tokens.length) return 0;
  const title = item.title.toLowerCase();
  const tags = (item.tags || []).join(' ') + ' ' + item.category + ' ' + CATEGORIES[item.category].toLowerCase();
  const summary = (item.summary || '').toLowerCase();
  const rest = searchText(item).toLowerCase();
  let total = 0;
  for (const t of tokens) total += title.includes(t) ? 1 : tags.includes(t) ? 0.8 : summary.includes(t) ? 0.6 : rest.includes(t) ? 0.35 : 0;
  return total / tokens.length;
}
async function search(items, q) {
  const tokens = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2 && !STOP.has(t)).map(stem))];
  const qe = await queryEmbedding(q.toLowerCase().trim().slice(0, 300));
  const rows = items.map((item) => ({ item, kw: keywordScore(item, tokens), cos: qe && item.emb ? ai.cosine(qe, item.emb) : null }));
  const cosines = rows.map((r) => r.cos).filter((c) => c != null);
  if (!cosines.length) {
    return { mode: 'keyword', items: rows.filter((r) => r.kw > 0).sort((a, b) => b.kw - a.kw || score(b.item) - score(a.item)).map((r) => r.item) };
  }
  const hi = Math.max(...cosines);
  const mean = cosines.reduce((a, b) => a + b, 0) / cosines.length;
  const sd = Math.sqrt(cosines.reduce((a, b) => a + (b - mean) ** 2, 0) / cosines.length) || 1e-6;
  // A material is a semantic hit when it stands out from the pack (z-score) and is close to the best match.
  for (const r of rows) {
    const z = r.cos == null ? -9 : (r.cos - mean) / sd;
    r.sem = r.cos == null ? 0 : Math.max(0, Math.min(1, z / 3));
    r.hit = r.kw >= 0.5 || (z >= 1.2 && r.cos >= hi - 0.05);
    r.rank = 0.6 * r.sem + 0.4 * r.kw;
  }
  rows.sort((a, b) => b.rank - a.rank);
  rows.slice(0, 3).forEach((r) => (r.hit = true)); // never an empty page while something is at least close
  const hits = rows.filter((r) => r.hit).slice(0, 30);
  return { mode: 'semantic', items: hits.map((r) => r.item), debug: [...rows].sort((a, b) => b.cos - a.cos).slice(0, 40).map((r) => ({ slug: r.item.slug, cos: +(r.cos ?? 0).toFixed(3), kw: +r.kw.toFixed(2), hit: r.hit })) };
}

// ---- API ----
const api = express.Router();
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const json = express.json({ limit: '2mb' });
api.param('slug', plainName(SLUG, 'No material with that name.'));
api.param('username', plainName(USERNAME, 'No account with that name.'));
api.get('/health', wrap(health(store)));

api.get('/meta', (req, res) => {
  const a = account(req);
  res.json({ categories: CATEGORIES, mcp: `${origin(req)}/mcp`, semantic_search: ai.enabled, conversion: ai.enabled, logos: ai.enabled, admin: isAdmin(req), account: a ? { username: a.u, group: a.g, role: a.r } : null, limits: { file_mb: MAX_FILE_BYTES / 1048576, types: Object.keys(MIME) } });
});

api.get(
  '/items',
  wrap(async (req, res) => {
    const all = await store.allItems();
    const me = clientId(req);
    const admin = isAdmin(req);
    let items = all.filter((i) => i.status === 'published' || ((admin || (me && i.owner === me)) && i.status === 'pending'));
    if (req.query.pending) items = items.filter((i) => i.status === 'pending');
    const forks = {};
    for (const i of items) if (i.forked_from) forks[i.forked_from] = (forks[i.forked_from] || 0) + 1;
    const counts = {};
    for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
    const total = items.length;
    let mode = 'browse';
    const q = String(req.query.q || '').trim().slice(0, 300);
    let debug;
    if (q) ({ items, mode, debug } = await search(items, q));
    const hits = {};
    for (const i of items) hits[i.category] = (hits[i.category] || 0) + 1;
    if (req.query.category) items = items.filter((i) => i.category === req.query.category);
    if (req.query.kind) items = items.filter((i) => i.kind === req.query.kind);
    if (!q || req.query.sort) items = sortItems(items, String(req.query.sort || 'best'));
    res.json({ mode, total, counts: q ? hits : counts, debug: admin && req.query.debug ? debug : undefined, items: items.map((i) => ({ ...view(i, req), forks: forks[i.slug] || 0 })) });
  }),
);

api.get(
  '/items/:slug',
  wrap(async (req, res) => {
    const item = await store.getItem(req.params.slug);
    if (!item || !canSee(req, item)) throw fail(404, 'No material with that name.');
    const all = await store.allItems();
    const forks = all.filter((i) => i.forked_from === item.slug && i.status === 'published').map((i) => ({ slug: i.slug, title: i.title, group: i.group, score: score(i) }));
    const parent = item.forked_from ? all.find((i) => i.slug === item.forked_from && canSee(req, i)) : null;
    const out = view(item, req, true);
    if (out.kit) {
      const withInfo = (k) => {
        const m = k.material && all.find((i) => i.slug === k.material && i.status === 'published');
        return m ? { ...k, material_info: { title: m.title, kind: m.kind } } : k;
      };
      out.kit = { ...out.kit, items: out.kit.items.map(withInfo) };
    }
    res.json({ ...out, forks, parent: parent ? { slug: parent.slug, title: parent.title, group: parent.group } : null });
  }),
);

// A published material that its owner changes goes back to review; otherwise an approval would cover whatever
// is uploaded afterwards. Moderators' own changes stay published.
const afterEdit = (req, item) => (item.status === 'published' && !isAdmin(req) ? 'pending' : item.status);
const gone = () => fail(404, 'No material with that name.');
async function freeSlug(base) {
  let slug = base;
  for (let n = 2; await store.getItem(slug); n++) slug = `${base.slice(0, 56)}-${n}`;
  return slug;
}
function newItem(clean, req) {
  const now = new Date().toISOString();
  return { ...clean, status: 'draft', edit_key: crypto.randomBytes(18).toString('hex'), owner: clientId(req) || undefined, author: account(req)?.u, created_at: now, updated_at: now, up: 0, down: 0, uses: 0, file_list: [] };
}

api.post(
  '/items',
  limit('write', 60),
  json,
  wrap(async (req, res) => {
    const clean = validateItem(req.body);
    const existing = await store.getItem(clean.slug);
    if (existing && req.body.auto_slug && !canEdit(req, existing)) clean.slug = await freeSlug(clean.slug);
    else if (existing) {
      if (!canEdit(req, existing)) throw fail(409, `A material called "${clean.slug}" already exists. Pick another slug, or pass its edit key to update it.`);
      const keep = (({ status, edit_key, owner, author, created_at, up, down, uses, simulated, file_list, emb, pages, featured, featured_at }) => ({ status, edit_key, owner, author, created_at, up, down, uses, simulated, file_list, emb, pages, featured, featured_at }))(existing);
      const item = { ...clean, ...keep, updated_at: new Date().toISOString() };
      item.status = afterEdit(req, existing);
      await store.putItem(item);
      return res.json({ slug: item.slug, edit_key: item.edit_key, status: item.status, updated: true });
    }
    const item = newItem(clean, req);
    await store.putItem(item);
    res.status(201).json({ slug: item.slug, edit_key: item.edit_key, status: item.status });
  }),
);

async function saveFile(item, p, buffer) {
  checkPath(p);
  if (!buffer?.length) throw new Invalid(`${p}: empty file`);
  if (buffer.length > MAX_FILE_BYTES) throw new Invalid(`${p}: larger than ${MAX_FILE_BYTES / 1048576} MB`);
  const list = (item.file_list || []).filter((f) => f.path !== p);
  if (list.length >= MAX_FILES) throw new Invalid(`A material can hold at most ${MAX_FILES} files`);
  if (list.reduce((a, f) => a + f.size, 0) + buffer.length > MAX_ITEM_BYTES) throw new Invalid(`A material can hold at most ${MAX_ITEM_BYTES / 1048576} MB`);
  checkActiveContent(p, buffer);
  await store.putFile(item.slug, p, buffer, MIME[ext(p)]);
  dropThumbnails(`${item.slug}/${p}`);
  list.push({ path: p, size: buffer.length });
  item.file_list = list;
  // null: the material was deleted while this upload was under way.
  if (!(await store.patchItem(item.slug, { file_list: list, updated_at: new Date().toISOString() }))) throw gone();
}

api.put(
  '/items/:slug/files/*',
  limit('upload', 600),
  express.raw({ limit: '26mb', type: () => true }),
  wrap(async (req, res) => {
    const item = await store.getItem(req.params.slug);
    if (!item) throw fail(404, 'No material with that name.');
    if (!canEdit(req, item)) throw fail(403, 'Wrong or missing edit key.');
    await saveFile(item, req.params[0], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    if (afterEdit(req, item) !== item.status) await store.patchItem(item.slug, { status: afterEdit(req, item) });
    res.json({ ok: true, path: req.params[0] });
  }),
);

// Page images for the first document of a file material: a PDF as it is, Office files through LibreOffice.
const OFFICE = ['pptx', 'docx', 'xlsx', 'odp'];
async function pagePreviews(item) {
  const pdf = item.files.find((f) => ext(f.path) === 'pdf');
  const office = item.files.find((f) => OFFICE.includes(ext(f.path)));
  let doc = pdf ? await store.readFile(item.slug, pdf.path) : null;
  if (!doc && office) doc = await officeToPdf(await store.readFile(item.slug, office.path), ext(office.path));
  if (!doc) return [];
  const pages = await pdfPages(doc, 12);
  const paths = [];
  for (const [i, jpg] of pages.entries()) {
    const p = `_pages/p${String(i + 1).padStart(2, '0')}.jpg`;
    await saveFile(item, p, jpg);
    paths.push(p);
  }
  return paths;
}

const DEFAULT_LOGOS = ['logo-square.svg', 'logo-wide.svg', 'logo-square-light.svg', 'logo-wide-light.svg'];
async function finish(item, req) {
  const have = new Set((item.file_list || []).map((f) => f.path));
  const missing = requiredFiles(item).filter((p) => !have.has(p));
  if (missing.length) throw new Invalid(`Upload these files first: ${missing.join(', ')}`);
  const patch = {};
  if (item.kind === 'template') {
    // Templates reference default logo files next to them; add the stock ones if the uploader left them out.
    for (const name of DEFAULT_LOGOS) {
      if (have.has(name)) continue;
      await saveFile(item, name, fs.readFileSync(path.join(PUBLIC, 'assets', 'brand', name)));
    }
  }
  if (!item.preview && item.kind === 'file') {
    const image = item.files.find((f) => ['jpg', 'jpeg', 'png', 'webp'].includes(ext(f.path)));
    const pdf = item.files.find((f) => ext(f.path) === 'pdf');
    if (image) patch.preview = image.path;
    else if (pdf) {
      const jpg = await pdfFirstPage(await store.readFile(item.slug, pdf.path));
      if (jpg) {
        await saveFile(item, '_preview.jpg', jpg);
        patch.preview = '_preview.jpg';
      }
    }
  }
  if (item.kind === 'file') {
    try {
      patch.pages = await pagePreviews(item);
      if (patch.pages.length && !item.preview && !patch.preview) patch.preview = patch.pages[0];
    } catch (e) {
      console.warn('page previews failed for', item.slug, e.message);
    }
  }
  try {
    const emb = await ai.embed(searchText({ ...item, ...patch }));
    if (emb) patch.emb = emb;
  } catch (e) {
    console.warn('embedding failed for', item.slug, e.message);
  }
  patch.status = isAdmin(req) ? 'published' : 'pending';
  patch.updated_at = new Date().toISOString();
  const stats = isAdmin(req) && req.body?.stats;
  if (stats) {
    for (const k of ['up', 'down', 'uses']) if (Number.isFinite(stats[k])) patch[k] = Math.max(0, Math.round(stats[k]));
    if (stats.created_at && !Number.isNaN(Date.parse(stats.created_at))) patch.created_at = new Date(stats.created_at).toISOString();
    patch.simulated = true;
  }
  if (!(await store.patchItem(item.slug, patch))) throw gone();
  return patch.status;
}

api.post(
  '/items/:slug/publish',
  limit('write', 60),
  json,
  wrap(async (req, res) => {
    const item = await store.getItem(req.params.slug);
    if (!item) throw fail(404, 'No material with that name.');
    if (!canEdit(req, item)) throw fail(403, 'Wrong or missing edit key.');
    const status = await finish(item, req);
    res.json({ slug: item.slug, status });
  }),
);

api.post(
  '/items/:slug/approve',
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Admin token required.');
    const item = await store.getItem(req.params.slug);
    if (!item) throw fail(404, 'No material with that name.');
    if (!(await store.patchItem(item.slug, { status: 'published', updated_at: new Date().toISOString() }))) throw gone();
    res.json({ slug: item.slug, status: 'published' });
  }),
);

// Moderators mark the best materials; they are shown first on the front page and flagged for assistants.
api.post(
  '/items/:slug/feature',
  json,
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Moderators only.');
    const item = await store.getItem(req.params.slug);
    if (!item) throw fail(404, 'No material with that name.');
    const featured = req.body?.featured !== false;
    if (!(await store.patchItem(item.slug, { featured, featured_at: featured ? new Date().toISOString() : null }))) throw gone();
    res.json({ slug: item.slug, featured });
  }),
);

api.delete(
  '/items/:slug',
  wrap(async (req, res) => {
    const item = await store.getItem(req.params.slug);
    if (!item) throw fail(404, 'No material with that name.');
    if (!canEdit(req, item)) throw fail(403, 'Wrong or missing edit key.');
    await store.deleteItem(item.slug);
    dropThumbnails(`${item.slug}/`);
    res.json({ ok: true });
  }),
);

// Create a material in one step (metadata, files, publish). Used by the MCP server.
async function createMaterial(req, meta, files = []) {
  if (!take(req, 'write', 60)) throw fail(429, TOO_MANY); // the same allowance as the web form
  const clean = validateItem(meta);
  clean.slug = await freeSlug(clean.slug);
  const item = newItem(clean, req);
  await store.putItem(item);
  for (const f of files) await saveFile(item, f.path, f.buffer);
  return { slug: item.slug, status: await finish(item, req) };
}

// Re-share a customized copy of a template: the server copies the original's files and swaps in the edited HTML.
api.post(
  '/items/:slug/fork',
  limit('write', 60),
  express.json({ limit: '9mb' }),
  wrap(async (req, res) => {
    const src = await store.getItem(req.params.slug);
    if (!src || !canSee(req, src)) throw fail(404, 'No material with that name.');
    if (src.kind !== 'template') throw new Invalid('Only templates can be re-shared from the editor. Use "commons add" for other materials.');
    const html = Buffer.from(String(req.body.html || ''), 'utf8');
    if (html.length < 200 || html.length > 6000000) throw new Invalid('The edited template is missing or too large (6 MB at most, photos included).');
    const { slug, title, summary, group, ...rest } = view(src, req, true);
    const clean = validateItem({
      ...rest,
      slug: await freeSlug(slugify(req.body.title || `${src.title} fork`)),
      title: req.body.title || `${src.title} (fork)`,
      summary: req.body.summary || summary,
      group: req.body.group || 'Anonymous group',
      source: 'adapted',
      provenance: `Customized from "${src.title}" by ${src.group}.`,
      forked_from: src.slug,
    });
    const item = newItem(clean, req);
    await store.putItem(item);
    const others = (src.file_list || []).map((f) => f.path).filter((p) => p !== src.template.path);
    await store.copyFiles(src.slug, item.slug, others);
    item.file_list = (src.file_list || []).filter((f) => f.path !== src.template.path);
    await saveFile(item, clean.template.path, html);
    const status = await finish(item, req);
    res.status(201).json({ slug: item.slug, edit_key: item.edit_key, status });
  }),
);

api.post(
  '/items/:slug/vote',
  limit('vote', 300),
  json,
  wrap(async (req, res) => {
    const me = clientId(req);
    if (!me) throw fail(400, 'Missing client id.');
    const dir = ['number', 'string'].includes(typeof req.body.dir) && req.body.dir !== '' ? Number(req.body.dir) : NaN; // null or true is not a vote
    if (![1, 0, -1].includes(dir)) throw new Invalid('dir must be 1, 0 or -1');
    const item = await store.getItem(req.params.slug);
    if (!item || item.status !== 'published') throw fail(404, 'No material with that name.');
    const r = await store.vote(item.slug, me, dir);
    res.json({ ...r, score: r.up - r.down });
  }),
);

api.get(
  '/me/votes',
  wrap(async (req, res) => {
    const me = clientId(req);
    res.json(me ? await store.votesOf(me) : {});
  }),
);

// Counts a download / copy / print. One per visitor per material per server instance.
const used = boundedMap(50000); // when it is full the oldest entries are forgotten, not all of them
api.post(
  '/items/:slug/use',
  limit('use', 600),
  wrap(async (req, res) => {
    const item = await store.getItem(req.params.slug);
    if (!item || item.status !== 'published') throw fail(404, 'No material with that name.');
    const key = `${item.slug}:${clientId(req) || req.ip}`;
    if (!used.has(key)) {
      used.set(key, 1);
      await store.incr(item.slug, 'uses', 1);
    }
    res.json({ uses: item.uses || 0 });
  }),
);

// The conversion agent: a finished printable (PDF or image) in, a contract-conforming template out.
const stripActive = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|form)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
api.post(
  '/convert',
  limit('convert', 6),
  express.raw({ limit: '26mb', type: () => true }),
  wrap(async (req, res) => {
    const type = (req.get('content-type') || '').split(';')[0].trim();
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Invalid('Send a PDF, PNG, JPEG or WebP file.');
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw new Invalid('Empty upload.');
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 1000);
    const rebuild = req.query.mode === 'rebuild';
    // A PDF is converted without any AI: the artwork stays exactly as it is and the text becomes live text.
    if (type === 'application/pdf' && !rebuild) {
      const { pdfToTemplate } = await import('./convert-pdf.js');
      let out;
      try {
        out = await pdfToTemplate(req.body, { maxPages: Math.min(30, parseInt(req.query.pages, 10) || 12), qr: 'placeholder', title: String(req.query.title || '').slice(0, 90) || undefined });
      } catch (e) {
        throw new Invalid(`This PDF could not be converted: ${String(e.message).slice(0, 200)}`);
      }
      checkActiveContent('template.html', Buffer.from(out.html));
      return res.json({ html: out.html, files: [], method: 'kept-original', pages: out.pages, report: out.report, seconds: seconds() });
    }
    if (!ai.enabled) throw fail(503, 'Converting images needs the AI services, which are switched off on this server.');
    if (!isAdmin(req) && !(await store.takeQuota('convert', 150))) throw fail(429, 'The conversion agent has reached its daily limit. Try again tomorrow.');
    // An image keeps its picture: an image model removes the baked-in text, and the text is set again as live text.
    const imageConverter = rebuild || type === 'application/pdf' ? null : await import('./convert-image.js').then((m) => m.imageToTemplate).catch(() => null);
    if (imageConverter) {
      const out = await imageConverter(req.body, type, { hint: String(req.query.hint || '') });
      checkActiveContent('template.html', Buffer.from(out.html));
      const files = (out.files || []).map((f) => ({ path: f.path, type: MIME[ext(f.path)] || 'application/octet-stream', data: f.buffer.toString('base64') }));
      return res.json({ html: out.html, files, method: 'kept-original', pages: 1, report: out.report, seconds: seconds() });
    }
    // Last resort, or when asked for: an AI redraws the design from scratch. Simpler, and photos are lost.
    const out = await ai.convertPrintable(req.body, type, String(req.query.hint || ''));
    const html = stripActive(out.html);
    checkActiveContent('template.html', Buffer.from(html));
    res.json({ html, files: [], method: 'rebuilt', model: out.model, seconds: seconds() });
  }),
);

// ---- accounts ----
const needAccount = (req) => {
  const a = account(req);
  if (!a) throw fail(401, 'Sign in first.');
  return a;
};
api.post(
  '/accounts',
  limit('signup', 10),
  json,
  wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const group = String(req.body.group || '').trim().slice(0, 80);
    if (!USERNAME.test(username)) throw new Invalid('Pick a user name with 3 to 30 lower-case letters, digits or hyphens.');
    if (password.length < 8 || password.length > 200) throw new Invalid('The password needs at least 8 characters.');
    if (!group) throw new Invalid('Tell us which group you organize for.');
    const acct = { username, group, role: 'member', password: hashPassword(password), created_at: new Date().toISOString() };
    // One step, so two people asking for the same name at the same moment cannot both get it.
    if (!(await store.createDoc('accounts', username, acct))) throw fail(409, 'That user name is taken.');
    signedIn.forget(username);
    res.status(201).json(sessionFor(acct));
  }),
);
// Wrong passwords are counted per user name (five, then a quarter of an hour's wait), on top of the limit per address.
const signIns = throttle({ max: 5, windowMs: 15 * 60e3 });
async function passwordCheck(username, password) {
  if (!USERNAME.test(username)) throw fail(401, 'Wrong user name or password.');
  const wait = signIns.blocked(username);
  if (wait) throw fail(429, `Too many wrong passwords for this user name. Try again in ${Math.ceil(wait / 60)} minutes.`);
  const acct = await store.getDoc('accounts', username);
  if (!acct || !checkPassword(password, acct.password)) {
    signIns.fail(username);
    throw fail(401, 'Wrong user name or password.');
  }
  signIns.clear(username);
  return acct;
}
api.post(
  '/session',
  limit('login', 30),
  json,
  wrap(async (req, res) => {
    const acct = await passwordCheck(String(req.body.username || '').trim().toLowerCase(), String(req.body.password || ''));
    res.json(sessionFor(acct));
  }),
);
// Removes an account and what hangs on it. Decided as follows (see SECURITY.md and the privacy page):
// - hosted websites of the account are taken down and their files deleted;
// - the saved brand kit is deleted and the account's votes are withdrawn;
// - materials that are not published yet are deleted;
// - published materials stay in the commons (other groups build on them) but lose the link to the account:
//   no owner, no user name. With `deleteMaterials` they are deleted as well.
// Nothing stays tied to the user name, so whoever registers it later inherits nothing.
async function removeAccount(username, deleteMaterials = false) {
  const id = `acct-${username}`;
  for (const item of await store.allItems()) {
    if (item.owner !== id) continue;
    if (deleteMaterials || item.status !== 'published') {
      await store.deleteItem(item.slug);
      dropThumbnails(`${item.slug}/`);
    } else await store.patchItem(item.slug, { owner: null, author: null });
  }
  for (const site of await store.listDocs('sites')) {
    if (site.owner !== id) continue;
    await store.deleteDoc('sites', site.name);
    await store.deleteFiles('_sites', `${site.name}/`);
  }
  for (const slug of Object.keys(await store.votesOf(id))) await store.vote(slug, id, 0).catch(() => {});
  await store.deleteFiles('_accounts', `${username}/`);
  await store.deleteDoc('accounts', username);
  signedIn.forget(username);
}
// A signed-in person changes their password. Every other session of the account ends; this one gets a new token.
api.post(
  '/me/password',
  limit('login', 30),
  json,
  wrap(async (req, res) => {
    const me = needAccount(req);
    const next = String(req.body.password || '');
    if (next.length < 8 || next.length > 200) throw new Invalid('The password needs at least 8 characters.');
    const acct = await passwordCheck(me.u, String(req.body.current || ''));
    const updated = { ...acct, password: hashPassword(next), valid_from: Date.now() };
    await store.setDoc('accounts', acct.username, updated);
    signedIn.forget(acct.username);
    res.json(sessionFor(updated));
  }),
);
// A signed-in person deletes their account. The password is asked again, so an unattended browser is not enough.
api.post(
  '/me/delete',
  limit('login', 30),
  json,
  wrap(async (req, res) => {
    const me = needAccount(req);
    await passwordCheck(me.u, String(req.body.password || ''));
    await removeAccount(me.u, req.body.materials === 'delete');
    res.json({ ok: true });
  }),
);
api.get(
  '/accounts',
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Moderators only.');
    res.json((await store.listDocs('accounts')).map(publicAccount));
  }),
);
api.post(
  '/accounts/:username/role',
  json,
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Moderators only.');
    const acct = await store.getDoc('accounts', req.params.username);
    if (!acct) throw fail(404, 'No account with that name.');
    acct.role = req.body.role === 'moderator' ? 'moderator' : 'member';
    await store.setDoc('accounts', acct.username, acct);
    signedIn.forget(acct.username);
    res.json(publicAccount(acct)); // takes effect at once here, and within half a minute on other instances
  }),
);
api.delete(
  '/accounts/:username',
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Moderators only.');
    await removeAccount(req.params.username, req.query.materials === 'delete');
    res.json({ ok: true });
  }),
);
// The brand kit follows the account to other devices. Logos make it too large for a database document, so it is a file.
api.get(
  '/me/brand',
  wrap(async (req, res) => {
    const buf = await store.readFile('_accounts', `${needAccount(req).u}/brand.json`);
    res.json(buf ? JSON.parse(buf.toString('utf8')) : null);
  }),
);
api.put(
  '/me/brand',
  limit('brand', 240),
  express.json({ limit: '3mb' }),
  wrap(async (req, res) => {
    const a = needAccount(req);
    const brand = {};
    for (const [k, v] of Object.entries(req.body || {})) if (/^[a-z_]{2,30}$/.test(k) && typeof v === 'string' && v.length < 600000) brand[k] = v;
    await store.putFile('_accounts', `${a.u}/brand.json`, Buffer.from(JSON.stringify(brand)), 'application/json');
    res.json({ ok: true });
  }),
);

// ---- hosted group websites: a customized website template, served at /s/<name> ----
const SITE_NAME = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SITE_BANNER = '<div style="font:12px/1.4 system-ui,sans-serif;text-align:center;padding:10px;background:#f6efe9;color:#6d5045">Hosted on Groups Commons (prototype)</div>';
const publicSite = ({ name, title, owner, status, updated_at, files, multi }) => ({ name, title, owner, status, updated_at, files: multi ? (files || []).length : 1 });
api.get(
  '/sites',
  wrap(async (req, res) => {
    const me = account(req) && clientId(req);
    const all = await store.listDocs('sites');
    res.json(all.filter((s) => isAdmin(req) || (me && s.owner === me)).map(publicSite));
  }),
);
api.post(
  '/sites',
  limit('write', 60),
  express.json({ limit: '3mb' }),
  wrap(async (req, res) => {
    needAccount(req);
    const name = slugify(req.body.name).slice(0, 40);
    if (!SITE_NAME.test(name)) throw new Invalid('The site name needs 3 to 40 lower-case letters, digits or hyphens.');
    const existing = await store.getDoc('sites', name);
    if (existing && existing.owner !== clientId(req) && !isAdmin(req)) throw fail(409, 'That site name is taken.');
    const html = stripActive(String(req.body.html || ''));
    if (html.length < 200 || html.length > 2500000 || !/<html[\s>]/i.test(html)) throw new Invalid('The page is missing or too large.');
    checkActiveContent('index.html', Buffer.from(html));
    const title = String(req.body.title || name).slice(0, 90);
    const safeTitle = title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const page = /<title>[^<]*<\/title>/i.test(html) ? html.replace(/<title>[^<]*<\/title>/i, `<title>${safeTitle}</title>`) : html;
    await store.putFile('_sites', `${name}/index.html`, Buffer.from(page), 'text/html; charset=utf-8');
    const site = { name, title, owner: existing?.owner || clientId(req), status: isAdmin(req) ? 'published' : 'pending', updated_at: new Date().toISOString() };
    await store.setDoc('sites', name, site);
    res.status(existing ? 200 : 201).json(publicSite(site));
  }),
);
// A whole static site (the output of a site generator), uploaded file by file by the CLI: `commons site publish <folder>`.
const SITE_MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8', txt: 'text/plain; charset=utf-8', webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', pdf: 'application/pdf',
};
const SITE_PATH = /^[A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*$/;
const SITE_MAX_FILES = 600;
const SITE_MAX_BYTES = 80 * 1024 * 1024;
api.put(
  '/sites/:name/files/*',
  limit('upload', 3000),
  express.raw({ limit: '12mb', type: () => true }),
  wrap(async (req, res) => {
    needAccount(req);
    const name = req.params.name;
    const p = req.params[0];
    if (!SITE_NAME.test(name)) throw new Invalid('The site name needs 3 to 40 lower-case letters, digits or hyphens.');
    if (!SITE_PATH.test(p) || p.includes('..') || p.length > 200) throw new Invalid(`Invalid file path: ${p}`);
    if (!SITE_MIME[ext(p)]) throw new Invalid(`File type not allowed on a website: ${p}`);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) throw new Invalid(`${p}: empty file`);
    let site = await store.getDoc('sites', name);
    if (site && site.owner !== clientId(req) && !isAdmin(req)) throw fail(409, 'That site name is taken.');
    if (!site) site = { name, title: name, owner: clientId(req), status: 'draft', files: [], updated_at: new Date().toISOString() };
    const files = (site.files || []).filter((f) => f.path !== p);
    if (files.length >= SITE_MAX_FILES) throw new Invalid(`A site can hold at most ${SITE_MAX_FILES} files.`);
    if (files.reduce((a, f) => a + f.size, 0) + buffer.length > SITE_MAX_BYTES) throw new Invalid('The site is larger than 80 MB.');
    await store.putFile('_sites', `${name}/${p}`, buffer, SITE_MIME[ext(p)]);
    files.push({ path: p, size: buffer.length });
    // A live site that its owner changes goes back to review, like a material (see afterEdit).
    await store.setDoc('sites', name, { ...site, status: afterEdit(req, site), files, multi: true, updated_at: new Date().toISOString() });
    res.json({ ok: true, path: p });
  }),
);
api.post(
  '/sites/:name/publish',
  limit('write', 60),
  json,
  wrap(async (req, res) => {
    const site = await ownSite(req);
    // The uploader says which files belong to this version; anything else from an earlier upload is dropped.
    const keep = Array.isArray(req.body?.files) ? new Set(req.body.files.map(String)) : null;
    const files = (site.files || []).filter((f) => !keep || keep.has(f.path));
    if (!files.some((f) => f.path === 'index.html')) throw new Invalid('The site needs an index.html at its top level.');
    const next = { ...site, files, title: String(req.body?.title || site.title || site.name).slice(0, 90), status: isAdmin(req) ? 'published' : 'pending', updated_at: new Date().toISOString() };
    await store.setDoc('sites', site.name, next);
    const base = `${origin(req)}/s/${site.name}/`;
    res.json({ ...publicSite(next), url: base, preview_url: `${base}?preview=${sign({ u: 'preview', site: site.name }, 2)}`, files: files.length });
  }),
);

const ownSite = async (req) => {
  const site = SITE_NAME.test(req.params.name) ? await store.getDoc('sites', req.params.name) : null;
  if (!site) throw fail(404, 'No site with that name.');
  if (!isAdmin(req) && site.owner !== clientId(req)) throw fail(403, 'That is not your site.');
  return site;
};
api.get(
  '/sites/:name/html',
  wrap(async (req, res) => {
    const site = await ownSite(req);
    res.json({ html: ((await store.readFile('_sites', `${site.name}/index.html`)) || '').toString('utf8') });
  }),
);
api.post(
  '/sites/:name/approve',
  wrap(async (req, res) => {
    if (!isAdmin(req)) throw fail(403, 'Moderators only.');
    const site = await ownSite(req);
    site.status = 'published';
    await store.setDoc('sites', site.name, site);
    res.json(publicSite(site));
  }),
);
api.delete(
  '/sites/:name',
  wrap(async (req, res) => {
    const site = await ownSite(req);
    await store.deleteDoc('sites', site.name);
    await store.deleteFiles('_sites', `${site.name}/`); // every file of the site, not only its first page
    res.json({ ok: true });
  }),
);

// ---- competition: the most upvoted materials of the running semester, and all-time standings by group ----
function semester(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (m >= 3 && m <= 8) return { label: `Summer semester ${y}`, start: new Date(Date.UTC(y, 3, 1)), end: new Date(Date.UTC(y, 9, 1)) };
  const s = m >= 9 ? y : y - 1;
  return { label: `Winter semester ${s}/${String(s + 1).slice(2)}`, start: new Date(Date.UTC(s, 9, 1)), end: new Date(Date.UTC(s + 1, 3, 1)) };
}
api.get(
  '/leaderboard',
  wrap(async (req, res) => {
    const items = (await store.allItems()).filter((i) => i.status === 'published');
    const sem = semester();
    const fresh = items.filter((i) => Date.parse(i.created_at) >= sem.start.getTime()).sort((a, b) => score(b) - score(a));
    const groups = {};
    for (const i of items) {
      const g = (groups[i.group] ||= { group: i.group, materials: 0, score: 0, uses: 0, forked: 0, this_semester: 0 });
      g.materials++;
      g.score += score(i);
      g.uses += i.uses || 0;
      if (Date.parse(i.created_at) >= sem.start.getTime()) g.this_semester += score(i);
    }
    for (const i of items) if (i.forked_from) {
      const parent = items.find((p) => p.slug === i.forked_from);
      if (parent && groups[parent.group]) groups[parent.group].forked++;
    }
    res.json({
      semester: { label: sem.label, start: sem.start.toISOString(), end: sem.end.toISOString(), days_left: Math.max(0, Math.ceil((sem.end - Date.now()) / 864e5)) },
      materials: fresh.slice(0, 10).map((i) => view(i, req)),
      groups: Object.values(groups).sort((a, b) => b.score - a.score).slice(0, 20),
      simulated: items.some((i) => i.simulated),
    });
  }),
);

// ---- AI logo marks ----
api.post(
  '/logo',
  limit('logo', 12),
  json,
  wrap(async (req, res) => {
    const name = String(req.body.group_name || '').trim();
    if (!name) throw new Invalid('Enter your group name first.');
    if (!ai.enabled) throw fail(503, 'Logo generation is switched off on this server.');
    if (!isAdmin(req) && !(await store.takeQuota('logo', 300))) throw fail(429, 'The logo generator has reached its daily limit. Try again tomorrow.');
    res.json({ logos: await ai.generateLogos(name, String(req.body.hint || '')) });
  }),
);

api.use((req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use('/api', api);

// ---- files ----
// Uploaded files are untrusted: they are served with a sandboxing policy so that opening one directly can never
// run script in the site's origin. The editor fetches templates and re-hosts a sanitized copy in a sandboxed frame.
const FILE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:";
// Files of a published material are public. Before that they are for the people who may see the material: the
// uploader and moderators (by their request headers, as the CLI sends them) or anyone holding a current file key,
// which the API hands to exactly those people and which sits in the address: /files/~<key>/<slug>/<path>.
const fileCache = new Map(); // "slug/path@size" -> Buffer, least recently used first
let fileCacheBytes = 0;
const FILE_CACHE_MAX = 160 * 1024 * 1024;
function cachedFile(key) {
  const buf = fileCache.get(key);
  if (buf) {
    fileCache.delete(key);
    fileCache.set(key, buf);
  }
  return buf;
}
function rememberFile(key, buf) {
  if (buf.length > 3 * 1024 * 1024 || fileCache.has(key)) return;
  fileCache.set(key, buf);
  fileCacheBytes += buf.length;
  while (fileCacheBytes > FILE_CACHE_MAX) {
    const [oldest, old] = fileCache.entries().next().value;
    fileCache.delete(oldest);
    fileCacheBytes -= old.length;
  }
}

const serveFile = [
  wrap(async (req, res) => {
    const p = req.params[0];
    const item = await store.getItem(req.params.slug);
    if (!item || !(item.file_list || []).some((f) => f.path === p)) throw fail(404, 'File not found.');
    const open = item.status === 'published';
    if (!open && !canSee(req, item) && !checkFileKey(req.params.key, item.slug)) throw fail(404, 'File not found.');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': open ? 'public, max-age=300' : 'private, max-age=300', 'X-Robots-Tag': 'noindex' });
    if (['html', 'svg'].includes(ext(p))) res.set('Content-Security-Policy', FILE_CSP);
    const width = Math.min(1600, Math.max(0, parseInt(req.query.w, 10) || 0));
    if (width && ['jpg', 'jpeg', 'png', 'webp'].includes(ext(p))) {
      const buf = await store.readFile(item.slug, p);
      const small = buf && (await thumbnail(`${item.slug}/${p}`, buf, width));
      if (small) return res.type('image/jpeg').send(small);
      if (buf) return res.type(MIME[ext(p)]).send(buf);
      throw fail(404, 'File not found.');
    }
    res.type(MIME[ext(p)] || 'application/octet-stream');
    if (req.query.download) res.attachment(path.basename(p));
    // The size in the key changes when the file is replaced, so a stale copy is never served.
    const size = item.file_list.find((f) => f.path === p).size;
    if (size <= 3 * 1024 * 1024) {
      const key = `${item.slug}/${p}@${size}@${item.updated_at || ''}`;
      let buf = cachedFile(key);
      if (!buf) {
        buf = await store.readFile(item.slug, p);
        if (!buf) throw fail(404, 'File not found.');
        rememberFile(key, buf);
      }
      return res.send(buf);
    }
    const stream = await store.fileStream(item.slug, p);
    if (!stream) throw fail(404, 'File not found.');
    stream.on('error', () => (res.headersSent ? res.end() : res.status(404).end()));
    res.on('close', () => stream.destroy()); // the visitor went away: stop reading from storage
    stream.pipe(res);
  }),
];
app.get('/files/~:key/:slug/*', serveFile);
app.get('/files/:slug/*', serveFile);

// ---- CLI and skill downloads (the server fills in its own address) ----
const origin = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
mountMcp(app, { store, search, origin, createMaterial, limit, wrap, sortItems, score });
mountSetup(app, { origin }); // /setup.sh, /setup.ps1 and /llms.txt

app.get('/cli/commons.mjs', (req, res) => {
  res.type('text/javascript; charset=utf-8').set('Cache-Control', 'no-cache');
  res.send(fs.readFileSync(path.join(ROOT, 'cli', 'commons.mjs'), 'utf8').replaceAll('__DEFAULT_URL__', origin(req)));
});
app.get('/cli/SKILL.md', (req, res) => {
  res.type('text/markdown; charset=utf-8').set('Cache-Control', 'no-cache');
  res.send(fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf8').replaceAll('__DEFAULT_URL__', origin(req)));
});
// Hosted group websites, at /s/<name>/. They are other people's pages on our address, so every response is
// sandboxed without "allow-same-origin": scripts on a hosted page run in an origin of their own and can reach
// neither this site's storage nor its API as a signed-in visitor. A banner says where the page is hosted.
const SITE_CSP_STRICT = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: https:; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols";
const SITE_CSP_BUILT = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols';
const previewCookie = (req, name) => (req.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`commons_preview_${name}=`))?.split('=')[1];
app.get(
  ['/s/:name', '/s/:name/*'],
  wrap(async (req, res) => {
    const name = req.params.name;
    const site = SITE_NAME.test(name) ? await store.getDoc('sites', name) : null;
    if (!site) return res.status(404).type('text/plain').send('No website with that name.');
    // Not yet approved: only someone holding a preview link (handed out when the site was uploaded) can look.
    if (site.status !== 'published') {
      const token = String(req.query.preview || '') || previewCookie(req, name);
      if (verify(token)?.site !== name) return res.status(404).type('text/plain').send('No website with that name.');
      if (req.query.preview) res.append('Set-Cookie', `commons_preview_${name}=${token}; Path=/s/${name}; Max-Age=172800; HttpOnly; Secure; SameSite=None`);
    }
    // Relative links on the pages need the address to end in a slash.
    if (req.path === `/s/${name}`) return res.redirect(302, `/s/${name}/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    let p = decodeURIComponent(req.path.slice(`/s/${name}/`.length)) || 'index.html';
    if (p.endsWith('/')) p += 'index.html';
    const has = (x) => !site.multi || (site.files || []).some((f) => f.path === x);
    if (site.multi && !has(p)) p = has(`${p}.html`) ? `${p}.html` : has(`${p}/index.html`) ? `${p}/index.html` : p;
    if (!site.multi && p !== 'index.html') return res.status(404).type('text/plain').send('Not found.');
    const buf = has(p) ? await store.readFile('_sites', `${name}/${p}`) : null;
    if (!buf) return res.status(404).type('text/plain').send('Not found.');
    res.set({
      'Content-Security-Policy': site.multi ? SITE_CSP_BUILT : SITE_CSP_STRICT,
      'Access-Control-Allow-Origin': '*', // pages run in a sandboxed origin, so their own scripts and fonts load cross-origin
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': site.status === 'published' ? 'public, max-age=120' : 'no-store',
    });
    const type = site.multi ? SITE_MIME[ext(p)] : SITE_MIME.html;
    if (ext(p) !== 'html') return res.type(type).send(buf);
    const html = buf.toString('utf8');
    res.type(type).send(/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${SITE_BANNER}</body>`) : html + SITE_BANNER);
  }),
);
// Search engines stay out (pages also carry a noindex header). Fetchers that act for one person who asked their
// assistant to read the commons are let in: the "Try it" prompt and /llms.txt depend on that.
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send('User-agent: Claude-User\nUser-agent: ChatGPT-User\nUser-agent: Perplexity-User\nAllow: /\n\nUser-agent: *\nDisallow: /\n'),
);
app.get('/healthz', (req, res) => res.send('ok'));

// ---- site ----
const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const siteHeaders = (res) => res.set({ 'Content-Security-Policy': SITE_CSP, 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-cache' });
app.use(express.static(PUBLIC, { index: false, setHeaders: staticHeaders(siteHeaders) }));
app.get('*', (req, res) => {
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).type('text/plain').send('Not found');
  siteHeaders(res).sendFile(path.join(PUBLIC, 'index.html'));
});

app.use((err, req, res, next) => {
  // Library errors (database, storage, auth) are logged in full and answered with a general sentence.
  const { status, message } = publicError(err);
  if (status >= 500) console.error(req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: message });
});

// `node server/index.js` (the container's command) starts the server. Tests import this file and call start(0).
export { app, store };
export const start = (port = Number(process.env.PORT || 8080)) =>
  serve(app, {
    port,
    store,
    hourly: [() => sweepDrafts(store, { onDelete: (item) => dropThumbnails(`${item.slug}/`) })],
    banner: `store=${process.env.STORE || 'local'}, vertex=${ai.enabled ? 'on' : 'off'}, admin=${ADMIN_TOKEN ? 'set' : 'unset'}`,
  });
if (isMain(import.meta.url)) handleSignals(await start());
