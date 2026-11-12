// Hosted setup scripts: GET /setup.sh (macOS, Linux, WSL) and GET /setup.ps1 (Windows PowerShell), written per
// request from the answers of the "Set up my AI" questionnaire on the website. Also /llms.txt.
//
//   curl -fsSL '<site>/setup.sh?agent=claude-code&install=1&cli=1&skill=1' | bash
//   irm '<site>/setup.ps1?agent=codex' | iex
//
// Anyone can craft such an address and send it to someone else, so nothing from the query string is ever placed
// into the script as text:
//   - agent, install, cli and skill only switch fixed lines on or off;
//   - group details are checked against narrow rules (public/setup-fields.js; fonts against the list of Google
//     Fonts the brand kit offers), anything else is dropped;
//   - the memory text is composed here, in a fixed sentence pattern, and travels as base64 that the script
//     decodes at run time, shows to the person and writes only after a yes.
// The only other variable part is this site's own address, which must look like a plain http(s) origin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_FIELDS, cleanGroupDetails, memoryText } from '../public/setup-fields.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = { sh: fs.readFileSync(path.join(HERE, 'setup.sh.tmpl'), 'utf8'), ps1: fs.readFileSync(path.join(HERE, 'setup.ps1.tmpl'), 'utf8') };
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]{1,200}(:\d{1,5})?$/;
const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex' };

// The fonts a brand kit can use: the same file the website loads. lower-case name -> proper spelling.
const FONTS = new Map();
try {
  for (const [family] of JSON.parse(fs.readFileSync(path.join(HERE, '..', 'public', 'vendor', 'google-fonts.json'), 'utf8'))) {
    if (typeof family === 'string' && /^[A-Za-z0-9 ]{1,60}$/.test(family)) FONTS.set(family.toLowerCase(), family);
  }
} catch (err) {
  console.warn('setup scripts: no font list, font names will be left out:', err.message);
}
const findFont = (name) => FONTS.get(String(name).toLowerCase());

const on = (v) => v === '1' || v === 'true';

// The answers in a query string, reduced to what the scripts understand.
export function readAnswers(query) {
  const q = query && typeof query === 'object' ? query : {};
  const named = typeof q.agent === 'string' ? q.agent.split(',').map((a) => a.trim().toLowerCase()) : [];
  let agents = Object.keys(AGENTS).filter((a) => named.includes(a));
  const assumed = !agents.length;
  if (assumed) agents = ['claude-code'];
  const { details, dropped } = cleanGroupDetails(q, findFont);
  return { agents, assumed, install: on(q.install), cli: on(q.cli), skill: on(q.skill) && agents.includes('claude-code'), details, dropped };
}

// The comment lines that tell a reader what this copy was asked to do. Built from fixed words only.
function requestLines(a) {
  const yes = (b) => (b ? 'yes' : 'no');
  const given = Object.keys(a.details).map((k) => GROUP_FIELDS[k][0]);
  const lines = [
    `Agent:                              ${a.agents.map((k) => AGENTS[k]).join(' and ')}${a.assumed ? ' (no agent was named in the address, so this is the default)' : ''}`,
    `Install the agent if it is missing: ${yes(a.install)}`,
    `Claude Code skill:                  ${yes(a.skill)}`,
    `"commons" command line tool:        ${yes(a.cli)}`,
    `Group details for its memory:       ${given.length ? `${given.join(', ')} (shown to you before anything is saved)` : 'none'}`,
  ];
  if (a.dropped.length) lines.push(`Left out, did not pass the check:   ${a.dropped.map((k) => GROUP_FIELDS[k][0]).join(', ')}`);
  return lines.map((l) => `#   ${l}`).join('\n');
}

function fill(template, values) {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`__${key}__`, () => value);
  if (/__[A-Z_]+__/.test(out)) throw new Error('setup template has an unfilled placeholder');
  return out;
}

