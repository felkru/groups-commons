// Small shared helpers for the pages.

import { api } from './api.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// currentItem: the material whose page is open, or null. The "Set up my AI" dialog offers a prompt for it.
export const state = { meta: { categories: {} }, votes: {}, currentItem: null };

export const KIND = { file: 'File', template: 'Customizable template', text: 'Text template', link: 'Link', kit: 'Kit', supplier: 'Supplier' };
export const SOURCE = {
  original: ['Shared as used', 'The group shared this the way they used it.'],
  adapted: ['Adapted', 'Rebuilt from the group’s own material so that other groups can re-brand it.'],
  synthesized: ['Synthesized', 'Written from the group’s internal material with names, amounts and private details removed.'],
};

let toastTimer;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(done);
  }
}

export function download(name, data, type = 'text/plain') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function timeAgo(iso) {
  const days = Math.max(0, (Date.now() - Date.parse(iso)) / 864e5);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${Math.floor(days)} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30.4)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const todo = (label = 'not implemented yet') => `<span class="badge todo">${esc(label)}</span>`;
export const cmd = (text) => `<pre class="cmd"><button type="button" data-copy="${esc(text)}">Copy</button><code>${esc(text)}</code></pre>`;

// ---- votes (one per visitor per material; clicking the same arrow again takes the vote back) ----
const ARROW_UP = '<svg viewBox="0 0 20 20"><path d="M10 4l7 9H3z"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 20 20"><path d="M10 16l7-9H3z"/></svg>';
export function voteBox(item, wide = false) {
  const my = state.votes[item.slug] || 0;
  if (item.status && item.status !== 'published') return `<div class="vote ${wide ? 'wide' : ''}" title="Voting opens once this material is published" aria-hidden="true"></div>`;
  return `<div class="vote ${wide ? 'wide' : ''} ${my === 1 ? 'up' : my === -1 ? 'down' : ''}" data-votebox="${esc(item.slug)}" data-base="${item.score - my}">
    <button type="button" class="u" data-vote="1" title="Upvote: this is useful" aria-label="Upvote">${ARROW_UP}</button>
    <span class="score" title="${item.up || 0} up, ${item.down || 0} down">${item.score}</span>
    <button type="button" class="d" data-vote="-1" title="Downvote" aria-label="Downvote">${ARROW_DOWN}</button>
  </div>`;
}
function paintVotes(slug, my, score) {
  for (const box of $$(`[data-votebox="${CSS.escape(slug)}"]`)) {
    box.classList.toggle('up', my === 1);
    box.classList.toggle('down', my === -1);
    $('.score', box).textContent = score ?? Number(box.dataset.base) + my;
  }
}
document.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) return copy(copyBtn.dataset.copy);
  const btn = e.target.closest('[data-vote]');
  if (!btn) return;
  e.preventDefault();
  const box = btn.closest('[data-votebox]');
  const slug = box.dataset.votebox;
  const dir = Number(btn.dataset.vote);
  const next = state.votes[slug] === dir ? 0 : dir;
  const before = state.votes[slug] || 0;
  state.votes[slug] = next;
  paintVotes(slug, next);
  try {
    const r = await api(`/items/${slug}/vote`, { method: 'POST', body: { dir: next } });
    for (const b of $$(`[data-votebox="${CSS.escape(slug)}"]`)) b.dataset.base = r.score - r.my;
    paintVotes(slug, r.my, r.score);
  } catch (err) {
    state.votes[slug] = before;
    paintVotes(slug, before);
    toast(err.message);
  }
});

export const countUse = (slug) => api(`/items/${slug}/use`, { method: 'POST' }).catch(() => {});
