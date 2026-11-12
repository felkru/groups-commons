// Validation of materials (the item.json format in docs/SEED_FORMAT.md) and of uploaded files.

export const CATEGORIES = {
  slides: 'Slides',
  print: 'Flyers & print',
  social: 'Social media',
  demo: 'Demos',
  message: 'Message templates',
  kit: 'Kits',
  website: 'Websites',
  supplier: 'Suppliers',
  event: 'Events',
  photo: 'Photos',
  brand: 'Branding',
  ops: 'Running the group',
};
export const KINDS = ['file', 'template', 'text', 'link', 'kit', 'supplier'];
export const CHANNELS = ['email', 'whatsapp', 'slack', 'instagram', 'doc'];

export const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ics: 'text/calendar; charset=utf-8',
};

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ITEM_BYTES = 60 * 1024 * 1024;
export const MAX_FILES = 60;

const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .()+&,@-]*(\/[A-Za-z0-9_][A-Za-z0-9_ .()+&,@-]*)*$/;

export class Invalid extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true; // the message is written for the visitor; errors without this flag are answered generically
  }
}

export function ext(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path || '');
  return m ? m[1].toLowerCase() : '';
}

export function checkPath(path) {
  if (typeof path !== 'string' || path.length > 160 || !PATH_RE.test(path) || path.includes('..')) {
    throw new Invalid(`Invalid file path: ${JSON.stringify(path)}`);
  }
  if (!MIME[ext(path)]) throw new Invalid(`File type not allowed: ${path} (allowed: ${Object.keys(MIME).join(', ')})`);
  return path;
}

