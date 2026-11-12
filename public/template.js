// Customizable templates ("like Claude Artifacts"): a template is plain HTML that follows docs/TEMPLATE_CONTRACT.md.
// The site loads a sanitized copy into a sandboxed frame (no scripts run inside it), re-skins it with the visitor's
// brand kit, makes the marked text editable in place and prints it to PDF.

import { fileBase, filePath, store } from './api.js';
import { brandVars, fontsUrl, getBrand, isDefaultBrand, logoFor, qrDataUri } from './brand.js';

const QR_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='white'/%3E%3Cpath d='M8 8h28v28H8zM64 8h28v28H64zM8 64h28v28H8z' fill='none' stroke='%23252627' stroke-width='8'/%3E%3Ctext x='50' y='56' font-family='sans-serif' font-size='12' text-anchor='middle' fill='%23252627'%3EQR%3C/text%3E%3C/svg%3E";
const SANDBOX = 'allow-same-origin allow-modals';

const cache = new Map();
export function fetchTemplate(item) {
  const url = filePath(item.slug, item.template.path);
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error('Could not load the template file.');
        return r.text();
      }),
    );
  }
  return cache.get(url);
}
export const forgetTemplate = (item) => cache.delete(filePath(item.slug, item.template.path));

function scrub(root) {
  root.querySelectorAll('script, iframe, object, embed, form, base, noscript, meta[http-equiv]').forEach((e) => e.remove());
  root.querySelectorAll('link').forEach((l) => {
    const ok = /stylesheet/i.test(l.getAttribute('rel') || '') && /^https:\/\/fonts\.googleapis\.com\//.test(l.getAttribute('href') || '');
    if (!ok) l.remove();
  });
  root.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      else if (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
}

const px = (v) => {
  const m = /^([\d.]+)(mm|px|in|cm)?$/.exec(v || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'mm' ? (n * 96) / 25.4 : m[2] === 'cm' ? (n * 96) / 2.54 : m[2] === 'in' ? n * 96 : n;
};

// Returns { html, width, height (null when the page grows with its content), format }.
export function prepare(source, base) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  scrub(doc);
  const size = (doc.querySelector('meta[name="commons:page"]')?.getAttribute('content') || '210mm 297mm').trim().split(/\s+/);
  const format = doc.querySelector('meta[name="commons:format"]')?.getAttribute('content') || '';
  const b = doc.createElement('base');
  b.setAttribute('href', new URL(base, location.origin).href);
  b.setAttribute('data-commons', '');
  doc.head.prepend(b);
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, width: px(size[0]) || 794, height: px(size[1]), format };
}

const cleanFragment = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  scrub(t.content);
  return t.innerHTML;
};

// Apply saved text edits, then the brand kit, to a loaded frame document.
const photoAttr = (el) => (el.namespaceURI === 'http://www.w3.org/2000/svg' ? 'href' : 'src');
function setPhoto(el, url) {
  if (!el.hasAttribute('data-commons-photo')) el.setAttribute('data-commons-photo', el.getAttribute(photoAttr(el)) || el.getAttribute('xlink:href') || '');
  el.removeAttribute('xlink:href');
  el.setAttribute(photoAttr(el), url);
}

// Chrome shows text that is being edited as plain text with its spaces and line ends kept, so the indentation of
// the template's source would appear on the page. Collapse it once, the way the browser does for normal text.
// Text that keeps its line ends on purpose (white-space: pre*) is left alone.
function tidySpace(el) {
  const view = el.ownerDocument.defaultView;
  if (view && /^pre|break-spaces/.test(view.getComputedStyle(el).whiteSpace || '')) return;
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const isBreak = (n) => !n || (n.nodeType === 1 && n.localName === 'br');
  for (const n of nodes) {
    let t = n.nodeValue.replace(/\s+/g, ' ');
    if (n.parentNode === el && isBreak(n.previousSibling)) t = t.replace(/^ /, '');
    if (n.parentNode === el && isBreak(n.nextSibling)) t = t.replace(/ $/, '');
    if (t !== n.nodeValue) n.nodeValue = t;
  }
}

