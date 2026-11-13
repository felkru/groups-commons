// MCP server (Model Context Protocol, streamable HTTP, stateless): the way Claude and other assistants use the commons.
// One endpoint, POST /mcp, speaking JSON-RPC 2.0. No login: everything it reads is public, and what it shares
// goes through the same review as the web form.

import express from 'express';
import { CATEGORIES, KINDS } from './ingest.js';
import { isOurs } from './ops.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BATCH = 20;

const INSTRUCTIONS = `Groups Commons is a shared library of materials that AI safety university groups keep re-making:
intro-talk slides, flyers, posters, Instagram posts, email / WhatsApp / Slack templates, tabling and event kits,
runsheets, surveys, supplier contacts, website templates and demos.

How to use it for an organizer:
1. Before writing or designing any outreach, event or group-admin material from scratch, call search_materials.
2. Call get_material on the best match to read it in full.
3. Adapt it to the organizer's group using what you already know about the group (your memory or project
   instructions: group name, university, city, colours, fonts, website, join link) plus their short instructions.
   - Text templates: fill the [Placeholders] yourself and return the finished text.
   - Customizable templates (flyers, posters, signs, slides, website): call customize_template with the group's brand
     and the new texts. It returns a link that opens the finished printable in the group's look, with working QR
     codes and a Print / Save as PDF button. Give the organizer that link.
4. If the organizer made a version worth sharing, ask whether they want to share it back, and only then call
   share_material. Never include names of private people, phone numbers, private links or amounts in what you share.
5. To turn the organizer's own finished flyer, poster or slide into a template that other groups can re-brand, write
   the HTML yourself, following the template contract at __ORIGIN__/cli/TEMPLATE.md, and share it with share_material
   (kind "template"). The site does not convert files. Where you have a terminal, the commons command line tool
   converts a PDF on the organizer's computer: commons convert flyer.pdf
Votes and use counts on the seed materials are simulated.`;

const TOOLS = [
  {
    name: 'search_materials',
    title: 'Search materials',
    description: 'Find reusable organizing materials by meaning (semantic search). Describe the need in plain words, e.g. "something to hand out at a freshers fair" or "ask a professor for five minutes in their lecture". Leave query empty to list the best-rated materials of a category.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the organizer needs, in their own words.' },
        category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Optional filter: ' + Object.entries(CATEGORIES).map(([k, v]) => `${k} (${v})`).join(', ') },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results (default 8).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_material',
    title: 'Read a material',
    description: 'Read one material in full: text templates with all versions, kit checklists with buy links and order emails, supplier notes with a ready quote request, links, files with download URLs, and for customizable templates the list of editable text fields.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The slug from search_materials.' } }, required: ['slug'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'customize_template',
    title: 'Customize a template for a group',
    description: 'Re-brand a customizable template (flyer, poster, sign, slides, Instagram post, website) for a group and change its texts. Returns a link that opens the finished material in the group\'s colours, fonts and name, with generated QR codes and a Print / Save as PDF button. Take the brand from what you know about the group; only ask the organizer for what is missing and matters.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of a material of kind "template".' },
        brand: {
          type: 'object',
          description: 'The group\'s brand kit. All fields optional; missing ones keep the organizer\'s current kit.',
          properties: {
            group_name: { type: 'string' }, tagline: { type: 'string' }, university: { type: 'string' }, city: { type: 'string' },
            website: { type: 'string' }, email: { type: 'string' }, join_url: { type: 'string', description: 'Sign-up link; QR codes point here.' }, survey_url: { type: 'string', description: 'Feedback survey link; survey QR codes point here.' }, instagram: { type: 'string' },
            color: { type: 'string', description: 'Main colour as #rrggbb.' }, accent: { type: 'string', description: 'Accent colour as #rrggbb.' },
            dark: { type: 'string', description: 'Dark tone as #rrggbb.' }, light: { type: 'string', description: 'Light background tone as #rrggbb.' },
            font_heading: { type: 'string', description: 'A Google Font, e.g. Fraunces, Vollkorn, Space Grotesk, Playfair Display.' }, font_body: { type: 'string', description: 'A Google Font, e.g. Inter, Hanken Grotesk, DM Sans.' },
          },
        },
        edits: { type: 'object', description: 'New texts by field key, e.g. {"headline": "Curious about AI safety?"}. Field keys come from get_material.', additionalProperties: { type: 'string' } },
      },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_template_html',
    title: 'Get a template\'s HTML',
    description: 'The raw HTML of a customizable template, for when the layout itself has to change. The file follows a contract: colours and fonts come from --brand-* CSS variables on :root, group texts carry data-brand, editable texts carry data-edit. Keep those when you change it.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'share_material',
    title: 'Share a material back',
    description: 'Add a material to the commons, or share an adapted version of an existing one. Call this ONLY after the organizer has explicitly agreed to share. It appears publicly after a moderator approved it. Remove names of private people, phone numbers, private links and real amounts first; write blanks as [Placeholders].',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Up to 90 characters.' },
        kind: { type: 'string', enum: ['text', 'link', 'kit', 'supplier', 'template'], description: 'text = message or document template, link = demo or website, kit = checklist, supplier = recommended supplier, template = customizable HTML (needs template_html).' },
        category: { type: 'string', enum: Object.keys(CATEGORIES) },
        summary: { type: 'string', description: 'What it is and when it worked well, up to 400 characters.' },
        group: { type: 'string', description: 'The group that shares it.' },
        description: { type: 'string', description: 'Optional tips in Markdown.' },
        tags: { type: 'array', items: { type: 'string' } },
        forked_from: { type: 'string', description: 'Slug of the material this was adapted from, if any.' },
        variants: { type: 'array', description: 'For kind "text".', items: { type: 'object', properties: { label: { type: 'string' }, channel: { type: 'string', enum: ['email', 'whatsapp', 'slack', 'instagram', 'doc'] }, lang: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['body'] } },
        link: { type: 'object', description: 'For kind "link".', properties: { url: { type: 'string' }, label: { type: 'string' } } },
        kit: { type: 'object', description: 'For kind "kit": { est_cost, items: [{ name, qty, note, url }] }.' },
        supplier: { type: 'object', description: 'For kind "supplier": { type, name, location, good_for, website, request: { subject, body } }. Business name only, no contact persons.' },
        template_html: { type: 'string', description: 'For kind "template": the complete HTML file, written to the template contract (/cli/TEMPLATE.md on this site; the server instructions give the address). Pictures go inside the file, as inline SVG or data: URIs.' },
      },
      required: ['title', 'kind', 'category', 'summary', 'group'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const strip = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Editable fields of a template: [{ key, text }]. A preview for the assistant, not a parser.
export function templateFields(html) {
  const fields = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<([a-z0-9]+)\b[^>]*\bdata-edit="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    fields.push({ key: m[2], text: strip(m[3]).slice(0, 140) });
  }
  return fields;
}