export function slugify(text) {
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

const str = (v, max, name, required = false) => {
  if (v == null || v === '') {
    if (required) throw new Invalid(`Missing "${name}"`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Invalid(`"${name}" must be text`);
  const s = v.trim();
  if (!s && required) throw new Invalid(`Missing "${name}"`);
  if (s.length > max) throw new Invalid(`"${name}" is too long (max ${max} characters)`);
  return s || undefined;
};

const url = (v, name, required = false) => {
  const s = str(v, 600, name, required);
  if (s === undefined) return undefined;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Invalid(`"${name}" is not a valid URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Invalid(`"${name}" must be an http(s) URL`);
  return u.toString();
};

// Returns a clean item (only known fields). Throws Invalid with a human-readable message.
export function validateItem(input) {
  if (!input || typeof input !== 'object') throw new Invalid('Expected a JSON object');
  const item = {};
  item.slug = slugify(input.slug || input.title);
  item.title = str(input.title, 90, 'title', true);
  item.category = str(input.category, 20, 'category', true);
  if (!CATEGORIES[item.category]) throw new Invalid(`Unknown category "${item.category}". Use one of: ${Object.keys(CATEGORIES).join(', ')}`);
  item.kind = str(input.kind, 20, 'kind', true);
  if (!KINDS.includes(item.kind)) throw new Invalid(`Unknown kind "${item.kind}". Use one of: ${KINDS.join(', ')}`);
  item.summary = str(input.summary, 400, 'summary', true);
  item.description = str(input.description, 4000, 'description');
  item.tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => slugify(t)).filter(Boolean))].slice(0, 8)
    : [];
  item.language = str(input.language, 10, 'language') || 'en';
  item.group = str(input.group, 80, 'group') || 'Anonymous group';
  item.source = ['original', 'adapted', 'synthesized'].includes(input.source) ? input.source : 'original';
  item.provenance = str(input.provenance, 300, 'provenance');
  if (input.forked_from) item.forked_from = slugify(input.forked_from);

  if (input.files != null) {
    if (!Array.isArray(input.files) || input.files.length > 40) throw new Invalid('"files" must be a list (max 40)');
    item.files = input.files.map((f) => ({ path: checkPath(f?.path), label: str(f?.label, 120, 'files.label') }));
  }
  if (input.preview) {
    item.preview = checkPath(input.preview);
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext(item.preview))) throw new Invalid('"preview" must be a jpg, png or webp image');
  }

  if (item.kind === 'file' && !(item.files && item.files.length)) throw new Invalid('kind "file" needs at least one entry in "files"');
  if (item.kind === 'template') {
    const path = checkPath(input.template?.path);
    if (ext(path) !== 'html') throw new Invalid('template.path must be an .html file');
    item.template = { path, format: str(input.template?.format, 60, 'template.format') };
  }
  if (item.kind === 'text') {
    if (!Array.isArray(input.variants) || !input.variants.length || input.variants.length > 12) {
      throw new Invalid('kind "text" needs 1-12 entries in "variants"');
    }
    item.variants = input.variants.map((v, i) => {
      const channel = str(v?.channel, 20, 'variants.channel') || 'email';
      if (!CHANNELS.includes(channel)) throw new Invalid(`Unknown channel "${channel}". Use one of: ${CHANNELS.join(', ')}`);
      return {
        label: str(v?.label, 60, 'variants.label') || `Variant ${i + 1}`,
        lang: str(v?.lang, 10, 'variants.lang') || 'en',
        channel,
        subject: str(v?.subject, 300, 'variants.subject'),
        body: str(v?.body, 40000, 'variants.body', true),
      };
    });
  }
  if (item.kind === 'link') {
    item.link = { url: url(input.link?.url, 'link.url', true), label: str(input.link?.label, 60, 'link.label') || 'Open link' };
  }
  if (item.kind === 'kit') {
    const items = input.kit?.items;
    if (!Array.isArray(items) || !items.length || items.length > 80) throw new Invalid('kind "kit" needs 1-80 entries in kit.items');
    item.kit = {
      est_cost: str(input.kit?.est_cost, 80, 'kit.est_cost'),
      items: items.map((k) => ({
        name: str(k?.name, 160, 'kit.items.name', true),
        qty: str(k?.qty == null ? undefined : String(k.qty), 40, 'kit.items.qty'),
        note: str(k?.note, 400, 'kit.items.note'),
        url: url(k?.url, 'kit.items.url'),
        // Ways to get the item without shopping: a material in the commons, a finished example, a ready order email.
        material: k?.material ? slugify(k.material) : undefined,
        example: k?.example?.url ? { url: url(k.example.url, 'kit.items.example.url', true), label: str(k.example.label, 60, 'kit.items.example.label') || 'See an example' } : undefined,
        order: k?.order?.body ? { subject: str(k.order.subject, 300, 'kit.items.order.subject'), body: str(k.order.body, 4000, 'kit.items.order.body', true) } : undefined,
      })),
    };
  }
  if (item.kind === 'supplier') {
    const s = input.supplier || {};
    item.supplier = {
      type: str(s.type, 60, 'supplier.type', true),
      name: str(s.name, 120, 'supplier.name', true),
      location: str(s.location, 120, 'supplier.location'),
      good_for: str(s.good_for, 600, 'supplier.good_for'),
      website: url(s.website, 'supplier.website'),
    };
    if (s.request?.body) {
      item.supplier.request = {
        subject: str(s.request.subject, 300, 'supplier.request.subject'),
        body: str(s.request.body, 8000, 'supplier.request.body', true),
      };
    }
  }
  return item;
}

// Paths that an item's metadata says must exist before it can be published.
export function requiredFiles(item) {
  const paths = [];
  for (const f of item.files || []) paths.push(f.path);
  if (item.preview) paths.push(item.preview);
  if (item.template) paths.push(item.template.path);
  return [...new Set(paths)];
}

// Templates and SVGs are shown inside the site, so they must not carry active content.
// (They are also served with a sandboxing Content-Security-Policy; this is the second layer.)
export function checkActiveContent(path, buffer) {
  const e = ext(path);
  if (e !== 'html' && e !== 'svg') return;
  const text = buffer.toString('utf8');
  if (/<script[\s>/]/i.test(text)) throw new Invalid(`${path}: <script> is not allowed in templates`);
  // An attribute can follow a space, a slash (<svg/onload=...>) or the closing quote of the one before it.
  if (/<[a-z][^>]*[\s/"']on[a-z]+\s*=/i.test(text)) throw new Invalid(`${path}: inline event handlers (onclick=...) are not allowed`);
  if (/(href|src|action)\s*=\s*["']?\s*(javascript|vbscript):/i.test(text)) throw new Invalid(`${path}: javascript: URLs are not allowed`);
  if (/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i.test(text)) throw new Invalid(`${path}: pages that redirect by themselves (meta refresh) are not allowed`);
  if (e === 'html' && /<(iframe|object|embed|form)[\s>]/i.test(text)) {
    throw new Invalid(`${path}: iframe, object, embed and form elements are not allowed in templates`);
  }
}

// Text used for keyword search and for the embedding.
export function searchText(item) {
  const parts = [item.title, item.summary, CATEGORIES[item.category], (item.tags || []).join(' '), item.description];
  for (const v of item.variants || []) parts.push(v.label, v.subject, (v.body || '').slice(0, 1500));
  for (const k of item.kit?.items || []) parts.push(k.name);
  if (item.supplier) parts.push(item.supplier.type, item.supplier.name, item.supplier.location, item.supplier.good_for);
  if (item.link) parts.push(item.link.url);
  if (item.template?.format) parts.push(item.template.format);
  return parts.filter(Boolean).join('\n');
}
