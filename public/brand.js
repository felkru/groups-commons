// The brand kit: one group's colour, fonts, logos and standard texts. Stored in the browser; every template
// and text template on the site is filled in from it.

import { api, store } from './api.js';

export const DEFAULT_BRAND = {
  group_name: 'AI Safety Aachen',
  tagline: "Let's make sure AI development happens safely",
  university: 'RWTH Aachen University',
  city: 'Aachen',
  website: 'aisafetyaachen.org',
  email: 'aisafetyaachen@gmail.com',
  join_url: 'aisafetyaachen.org',
  survey_url: '',
  instagram: '',
  your_name: '',
  color: '#8391f6',
  accent: '#481b5d',
  dark: '#252627',
  light: '#fefee0',
  font_heading: 'Hanken Grotesk',
  font_body: 'Vollkorn',
  logo_square: '',
  logo_wide: '',
  logo_square_light: '',
  logo_wide_light: '',
};
export const BRAND_TEXT_KEYS = ['group_name', 'tagline', 'university', 'city', 'website', 'email', 'join_url', 'survey_url', 'instagram'];

export const FONTS = {
  Vollkorn: 'serif', Newsreader: 'serif', Fraunces: 'serif', 'Playfair Display': 'serif', Lora: 'serif', 'Source Serif 4': 'serif',
  Merriweather: 'serif', 'Libre Baskerville': 'serif', 'DM Serif Display': 'serif', Bitter: 'serif',
  'Hanken Grotesk': 'sans', Inter: 'sans', 'Space Grotesk': 'sans', Sora: 'sans', Archivo: 'sans', 'Bricolage Grotesque': 'sans',
  Montserrat: 'sans', Poppins: 'sans', 'IBM Plex Sans': 'sans', 'Work Sans': 'sans', Manrope: 'sans', 'DM Sans': 'sans', Outfit: 'sans',
};
const PAIRS = [
  ['Vollkorn', 'Hanken Grotesk'], ['Fraunces', 'Inter'], ['Playfair Display', 'Work Sans'], ['Space Grotesk', 'Inter'], ['Newsreader', 'DM Sans'],
  ['Sora', 'Manrope'], ['Bricolage Grotesque', 'IBM Plex Sans'], ['Lora', 'Montserrat'], ['Archivo', 'Source Serif 4'], ['DM Serif Display', 'Outfit'],
  ['Bitter', 'Poppins'], ['Montserrat', 'Merriweather'],
];

// All Google Fonts (family -> serif | sans | display | hand | mono) and the example brand kits of real groups.
export let PRESETS = [];
export async function loadBrandData() {
  const get = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [fonts, presets] = await Promise.all([get('/vendor/google-fonts.json'), get('/brand-presets.json')]);
  if (Array.isArray(fonts)) for (const [family, kind] of fonts) FONTS[family] ??= kind;
  if (Array.isArray(presets)) PRESETS = presets.filter((p) => p && p.id && p.group_name);
  if (Array.isArray(presets)) refreshPreset();
}
// A visitor who picked an example kit earlier gets that kit as it is now (its logos and values may have changed).
// If the kit no longer exists, their own kit comes back.
function refreshPreset() {
  const id = store.get('commons_brand_preset', '');
  if (!id) return;
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    if (store.get('commons_brand_own', null)) restoreOwnBrand();
    else { store.del('commons_brand_preset'); store.del('commons_brand'); }
    return;
  }
  const now = getBrand();
  const fresh = presetBrand(preset);
  if (Object.keys(fresh).some((k) => fresh[k] !== now[k])) setBrand(fresh, true);
}
export const findFont = (name) => Object.keys(FONTS).find((f) => f.toLowerCase() === String(name || '').trim().toLowerCase());

