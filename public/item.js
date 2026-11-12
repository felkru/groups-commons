// One material: header, the tool for its kind (template editor, text fill-in, kit checklist, ...), files and forks.

import { adminToken, api, editKeys, fileBase, filePath, rememberKey, store } from './api.js';
import { getBrand, paletteFrom, setBrand } from './brand.js';
import { go } from './app.js';
import { fetchTemplate, mountEditor } from './template.js';
import { md, quickFill, textTool } from './text.js';
import { $, $$, KIND, SOURCE, bytes, cmd, copy, countUse, download, esc, plural, state, timeAgo, toast, todo, voteBox } from './ui.js';

const IMG = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const extOf = (p) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] || '').toLowerCase();

// A text cut to a length at a word boundary (for suggested titles).
const shorten = (text, max) => {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  return (cut.lastIndexOf(' ') > max * 0.5 ? cut.slice(0, cut.lastIndexOf(' ')) : t.slice(0, max)).replace(/[\s,:;.–-]+$/, '');
};

export async function itemPage(root, [slug]) {
  const item = await api(`/items/${slug}`);
  state.currentItem = item;
  document.title = `${item.title} · Groups Commons`;
  const [srcLabel, srcHelp] = SOURCE[item.source] || SOURCE.original;
  const canDelete = adminToken() || state.meta.admin || item.mine || editKeys()[item.slug];
  let editor = null;

  root.innerHTML = `
    <p class="crumb"><a href="/">← All materials</a> / <a href="/?c=${esc(item.category)}">${esc(state.meta.categories[item.category] || item.category)}</a></p>
    ${item.status !== 'published' ? `<div class="notice">This material is waiting for review. Only you${adminToken() ? ' and moderators' : ''} can see it until a moderator approves it. ${adminToken() ? '<button class="btn small primary" data-act="approve">Approve</button>' : ''}</div>` : ''}
    <header class="itemhead">
      ${voteBox(item)}
      <div>
        <div class="meta"><span class="badge kind">${esc(KIND[item.kind])}</span>${item.featured ? '<span class="badge featured">★ Featured by moderators</span>' : ''}${item.template?.format ? `<span class="badge">${esc(item.template.format)}</span>` : ''}<span class="badge" title="${esc(srcHelp)}">${esc(srcLabel)}</span><span class="badge">${esc((item.language || 'en').toUpperCase())}</span></div>
        <h1>${esc(item.title)}</h1>
        <p class="sum">${esc(item.summary)}</p>
        <div class="meta"><span>Shared by <strong>${esc(item.group)}</strong></span><span>·</span><span>${plural(item.uses || 0, 'use')}</span><span>·</span><span>${item.up || 0} up, ${item.down || 0} down${item.simulated ? ' (simulated)' : ''}</span><span>·</span><span>added ${timeAgo(item.created_at)}</span></div>
      </div>
    </header>
    <div id="tool"></div>
    <div class="cols">
      <div>
        ${item.kind === 'file' ? '<div id="files"></div>' : ''}
        ${item.description ? `<section class="panel"><h2>How to use it</h2><div class="md">${md(item.description)}</div></section>` : ''}
        ${item.kind === 'file' ? '' : '<div id="files"></div>'}
      </div>
      <aside>
        <section class="panel">
          <dl class="kv">
            <dt>Category</dt><dd><a href="/?c=${esc(item.category)}">${esc(state.meta.categories[item.category] || item.category)}</a></dd>
            <dt>From</dt><dd>${esc(item.group)}</dd>
            <dt>Origin</dt><dd>${esc(srcLabel)}${item.provenance ? `<br><span class="small muted">${esc(item.provenance)}</span>` : ''}</dd>
            ${item.parent ? `<dt>Fork of</dt><dd><a href="/m/${esc(item.parent.slug)}">${esc(item.parent.title)}</a></dd>` : ''}
            <dt>Updated</dt><dd>${timeAgo(item.updated_at || item.created_at)}</dd>
          </dl>
          ${item.tags?.length ? `<div class="tags" style="margin-top:12px">${item.tags.map((t) => `<a href="/?q=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
        </section>
        ${item.forks?.length ? `<section class="panel"><h3 style="margin-top:0">Versions by other groups</h3><ul class="files">${item.forks.map((f) => `<li><a href="/m/${esc(f.slug)}">${esc(f.title)}</a><span class="small muted">${esc(f.group)} · ${f.score}</span></li>`).join('')}</ul></section>` : ''}
        <section class="panel">
          <h3 style="margin-top:0">For agents and the terminal</h3>
          <p class="small muted">Download this material into a folder, adapt it, then share your version back.</p>
          ${cmd(`commons get ${item.slug}`)}
          <p class="small"><button type="button" class="btn small" data-agent-setup>Set up my AI</button> or copy a prompt for this material</p>
        </section>
        ${canDelete ? `<section class="panel"><div class="row">${state.meta.admin && item.status === 'published' ? `<button class="btn small" data-act="feature">${item.featured ? 'Remove from featured' : '★ Feature this'}</button>` : ''}<button class="btn small danger" data-act="delete">Delete this material</button></div></section>` : ''}
      </aside>
    </div>`;

  const tool = $('#tool', root);
  if (item.kind === 'template') editor = await templateTool(tool, item);
  if (item.kind === 'text') {
    tool.innerHTML = '<section class="panel"><div data-text></div></section>';
    textTool($('[data-text]', tool), item.variants, item.slug);
  }
  if (item.kind === 'kit') kitTool(tool, item);
  if (item.kind === 'supplier') supplierTool(tool, item);
  if (item.kind === 'link') {
    tool.innerHTML = `<section class="panel pink"><div class="row"><a class="btn primary" href="${esc(item.link.url)}" target="_blank" rel="noopener noreferrer" data-use>${esc(item.link.label)} ↗</a><span class="small muted">${esc(item.link.url)}</span></div></section>`;
  }
  filesPanel($('#files', root), item);

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-use]')) countUse(item.slug);
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'approve') {
        await api(`/items/${item.slug}/approve`, { method: 'POST' });
        toast('Approved and published');
        go(`/m/${item.slug}`, true);
      }
      if (act === 'feature') {
        const r = await api(`/items/${item.slug}/feature`, { method: 'POST', body: { featured: !item.featured } });
        toast(r.featured ? 'Featured on the front page' : 'No longer featured');
        go(`/m/${item.slug}`, true);
      }
      if (act === 'delete' && confirm(`Delete “${item.title}” for everyone?`)) {
        await api(`/items/${item.slug}`, { method: 'DELETE', editKey: editKeys()[item.slug] });
        toast('Deleted');
        go('/');
      }
    } catch (err) {
      toast(err.message);
    }
  });
  return () => {
    editor?.destroy();
    state.currentItem = null;
  };
}

