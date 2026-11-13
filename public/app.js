// Router and the browse page.

import { contributePage } from './agent.js';
import { api, filePath, store } from './api.js';
import { PRESETS, activePreset, applyPreset, brandFromLink, getBrand, hasOwnBrand, loadBrandData, restoreOwnBrand, setBrand } from './brand.js';
import { itemPage } from './item.js';
import { accountPage, leaderboardPage, moderatePage, privacyPage } from './more.js';
import { aboutPage, addPage, brandPage, cliPage } from './pages.js';
import { redressPreviews, watchPreviews } from './template.js';
import { $, $$, KIND, esc, plural, state, timeAgo, voteBox } from './ui.js';

const app = $('#app');
let cleanup = null;
// Lists of materials this visit has already loaded, by filter (shown at once when the visitor comes back to one).
const listCache = new Map();

// [address, page, entry of the navigation it belongs to, name in the browser tab]
const SITE_TITLE = 'Groups Commons: shared materials for AI safety groups';
const routes = [
  [/^\/$/, home, 'browse', ''],
  [/^\/m\/([a-z0-9-]+)\/?$/, itemPage, 'browse', ''],
  [/^\/brand\/?$/, brandPage, 'brand', 'Brand kit'],
  [/^\/add\/?$/, addPage, 'add', 'Add material'],
  [/^\/contribute\/?$/, contributePage, 'add', 'Contribute'],
  [/^\/cli\/?$/, cliPage, 'cli', 'Use it with Claude'],
  [/^\/about\/?$/, aboutPage, 'about', 'About'],
  [/^\/privacy\/?$/, privacyPage, '', 'Privacy'],
  [/^\/leaderboard\/?$/, leaderboardPage, 'leaderboard', 'Leaderboard'],
  [/^\/account\/?$/, accountPage, 'account', 'Account'],
  [/^\/moderate\/?$/, moderatePage, 'moderate', 'Moderate'],
];

// On phones the navigation folds away behind the Menu button in the header (styles.css shows the button there).
const header = $('header.top');
const menuBtn = $('#menu-btn');
function setMenu(open) {
  header.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => setMenu(!header.classList.contains('open')));
header.addEventListener('click', (e) => {
  if (e.target.closest('a, button') && !e.target.closest('#menu-btn')) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
});

// A row that scrolls sideways on phones (filters, example kits) starts with its selected entry in view.
function showSelected(row) {
  const on = row?.querySelector('.on');
  if (on && row.scrollWidth > row.clientWidth) row.scrollLeft = on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
}

async function render() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  setMenu(false);
  const path = location.pathname;
  const route = routes.find(([re]) => re.test(path));
  queueMicrotask(() => $$('[data-tryit]').forEach((a) => a.setAttribute('href', `https://claude.ai/new?q=${encodeURIComponent(tryItPrompt())}`)));
  const me = state.meta.account;
  // The account: a round picture (the group's own square logo once it has one), else the first two letters of
  // the user name; a plain figure while nobody is signed in.
  const acct = $('#acct');
  const brand = getBrand();
  const picture = me && !activePreset() && brand.logo_square ? brand.logo_square : '';
  const face = me ? (picture ? `<img alt="" src="${esc(picture)}">` : esc([...me.username].slice(0, 2).join('').toUpperCase())) : '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7.2" r="3.3"/><path d="M3.6 17.2c.9-3.2 3.4-4.8 6.4-4.8s5.500 1.600 6.400 4.800"/></svg>';
  acct.innerHTML = `<span class="pic">${face}</span><span class="who">${me ? esc(me.username) : 'Sign in'}</span>`;
  acct.classList.toggle('in', !!me);
  acct.setAttribute('aria-label', me ? `Account: ${me.username}` : 'Sign in');
  acct.title = me ? `Signed in as ${me.username}` : 'Sign in';
  $('#mod').innerHTML = state.meta.admin ? '<a href="/moderate" data-nav="moderate">Moderate</a>' : '';
  for (const a of $$('#nav a')) a.classList.toggle('on', !!route && a.dataset.nav === route[2]);
  document.title = !route ? 'Page not found · Groups Commons' : route[3] ? `${route[3]} · Groups Commons` : SITE_TITLE;
  if (!route) {
    app.innerHTML = '<div class="empty"><h2>Page not found</h2><p><a href="/">Back to all materials</a></p></div>';
    return;
  }
  try {
    cleanup = await route[1](app, route[0].exec(path).slice(1));
  } catch (err) {
    app.innerHTML = `<div class="empty"><h2>${err.status === 404 ? 'Not found' : 'Something went wrong'}</h2><p>${esc(err.message)}</p><p><a href="/">Back to all materials</a></p></div>`;
  }
}

