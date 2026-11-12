// Brand kit, Add material, CLI & agents, About.

import { adminToken, api, store, uploadItem } from './api.js';
import { DEFAULT_BRAND, FONTS, PRESETS, activePreset, applyPreset, findFont, getBrand, isDefaultBrand, logoFromMark, monogram, paletteFrom, resetBrand, setBrand, suggestBrand } from './brand.js';
import { go } from './app.js';
import { mountEditor, mountPreview } from './template.js';
import { $, $$, cmd, download, esc, state, toast, todo } from './ui.js';

// ---------------------------------------------------------------- brand kit
const TEXT_FIELDS = [
  ['group_name', 'Group name'], ['tagline', 'Tagline'], ['university', 'University'], ['city', 'City'], ['website', 'Website'],
  ['email', 'Contact email'], ['join_url', 'Join link (QR codes point here)'], ['survey_url', 'Feedback survey link (for survey QR codes)'], ['instagram', 'Instagram handle'], ['your_name', 'Your name (for message templates)'],
];
const COLOR_FIELDS = [['color', 'Main colour'], ['accent', 'Accent'], ['dark', 'Dark'], ['light', 'Light']];
const LOGO_FIELDS = [['logo_square', 'Square', 'square', false], ['logo_wide', 'Wide', 'wide', false], ['logo_square_light', 'Square, for dark backgrounds', 'square', true], ['logo_wide_light', 'Wide, for dark backgrounds', 'wide', true]];