// kind: 'sh' | 'ps1'. origin: this site's own address. Throws when the address is not a plain origin.
export function setupScript(kind, query, origin) {
  const site = String(origin || '').replace(/\/+$/, '');
  if (!ORIGIN.test(site)) throw Object.assign(new Error('The setup script is not available under this address.'), { status: 400 });
  const a = readAnswers(query);
  const memory = memoryText(a.details, site);
  const flag = kind === 'ps1' ? (b) => (b ? '$true' : '$false') : (b) => (b ? '1' : '0');
  return fill(TEMPLATES[kind], {
    COMMONS_URL: site,
    REQUEST: requestLines(a),
    WANT_CLAUDE: flag(a.agents.includes('claude-code')),
    WANT_CODEX: flag(a.agents.includes('codex')),
    INSTALL_AGENT: flag(a.install),
    INSTALL_SKILL: flag(a.skill),
    INSTALL_CLI: flag(a.cli),
    MEMORY_B64: memory ? Buffer.from(memory, 'utf8').toString('base64') : '',
  });
}

// A short description for assistants that can open web pages.
export function llmsTxt(origin) {
  return `# Groups Commons

> A shared library of organizing materials made by AI safety university groups: intro-talk slides, flyers,
> posters, Instagram posts, email / WhatsApp / Slack templates, tabling and event kits, runsheets, surveys,
> supplier notes, website templates and demos. Organizers take what another group already made, re-brand it and
> share their version back. Before writing or designing such material from scratch, look here first.
> This is a prototype; votes and use counts on the first materials are simulated.

## Best way in: MCP
MCP server (streamable HTTP, no login): ${origin}/mcp
Tools: search_materials, get_material, customize_template, get_template_html, share_material.
Setup for people (Claude app, Claude Code, Codex, other assistants): ${origin}/cli

## Public JSON, no login
- ${origin}/api/items?q=<what the organizer needs, in plain words>
  Search. Optional: category=<id>, kind=file|template|text|link|kit|supplier, sort=best|hot|top|new.
  Without q it lists everything. Answers { items: [{ slug, title, kind, category, summary, group, ... }] }.
- ${origin}/api/items/<slug>
  One material in full: text templates with all versions (variants[].subject, variants[].body, blanks written
  as [Placeholders]), kit checklists (kit.items), supplier notes, links, and the list of files.
- ${origin}/files/<slug>/<path>
  A file of a material (paths come from "files", "template.path" and "preview" in the answer above).
- ${origin}/api/meta
  The category ids and their names.

## Pages for people
- ${origin}/m/<slug>  one material; templates open in an editor with a Print / Save as PDF button.

## Giving someone a customized template
Materials of kind "template" are HTML pages that re-brand themselves. Hand the organizer a link that opens the
template in their group's look with new texts:

  ${origin}/m/<slug>#brand=<URL-encoded JSON>&edits=<URL-encoded JSON>

- brand (all keys optional): group_name, tagline, university, city, website, email, join_url (QR codes point
  here), instagram, your_name, color, accent, dark, light (colours as #rrggbb), font_heading, font_body (a Google
  Font such as Fraunces, Vollkorn, Space Grotesk, Inter, Hanken Grotesk, DM Sans).
- edits: new texts by field key, for example {"care_headline_1":"You don’t need a degree."}. The field keys are the
  data-edit="..." attributes in the template file (${origin}/files/<slug>/<template.path>).
- Encode both JSON values with percent-encoding (encodeURIComponent). Everything after # stays in the browser.

Example: ${origin}/m/poster-series-template#brand=%7B%22group_name%22%3A%22AI%20Safety%20Example%22%2C%22color%22%3A%22%231f6f5c%22%7D&edits=%7B%22care_headline_1%22%3A%22You%20don%E2%80%99t%20need%20a%20degree.%22%7D

## Text templates
Fill the [Placeholders] from what you know about the organizer's group and return the finished text.

## Sharing back
Only after the organizer explicitly agreed: the MCP tool share_material, or the command line tool
(${origin}/cli/commons.mjs, "commons add <folder>"). Remove names of private people, phone numbers, private
links and real amounts first. New materials appear after a moderator approved them. How to contribute a whole
folder of materials: ${origin}/contribute
`;
}

export function mountSetup(app, { origin }) {
  const send = (res, body) => res.type('text/plain; charset=utf-8').set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' }).send(body);
  for (const kind of ['sh', 'ps1']) {
    app.get(`/setup.${kind}`, (req, res, next) => {
      try {
        send(res, setupScript(kind, req.query, origin(req)));
      } catch (err) {
        next(err);
      }
    });
  }
  app.get('/llms.txt', (req, res) => send(res, llmsTxt(origin(req))));
}