export function go(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  window.scrollTo(0, 0);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('/files/') || href.startsWith('/cli/')) return;
  e.preventDefault();
  go(href);
});
window.addEventListener('popstate', render);

// ---- browse ----
const HERO_ART = `<svg viewBox="0 0 250 190" fill="none" stroke="#e0a63a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="26" y="34" width="92" height="124" rx="6" transform="rotate(-7 72 96)"/><path d="M44 66l56-7M46 82l56-7M48 98l38-5" />
  <rect x="96" y="22" width="92" height="124" rx="6" transform="rotate(5 142 84)" fill="#fffdfb"/><path d="M114 52l56 5M112 68l56 5M111 84l34 3"/>
  <rect x="118" y="98" width="38" height="38" rx="4" transform="rotate(5 137 117)"/><path d="M127 108h7v7h-7zM141 110h6M141 118h6M127 122h6" transform="rotate(5 137 117)"/>
  <circle cx="206" cy="52" r="16"/><path d="M199 52l5 5 9-10"/><path d="M196 110c12-6 26-4 34 6M200 128c9-4 18-3 24 3M16 170h218"/>
</svg>`;

function thumb(item) {
  const href = `/m/${item.slug}`;
  if (item.kind === 'template') {
    const img = item.preview ? `<img class="contain" loading="lazy" alt="" src="${filePath(item.slug, item.preview)}?w=480">` : '';
    return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true" data-template="${esc(item.slug)}" data-path="${esc(item.template.path)}">${img}<span class="live">your brand, live</span></a>`;
  }
  if (item.preview) return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><img class="cover" loading="lazy" alt="" src="${filePath(item.slug, item.preview)}?w=480"></a>`;
  if (item.kind === 'text') {
    const v = item.variants?.[0] || {};
    return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><div class="paper"><b>${esc(v.channel === 'doc' ? 'Document' : v.channel || 'text')}${item.variants?.length > 1 ? ` · ${item.variants.length} versions` : ''}</b>${esc(item.snippet || item.summary)}</div></a>`;
  }
  if (item.kind === 'kit') {
    return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><div class="paper"><b>${item.kit.count} items${item.kit.est_cost ? ` · ${esc(item.kit.est_cost)}` : ''}</b><ul>${item.kit.first.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></a>`;
  }
  if (item.kind === 'supplier') {
    return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><div class="big"><svg viewBox="0 0 48 48"><path d="M8 20l4-10h24l4 10M8 20v18h32V20M8 20h32M19 38V27h10v11"/></svg><div class="t">${esc(item.supplier.name)}</div><div class="s">${esc([item.supplier.type, item.supplier.location].filter(Boolean).join(' · '))}</div></div></a>`;
  }
  if (item.kind === 'link') {
    let host = '';
    try {
      host = new URL(item.link.url).host.replace(/^www\./, '');
    } catch {}
    return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><div class="big"><svg viewBox="0 0 48 48"><path d="M20 28a8 8 0 0 0 11 0l7-7a8 8 0 0 0-11-11l-3 3M28 20a8 8 0 0 0-11 0l-7 7a8 8 0 0 0 11 11l3-3"/></svg><div class="t">${esc(host)}</div><div class="s">${esc(item.link.label)}</div></div></a>`;
  }
  return `<a class="thumb" href="${href}" tabindex="-1" aria-hidden="true"><div class="big"><svg viewBox="0 0 48 48"><path d="M12 6h17l9 9v27H12zM29 6v9h9M18 24h12M18 31h12"/></svg><div class="s">${esc((item.files || []).map((f) => f.path.split('.').pop().toUpperCase()).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}</div></div></a>`;
}

export function card(item) {
  const kind = item.kind === 'template' ? `Template${item.template.format ? ' · ' + item.template.format : ''}` : KIND[item.kind];
  return `<article class="card">
    ${thumb(item)}
    <div class="body">
      ${voteBox(item)}
      <div>
        <div class="meta"><span class="badge kind">${esc(kind)}</span><span>${esc(state.meta.categories[item.category] || item.category)}</span>${item.featured ? '<span class="badge featured">★ Featured</span>' : ''}${item.status === 'pending' ? '<span class="badge pending">pending review</span>' : ''}</div>
        <h3><a href="/m/${esc(item.slug)}">${esc(item.title)}</a></h3>
        <p class="sum">${esc(item.summary)}</p>
        <div class="meta"><span>${esc(item.group)}</span><span>·</span><span>${plural(item.uses || 0, 'use')}</span>${item.forks ? `<span>·</span><span>${plural(item.forks, 'fork')}</span>` : ''}<span>·</span><span>${timeAgo(item.created_at)}</span></div>
      </div>
    </div>
  </article>`;
}

const SORTS = { best: 'Best', hot: 'Hot', top: 'Top', new: 'New' };
const SORT_HELP = {
  hot: 'Votes, with newer materials ranked higher (like Reddit and Hacker News).',
  best: 'Liked by the people who used it: upvotes ÷ uses × ln(uses).',
  top: 'Most upvotes minus downvotes.',
  new: 'Newest first.',
};

async function home(root) {
  const p = new URLSearchParams(location.search);
  let q = p.get('q') || '';
  let cat = p.get('c') || '';
  let sort = p.get('sort') || '';
  // The line that says whose look the templates are in, and the row of example kits.
  const brandBar = () => {
    const brand = getBrand();
    return `
    <div class="brandstrip">
      <span>Templates are shown in your brand:</span>
      <span><span class="swatch" style="background:${esc(brand.color)}"></span> <span class="swatch" style="background:${esc(brand.accent)}"></span></span>
      <strong>${esc(brand.group_name)}</strong><span>${esc(brand.font_heading)} / ${esc(brand.font_body)}</span>
      <a href="/brand">Change brand kit</a>
    </div>
    ${PRESETS.length > 1 ? `<div class="kits"><span class="small muted">See every template in another group’s real look:</span><div class="kitrow">${PRESETS.map((k) => `<button type="button" class="kit ${activePreset() === k.id ? 'on' : ''}" data-kit="${esc(k.id)}" title="${esc(`${k.group_name}: ${k.font_heading} / ${k.font_body}`)}"><span class="swatch" style="background:${esc(k.color)}"></span><span class="swatch" style="background:${esc(k.accent)}"></span>${esc(k.group_name)}</button>`).join('')}${hasOwnBrand() ? '<button type="button" class="kit" data-kit="">Back to my own kit</button>' : ''}</div></div>` : ''}`;
  };
  root.innerHTML = `
    <section class="hero ${q || cat ? 'compact' : ''}">
      <div>
        <h1>Don’t redo what another group <em>already made.</em></h1>
        <p class="lead">Slides, flyers, message templates, tabling kits and suppliers from AI safety university groups. Take what works, re-brand it in one click, and share your version back.</p>
        <p class="row hero-actions"><a class="btn primary" data-tryit target="_blank" rel="noopener" href="https://claude.ai/new">Try it with Claude</a><a class="btn" href="/cli">Connect Claude</a><button type="button" class="btn" data-intro>▶ Watch the intro</button></p>
      </div>
      ${HERO_ART}
    </section>
    <label class="search">
      <input id="q" type="search" placeholder="What do you need? Try “something to hand out at a freshers fair”" value="${esc(q)}" autocomplete="off" aria-label="Search materials">
      <span class="mode" id="mode"></span>
    </label>
    <div id="brandbar">${brandBar()}</div>
    <div id="results">${listCache.size ? '' : '<p class="loading">Loading materials…</p>'}</div>`;

  root.addEventListener('click', (e) => {
    const kit = e.target.closest('[data-kit]');
    if (!kit) return;
    if (kit.dataset.kit) applyPreset(kit.dataset.kit);
    else restoreOwnBrand();
    // Only the look changes: the materials stay where they are and their previews are re-dressed in place.
    $('#brandbar', root).innerHTML = brandBar();
    showSelected($('.kitrow', root));
    redressPreviews(root);
  });
  showSelected($('.kitrow', root));
  const results = $('#results', root);
  let seq = 0;
  // Choosing a category or an order is a step the Back button undoes; typing a search is not (one step per letter).
  async function load(step = false) {
    const mine = ++seq;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (cat) params.set('category', cat);
    if (sort) params.set('sort', sort);
    const url = new URLSearchParams();
    if (q) url.set('q', q);
    if (cat) url.set('c', cat);
    if (sort) url.set('sort', sort);
    const address = '/' + (url.size ? '?' + url : '');
    if (address !== location.pathname + location.search) history[step ? 'pushState' : 'replaceState']({}, '', address);
    // What this list looked like a moment ago is shown at once; the current state follows quietly.
    const key = String(params);
    const known = listCache.get(key);
    if (known) show(known);
    let data;
    try {
      data = await api('/items?' + params);
    } catch (err) {
      if (mine === seq && !known) results.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    listCache.set(key, data);
    if (listCache.size > 30) listCache.delete(listCache.keys().next().value);
    if (mine !== seq) return;
    if (!known || JSON.stringify(known) !== JSON.stringify(data)) show(data);
  }
  function show(data) {
    $('.hero', root).classList.toggle('compact', !!(q || cat));
    $('#mode', root).textContent = q ? (data.mode === 'semantic' ? 'semantic search' : 'keyword search') : '';
    const cats = Object.entries(state.meta.categories).filter(([k]) => data.counts[k]);
    const all = Object.values(data.counts).reduce((a, b) => a + b, 0);
    const active = sort || (q ? '' : 'best');
    // The moderators' picks lead the unfiltered list and are not repeated below them.
    const featured = q || cat ? [] : data.items.filter((i) => i.featured).sort((a, b) => String(b.featured_at).localeCompare(String(a.featured_at))).slice(0, 3);
    results.innerHTML = `
      <div class="chips">
        <button class="chip ${cat ? '' : 'on'}" data-cat="">All<span class="n">${all}</span></button>
        ${cats.map(([k, label]) => `<button class="chip ${cat === k ? 'on' : ''}" data-cat="${k}">${esc(label)}<span class="n">${data.counts[k]}</span></button>`).join('')}
      </div>
      <div class="bar">
        <div class="tabs">${q ? `<button data-sort="" class="${active ? '' : 'on'}">Relevance</button>` : ''}${Object.entries(SORTS).map(([k, label]) => `<button data-sort="${k}" class="${active === k ? 'on' : ''}" title="${esc(SORT_HELP[k])}">${label}</button>`).join('')}</div>
        <span class="small muted">${q ? `${plural(data.items.length, 'result')} for “${esc(q)}”` : esc(SORT_HELP[active] || '')}</span>
      </div>
      ${featured.length ? `<h2 class="rowtitle">Featured by moderators</h2><div class="grid">${featured.map(card).join('')}</div><h2 class="rowtitle">More materials</h2>` : ''}
      ${data.items.length ? `<div class="grid">${data.items.filter((i) => !featured.includes(i)).map(card).join('')}</div>` : `<div class="empty"><h2>Nothing here yet</h2><p>${q ? 'No material matches that search.' : 'No materials in this category.'} If your group has one, <a href="/add">add it</a>.</p></div>`}`;
    watchPreviews(results);
    showSelected($('.chips', results));
  }
  results.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    const tab = e.target.closest('[data-sort]');
    if (chip) cat = chip.dataset.cat;
    else if (tab) sort = tab.dataset.sort;
    else return;
    load(true);
  });
  let timer;
  $('#q', root).addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = e.target.value.trim();
      if (!q && !['', 'hot', 'best', 'top', 'new'].includes(sort)) sort = '';
      load();
    }, 350);
  });
  await load();
  return () => clearTimeout(timer);
}

// A link such as /m/<slug>#brand={...}&edits={...} opens a template already in a group's look with new texts.
let cameWithLink = false;
function takeLinkCustomization() {
  if (!location.hash.includes('brand=') && !location.hash.includes('edits=')) return;
  cameWithLink = true;
  const p = new URLSearchParams(location.hash.slice(1));
  const parse = (v) => {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const brand = brandFromLink(parse(p.get('brand')));
  if (Object.keys(brand).length) setBrand(brand);
  const edits = parse(p.get('edits'));
  const slug = /^\/m\/([a-z0-9-]+)/.exec(location.pathname)?.[1];
  if (slug && edits && typeof edits === 'object') {
    const html = {};
    for (const [k, v] of Object.entries(edits)) if (typeof v === 'string') html[k] = esc(v.slice(0, 2000)).replace(/\n/g, '<br>');
    store.set(`commons_fork_${slug}`, { edits: { ...(store.get(`commons_fork_${slug}`, {}).edits || {}), ...html } });
  }
  history.replaceState({}, '', location.pathname + location.search);
}

// "Try it": the fastest way in. Opens Claude with a prompt that makes it interview the organizer about their event
// and what they already have, and then work from the commons. The prompt is also copied, in case it is not filled in.
export function tryItPrompt() {
  const o = location.origin;
  return [
    'I want help preparing the marketing for an event my student group is running. Work like this:',
    '1. Interview me first, one question at a time: what the event is, date, time and place, who it is for, my group (name, university, city, colours, fonts, website, sign-up link), which channels we use, and what we already have (flyers, texts, photos, a logo). Skip what you already know about us.',
    `2. Then use the Groups Commons, a library of materials that other AI safety student groups wrote, designed and used at real events: ${o} . If you have its connector (an MCP server at ${o}/mcp), use that. Otherwise read ${o}/llms.txt to see how to search it.`,
    '3. Give me a marketing to-do list with dates counting back from the event, the texts for each channel adapted from what you found (keep the original wording where it fits), and for posters, slides and Instagram posts a link that opens the template in our look.',
    'Start with your first question.',
  ].join('\n');
}
for (const a of $$('[data-tryit]')) a.setAttribute('href', `https://claude.ai/new?q=${encodeURIComponent(tryItPrompt())}`);
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-tryit]')) return;
  navigator.clipboard?.writeText(tryItPrompt()).catch(() => {});
});