// The whole kit of an example group: its texts, colours, fonts and its own logo files (addresses on this site).
const PRESET_LOGO = /^\/assets\/presets\/[\w.-]+$/;
function presetBrand(preset) {
  const next = { ...DEFAULT_BRAND };
  for (const k of [...BRAND_TEXT_KEYS, 'color', 'accent', 'dark', 'light']) if (typeof preset[k] === 'string') next[k] = preset[k];
  next.join_url = preset.join_url || preset.website || '';
  next.email = preset.email || '';
  next.font_heading = findFont(preset.font_heading) || DEFAULT_BRAND.font_heading;
  next.font_body = findFont(preset.font_body) || DEFAULT_BRAND.font_body;
  const logos = preset.logos && typeof preset.logos === 'object' ? preset.logos : {};
  for (const kind of ['square', 'wide', 'square_light', 'wide_light']) next[`logo_${kind}`] = PRESET_LOGO.test(logos[kind] || '') ? logos[kind] : '';
  return next;
}
// Switch to an example kit. The visitor's own kit is kept aside and can be put back.
export function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return getBrand();
  const current = store.get('commons_brand', {});
  if (!store.get('commons_brand_preset', '') && Object.keys(current).length) store.set('commons_brand_own', current);
  store.set('commons_brand_preset', id);
  return setBrand(presetBrand(preset), true);
}
export function restoreOwnBrand() {
  const own = store.get('commons_brand_own', null);
  store.del('commons_brand_preset');
  if (!own) return getBrand();
  store.set('commons_brand', own);
  store.del('commons_brand_own');
  return getBrand();
}
export const activePreset = () => store.get('commons_brand_preset', '') || (Object.keys(store.get('commons_brand', {})).length ? '' : 'aachen');
export const hasOwnBrand = () => !!store.get('commons_brand_own', null);

export function getBrand() {
  const brand = { ...DEFAULT_BRAND, ...store.get('commons_brand', {}) };
  // An example kit's logo file that is no longer on the site (the kit was replaced) is dropped, not shown broken.
  if (PRESETS.length) {
    const known = new Set(PRESETS.flatMap((p) => Object.values(p.logos || {})));
    for (const k of ['logo_square', 'logo_wide', 'logo_square_light', 'logo_wide_light']) if (PRESET_LOGO.test(brand[k]) && !known.has(brand[k])) brand[k] = '';
  }
  return brand;
}
// Leaving the example group: its own details (email, website, tagline, …) must not travel along under another
// group's name. They are emptied unless the change brings its own values.
const EXAMPLE_DETAILS = ['tagline', 'university', 'city', 'website', 'email', 'join_url'];
function withoutExampleDetails(patch) {
  const now = getBrand();
  if (!isDefaultBrand(now) || !patch.group_name || patch.group_name === DEFAULT_BRAND.group_name) return patch;
  const out = { ...patch };
  for (const k of EXAMPLE_DETAILS) if (!(k in out) && now[k] === DEFAULT_BRAND[k]) out[k] = '';
  return out;
}
export function setBrand(patch, fromPreset = false) {
  // Editing a kit by hand makes it the visitor's own kit.
  if (!fromPreset) {
    store.del('commons_brand_preset');
    patch = withoutExampleDetails(patch);
  }
  const next = { ...getBrand(), ...patch };
  const diff = {};
  for (const k of Object.keys(DEFAULT_BRAND)) if (next[k] !== DEFAULT_BRAND[k]) diff[k] = next[k];
  store.set('commons_brand', diff);
  syncBrand();
  return next;
}
export function resetBrand() {
  store.del('commons_brand');
  syncBrand();
}
// When signed in, the brand kit is saved to the account a moment after the last change.
let syncTimer;
function syncBrand() {
  if (!store.get('commons_session', '')) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => api('/me/brand', { method: 'PUT', body: getBrand() }).catch(() => {}), 1500);
}
export const isDefaultBrand = (b) => b.group_name === DEFAULT_BRAND.group_name;