export function dress(doc, brand, edits = {}, editable = false, photos = {}) {
  const root = doc.documentElement;
  for (const el of doc.querySelectorAll('[data-photo]')) {
    const url = photos[el.getAttribute('data-photo')];
    if (url && el.getAttribute(photoAttr(el)) !== url) setPhoto(el, url);
  }
  for (const el of doc.querySelectorAll('[data-edit]')) {
    const key = el.getAttribute('data-edit');
    if (!el.hasAttribute('data-commons-original')) { tidySpace(el); el.setAttribute('data-commons-original', el.innerHTML); }
    if (edits[key] != null && el.innerHTML !== edits[key] && doc.activeElement !== el) el.innerHTML = cleanFragment(edits[key]);
    if (editable && !el.isContentEditable) {
      el.setAttribute('contenteditable', 'plaintext-only');
      if (!el.isContentEditable) el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');
    }
  }
  const vars = brandVars(brand);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  for (const k of ['--brand-font-heading', '--brand-font-body']) if (!(k in vars)) root.style.removeProperty(k);
  let fonts = doc.querySelector('link[data-commons-fonts]');
  if (!fonts) {
    fonts = doc.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.setAttribute('data-commons-fonts', '');
    doc.head.append(fonts);
  }
  if (fonts.getAttribute('href') !== fontsUrl(brand)) fonts.setAttribute('href', fontsUrl(brand));
  const ownDetails = isDefaultBrand(brand);
  for (const el of doc.querySelectorAll('[data-brand]')) {
    const v = brand[el.getAttribute('data-brand')];
    if (!el.hasAttribute('data-commons-brand-original')) el.setAttribute('data-commons-brand-original', el.textContent);
    // A kit that leaves a detail empty (say, no email address) must not show the example group's detail under
    // another group's name: the place stays empty. The example group's own kit keeps the template's text.
    const next = v || (ownDetails ? el.getAttribute('data-commons-brand-original') : '');
    if (el.textContent !== next && doc.activeElement !== el) el.textContent = next;
  }
  for (const a of doc.querySelectorAll('a[data-brand]')) {
    const key = a.getAttribute('data-brand');
    const v = String(brand[key] || '').trim();
    if (!v) continue;
    const href = key === 'email' ? `mailto:${v}` : key === 'instagram' ? `https://www.instagram.com/${v.replace(/^@/, '')}/` : /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
    a.setAttribute(a.hasAttribute('data-commons-href') ? 'data-commons-href' : 'href', href);
  }
  for (const img of doc.querySelectorAll('img[data-logo]')) {
    if (!img.hasAttribute('data-commons-src')) img.setAttribute('data-commons-src', img.getAttribute('src') || '');
    const kind = img.getAttribute('data-logo') === 'square' ? 'square' : 'wide';
    const src = logoFor(brand, kind, img.getAttribute('data-logo-on') === 'dark') || img.getAttribute('data-commons-src');
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  }
  for (const img of doc.querySelectorAll('img[data-qr]')) {
    const src = qrDataUri(brand[img.getAttribute('data-qr')]) || QR_PLACEHOLDER;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  }
  if (editable) {
    // Links would navigate the frame away from the template; park them while editing.
    for (const a of doc.querySelectorAll('a[href]')) {
      if (/^#/.test(a.getAttribute('href'))) continue;
      a.setAttribute('data-commons-href', a.getAttribute('href'));
      a.removeAttribute('href');
    }
  }
}

function readEdits(doc) {
  const edits = {};
  for (const el of doc.querySelectorAll('[data-edit]')) {
    const html = el.innerHTML;
    if (html !== el.getAttribute('data-commons-original')) edits[el.getAttribute('data-edit')] = html;
  }
  return edits;
}

// A clean copy of the frame document. mode "export": standalone file with the brand baked in.
// mode "share": still a re-brandable template (brand overrides and generated images are taken out again).
async function serialize(doc, mode) {
  const copy = doc.documentElement.cloneNode(true);
  copy.removeAttribute('data-commons-ready');
  const base = copy.querySelector('base[data-commons]')?.getAttribute('href');
  copy.querySelectorAll('[data-commons]').forEach((e) => e.remove());
  for (const el of copy.querySelectorAll('[contenteditable]')) {
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
  }
  for (const el of copy.querySelectorAll('[data-commons-original]')) el.removeAttribute('data-commons-original');
  for (const a of copy.querySelectorAll('[data-commons-href]')) {
    a.setAttribute('href', a.getAttribute('data-commons-href'));
    a.removeAttribute('data-commons-href');
  }
  if (mode === 'share') {
    copy.removeAttribute('style');
    copy.querySelectorAll('link[data-commons-fonts]').forEach((e) => e.remove());
    for (const img of copy.querySelectorAll('img[data-qr]')) img.setAttribute('src', QR_PLACEHOLDER);
    for (const img of copy.querySelectorAll('img[data-commons-src]')) img.setAttribute('src', img.getAttribute('data-commons-src'));
  } else {
    copy.querySelectorAll('link[data-commons-fonts]').forEach((e) => e.removeAttribute('data-commons-fonts'));
    for (const img of copy.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (/^(data:|https?:)/.test(src) || !base) continue;
      try {
        const res = await fetch(new URL(src, base));
        const blob = await res.blob();
        img.setAttribute('src', await new Promise((ok) => Object.assign(new FileReader(), { onload: (e) => ok(e.target.result) }).readAsDataURL(blob)));
      } catch {
        /* leave the relative path */
      }
    }
  }
  for (const img of copy.querySelectorAll('[data-commons-src]')) img.removeAttribute('data-commons-src');
  for (const el of copy.querySelectorAll('[data-commons-photo]')) el.removeAttribute('data-commons-photo');
  return '<!doctype html>\n' + copy.outerHTML;
}

// Calls back once a frame's document is parsed, without waiting for its images (the "load" event waits for all of them).
function whenParsed(frame, fn) {
  let tries = 0;
  const timer = setInterval(() => {
    const doc = frame.contentDocument;
    if (doc && doc.body && doc.readyState !== 'loading' && doc.querySelector('.page, [data-edit], svg')) {
      clearInterval(timer);
      fn();
    } else if (++tries > 400) clearInterval(timer);
  }, 50);
}

// ---- small live previews for cards ----
const PREVIEW_CSS = 'html,body{background:transparent!important;margin:0!important;padding:0!important;overflow:hidden!important}.page{margin:0!important;box-shadow:none!important}';
let observer;
export function watchPreviews(root) {
  observer ||= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        mountPreview(e.target).catch(() => {});
      }
    },
    { rootMargin: '400px' },
  );
  for (const el of root.querySelectorAll('[data-template]:not([data-mounted])')) observer.observe(el);
}
export async function mountPreview(box, brand = getBrand()) {
  box.setAttribute('data-mounted', '');
  const item = { slug: box.dataset.template, template: { path: box.dataset.path } };
  const t = prepare(await fetchTemplate(item), fileBase(item.slug));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX);
  frame.setAttribute('tabindex', '-1');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Template preview';
  const h = t.height || t.width * 0.75;
  frame.style.width = t.width + 'px';
  frame.style.height = h + 'px';
  frame.style.visibility = 'hidden';
  const fit = () => {
    const w = box.clientWidth;
    const bh = box.clientHeight;
    const s = t.height ? Math.min((w - 28) / t.width, (bh - 28) / h) : w / t.width;
    frame.style.transform = `scale(${s})`;
    frame.style.left = (w - t.width * s) / 2 + 'px';
    frame.style.top = (t.height ? (bh - h * s) / 2 : 0) + 'px';
  };
  let shown = false;
  const show = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    if (!shown) {
      shown = true;
      const style = doc.createElement('style');
      style.textContent = PREVIEW_CSS;
      doc.head.append(style);
    }
    const fork = store.get(`commons_fork_${item.slug}`, {});
    dress(doc, brand, fork.edits || {}, false, fork.photos || {});
    fit();
    frame.style.visibility = '';
    box.querySelector('img')?.remove();
  };
  whenParsed(frame, show);
  frame.addEventListener('load', show);
  frame.srcdoc = t.html;
  box.append(frame);
  new ResizeObserver(fit).observe(box);
  return { frame, redress: (b) => frame.contentDocument && dress(frame.contentDocument, b, {}) };
}