export async function brandPage(root) {
  let brand = getBrand();
  let seed = 3;
  const fontOptions = (sel) => Object.keys(FONTS).map((f) => `<option ${f === sel ? 'selected' : ''}>${esc(f)}</option>`).join('');
  root.innerHTML = `
    <section class="hero compact"><div><h1>Brand kit</h1></div></section>
    <p class="muted" style="max-width:70ch">Commit to a colour, two fonts and a logo once. Every template on this site, and every message template, then comes out in your group’s look. The kit is stored in this browser only.</p>
    <div class="cols" style="margin-top:18px">
      <div>
        ${PRESETS.length > 1 ? `<section class="panel"><h2>Example kits from real groups</h2><p class="small muted" style="margin-bottom:10px">Colours and fonts as these groups use them on their own websites. Pick one to see every template change; your own kit is kept.</p><div class="kits" style="margin:0">${PRESETS.map((k) => `<button type="button" class="kit ${activePreset() === k.id ? 'on' : ''}" data-preset="${esc(k.id)}" title="${esc(k.note || '')}"><span class="swatch" style="background:${esc(k.color)}"></span><span class="swatch" style="background:${esc(k.accent)}"></span>${esc(k.group_name)}</button>`).join('')}</div></section>` : ''}
        <section class="panel form">
          <h2>Your group</h2>
          <div class="two">${TEXT_FIELDS.map(([k, label]) => `<label>${label}<input data-k="${k}" value="${esc(brand[k])}"></label>`).join('')}</div>
        </section>
        <section class="panel form">
          <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Colours and fonts</h2><span style="flex:1"></span><button type="button" class="btn small primary" data-act="suggest">Suggest a look</button><button type="button" class="btn small" data-act="derive">Derive from main colour</button></div>
          <div class="row" style="margin-bottom:14px">${COLOR_FIELDS.map(([k, label]) => `<label style="margin:0">${label}<input type="color" data-k="${k}" value="${esc(brand[k])}" style="height:42px;padding:3px"></label>`).join('')}</div>
          <div class="two">
            <label>Heading font<input data-font="font_heading" list="fontlist" value="${esc(brand.font_heading)}" autocomplete="off" spellcheck="false"></label>
            <label>Body font<input data-font="font_body" list="fontlist" value="${esc(brand.font_body)}" autocomplete="off" spellcheck="false"></label>
          </div>
          <datalist id="fontlist">${Object.keys(FONTS).map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>
          <p class="hint">Any of the ${Object.keys(FONTS).length} Google Fonts works: start typing a name.</p>
        </section>
        <section class="panel">
          <h2>Logos</h2>
          <div class="logos" id="logos"></div>
          <p class="hint">SVG or PNG, up to 400 KB each. Without an upload, templates use a generated monogram of your group name.</p>
          <div class="form" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
            <label>No logo yet? Describe a motif and let the AI draw four options (optional)<input id="logohint" maxlength="120" placeholder="e.g. a lighthouse, a compass needle, a knot"></label>
            <div class="row"><button type="button" class="btn small primary" data-act="genlogo" ${state.meta.logos ? '' : 'disabled'}>Generate logos</button><span class="small muted" id="logostatus">${state.meta.logos ? '' : 'Switched off on this server.'}</span></div>
            <div class="logos" id="candidates" style="margin-top:12px"></div>
          </div>
        </section>
        <section class="panel">
          <div class="row">
            <button type="button" class="btn" data-act="export">Export brand-kit.json</button>
            <label class="btn" style="cursor:pointer">Import<input type="file" accept="application/json,.json" data-import hidden></label>
            <button type="button" class="btn danger" data-act="reset">Reset to the example (AI Safety Aachen)</button>
          </div>
          <p class="hint">The exported file is what the CLI and agents use to brand materials for your group.</p>
        </section>
      </div>
      <aside>
        <section class="panel">
          <h3 style="margin-top:0">Live preview</h3>
          <div id="previews" style="display:grid;gap:12px"><p class="small muted">Loading templates…</p></div>
        </section>
      </aside>
    </div>`;

  const previews = [];
  const paintLogos = () => {
    $('#logos', root).innerHTML = LOGO_FIELDS.map(([k, label, kind, dark]) => {
      const src = brand[k] || (isDefaultBrand(brand) ? `/assets/brand/logo-${kind}${dark ? '-light' : ''}.svg` : monogram(brand, kind, dark));
      return `<div class="logo-slot"><div class="pv ${dark ? 'dark' : ''}"><img alt="" src="${esc(src)}"></div>${label}<div class="row" style="justify-content:center;margin-top:6px"><label class="btn small" style="cursor:pointer">Upload<input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" data-logo="${k}" hidden></label>${brand[k] ? `<button type="button" class="btn small" data-clear="${k}">Remove</button>` : ''}</div></div>`;
    }).join('');
  };
  const refresh = (patch, repaintInputs = false) => {
    brand = setBrand(patch);
    for (const p of previews) p.redress(brand);
    paintLogos();
    if (repaintInputs) for (const el of $$('[data-k], [data-font]', root)) el.value = brand[el.dataset.k || el.dataset.font];
  };
  paintLogos();

  root.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (k) refresh({ [k]: e.target.value });
    // A font applies once the name typed is a real Google Font.
    const f = e.target.dataset.font;
    if (f && findFont(e.target.value)) refresh({ [f]: findFont(e.target.value) });
  });
  root.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (e.target.dataset.logo) {
      if (file.size > 400 * 1024) return toast('That logo is larger than 400 KB.');
      const reader = new FileReader();
      reader.onload = () => refresh({ [e.target.dataset.logo]: reader.result });
      reader.readAsDataURL(file);
    }
    if (e.target.hasAttribute('data-import')) {
      file.text().then((t) => {
        try {
          const data = JSON.parse(t);
          const patch = {};
          for (const k of Object.keys(DEFAULT_BRAND)) if (typeof data[k] === 'string') patch[k] = data[k];
          refresh(patch, true);
          toast('Brand kit imported');
        } catch {
          toast('That file is not a brand-kit.json.');
        }
      });
    }
  });
  let marks = [];
  const paintMarks = () => {
    $('#candidates', root).innerHTML = marks.map((svg, i) => `<button type="button" class="logo-slot" data-pick="${i}" style="cursor:pointer"><div class="pv"><img alt="Logo option ${i + 1}" src="${esc(logoFromMark(svg, brand, 'square'))}"></div>Use this one</button>`).join('');
  };
  root.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const svg = marks[Number(pick.dataset.pick)];
      refresh({ logo_square: logoFromMark(svg, brand, 'square'), logo_wide: logoFromMark(svg, brand, 'wide'), logo_square_light: logoFromMark(svg, brand, 'square', true), logo_wide_light: logoFromMark(svg, brand, 'wide', true) });
      return toast('Logo set for all four variants');
    }
    if (e.target.closest('[data-act="genlogo"]')) {
      const status = $('#logostatus', root);
      const btn = e.target.closest('button');
      btn.disabled = true;
      status.textContent = 'Drawing four options, this takes about a minute…';
      try {
        marks = (await api('/logo', { method: 'POST', body: { group_name: brand.group_name, hint: $('#logohint', root).value } })).logos;
        status.textContent = 'Pick one. It is recoloured with your brand colours.';
        paintMarks();
      } catch (err) {
        status.textContent = err.message;
      }
      btn.disabled = false;
      return;
    }
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      applyPreset(preset.dataset.preset);
      return go('/brand', true);
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) return refresh({ [clear.dataset.clear]: '' });
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'suggest') refresh(suggestBrand(seed++ * 7 + Math.floor(Math.random() * 5)), true);
    if (act === 'derive') refresh(paletteFrom(brand.color), true);
    if (act === 'export') download('brand-kit.json', JSON.stringify(brand, null, 2), 'application/json');
    if (act === 'reset' && confirm('Replace your brand kit with the example?')) {
      resetBrand();
      refresh({}, true);
    }
  });

  api('/items?kind=template&sort=top')
    .then(async ({ items }) => {
      const want = ['poster-series-template', 'instagram-series-template', 'trifold-flyer-template'];
      const pick = [...items.filter((i) => want.includes(i.slug)), ...items.filter((i) => !want.includes(i.slug))].slice(0, 3);
      const box = $('#previews', root);
      if (!box) return;
      box.innerHTML = pick.length ? pick.map((i) => `<a class="thumb" style="border:1px solid var(--line);border-radius:12px" href="/m/${esc(i.slug)}" data-template="${esc(i.slug)}" data-path="${esc(i.template.path)}" title="${esc(i.title)}"></a>`).join('') : '<p class="small muted">No templates yet.</p>';
      for (const el of $$('[data-template]', box)) previews.push(await mountPreview(el, brand));
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- add material
const safeName = (name) => {
  const clean = name.normalize('NFKD').replace(/[^A-Za-z0-9_ .()+&,@-]/g, '-').replace(/^[^A-Za-z0-9_]+/, '');
  return clean.slice(-120) || 'file';
};

export async function addPage(root) {
  const brand = getBrand();
  const cats = Object.entries(state.meta.categories).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  const origin = location.origin;
  root.innerHTML = `
    <section class="hero compact"><div><h1>Add material</h1></div></section>
    <p class="muted" style="max-width:72ch">Share what worked for your group. Remove names of private people, phone numbers and private links first. Materials added on the web appear after a moderator has approved them.</p>

    <section class="panel form" style="margin-top:18px">
      <h2>Quick add</h2>
      <form id="quick">
        <div class="two">
          <label>What is it?<select name="kind"><option value="file">A file (PDF, image, slides, document)</option><option value="link">A link (demo, codebase, website)</option><option value="text">A text template (email, WhatsApp, Slack, doc)</option></select></label>
          <label>Category<select name="category">${cats}</select></label>
        </div>
        <label>Title<input name="title" maxlength="90" required placeholder="e.g. Freshers fair flyer, A5"></label>
        <label>What is it, and when did it work well?<textarea name="summary" maxlength="400" required></textarea></label>
        <div class="two">
          <label>Your group<input name="group" maxlength="80" value="${esc(brand.group_name)}"></label>
          <label>Tags, separated by commas<input name="tags" placeholder="tabling, freshers-week"></label>
        </div>
        <div data-for="file"><label>Files (up to ${state.meta.limits?.file_mb || 25} MB each)<input type="file" name="files" multiple></label></div>
        <div data-for="link" hidden><div class="two"><label>Link<input name="url" type="url" placeholder="https://"></label><label>Button text<input name="label" maxlength="60" placeholder="Open the demo"></label></div></div>
        <div data-for="text" hidden>
          <div class="two"><label>Channel<select name="channel"><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="slack">Slack</option><option value="instagram">Instagram caption</option><option value="doc">Document (Markdown)</option></select></label><label>Subject (email only)<input name="subject" maxlength="300"></label></div>
          <label>Text. Write blanks as [Group name], [Date], [Room]<textarea name="body" style="min-height:180px"></textarea></label>
        </div>
        <p class="err" data-err></p>
        <button class="btn primary">Add to the commons</button>
      </form>
    </section>

    <section class="panel form">
      <h2>Turn a finished printable into a template</h2>
      <p class="small muted" style="max-width:75ch">Upload a flyer, poster, sign or slide. Your design is kept as it is: the artwork and photos stay untouched, the text becomes editable text at the same place, and your colours become the brand colours another group can swap. A PDF converts in seconds without any AI. For an image, an image model first removes the baked-in text from the picture. Check the result, fix texts in place, then publish it.</p>
      ${state.meta.conversion ? '' : '<div class="notice">The conversion agent is switched off on this server.</div>'}
      <div class="two">
        <label>Printable (PDF is best; PNG, JPG or WebP also work; up to 25 MB)<input type="file" id="printable" accept="application/pdf,image/png,image/jpeg,image/webp"></label>
        <label>Anything the agent should know? (optional)<input id="hint" maxlength="300" placeholder="e.g. A5 flyer for our intro talk"></label>
      </div>
      <div class="row"><button type="button" class="btn primary" id="convert" ${state.meta.conversion ? '' : 'disabled'}>Convert to a template</button><span class="small muted" id="progress"></span></div>
      <div id="converted" hidden style="margin-top:16px">
        <div class="stage"></div>
        <p class="hint">Click any text to fix it. The preview uses your brand kit.</p>
        <form id="save" style="margin-top:12px">
          <div class="two"><label>Title<input name="title" maxlength="90" required></label><label>Category<select name="category">${cats}</select></label></div>
          <label>What is it, and when did it work well?<textarea name="summary" maxlength="400" required></textarea></label>
          <p class="err" data-err></p>
          <button class="btn primary">Publish this template</button>
        </form>
      </div>
    </section>

    <section class="panel">
      <h2>From the terminal or your coding agent</h2>
      <p class="small muted">The <a href="/cli">commons CLI</a> adds a single file, a link, a text, or a whole folder with several files. To share everything your group has made in one go, <a href="/contribute">let your agent do it</a>.</p>
      ${cmd(`commons add flyer.pdf --title "Freshers fair flyer" --category print --summary "A5 flyer we handed out at the activities fair"`)}
      ${cmd(`commons add --link ${origin} --title "Our demo" --category demo`)}
      ${cmd(`commons add ./my-material-folder`)}
    </section>`;

  // quick add
  const quick = $('#quick', root);
  const showKind = () => {
    for (const el of $$('[data-for]', quick)) el.hidden = el.dataset.for !== quick.kind.value;
    const def = { file: 'print', link: 'demo', text: 'message' }[quick.kind.value];
    if (def && state.meta.categories[def]) quick.category.value = def;
  };
  quick.kind.addEventListener('change', showKind);
  showKind();
  quick.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-err]', quick);
    const btn = $('button', quick);
    err.textContent = '';
    const f = new FormData(quick);
    const meta = { kind: f.get('kind'), title: f.get('title'), category: f.get('category'), summary: f.get('summary'), group: f.get('group'), tags: String(f.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean) };
    const files = [];
    if (meta.kind === 'file') {
      const picked = [...quick.files.files];
      if (!picked.length) return (err.textContent = 'Choose at least one file.');
      for (const file of picked) files.push({ path: safeName(file.name), data: file, type: file.type });
      meta.files = files.map((x) => ({ path: x.path }));
    }
    if (meta.kind === 'link') meta.link = { url: f.get('url'), label: f.get('label') || 'Open link' };
    if (meta.kind === 'text') meta.variants = [{ label: 'Version 1', channel: f.get('channel'), subject: f.get('subject'), body: f.get('body') }];
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const r = await uploadItem(meta, files);
      toast(r.status === 'published' ? 'Published' : 'Thank you! It appears for everyone after review.');
      go(`/m/${r.slug}`);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Add to the commons';
    }
  });

  // conversion
  let editor = null;
  let ticker;
  $('#convert', root).addEventListener('click', async () => {
    const file = $('#printable', root).files[0];
    const progress = $('#progress', root);
    if (!file) return (progress.textContent = 'Choose a file first.');
    if (file.size > 25 * 1048576) return (progress.textContent = 'That file is larger than 25 MB.');
    const btn = $('#convert', root);
    btn.disabled = true;
    const started = Date.now();
    ticker = setInterval(() => (progress.textContent = `${file.type === 'application/pdf' ? 'Converting your PDF' : 'Removing the text from the picture and setting it again as editable text, about two minutes'} (${Math.round((Date.now() - started) / 1000)} s)…`), 1000);
    try {
      const r = await api(`/convert?hint=${encodeURIComponent($('#hint', root).value)}`, { method: 'POST', raw: file, type: file.type });
      clearInterval(ticker);
      // Files that belong to the template (a background picture) are put into the page itself, so one file holds it all.
      for (const f of r.files || []) r.html = r.html.split(`"${f.path}"`).join(`"data:${f.type};base64,${f.data}"`);
      const rep = r.report || {};
      const facts = [r.pages > 1 ? `${r.pages} pages` : '', rep.editable != null ? `${rep.editable} editable texts` : '', rep.photos != null ? `${rep.photos} photos kept` : ''].filter(Boolean).join(', ');
      progress.textContent = r.method === 'rebuilt' ? `Rebuilt by AI in ${r.seconds} s (${r.model}). The design is simplified; a PDF would keep the original.` : `Done in ${r.seconds} s: original design kept${facts ? ` (${facts})` : ''}.`;
      for (const w of (rep.warnings || []).slice(0, 3)) progress.textContent += ` Note: ${w}`;
      $('#converted', root).hidden = false;
      editor?.destroy();
      editor = mountEditor($('#converted .stage', root), { html: r.html, base: '/assets/brand/' });
      const save = $('#save', root);
      if (!save.elements.title.value) save.elements.title.value = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 80) + ' (template)';
      save.elements.category.value = 'print';
    } catch (ex) {
      clearInterval(ticker);
      progress.textContent = ex.message;
    }
    btn.disabled = false;
  });
  $('#save', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const save = e.target;
    const err = $('[data-err]', save);
    err.textContent = '';
    try {
      const html = await editor.shareHtml();
      const r = await uploadItem(
        { kind: 'template', title: save.elements.title.value, category: save.elements.category.value, summary: save.elements.summary.value, group: brand.group_name, source: 'adapted', provenance: 'Converted from a finished printable by the conversion agent.', template: { path: 'template.html', format: editor.format || undefined } },
        [{ path: 'template.html', data: html, type: 'text/html' }],
      );
      toast(r.status === 'published' ? 'Published' : 'Thank you! It appears for everyone after review.');
      go(`/m/${r.slug}`);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  return () => {
    clearInterval(ticker);
    editor?.destroy();
  };
}

// ---------------------------------------------------------------- CLI & agents
export async function cliPage(root) {
  const o = location.origin;
  root.innerHTML = `
    <section class="hero compact"><div><h1>Use it with Claude</h1></div></section>
    <p class="muted" style="max-width:74ch">Most groups will not browse this site. They ask Claude: “I want to run an intro evening, prep all the marketing for me.” Claude finds what other groups wrote, designed and used at real events, adapts it to your group from what it remembers about you, and hands back posters, posts and emails that are nearly done. <button type="button" class="btn small" data-intro>▶ Watch the intro</button></p>
    <div class="cols" style="margin-top:18px">
      <div>
        <section class="panel">
          <h2>1. Connect your AI</h2>
          <p class="small muted">Two questions, then one thing to copy: for the Claude app, Claude Code, Codex or any other assistant, on macOS, Linux and Windows, whether or not you have set anything up yet. It also tells your assistant about your group, from your <a href="/brand">brand kit</a>.</p>
          <p><button type="button" class="btn primary" data-agent-setup>Set up my AI</button></p>
          <p class="small muted">For those who know what to do with it: the commons is an MCP server, with no login.</p>
          ${cmd(`${o}/mcp`)}
          <h2 style="margin-top:22px">2. Ask</h2>
          <div class="md"><ul>
            <li>“I want to run an intro evening on 23 October in lecture hall 2. Prep all the marketing for me.”</li>
            <li>“We have a stall at the activities fair next week. What do we need, and can you get the flyers ordered?”</li>
            <li>“Write to three professors and ask for five minutes at the start of their lecture.”</li>
          </ul></div>
          <p class="small muted">Printables come back as a link that opens the material in your colours, fonts and name, with working QR codes and a Print / Save as PDF button. If you improve something, Claude asks whether you want to share your version back.</p>
        </section>
        <section class="panel">
          <h2>For the terminal: the commons CLI</h2>
          <p class="small muted">One file, for agents and people who live in the terminal. It does what the MCP server does, plus uploading whole folders. <button type="button" class="btn small" data-agent-setup>Set up my AI</button> installs it together with the Claude Code skill (it needs Node.js 18 or newer); the file itself is at <a href="/cli/commons.mjs" target="_blank" rel="noopener">${esc(o)}/cli/commons.mjs</a>.</p>
          <h3>Find and fork</h3>
          ${cmd(`commons search "something to hand out at a freshers fair"`)}
          ${cmd(`commons show tabling-kit`)}
          ${cmd(`commons get poster-series-template     # downloads the material into ./poster-series-template/`)}
          <h3>Share back</h3>
          <p class="small muted">A forked folder remembers where it came from, so your version links to the original.</p>
          ${cmd(`commons add ./poster-series-template`)}
          ${cmd(`commons add poster.pdf --title "Reading group poster" --category print --summary "A3 poster for the semester kickoff"`)}
          ${cmd(`commons add --text invite.md --title "Invitation to a first meetup" --category message --channel email`)}
          ${cmd(`commons add --link https://example.org/demo --title "Demo that makes people say wow" --category demo`)}
          <p class="small muted">Other commands: <code>commons list --sort best</code>, <code>commons vote &lt;slug&gt; up</code>, <code>commons help</code>.</p>
          <p class="small muted">To share everything your group has made in one go, see <a href="/contribute">Contribute your group’s materials</a>.</p>
          <h3>The Claude Code skill</h3>
          <p class="small muted">With the skill, Claude Code checks the commons before it designs a flyer or writes an invitation from scratch, forks the best match, adapts it, and asks whether you want to share the result. The setup installs it; by hand it is <code>commons skill install</code>.</p>
        </section>
      </div>
      <aside>
        <section class="panel pink">
          <h3 style="margin-top:0">What a material is</h3>
          <p class="small">A folder with an <code>item.json</code> (title, category, kind, summary) and its files. Kinds: file, customizable template, text template, link, kit, supplier.</p>
          <p class="small" style="margin:0">The same HTTP API serves this website and the CLI, so anything you can do here an agent can do too.</p>
        </section>
        <section class="panel">
          <h3 style="margin-top:0">Search</h3>
          <p class="small" style="margin:0">${state.meta.semantic_search ? 'Search is semantic: materials are matched by meaning (text embeddings), blended with keyword matches. Describe what you need in your own words.' : 'Semantic search is switched off on this server; search falls back to keywords.'}</p>
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- about
export async function aboutPage(root) {
  const row = (need, how, status, label) => `<tr><td><strong>${need}</strong></td><td>${how}</td><td><span class="status ${status}">${label}</span></td></tr>`;
  root.innerHTML = `
    <section class="hero compact"><div><h1>About this prototype</h1></div></section>
    <p class="muted" style="max-width:75ch">University groups keep producing the same intro slides, flyers, invitations and tabling kits. Groups Commons is a prototype of a shared place for these materials, built to test the technically risky parts of the idea. It is filled with material from one group, AI Safety Aachen.</p>

    <section class="panel" style="margin-top:18px">
      <h2>What works, and what is only sketched</h2>
      <table class="spec">
        <thead><tr><th>Requirement</th><th>In this prototype</th><th>Status</th></tr></thead>
        <tbody>
          ${row('Quality rises to the top', 'One vote per visitor, up or down, like Reddit. “Best” (the default) is upvotes ÷ uses × ln(uses), so a material that many people used and liked beats one with a few early votes. “Hot” mixes votes with age.', 'live', 'Works')}
          ${row('Design consistency', 'A brand kit with colour, fonts, square and wide logo. Every template re-skins itself, including QR codes to your join link. A generator suggests palettes, font pairings and a monogram logo.', 'live', 'Works')}
          ${row('Easy customization', 'Templates open in an editor in the browser: click text to change it, print to PDF, download as HTML, share your version as a fork.', 'live', 'Works')}
          ${row('Printables become templates', 'An agent on the server rebuilds an uploaded PDF or image as a re-brandable template.', 'live', 'Works, quality varies')}
          ${row('Use through Claude', 'An MCP server lets Claude search the commons, read materials, prepare them in a group’s look and share versions back. A command line tool and a Claude Code skill do the same in the terminal. Search matches by meaning, using text embeddings.', 'live', 'Works')}
          ${row('Low transaction costs', 'Message templates fill themselves in from your brand kit and open in your mail app or WhatsApp. Supplier pages come with a ready quote request. Kits are checklists with buy links.', 'live', 'Works')}
          ${row('Moderation', 'Materials and group websites added on the web wait for approval. Moderators approve or reject them on the <a href="/moderate">moderation page</a>, and can make other accounts moderators.', 'live', 'Works')}
          ${row('Accounts', '<a href="/account">Accounts</a> with user name and password tie votes, materials, brand kit and website to a person instead of a browser. Without an account everything except hosting a website still works. Password reset and university sign-in are not built.', 'part', 'Works, basic')}
          ${row('Competitions', 'A <a href="/leaderboard">leaderboard</a> ranks the materials added in the running semester and the groups behind them. Prizes are not decided.', 'part', 'Works, no prizes')}
          ${row('Hosted websites', 'The website template can be published as a group website at /s/your-group with one click, after review. Own domains and server access are not built.', 'part', 'Works, no own domain')}
          ${row('Office files', 'PowerPoint, Word and Excel files get page previews in the browser, like PDFs. They cannot be converted to re-brandable templates yet.', 'part', 'Previews work')}
          ${row('AI logo generation', 'The brand kit draws four logo options from your group name and a motif, as vector graphics in your brand colours, with square, wide and dark-background variants.', 'live', 'Works')}
        </tbody>
      </table>
    </section>

    <div class="cols">
      <div>
        <section class="panel">
          <h2>About the content</h2>
          <div class="md">
            <ul>
              <li><strong>Votes and use counts on the seed materials are simulated.</strong> They reflect a guess at what matters most when running a group, so that ranking and sorting can be tried out. Your own votes are real and count.</li>
              <li><strong>Shared as used:</strong> material the group could publish as it is.</li>
              <li><strong>Adapted:</strong> the group’s designs, rebuilt as templates that other groups can re-brand.</li>
              <li><strong>Synthesized:</strong> written from internal documents and emails, with names, amounts and private details removed. Internal files themselves are not on this site.</li>
            </ul>
          </div>
        </section>
        <section class="panel">
          <h2>How ranking works</h2>
          <div class="md">
            <ul>
              <li><strong>Best</strong> (default): upvotes ÷ uses × ln(uses). A use is a download, print, copy or opened link, so a material ranks high when many of the people who used it also liked it.</li>
              <li><strong>Hot:</strong> log10 of the score plus a bonus for newer materials, like Reddit and Hacker News. Ten times more votes are worth as much as being about six months newer.</li>
              <li><strong>Top:</strong> upvotes minus downvotes. <strong>New:</strong> newest first.</li>
            </ul>
          </div>
        </section>
      </div>
      <aside>
        <section class="panel form">
          <h3 style="margin-top:0">Moderators</h3>
          <p class="small muted">${adminToken() ? 'This browser is signed in as moderator. Pending materials show an Approve button.' : 'Paste the moderator token to approve pending materials in this browser.'}</p>
          <label>Moderator token<input type="password" id="token" autocomplete="off" value=""></label>
          <div class="row"><button type="button" class="btn small" id="signin">Sign in</button>${adminToken() ? '<button type="button" class="btn small" id="signout">Sign out</button>' : ''}</div>
        </section>
      </aside>
    </div>`;
  $('#signin', root).addEventListener('click', async () => {
    store.set('commons_admin', $('#token', root).value.trim());
    const meta = await api('/meta').catch(() => ({}));
    if (!meta.admin) {
      store.del('commons_admin');
      return toast('That token is not valid.');
    }
    state.meta = meta;
    toast('Signed in as moderator');
    go('/about', true);
  });
  $('#signout', root)?.addEventListener('click', () => {
    store.del('commons_admin');
    go('/about', true);
  });
}