// ---- colour maths ----
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt(m ? m[1] : '888888', 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// Text colour that reads best on a surface: white unless the brand's dark tone has clearly more contrast.
export const onColor = (surface, dark) => (contrast(surface, '#ffffff') >= 3 || contrast(surface, '#ffffff') >= contrast(surface, dark) ? '#ffffff' : dark);
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// A brand kit that arrives in a link (from an assistant): only known text, colour and font fields are accepted.
export function brandFromLink(input) {
  const patch = {};
  if (!input || typeof input !== 'object') return patch;
  for (const k of [...BRAND_TEXT_KEYS, 'your_name']) if (typeof input[k] === 'string') patch[k] = input[k].slice(0, 200);
  for (const k of ['color', 'accent', 'dark', 'light']) if (/^#[0-9a-f]{6}$/i.test(input[k] || '')) patch[k] = input[k].toLowerCase();
  if (findFont(input.font_heading)) patch.font_heading = findFont(input.font_heading);
  if (findFont(input.font_body)) patch.font_body = findFont(input.font_body);
  if (patch.color && !patch.dark && !patch.light) Object.assign(patch, { dark: paletteFrom(patch.color).dark, light: paletteFrom(patch.color).light }, patch.accent ? {} : { accent: paletteFrom(patch.color).accent });
  // A new group name without logos must not keep another group's uploaded logos.
  if (patch.group_name && patch.group_name !== getBrand().group_name) Object.assign(patch, { logo_square: '', logo_wide: '', logo_square_light: '', logo_wide_light: '' });
  return patch;
}

const FALLBACK = { serif: 'Georgia, serif', mono: 'ui-monospace, Menlo, monospace', hand: 'cursive', display: 'system-ui, sans-serif', sans: 'system-ui, sans-serif' };
export const fontCss = (name) => `'${name}', ${FALLBACK[FONTS[name]] || FALLBACK.sans}`;
export function fontsUrl(brand) {
  const fam = [...new Set([brand.font_heading, brand.font_body])].map((f) => `${f.replace(/ /g, '+')}:400,500,600,700,800`).join('|');
  return `https://fonts.googleapis.com/css?family=${fam}&display=swap`;
}
// A value the group has not chosen (it still equals the starting kit's) is not forced onto a template: templates
// then keep the colours and fonts they were printed in (the roll-up banner dark blue, the flyer's serif titles
// and white text on violet). Everything a group did choose, or an example kit sets, is applied.
export const BRAND_VAR_NAMES = ['--brand-color', '--brand-accent', '--brand-dark', '--brand-light', '--brand-on-color', '--brand-on-accent', '--brand-font-heading', '--brand-font-body'];
export function brandVars(brand) {
  const vars = allBrandVars(brand);
  const same = (k) => brand[k] === DEFAULT_BRAND[k];
  if (same('font_heading') && same('font_body')) {
    delete vars['--brand-font-heading'];
    delete vars['--brand-font-body'];
  }
  for (const k of ['color', 'accent', 'dark', 'light']) if (same(k)) delete vars[`--brand-${k}`];
  if (same('color') && same('dark')) delete vars['--brand-on-color'];
  if (same('accent') && same('dark')) delete vars['--brand-on-accent'];
  return vars;
}
function allBrandVars(brand) {
  return {
    '--brand-color': brand.color,
    '--brand-accent': brand.accent,
    '--brand-dark': brand.dark,
    '--brand-light': brand.light,
    '--brand-on-color': onColor(brand.color, brand.dark),
    '--brand-on-accent': onColor(brand.accent, brand.dark),
    '--brand-font-heading': fontCss(brand.font_heading),
    '--brand-font-body': fontCss(brand.font_body),
  };
}

// ---- generator: a palette and a font pairing from one hue ----
export function suggestBrand(n = Math.floor(Math.random() * 1e6)) {
  const hue = (n * 47) % 360;
  const sat = 52 + (n % 5) * 6;
  const offsets = [150, 180, 205, 35, -35, 120];
  const pair = PAIRS[n % PAIRS.length];
  return {
    color: hsl(hue, sat, 48 + (n % 3) * 5),
    accent: hsl(hue + offsets[n % offsets.length], 55, 55),
    dark: hsl(hue, 22, 13),
    light: hsl(hue + 30, 70, 96),
    font_heading: pair[0],
    font_body: pair[1],
  };
}
export function paletteFrom(color) {
  const [r, g, b] = rgb(color).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { color, accent: hsl(h + 165, 55, 55), dark: hsl(h, 22, 13), light: hsl(h + 30, 70, 96) };
}

// ---- generated monogram logos (used until the group uploads its own) ----
const svgUri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The short name groups go by: "Cambridge AI Safety Hub" is CAISH, "AI Safety Aachen" is AISA. A short name the
// group writes in brackets wins ("AI Safety Team (AIST)"); short all-capital words (AI, UC, NTU) are kept whole.
export function initials(name) {
  const given = String(name || '').match(/\(([\p{Lu}\p{N}]{2,6})\)/u);
  if (given) return given[1];
  const words = String(name || 'Group').split(/[\s/–-]+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const caps = words.filter((w) => /^[\p{Lu}\p{N}]/u.test(w));
  const used = caps.length >= 2 ? caps : words;
  const whole = used.map((w) => (/^[\p{Lu}\p{N}]{2,3}$/u.test(w) ? w : [...w][0].toUpperCase())).join('');
  return (whole.length <= 6 ? whole : used.map((w) => [...w][0].toUpperCase()).join('').slice(0, 5)) || 'G';
}
// The group's name next to a mark. A long name is set on two lines, so that the logo does not become a thin strip.
function besideName(name, fill) {
  const text = String(name || 'Your group').trim();
  let lines = [text];
  if (text.length > 26 && text.includes(' ')) {
    const spaces = [...text.matchAll(/ /g)].map((m) => m.index);
    const cut = spaces.reduce((best, i) => (Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2) ? i : best), spaces[0]);
    lines = [text.slice(0, cut), text.slice(cut + 1)];
  }
  const size = lines.length > 1 ? 62 : 78;
  const width = 250 + Math.round(Math.max(...lines.map((l) => l.length)) * size * 0.565);
  const y = lines.length > 1 ? [88, 160] : [126];
  return { width, markup: lines.map((l, i) => `<text x="236" y="${y[i]}" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${size}" fill="${fill}">${xml(l)}</text>`).join('') };
}
export function monogram(brand, kind, light = false) {
  const text = initials(brand.group_name);
  const fill = light ? '#ffffff' : brand.color;
  const ink = light ? brand.color : onColor(brand.color, brand.dark);
  const size = [96, 96, 96, 78, 62, 50, 42][text.length] || 42;
  const mark = `<rect width="200" height="200" rx="44" fill="${fill}"/><text x="100" y="${100 + size * 0.35}" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${size}" text-anchor="middle" fill="${ink}">${xml(text)}</text>`;
  if (kind === 'square') return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${mark}</svg>`);
  const name = besideName(brand.group_name, light ? '#ffffff' : brand.dark);
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${name.width} 200">${mark}${name.markup}</svg>`);
}
// A generated logo mark (SVG drawn in #111111 and #eeeeee) in the brand's colours, alone or next to the group name.
export function logoFromMark(svg, brand, kind, light = false) {
  const main = light ? '#ffffff' : brand.color;
  const detail = light ? brand.color : onColor(brand.color, brand.dark);
  const mark = String(svg).replace(/#111111/gi, main).replace(/#eeeeee/gi, detail);
  if (kind === 'square') return svgUri(mark);
  const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
  const name = besideName(brand.group_name, light ? '#ffffff' : brand.dark);
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${name.width} 200"><svg x="0" y="0" width="200" height="200" viewBox="0 0 200 200">${inner}</svg>${name.markup}</svg>`);
}

// The logo a template should show, or null to keep the template's own default file.
export function logoFor(brand, kind, onDark) {
  const own = (onDark && brand[`logo_${kind}_light`]) || brand[`logo_${kind}`];
  if (own) return own;
  if (isDefaultBrand(brand)) return null;
  return monogram(brand, kind, onDark);
}

export function qrDataUri(value) {
  let text = String(value || '').trim();
  if (!text || !window.qrcode) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return svgUri(qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }));
}