// ---- template editor ----
async function templateTool(tool, item) {
  const brand = getBrand();
  tool.innerHTML = `
    <section class="panel editor">
      <div class="toolbar">
        <button class="btn primary" data-ed="print">Print / save as PDF</button>
        <button class="btn" data-ed="html">Download HTML</button>
        <button class="btn" data-ed="share">Share my version</button>
        ${item.category === 'website' ? '<button class="btn" data-ed="site">Publish as website</button>' : ''}
        <button class="btn" data-ed="reset">Reset my edits</button>
        <span class="grow"></span>
        <label>Colour <input type="color" data-color="color" value="${esc(brand.color)}"></label>
        <label>Accent <input type="color" data-color="accent" value="${esc(brand.accent)}"></label>
        <a class="btn small" href="/brand">Brand kit: ${esc(brand.group_name)}</a>
      </div>
      <div class="stage"><p class="loading">Loading template…</p></div>
      <p class="hint">Click or tap any text to change it, and any photo to replace it with your own. Colours, fonts, logo, group name and QR codes come from your brand kit, so every template on this site matches. Your edits are saved in this browser. In the print dialog choose “Save as PDF”, margins “None” and switch on “Background graphics”.</p>
    </section>
    <dialog id="share">
      <form method="dialog" class="form">
        <h2>Share your version</h2>
        <p class="small muted">Your text edits are published as a new template that links back to the original. Other groups can re-brand it like any other template. It appears after a moderator has approved it.</p>
        <label>Title<input name="title" maxlength="90" required value="${esc(`${shorten(item.title, 44)} (${shorten(brand.group_name, 34)} version)`)}"></label>
        <label>Your group<input name="group" maxlength="80" required value="${esc(brand.group_name)}"></label>
        <label>What did you change, and when does it work well?<textarea name="summary" maxlength="400" required></textarea></label>
        <p class="err" data-err></p>
        <div class="row"><button class="btn primary" value="ok">Publish my version</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
      </form>
    </dialog>`;
  // The pickers show the colours the template really has (with the untouched example kit: the template's own).
  const showColours = (now) => { for (const input of tool.querySelectorAll('input[data-color]')) if (now[input.dataset.color]) input.value = now[input.dataset.color]; };
  const editor = mountEditor($('.stage', tool), { html: await fetchTemplate(item), base: fileBase(item.slug), storageKey: `commons_fork_${item.slug}`, onError: toast, onReady: showColours });
  const dialog = $('#share', tool);

  tool.addEventListener('input', (e) => {
    const key = e.target.dataset.color;
    if (!key) return;
    setBrand(key === 'color' ? { ...paletteFrom(e.target.value), accent: getBrand().accent } : { accent: e.target.value });
    editor.rebrand();
  });
  tool.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-ed]')?.dataset.ed;
    if (!act) return;
    try {
      if (act === 'print') {
        countUse(item.slug);
        await editor.print();
      }
      if (act === 'html') {
        countUse(item.slug);
        download(`${item.slug}.html`, await editor.exportHtml(), 'text/html');
      }
      if (act === 'reset' && confirm('Throw away your text edits to this template?')) editor.reset();
      if (act === 'share') dialog.showModal();
      if (act === 'site') {
        if (!state.meta.account) {
          toast('Sign in to host a website');
          return go('/account');
        }
        const b = getBrand();
        const suggested = b.group_name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
        const name = prompt('Address of your website: /s/…  (lower-case letters, digits, hyphens)', suggested);
        if (!name) return;
        const site = await api('/sites', { method: 'POST', body: { name, title: b.group_name, html: await editor.exportHtml() } });
        toast(site.status === 'published' ? `Live at /s/${site.name}` : `Sent for review. It will be live at /s/${site.name}`);
        go('/account');
      }
    } catch (err) {
      toast(err.message);
    }
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'ok') return;
    const f = new FormData($('form', dialog));
    try {
      const r = await api(`/items/${item.slug}/fork`, { method: 'POST', body: { title: f.get('title'), group: f.get('group'), summary: f.get('summary'), html: await editor.shareHtml() } });
      rememberKey(r.slug, r.edit_key);
      toast(r.status === 'published' ? 'Your version is published' : 'Sent for review. Thank you for sharing back!');
      go(`/m/${r.slug}`);
    } catch (err) {
      toast(err.message);
    }
  });
  return editor;
}