// The intro: a short video of the main way to use the commons, with music. Shown once, on the first visit.
// byVisitor: the visitor asked for it with a click, so it may play with sound. When it opens by itself, browsers
// only allow muted playback: then a "Sound on" button sits on the video.
function openIntro(byVisitor = false) {
  const dialog = $('#intro');
  const video = $('video', dialog);
  const soundBtn = $('#intro-sound');
  if (!video.getAttribute('src')) {
    // A copy of the site without the video file (it is not in the public repository) shows the text alone.
    video.addEventListener('error', () => { video.hidden = true; soundBtn.hidden = true; }, { once: true });
    video.addEventListener('volumechange', () => { soundBtn.hidden = !video.muted || video.hidden; });
    soundBtn.addEventListener('click', () => {
      video.muted = false;
      video.currentTime = 0;
      video.play().catch(() => {});
    });
    video.setAttribute('poster', '/assets/intro-poster.jpg');
    video.setAttribute('src', '/assets/intro.mp4');
  }
  if (!dialog.open) dialog.showModal();
  video.muted = !byVisitor;
  soundBtn.hidden = !video.muted || video.hidden;
  // Safari starts a video reliably only once it has something to play: begin at the start when it is loaded,
  // and try again as soon as the first frames are there.
  if (video.readyState > 0) video.currentTime = 0;
  const start = () => {
    if (!dialog.open || !video.paused) return;
    video.play().catch(() => {
      // Not allowed with sound after all (no click the browser counts): play muted and offer the button.
      if (video.muted) return;
      video.muted = true;
      video.play().catch(() => {});
    });
  };
  video.addEventListener('canplay', start, { once: true });
  if (video.readyState === 0) video.load();
  start();
}
$('#intro').addEventListener('close', () => $('#intro video').pause());
$('#intro').addEventListener('click', (e) => {
  if (e.target.id === 'intro' || e.target.closest('[data-close-intro]')) $('#intro').close();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-intro]')) return;
  e.preventDefault();
  openIntro(true);
});

// ---- start ----
Promise.all([api('/meta').catch(() => ({ categories: {} })), api('/me/votes').catch(() => ({})), loadBrandData()]).then(([meta, votes]) => {
  takeLinkCustomization();
  state.meta = meta;
  state.votes = votes;
  render();
  // Someone who arrives through a link from Claude came for their material, not for the intro.
  if (!store.get('commons_intro_seen', false) && !cameWithLink && !location.pathname.startsWith('/m/')) {
    store.set('commons_intro_seen', true);
    openIntro();
  }
});
