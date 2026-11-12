// Text templates: [Placeholders] become a fill-in form; docs are rendered from a small, safe Markdown subset.

import { store } from './api.js';
import { getBrand } from './brand.js';
import { $, $$, copy, countUse, download, esc } from './ui.js';

const PH = /\[([A-Za-zÀ-ÿ][^\]\n]{1,199})\](?!\()/g;
const BRAND_FILL = {
  'group name': 'group_name', 'your group': 'group_name', university: 'university', city: 'city', website: 'website',
  'contact email': 'email', 'join link': 'join_url', 'your name': 'your_name', instagram: 'instagram', tagline: 'tagline',
};

export function placeholders(text) {
  const seen = new Map();
  for (const m of String(text || '').matchAll(PH)) if (!seen.has(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), m[1]);
  return [...seen.values()];
}
const fill = (text, values) => String(text || '').replace(PH, (all, name) => values[name.toLowerCase()] || all);

// Fills a text in one step from the brand kit plus the given values (keys in lower case), for ready-to-send messages.
// A placeholder that ends with "?" is optional: when there is no value for it, its whole line is left out.
export function quickFill(text, extra = {}) {
  const brand = getBrand();
  const value = (name) => {
    const k = name.toLowerCase().replace(/\?$/, '');
    return extra[k] || (BRAND_FILL[k] ? brand[BRAND_FILL[k]] : '') || '';
  };
  return String(text || '')
    .split('\n')
    .filter((line) => ![...line.matchAll(PH)].some((m) => m[1].endsWith('?') && !value(m[1])))
    .map((line) => line.replace(PH, (all, name) => value(name) || all))
    .join('\n');
}

// Escaped HTML with filled values and open placeholders highlighted.
function highlighted(text, values) {
  let out = '';
  let last = 0;
  const s = String(text || '');
  for (const m of s.matchAll(PH)) {
    out += esc(s.slice(last, m.index));
    const v = values[m[1].toLowerCase()];
    out += v ? `<span class="filled">${esc(v)}</span>` : `<mark class="ph">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// ---- Markdown (headings, lists, task lists, tables, quotes, code, bold/italic, links) ----
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(PH, '<mark class="ph">[$1]</mark>');
}
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isBlockStart = (l) => /^(#{1,4}\s|>|```|\|)/.test(l) || LIST.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l);
function list(lines, start, indent) {
  const ordered = /\d/.test(LIST.exec(lines[start])[2]);
  let html = ordered ? '<ol>' : '<ul>';
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent + 1) {
      const sub = list(lines, i, m[1].length);
      html = html.replace(/<\/li>$/, '') + sub.html + '</li>';
      i = sub.next;
      continue;
    }
    let text = m[3];
    i++;
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && /^\s{2,}/.test(lines[i])) text += ' ' + lines[i++].trim();
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    html += task ? `<li class="task"><label><input type="checkbox"${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}</label></li>` : `<li>${inline(text)}</li>`;
  }
  return { html: html + (ordered ? '</ol>' : '</ul>'), next: i };
}
export function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,4}\s/.test(line)) {
      const m = /^(#{1,4})\s+(.*?)\s*#*$/.exec(line);
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (line.startsWith('|') && /^\|?[\s:|-]+$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      let t = '<table><thead><tr>' + cells(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) t += '<tr>' + cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      out.push(t + '</tbody></table>');
    } else if (line.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
    } else if (LIST.test(line)) {
      const l = list(lines, i, LIST.exec(line)[1].length);
      out.push(l.html);
      i = l.next;
    } else {
      const p = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) p.push(lines[i++]);
      out.push(`<p>${p.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

// ---- the fill-in tool ----
const CHANNEL = { email: 'Email', whatsapp: 'WhatsApp', slack: 'Slack', instagram: 'Instagram caption', doc: 'Document' };

// variants: [{ label, channel, lang, subject, body }]
export function textTool(root, variants, slug) {
  const brand = getBrand();
  const key = `commons_fill_${slug}`;
  const typed = store.get(key, {});
  let active = 0;
  const valuesFor = (names) => {
    const v = {};
    for (const n of names) {
      const k = n.toLowerCase();
      v[k] = typed[k] ?? (BRAND_FILL[k] ? brand[BRAND_FILL[k]] : '') ?? '';
    }
    return v;
  };

  function render() {
    const v = variants[active];
    const names = placeholders(`${v.subject || ''}\n${v.body}`);
    const values = valuesFor(names);
    const isDoc = v.channel === 'doc';
    root.innerHTML = `
      ${variants.length > 1 ? `<div class="tabs" style="margin-bottom:14px;flex-wrap:wrap">${variants.map((x, i) => `<button type="button" data-variant="${i}" class="${i === active ? 'on' : ''}">${esc(x.label)}</button>`).join('')}</div>` : ''}
      <div class="texttool">
        <div class="fields">
          ${names.length ? `<p class="small muted">Fill in the blanks. Fields we know from your <a href="/brand">brand kit</a> are filled in already.</p>` : '<p class="small muted">Nothing to fill in: this text is ready to use.</p>'}
          ${names.map((n) => `<label>${esc(n)}<input data-ph="${esc(n.toLowerCase())}" value="${esc(values[n.toLowerCase()])}" placeholder="${esc(n)}"></label>`).join('')}
        </div>
        <div>
          <div class="row" style="margin-bottom:10px">
            <span class="badge kind">${esc(CHANNEL[v.channel] || v.channel)}</span><span class="badge">${esc((v.lang || 'en').toUpperCase())}</span>
            <span style="flex:1"></span>
            <button type="button" class="btn small primary" data-act="copy">${isDoc ? 'Copy Markdown' : 'Copy text'}</button>
            ${v.channel === 'email' ? '<button type="button" class="btn small" data-act="mail">Open in mail app</button>' : ''}
            ${v.channel === 'whatsapp' ? '<button type="button" class="btn small" data-act="wa">Open in WhatsApp</button>' : ''}
            ${isDoc ? '<button type="button" class="btn small" data-act="md">Download .md</button>' : ''}
          </div>
          <div class="msg ${isDoc ? 'doc md' : v.channel === 'email' ? '' : 'chat'}" data-out></div>
        </div>
      </div>`;
    paint();
  }
  function current() {
    const v = variants[active];
    const values = {};
    for (const input of $$('[data-ph]', root)) values[input.dataset.ph] = input.value.trim();
    return { v, values, subject: fill(v.subject, values), body: fill(v.body, values) };
  }
  function paint() {
    const { v, values, body } = current();
    $('[data-out]', root).innerHTML = v.channel === 'doc' ? md(body) : `${v.subject ? `<div class="subject">${highlighted(v.subject, values)}</div>` : ''}${highlighted(v.body, values)}`;
  }
  root.addEventListener('input', (e) => {
    if (!e.target.dataset.ph) return;
    typed[e.target.dataset.ph] = e.target.value;
    store.set(key, typed);
    paint();
  });
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-variant]');
    if (tab) {
      active = Number(tab.dataset.variant);
      return render();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const { v, subject, body } = current();
    countUse(slug);
    if (act === 'copy') copy(v.subject && v.channel === 'email' ? `Subject: ${subject}\n\n${body}` : body);
    if (act === 'mail') location.href = `mailto:?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body)}`;
    if (act === 'wa') window.open(`https://wa.me/?text=${encodeURIComponent(body)}`, '_blank', 'noopener');
    if (act === 'md') download(`${slug}.md`, body, 'text/markdown');
  });
  render();
}