// ---- kit checklist ----
function kitTool(tool, item) {
  const key = `commons_kit_${item.slug}`;
  const done = new Set(store.get(key, []));
  const rows = item.kit.items;
  // Shortcuts under a row: make the item from a material in the commons, look at a finished example, order it by email.
  const shortcuts = (r) => {
    const out = [];
    if (r.material_info) out.push(`<a class="btn small" href="/m/${esc(r.material)}" title="${esc(r.material_info.title)}">${r.material_info.kind === 'template' ? 'Make it in your brand' : 'Open in the commons'}</a>`);
    if (r.example) out.push(`<a class="btn small" href="${esc(r.example.url)}" target="_blank" rel="noopener noreferrer">${esc(r.example.label)} ↗</a>`);
    if (r.order) {
      // The example belongs to the group that shared the kit, so only that group's order email links to it.
      const extra = { quantity: r.qty || '', item: r.name, 'example link': getBrand().group_name === item.group ? r.example?.url : '' };
      const subject = quickFill(r.order.subject, extra);
      const body = quickFill(r.order.body, extra);
      out.push(`<a class="btn small primary" href="mailto:?subject=${encodeURIComponent(subject)}&amp;body=${encodeURIComponent(body)}" data-use title="Opens your mail app with the order written out">Order by email</a>`);
      out.push(`<button type="button" class="btn small" data-copy="${esc(`Subject: ${subject}\n\n${body}`)}">Copy order text</button>`);
    }
    return out.length ? `<div class="row shortcuts">${out.join('')}</div>` : '';
  };
  const paint = () => {
    tool.innerHTML = `
      <section class="panel">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Checklist</h2><span class="badge">${done.size} of ${rows.length} packed</span>${item.kit.est_cost ? `<span class="badge kind">${esc(item.kit.est_cost)}</span>` : ''}
          <span style="flex:1"></span>
          <button class="btn small" data-kit="copy">Copy as list</button><button class="btn small" data-kit="clear">Untick all</button>
        </div>
        <table class="kit">
          <thead><tr><th></th><th>Item</th><th>Qty</th><th>Why / tip</th><th></th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr class="${done.has(i) ? 'done' : ''}"><td><label class="check"><input type="checkbox" data-i="${i}" ${done.has(i) ? 'checked' : ''} aria-label="Packed"></label></td><td class="name"><strong>${esc(r.name)}</strong></td><td>${esc(r.qty || '')}</td><td class="note">${esc(r.note || '')}${shortcuts(r)}</td><td>${r.url ? `<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" data-use>Buy ↗</a>` : ''}</td></tr>`).join('')}</tbody>
        </table>
        <p class="hint">Ticks are saved in this browser. Buy links are examples; check price and delivery time yourself. Order emails are filled in from your <a href="/brand">brand kit</a>.</p>
      </section>`;
  };
  tool.addEventListener('change', (e) => {
    const i = e.target.dataset.i;
    if (i == null) return;
    e.target.checked ? done.add(Number(i)) : done.delete(Number(i));
    store.set(key, [...done]);
    paint();
  });
  tool.addEventListener('click', (e) => {
    const act = e.target.closest('[data-kit]')?.dataset.kit;
    if (act === 'copy') {
      countUse(item.slug);
      copy(rows.map((r) => `- [ ] ${r.qty ? r.qty + ' × ' : ''}${r.name}${r.url ? ` (${r.url})` : ''}`).join('\n'), 'Checklist copied');
    }
    if (act === 'clear') {
      done.clear();
      store.set(key, []);
      paint();
    }
  });
  paint();
}

// ---- supplier ----
function supplierTool(tool, item) {
  const s = item.supplier;
  tool.innerHTML = `
    <section class="panel pink">
      <dl class="kv">
        <dt>Supplier</dt><dd><strong>${esc(s.name)}</strong></dd>
        <dt>Type</dt><dd>${esc(s.type)}</dd>
        ${s.location ? `<dt>Where</dt><dd>${esc(s.location)}</dd>` : ''}
        ${s.good_for ? `<dt>Good for</dt><dd>${esc(s.good_for)}</dd>` : ''}
        ${s.website ? `<dt>Website</dt><dd><a href="${esc(s.website)}" target="_blank" rel="noopener noreferrer">${esc(s.website)}</a></dd>` : ''}
      </dl>
    </section>
    ${s.request ? '<section class="panel"><h2>Quote request, written for you</h2><div data-text></div></section>' : ''}`;
  if (s.request) textTool($('[data-text]', tool), [{ label: 'Quote request', channel: 'email', lang: item.language?.slice(0, 2) || 'en', subject: s.request.subject, body: s.request.body }], item.slug);
}

// ---- files ----
function filesPanel(box, item) {
  const listed = item.files || [];
  if (!listed.length && item.kind !== 'file') return;
  const sizes = Object.fromEntries((item.file_list || []).map((f) => [f.path, f.size]));
  const images = listed.filter((f) => IMG.includes(extOf(f.path)));
  const pages = item.pages || [];
  // The overview picture is only for materials without pictures of their own: those are shown themselves.
  const preview = !pages.length && !images.length && item.kind === 'file' && item.preview ? item.preview : null;
  box.innerHTML = `
    <section class="panel">
      <h2>${item.kind === 'file' ? 'Files' : 'Attached files'}</h2>
      ${pages.length ? `<div class="pages">${pages.map((p, i) => `<figure><img loading="lazy" alt="Page ${i + 1}" src="${filePath(item.slug, p)}?w=1100"><figcaption>${i + 1} / ${pages.length}${pages.length === 12 && i === 11 ? ' (first 12 pages shown)' : ''}</figcaption></figure>`).join('')}</div>` : ''}
      ${preview ? `<img class="bigpreview" alt="Preview of the first page" src="${filePath(item.slug, preview)}?w=1200" style="margin-bottom:14px">` : ''}
      ${images.length > 1 ? `<div class="gallery" style="margin-bottom:14px">${images.map((f) => `<a href="${filePath(item.slug, f.path)}" target="_blank" data-use title="${esc(f.label || f.path)}"><img loading="lazy" alt="${esc(f.label || f.path)}" src="${filePath(item.slug, f.path)}?w=480"></a>`).join('')}</div>` : ''}
      ${images.length === 1 && item.kind === 'file' ? `<img class="bigpreview" alt="" src="${filePath(item.slug, images[0].path)}?w=1200" style="margin-bottom:14px">` : ''}
      <ul class="files">${listed.map((f) => `<li><span><strong>${esc(f.label || f.path)}</strong> <span class="small muted">${esc(extOf(f.path).toUpperCase())}${sizes[f.path] ? ' · ' + bytes(sizes[f.path]) : ''}</span></span><a class="btn small" href="${filePath(item.slug, f.path)}?download=1" data-use download>Download</a></li>`).join('')}</ul>
      ${listed.some((f) => ['pptx', 'docx', 'xlsx', 'odp'].includes(extOf(f.path))) ? `<p class="hint">Turning Office files into re-brandable templates ${todo()}</p>` : ''}
    </section>`;
}