// deps: { store, search, view, origin, createMaterial, limit, wrap, sortItems }
export function mountMcp(app, deps) {
  const { store, search, origin, createMaterial, limit, wrap, sortItems, score } = deps;
  const published = async () => (await store.allItems()).filter((i) => i.status === 'published');
  const brief = (i, base) => ({ slug: i.slug, title: i.title, kind: i.kind, category: i.category, summary: i.summary, format: i.template?.format, group: i.group, score: score(i), uses: i.uses || 0, featured_by_moderators: i.featured || undefined, url: `${base}/m/${i.slug}` });
  const fileUrl = (base, slug, p) => `${base}/files/${slug}/${p.split('/').map(encodeURIComponent).join('/')}`;

  const tools = {
    async search_materials(args, req) {
      const base = origin(req);
      let items = await published();
      const q = String(args.query || '').trim().slice(0, 300);
      let mode = 'best rated';
      if (q) ({ items, mode } = await search(items, q));
      if (args.category) items = items.filter((i) => i.category === args.category);
      if (!q) items = sortItems(items, 'best');
      const n = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 8));
      return { search: q ? mode : 'best rated', count: Math.min(n, items.length), materials: items.slice(0, n).map((i) => brief(i, base)), next: 'Call get_material with a slug to read one in full.' };
    },

    async get_material(args, req) {
      const base = origin(req);
      const item = (await published()).find((i) => i.slug === String(args.slug || ''));
      if (!item) throw new Error(`No material with the slug "${args.slug}". Use search_materials first.`);
      const out = { ...brief(item, base), description: item.description, tags: item.tags, language: item.language, origin: item.source, provenance: item.provenance, forked_from: item.forked_from };
      if (item.variants) out.versions = item.variants.map((v) => ({ label: v.label, channel: v.channel, language: v.lang, subject: v.subject, body: v.body }));
      if (item.kit) out.kit = item.kit;
      if (item.supplier) out.supplier = item.supplier;
      if (item.link) out.link = item.link;
      if (item.files?.length) out.files = item.files.map((f) => ({ label: f.label || f.path, url: fileUrl(base, item.slug, f.path) }));
      if (item.kind === 'template') {
        const html = ((await store.readFile(item.slug, item.template.path)) || '').toString('utf8');
        out.editable_fields = templateFields(html);
        out.brand_fields_used = [...new Set([...html.matchAll(/data-(?:brand|qr)="([a-z_]+)"/g)].map((m) => m[1]))];
        out.how_to_customize = 'Call customize_template with this slug, the group\'s brand and an "edits" object keyed by the editable field keys. Fields you leave out keep their text.';
      }
      if (item.kind === 'text') out.how_to_customize = 'Fill the [Placeholders] from what you know about the group and the organizer\'s instructions, and return the finished text.';
      store.incr(item.slug, 'uses', 1).catch(() => {});
      return out;
    },

    async customize_template(args, req) {
      const base = origin(req);
      const item = (await published()).find((i) => i.slug === String(args.slug || ''));
      if (!item) throw new Error(`No material with the slug "${args.slug}".`);
      if (item.kind !== 'template') throw new Error(`"${item.slug}" is a ${item.kind}, not a customizable template. Read it with get_material and adapt the content yourself.`);
      const html = ((await store.readFile(item.slug, item.template.path)) || '').toString('utf8');
      const known = new Set(templateFields(html).map((f) => f.key));
      const edits = {};
      const unknown = [];
      for (const [k, v] of Object.entries(args.edits || {})) (known.has(k) ? (edits[k] = String(v).slice(0, 2000)) : unknown.push(k));
      const brand = {};
      for (const [k, v] of Object.entries(args.brand || {})) if (typeof v === 'string' && v.trim()) brand[k] = v.trim().slice(0, 200);
      const hash = new URLSearchParams();
      if (Object.keys(brand).length) hash.set('brand', JSON.stringify(brand));
      if (Object.keys(edits).length) hash.set('edits', JSON.stringify(edits));
      return {
        open_url: `${base}/m/${item.slug}${[...hash].length ? '#' + hash : ''}`,
        title: item.title,
        format: item.template.format,
        applied: { brand: Object.keys(brand), edits: Object.keys(edits) },
        ignored_edit_keys: unknown.length ? unknown : undefined,
        tell_the_organizer: 'Give them the link. It opens the material in their look; they can click any text to change it and use "Print / save as PDF". If they like the result, ask whether they want to share their version back.',
      };
    },

    async get_template_html(args) {
      const item = (await published()).find((i) => i.slug === String(args.slug || ''));
      if (!item || item.kind !== 'template') throw new Error(`No customizable template with the slug "${args.slug}".`);
      return ((await store.readFile(item.slug, item.template.path)) || '').toString('utf8');
    },

    async share_material(args, req) {
      if (!KINDS.includes(args.kind) || args.kind === 'file') throw new Error('kind must be one of: text, link, kit, supplier, template.');
      const { template_html, ...meta } = args;
      const files = [];
      if (meta.kind === 'template') {
        if (!template_html) throw new Error('A template needs template_html.');
        meta.template = { path: 'template.html', format: /commons:format" content="([^"]{1,60})"/.exec(template_html)?.[1] };
        files.push({ path: 'template.html', buffer: Buffer.from(template_html, 'utf8') });
      }
      const r = await createMaterial(req, { ...meta, source: meta.forked_from ? 'adapted' : 'original', provenance: 'Shared through an AI assistant.' }, files);
      return { slug: r.slug, status: r.status, url: `${origin(req)}/m/${r.slug}`, note: r.status === 'published' ? 'Published.' : 'Received. It appears publicly after a moderator approved it.' };
    },
  };

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg, req) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id ?? null, -32600, 'Invalid request');
    if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return ok(msg.id, {
          protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'groups-commons', title: 'Groups Commons', version: '0.1.0' },
          instructions: INSTRUCTIONS.replaceAll('__ORIGIN__', origin(req)),
        });
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const tool = Object.hasOwn(tools, p.name) ? tools[p.name] : null;
        if (!tool) return err(msg.id, -32602, `Unknown tool: ${p.name}`);
        try {
          const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
          const result = await tool(args, req);
          return ok(msg.id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }], isError: false });
        } catch (e) {
          // Only messages this code wrote for the assistant are passed on; a database or storage error is logged.
          const shown = isOurs(e) && !(e.status >= 500);
          if (!shown) console.error('mcp tool failed:', p.name, e);
          return ok(msg.id, { content: [{ type: 'text', text: shown ? e.message : 'The commons could not answer right now.' }], isError: true });
        }
      }
      case 'resources/list':
        return ok(msg.id, { resources: [] });
      case 'prompts/list':
        return ok(msg.id, { prompts: [] });
      default:
        return err(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  const cors = (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' });
    next();
  };
  app.options('/mcp', cors, (req, res) => res.status(204).end());
  app.post(
    '/mcp',
    cors,
    limit('mcp', 3000),
    express.json({ limit: '2mb' }),
    wrap(async (req, res) => {
      const body = req.body;
      if (Array.isArray(body)) {
        // One request counts once against the rate limit, so a batch must not carry an unlimited number of calls.
        if (body.length > MAX_BATCH) return res.status(400).json(err(null, -32600, `A batch can hold at most ${MAX_BATCH} messages.`));
        const out = (await Promise.all(body.map((m) => handle(m, req)))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
      }
      const out = await handle(body, req);
      return out ? res.json(out) : res.status(202).end();
    }),
  );
  // No server-initiated stream and no sessions: GET and DELETE have nothing to do.
  app.all('/mcp', cors, (req, res) => res.status(405).set('Allow', 'POST, OPTIONS').json(err(null, -32000, 'Use POST.')));
}