// ---- the editor ----
// opts: { html, base, storageKey, onChange }. Returns controls used by the page's toolbar.
export function mountEditor(stage, opts) {
  const t = prepare(opts.html, opts.base);
  const saved = opts.storageKey ? store.get(opts.storageKey, {}) : {};
  let edits = saved.edits || {};
  let photos = saved.photos || {};
  const save = () => opts.storageKey && store.set(opts.storageKey, { edits, photos });
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX);
  frame.title = 'Template editor';
  const pad = t.height ? 48 : 0;
  frame.style.width = t.width + pad + 'px';
  frame.style.height = '600px';
  let ready = false;

  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc || !ready) return;
    const s = Math.min(1, stage.clientWidth / (t.width + pad));
    const h = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
    if (frame.style.height !== h + 'px') frame.style.height = h + 'px';
    frame.style.transform = `scale(${s})`;
    frame.style.marginLeft = Math.max(0, (stage.clientWidth - (t.width + pad) * s) / 2) + 'px';
    stage.style.height = Math.ceil(h * s) + 'px';
  };
  const persist = () => {
    const doc = frame.contentDocument;
    if (!doc || !ready) return;
    const now = readEdits(doc);
    if (JSON.stringify(now) !== JSON.stringify(edits)) {
      edits = now;
      save();
      opts.onChange?.(edits);
    }
    fit();
  };
  const start = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    if (ready && doc.documentElement.hasAttribute('data-commons-ready')) return fit(); // the later "load": only re-fit
    doc.documentElement.setAttribute('data-commons-ready', '');
    ready = true;
    dress(doc, getBrand(), edits, true, photos);
    const hint = doc.createElement('style');
    hint.setAttribute('data-commons', '');
    hint.textContent = '[data-photo],[data-photo-ref]{cursor:pointer}[data-photo]:hover,[data-photo-ref]:hover{outline:4px solid rgba(200,68,47,.75);outline-offset:-4px}';
    doc.head.append(hint);
    try {
      doc.addEventListener('input', persist);
      doc.addEventListener('click', (e) => {
        const hit = e.target.closest?.('[data-photo], [data-photo-ref]');
        // Converted artwork stores a picture once and draws it with <use>; the stored picture is the one to replace.
        const slot = hit?.hasAttribute('data-photo') ? hit : hit && doc.querySelector(`[data-photo="${CSS.escape(hit.getAttribute('data-photo-ref'))}"]`);
        if (slot) pickPhoto(slot);
      });
    } catch {}
    fit();
    doc.fonts?.ready.then(fit).catch(() => {});
  };
  whenParsed(frame, start);
  frame.addEventListener('load', start);
  // Replacing a photo: the visitor picks a file, it is scaled down in the browser and kept with their other edits.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/jpeg,image/png,image/webp';
  picker.hidden = true;
  let target = null;
  function pickPhoto(slot) {
    target = slot;
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file || !target) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.85);
      photos = { ...photos, [target.getAttribute('data-photo')]: url };
      setPhoto(target, url);
      save();
      opts.onChange?.(edits);
    } catch {
      opts.onError?.('That image could not be read. Use a JPEG or PNG file.');
    }
  });
  frame.srcdoc = t.html;
  stage.replaceChildren(frame, picker);
  // Listeners inside a script-less frame are not guaranteed to fire in every browser, so edits are also polled.
  const timer = setInterval(persist, 1200);
  const ro = new ResizeObserver(fit);
  ro.observe(stage);

  return {
    format: t.format,
    editCount: () => Object.keys(edits).length,
    photoSlots: () => (ready ? [...frame.contentDocument.querySelectorAll('[data-photo]')].map((el) => el.getAttribute('data-photo')) : []),
    replacePhoto(key) {
      const slot = ready && frame.contentDocument.querySelector(`[data-photo="${CSS.escape(key)}"]`);
      if (slot) pickPhoto(slot);
    },
    rebrand() {
      if (ready) dress(frame.contentDocument, getBrand(), {}, true, photos);
      fit();
    },
    reset() {
      edits = {};
      photos = {};
      if (opts.storageKey) store.del(opts.storageKey);
      ready = false;
      frame.srcdoc = t.html;
    },
    async print() {
      persist();
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch {
        const w = window.open(URL.createObjectURL(new Blob([await serialize(frame.contentDocument, 'export')], { type: 'text/html' })), '_blank');
        if (!w) throw new Error('Allow pop-ups to print, or use "Download HTML" and print that file.');
      }
    },
    exportHtml: () => (persist(), serialize(frame.contentDocument, 'export')),
    shareHtml: () => (persist(), serialize(frame.contentDocument, 'share')),
    destroy() {
      clearInterval(timer);
      ro.disconnect();
    },
  };
}
