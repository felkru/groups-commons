// The group details a setup script may carry into an agent's memory. Shared by the website (to show what will be
// written) and the server (which checks every value again, because anyone can craft a setup address). No imports,
// so both sides can load it; each side passes in its own way of looking up a font name.
//
// The rules are deliberately narrow: a value that does not pass is left out, never repaired.

const NAME = /^[\p{L}\p{M}\p{N} .,&'()-]{1,60}$/u; // letters (any alphabet, with accents), digits, space and . , & ' ( ) -
const COLOR = /^#?[0-9a-f]{6}$/i;
const LINK = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?(\/[a-z0-9._~/?#=&%+@:,;!-]*)?$/i; // a web address, no spaces or quotes

const name = (v) => {
  const s = v.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  return NAME.test(s) && /[\p{L}\p{N}]/u.test(s) ? s : null;
};
const color = (v) => (COLOR.test(v.trim()) ? '#' + v.trim().replace(/^#/, '').toLowerCase() : null);
const link = (v) => (v.trim().length <= 120 && LINK.test(v.trim()) ? v.trim() : null);

// field -> [label for people, check]
export const GROUP_FIELDS = {
  group: ['group name', name],
  university: ['university', name],
  city: ['city', name],
  color: ['main colour', color],
  accent: ['accent colour', color],
  font_heading: ['heading font', 'font'],
  font_body: ['body font', 'font'],
  website: ['website', link],
  join: ['sign-up link', link],
};

// Returns { details: { field: clean value }, dropped: [field, ...] }. Only plain strings are looked at.
// findFont(name) answers the proper spelling of a known Google Font, or nothing.
export function cleanGroupDetails(input, findFont) {
  const font = (v) => (typeof findFont === 'function' && findFont(v.trim())) || null;
  const details = {};
  const dropped = [];
  for (const [key, [, check]] of Object.entries(GROUP_FIELDS)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const clean = typeof raw === 'string' && raw.length <= 400 ? (check === 'font' ? font : check)(raw) : null;
    if (clean) details[key] = clean;
    else dropped.push(key);
  }
  return { details, dropped };
}

// The memory text, always in this sentence pattern. Nothing else from the address ends up in it.
export function memoryText(details, origin) {
  const d = details || {};
  const lines = [];
  const where = [d.university ? `at ${d.university}` : '', d.city ? `in ${d.city}` : ''].filter(Boolean).join(' ');
  if (d.group) lines.push(`Our group: ${d.group}${where ? `, a student group ${where}` : ''}.`);
  else if (where) lines.push(`Our group is a student group ${where}.`);
  const brand = [d.color && `main colour ${d.color}`, d.accent && `accent ${d.accent}`, d.font_heading && `heading font ${d.font_heading}`, d.font_body && `body font ${d.font_body}`].filter(Boolean);
  if (brand.length) lines.push(`Brand: ${brand.join(', ')}.`);
  if (d.website) lines.push(`Website: ${d.website}`);
  if (d.join) lines.push(`Sign-up link (QR codes point here): ${d.join}`);
  if (!lines.length) return '';
  lines.push(`When we need outreach, event or group-admin material, search the Groups Commons (${origin}) first and adapt what other groups already made to this brand.`);
  return ['## Our student group', ...lines].join('\n');
}
