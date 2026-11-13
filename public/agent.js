// "Set up my AI": the questionnaire behind the button in the header, the prompts it hands out, and the
// Contribute page. The questionnaire ends in ONE thing to copy: a command that fetches a setup script written for
// the answers (server/setup.js), or the three steps for the Claude app, or a prompt for any other assistant.

import { tryItPrompt } from './app.js';
import { activePreset, findFont, getBrand } from './brand.js';
import { cleanGroupDetails, GROUP_FIELDS, memoryText } from './setup-fields.js';
import { fetchTemplate } from './template.js';
import { $, KIND, cmd, copy, esc, state } from './ui.js';

const EXAMPLE = 'We have a stall at the activities fair next week. Find a table sign and a flyer on the Groups Commons and prepare them for our group.';
const AGENT = { 'claude-code': 'Claude Code', codex: 'Codex' };

// ---------------------------------------------------------------- what the answers turn into
// The brand kit shows an example group until the visitor has entered their own.
export const hasOwnGroup = () => !activePreset();

// The brand kit fields a setup script can carry, under the names the script address uses.
export const groupAnswers = (b) => ({ group: b.group_name, university: b.university, city: b.city, color: b.color, accent: b.accent, font_heading: b.font_heading, font_body: b.font_body, website: b.website, join: b.join_url });

// answers: { agent: 'claude-code' | 'codex', os: 'macos' | 'linux' | 'windows', install, cli, group }
export function setupUrl(answers, brand = getBrand(), origin = location.origin) {
  const p = new URLSearchParams({ agent: answers.agent === 'codex' ? 'codex' : 'claude-code' });
  if (answers.install) p.set('install', '1');
  if (answers.cli) p.set('cli', '1');
  if (answers.cli && answers.agent !== 'codex') p.set('skill', '1'); // the skill is what makes Claude Code reach for the tool
  if (answers.group) {
    const { details } = cleanGroupDetails(groupAnswers(brand), findFont);
    for (const [k, v] of Object.entries(details)) p.set(k, v.replace(/^#/, ''));
  }
  return `${origin}/setup.${answers.os === 'windows' ? 'ps1' : 'sh'}?${p}`;
}
// The address only holds letters, digits and % + & = . - _ * after encoding, so single quotes are safe in both shells.
export const setupCommand = (answers, brand, origin) => (answers.os === 'windows' ? `irm '${setupUrl(answers, brand, origin)}' | iex` : `curl -fsSL '${setupUrl(answers, brand, origin)}' | bash`);

// What an assistant should remember about the group. For pasting by hand, so it may hold everything in the kit.
export function memorySnippet(b = getBrand(), origin = location.origin) {
  const line = (label, value) => (value ? `${label}: ${value}\n` : '');
  return (
    `Our group: ${b.group_name}${b.university ? `, a student group at ${b.university}` : ''}${b.city ? ` in ${b.city}` : ''}.\n` +
    `Brand: main colour ${b.color}, accent ${b.accent}, heading font ${b.font_heading}, body font ${b.font_body}.\n` +
    line('Website', b.website) + line('Sign-up link (QR codes point here)', b.join_url) + line('Contact', b.email) + line('Instagram', b.instagram) +
    `When we need outreach, event or group-admin material, search the Groups Commons (${origin}) first and adapt what other groups already made to this brand.`
  );
}

const LINK_FORMAT = (origin, slug) => `${origin}/m/${slug}#brand=<URL-encoded JSON>&edits=<URL-encoded JSON>`;
const BRAND_KEYS = 'group_name, tagline, university, city, website, email, join_url (QR codes point here), color, accent (colours as #rrggbb), font_heading, font_body (Google Fonts)';

// For assistants without MCP: one prompt that explains the commons well enough to use it by opening web pages.
export function anyAssistantPrompt(b = getBrand(), origin = location.origin, own = hasOwnGroup()) {
  return [
    `For this conversation, use the Groups Commons: a shared library of organizing materials made by AI safety university groups (flyers, posters, slides, emails, WhatsApp messages, tabling kits, runsheets) at ${origin}`,
    `How to use it is written down at ${origin}/llms.txt. In short: search with ${origin}/api/items?q=<what I need>, read one material with ${origin}/api/items/<slug>, and for customizable templates give me a link of the form ${LINK_FORMAT(origin, '<slug>')} that opens the template in my group's look.`,
    own ? `About my group:\n${memorySnippet(b, origin).split('\n').slice(0, -1).join('\n')}` : 'Ask me for my group\'s name, university, colours and links before you adapt anything.',
    'Before you write or design anything for my group from scratch, look there first and adapt what another group already made. If you cannot open web pages, say so, and I will paste the material from the site.',
    'My first request: [what you need, for example "a flyer and an Instagram post for our intro evening on 23 October"]',
  ].join('\n\n');
}

// The editable texts of a template: [{ key, text }].
export function templateFields(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const seen = new Set();
  const fields = [];
  for (const el of doc.querySelectorAll('[data-edit]')) {
    const key = el.getAttribute('data-edit');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fields.push({ key, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) });
  }
  return fields;
}

// A prompt for one material that works in any AI chat without setup: it names the material, carries its content
// when that is text, and for templates explains the link that opens the finished printable.
// fields: the result of templateFields() for a template.
export function materialPrompt(item, { fields = [], brand = getBrand(), origin = location.origin, own = hasOwnGroup() } = {}) {
  const page = `${origin}/m/${item.slug}`;
  const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}\n[cut here; the full text is at ${origin}/api/items/${item.slug}]` : String(s));
  const out = [
    'I want to use a material from the Groups Commons, a shared library of organizing materials made by AI safety university groups, and adapt it for my group.',
    [`Material: "${item.title}" (${KIND[item.kind] || item.kind}, shared by ${item.group})`, `Page: ${page}`, `What it is: ${item.summary}`].join('\n'),
  ];
  if (item.description) out.push(`Notes from the group that shared it:\n${clip(item.description, 1500)}`);
  let task = 'If you can open web pages, look at it first. Then ask me what I need it for and help me adapt it for my group.';

  if (item.kind === 'text' && item.variants?.length) {
    const many = item.variants.length > 1;
    out.push(
      `${many ? `The texts (${item.variants.length} versions)` : 'The text'}, with blanks written as [Placeholders]:\n\n` +
        item.variants.map((v) => `${many || v.label ? `--- ${[v.label, v.channel, v.lang].filter(Boolean).join(', ')} ---\n` : ''}${v.subject ? `Subject: ${v.subject}\n\n` : ''}${clip(v.body, 6000)}`).join('\n\n'),
    );
    task = `${many ? 'Ask me which version I need. ' : ''}Fill in the [Placeholders] for my group and keep the original wording where it fits. Ask me for what you cannot know (date, room, names), then give me the finished text.`;
  }
  if (item.kind === 'kit' && item.kit?.items?.length) {
    out.push(`The checklist${item.kit.est_cost ? ` (${item.kit.est_cost})` : ''}:\n` + item.kit.items.map((k) => `- ${k.qty ? `${k.qty} × ` : ''}${k.name}${k.note ? `: ${k.note}` : ''}${k.url ? ` (${k.url})` : ''}${k.material ? ` (make it from ${origin}/m/${k.material})` : ''}`).join('\n'));
    task = 'Go through the checklist with me: ask what the event is and what we already have, then give me a shopping and to-do list with the links, in the order things have to be ordered.';
  }
  if (item.kind === 'supplier' && item.supplier) {
    const s = item.supplier;
    out.push([`Supplier: ${s.name} (${[s.type, s.location].filter(Boolean).join(', ')})`, s.good_for && `Good for: ${s.good_for}`, s.request && `Their quote request:\nSubject: ${s.request.subject}\n\n${s.request.body}`].filter(Boolean).join('\n'));
    task = 'Help me write a quote request like this one to a supplier near me. Ask me for the event, the date and the quantities first.';
  }
  if (item.kind === 'link' && item.link) out.push(`Link: ${item.link.url}`);
  if (item.files?.length) out.push('Files:\n' + item.files.map((f) => `- ${f.label || f.path}: ${origin}/files/${item.slug}/${f.path.split('/').map(encodeURIComponent).join('/')}`).join('\n'));
  if (item.kind === 'template') {
    const b = own ? { group_name: brand.group_name, color: brand.color, accent: brand.accent, font_heading: brand.font_heading, font_body: brand.font_body } : { group_name: 'AI Safety Example', color: '#1f6f5c' };
    const first = fields[0] || { key: 'headline', text: 'Curious about AI safety?' };
    out.push(
      [
        `It is a customizable template${item.template?.format ? ` (${item.template.format})` : ''}: an HTML page that re-brands itself. Do not redesign it. Give me a link that opens it in my group's look with my texts:`,
        `  ${LINK_FORMAT(origin, item.slug)}`,
        `- brand: any of ${BRAND_KEYS}.`,
        fields.length ? `- edits: new texts by field key. The fields of this template and what they say now:\n${fields.map((f) => `    ${f.key}: ${JSON.stringify(f.text)}`).join('\n')}` : `- edits: new texts by field key. The keys are the data-edit="..." attributes in ${origin}/files/${item.slug}/${item.template?.path || 'template.html'}`,
        '- Fields you leave out keep their text. Encode both JSON values with percent-encoding (what encodeURIComponent does in JavaScript).',
        `- A finished link looks like this: ${page}#brand=${encodeURIComponent(JSON.stringify(b))}&edits=${encodeURIComponent(JSON.stringify({ [first.key]: first.text }))}`,
      ].join('\n'),
    );
    task = 'Ask me what it is for (event, date, place, anything that has to be on it), write the texts, and give me the finished link. The page behind the link has a Print / Save as PDF button.';
  }
  out.push(own ? `About my group:\n${memorySnippet(brand, origin).split('\n').slice(0, -1).join('\n')}` : 'Ask me for my group\'s name, university, colours and links first.');
  out.push(task);
  out.push(`More materials like this: ${origin} (for assistants that can open web pages: ${origin}/llms.txt).`);
  return out.join('\n\n');
}

// ---------------------------------------------------------------- the dialog
function guessOs() {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/win/i.test(p)) return 'windows';
  if (/mac|iphone|ipad/i.test(p)) return 'macos';
  return /linux|x11|cros|android/i.test(p) ? 'linux' : 'macos';
}
const answers = { where: '', os: guessOs(), install: true, cli: true, group: true };

const WHERE = [
  ['claude-app', 'Claude app', 'in the browser or the desktop app'],
  ['claude-code', 'Claude Code', 'in the terminal or an editor'],
  ['codex', 'Codex', 'OpenAI’s coding agent'],
  ['other', 'Another assistant', 'ChatGPT, Gemini, Cursor, …'],
  ['none', 'Nothing yet', 'I have not set one up'],
];
const OS = [['macos', 'macOS'], ['linux', 'Linux'], ['windows', 'Windows']];
const TERMINAL = {
  macos: 'Open the Terminal app (press ⌘ and Space, type “Terminal”, press Enter). Paste the line and press Enter.',
  linux: 'Open a terminal, paste the line and press Enter. This is also the one for WSL on Windows.',
  windows: 'Open PowerShell (press the Windows key, type “PowerShell”, press Enter). Paste the line and press Enter. If you work in WSL, choose Linux instead.',
};
const radios = (name, options, value) => `<div class="opts ${name}">${options.map(([v, label, sub]) => `<label class="opt"><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`).join('')}</div>`;
const tick = (name, checked, label, note = '', disabled = false) => `<label class="tick"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${label}${note ? `<small>${note}</small>` : ''}</span></label>`;

function groupOption(agentName) {
  if (!hasOwnGroup()) return tick('group', false, `Tell ${agentName} about my group`, 'Your brand kit still shows an example group. <a href="/brand" data-close-setup>Enter your own group in the brand kit</a>, then come back here.', true);
  const { details, dropped } = cleanGroupDetails(groupAnswers(getBrand()), findFont);
  const text = memoryText(details, location.origin);
  const left = dropped.length ? ` Left out because the script only takes plain names and web addresses: ${dropped.map((k) => GROUP_FIELDS[k][0]).join(', ')}.` : '';
  return (
    tick('group', answers.group, `Tell ${agentName} about my group`, `These lines from your <a href="/brand" data-close-setup>brand kit</a> go into its memory file. The script shows them and asks first.${left}`) +
    (answers.group ? `<pre class="memo">${esc(text)}</pre>` : '')
  );
}

function scriptResult(agent, intro = '') {
  const a = { ...answers, agent, group: answers.group && hasOwnGroup() };
  const name = AGENT[agent];
  return `
    ${intro}
    <div class="setup-q"><h3>Your computer</h3>${radios('os', OS, answers.os)}</div>
    <div class="setup-q ticks">
      ${tick('install', answers.install, `Install ${name} if it is not on my computer yet`, agent === 'codex' ? 'Codex is installed through npm, so this needs Node.js.' : 'With its official installer. No administrator password needed.')}
      ${tick('cli', answers.cli, agent === 'codex' ? 'Also install the command line tool' : 'Also install the command line tool and the Claude Code skill', 'Needed to <a href="/contribute" data-close-setup>share whole folders</a> of your own material. Uses Node.js; skipped with a note when that is missing.')}
      ${groupOption(name)}
    </div>
    <div class="setup-result">
      <h3>1. Copy this line into your terminal</h3>
      <p class="small muted">${esc(TERMINAL[answers.os])}</p>
      ${cmd(setupCommand(a))}
      <p class="small"><a href="${esc(setupUrl(a))}" target="_blank" rel="noopener">See what this script does</a> <span class="muted">· It says what it does at each step, never asks for a password, and can be run again.</span></p>
      <h3>2. Now say this to your agent</h3>
      <p class="small muted">Start it by typing <code>${agent === 'codex' ? 'codex' : 'claude'}</code> in the same window. The first time it asks you to sign in.</p>
      ${cmd(EXAMPLE)}
    </div>`;
}

function result() {
  const o = location.origin;
  const tryUrl = `https://claude.ai/new?q=${encodeURIComponent(tryItPrompt())}`;
  switch (answers.where) {
    case 'claude-code':
    case 'codex':
      return scriptResult(answers.where);
    case 'claude-app':
      return `
        <div class="setup-result">
          <h3>1. Add the commons as a connector</h3>
          <ol class="plain"><li>In Claude, open <b>Settings</b>.</li><li>Go to <b>Connectors</b>.</li><li>Choose <b>Add custom connector</b>, call it “Groups Commons” and paste this address:</li></ol>
          ${cmd(`${o}/mcp`)}
          <h3>2. Tell Claude about your group, once</h3>
          <p class="small muted">Paste this into a chat and ask Claude to remember it, or into the instructions of a project. ${hasOwnGroup() ? 'It is written from your <a href="/brand" data-close-setup>brand kit</a>.' : 'It still shows an example group: <a href="/brand" data-close-setup>enter your own in the brand kit</a> first.'}</p>
          ${cmd(memorySnippet())}
          <h3>3. Now say this to Claude</h3>
          ${cmd(EXAMPLE)}
        </div>`;
    case 'other':
      return `
        <div class="setup-result">
          <h3>If your assistant can add an MCP server</h3>
          <p class="small muted">Look for “connectors”, “tools” or “MCP servers” in its settings and add this address. No login is needed.</p>
          ${cmd(`${o}/mcp`)}
          <h3>If not: paste this at the start of a chat</h3>
          <p class="small muted">It works without any setup in every assistant that can open web pages. Change the last line to what you need.</p>
          ${cmd(anyAssistantPrompt())}
        </div>`;
    case 'none':
      return scriptResult(
        'claude-code',
        `<div class="setup-result">
          <h3>Try it first, with nothing to install</h3>
          <p class="small"><a class="btn primary" data-tryit target="_blank" rel="noopener" href="${esc(tryUrl)}">Try it with Claude</a></p>
          <p class="small muted">This opens Claude with a prompt ready: it asks you about your event and prepares the marketing from the commons. You only need a Claude account.</p>
          <h3>To keep it</h3>
          <p class="small">If you have a Claude account, connect the Claude app: three clicks and nothing to install. <button type="button" class="btn small" data-where="claude-app">Show me the steps</button></p>
          <p class="small">Otherwise use Claude Code, an agent that works with the files on your computer: the line below installs it and connects it to the commons in one go.</p>
        </div>`,
      );
    default:
      return '<p class="small muted setup-result">Pick one and you get a single thing to copy.</p>';
  }
}

function materialBox() {
  const item = state.currentItem;
  if (!item) return '';
  const carries = item.kind === 'text' || item.kind === 'kit' ? ' It includes the full text.' : item.kind === 'template' ? ' It explains how to hand you back a link to the finished printable.' : '';
  return `<section class="panel pink setup-material"><div><b>On this page: ${esc(item.title)}</b><p class="small">Paste the prompt into any AI chat and it adapts this material for your group. No setup needed.${carries}</p></div><button type="button" class="btn primary" data-material-prompt>Copy a prompt for this material</button></section>`;
}

function paint() {
  const dialog = $('#agent-setup');
  dialog.innerHTML = `
    <button type="button" class="x" data-close-setup aria-label="Close">×</button>
    <h2 id="setup-title">Get the commons into <em>your AI</em></h2>
    <p class="small muted">Most groups never browse this site. They ask their assistant, and it finds, adapts and prepares the materials. Two questions, then one thing to copy.</p>
    ${materialBox()}
    <div class="setup-q"><h3>Where do you use AI?</h3>${radios('where', WHERE, answers.where)}</div>
    ${result()}`;
}

export function openAgentSetup(where) {
  if (where) answers.where = where;
  paint();
  const dialog = $('#agent-setup');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

async function copyMaterialPrompt(btn) {
  const item = state.currentItem;
  if (!item) return;
  let fields = [];
  if (item.kind === 'template') fields = templateFields(await fetchTemplate(item).catch(() => ''));
  await copy(materialPrompt(item, { fields }), 'Prompt copied. Paste it into your AI chat.');
  flash(btn);
}
function flash(btn) {
  const label = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = label), 1600);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-agent-setup]')) {
    e.preventDefault();
    return openAgentSetup(e.target.closest('[data-agent-setup]').dataset.agentSetup);
  }
  const dialog = $('#agent-setup');
  if (!dialog?.open || !dialog.contains(e.target)) return;
  const box = dialog.getBoundingClientRect();
  const outside = e.target === dialog && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom);
  if (outside || e.target.closest('[data-close-setup]')) return dialog.close();
  const jump = e.target.closest('[data-where]');
  if (jump) return openAgentSetup(jump.dataset.where);
  const material = e.target.closest('[data-material-prompt]');
  if (material) return copyMaterialPrompt(material);
  const copied = e.target.closest('[data-copy]'); // the copying itself happens in ui.js; the toast is hidden behind the dialog
  if (copied) flash(copied);
});
document.addEventListener('change', (e) => {
  const dialog = $('#agent-setup');
  if (!dialog?.contains(e.target) || !e.target.name) return;
  if (e.target.type === 'radio') answers[e.target.name] = e.target.value;
  else if (e.target.type === 'checkbox') answers[e.target.name] = e.target.checked;
  const top = dialog.scrollTop;
  paint();
  dialog.scrollTop = top;
  $(`[name="${e.target.name}"]${e.target.type === 'radio' ? ':checked' : ''}`, dialog)?.focus();
});

// ---------------------------------------------------------------- contribute
export function contributePrompt(origin = location.origin, group = hasOwnGroup() ? getBrand().group_name : '[your group]') {
  return [
    `I want to share my group's organizing materials on the Groups Commons (${origin}), a library where AI safety university groups reuse each other's flyers, posters, slides, messages and checklists. We are ${group}. Everything is in this folder: [path to your folder]`,
    [
      '1. Go through the folder and tell me what is in it. Leave out drafts, duplicates, and anything that is about one person or not finished.',
      '2. Turn every finished printable (flyer, poster, sign, slide, social media post) into a template that other groups can re-brand with their own colours, fonts, logo and texts. For a PDF run `commons convert <file.pdf>`: it converts the file on this computer, keeps our design and makes the text editable. Then open the `template.html` it wrote and mark our logo and our group name the way `commons contract` describes; logos of partners stay as they are. For a picture that has no PDF, write the template by hand from that contract, with the picture as the reference. Compare every template with its original.',
      '3. For every message, email, checklist, runsheet or guide, make a folder with an `item.json` (kind "text"; kind "kit" for checklists of things to buy or bring). Keep our original wording. Write the parts that change from event to event as [Placeholders]: [Date], [Room], [Speaker], and [Group name], [University], [Website], [Join link] for our own details. `commons get <slug>` on a similar material shows the format.',
      '4. Take out everything private, in texts and in designs: names of people, phone numbers, personal email addresses, private links (WhatsApp or Signal invites, Google Docs, sign-up forms, video calls), and amounts from invoices, grants or budgets. Our group name and public website can stay.',
      '5. Give every material a short concrete title, a category (`commons categories` lists them), two to six tags, and one or two sentences that say what it is and when it worked well for us.',
      '6. Show me the whole list before anything is uploaded: title, kind, category, and what you took out. Wait for my OK, and drop whatever I say no to.',
      '7. After my OK, run `commons add <folder>` for each one and give me the links.',
    ].join('\n'),
    'If `commons` is not installed, tell me, and I will run the setup line from the site first.',
  ].join('\n\n');
}

export async function contributePage(root) {
  root.innerHTML = `
    <section class="hero compact"><div><h1>Contribute your group’s materials</h1></div></section>
    <p class="muted" style="max-width:74ch">You do not have to upload things one by one. Point your agent at the folder where your flyers, posters, slides and messages live, and it turns them into materials that other groups can re-brand and reuse. You check the list; it does the rest.</p>
    <div class="cols" style="margin-top:18px">
      <div>
        <section class="panel">
          <h2>1. Connect your agent</h2>
          <p class="small muted">This needs an agent that can read files on your computer, such as Claude Code or Codex, and the commons command line tool. One line sets up both; leave “Also install the command line tool” ticked.</p>
          <p><button type="button" class="btn primary" data-agent-setup="claude-code">Set up my AI</button></p>
          <h2 style="margin-top:22px">2. Put everything in one folder</h2>
          <p class="small muted">Flyers, posters, slides, signs, Instagram posts, emails, WhatsApp messages, checklists, runsheets. Finished files are best: PDFs and images for anything designed, text or Word files for messages. No need to sort or rename them.</p>
          <h2 style="margin-top:22px">3. Give your agent this prompt</h2>
          <p class="small muted">Start the agent in that folder (type <code>claude</code> or <code>codex</code>) and paste this. Put the folder’s path in the first paragraph.</p>
          ${cmd(contributePrompt())}
          <h2 style="margin-top:22px">4. Check the list, then say yes</h2>
          <p class="small muted">The agent shows you what it would share and what it took out. Nothing is uploaded before your OK. Look at the templates it made, in your own look and in another group’s: a PDF keeps its design, but the agent decides which pictures are your logo, and a template rebuilt from a picture can differ from the original. Ask it to fix what is off, or leave that one out.</p>
        </section>
        <section class="panel">
          <h2>What happens next</h2>
          <div class="md"><ul>
            <li><strong>A moderator looks at each material</strong> before it appears for everyone. Until then only you can see it.</li>
            <li><strong>Your group is credited</strong> on every material and on the <a href="/leaderboard">leaderboard</a>, which counts the votes and uses your materials collect.</li>
            <li><strong>Other groups re-brand it</strong> in one click: your flyer in their colours, fonts and logo, with their texts. Versions they share back link to your original.</li>
            <li><strong>You can take things down</strong> again: <code>commons rm &lt;slug&gt;</code>, or the Delete button on the material’s page.</li>
          </ul></div>
        </section>
      </div>
      <aside>
        <section class="panel pink">
          <h3 style="margin-top:0">Without an agent</h3>
          <p class="small">The web form takes one material at a time: a file, a link or a text. Turning a flyer or poster into a re-brandable template is done by your assistant or the command line tool; the same page says how.</p>
          <p style="margin:0"><a class="btn" href="/add">Open the web form</a></p>
        </section>
        <section class="panel">
          <h3 style="margin-top:0">Only the Claude app?</h3>
          <p class="small" style="margin:0">Attach the file or paste the text in a chat and say “share this on the Groups Commons”. With the <button type="button" class="btn small" data-agent-setup="claude-app">connector</button> added, Claude removes private details, asks for your OK and sends it for review. This works for texts, checklists and links; whole folders need an agent on your computer.</p>
        </section>
        <section class="panel">
          <h3 style="margin-top:0">What must not go in</h3>
          <p class="small" style="margin:0">The site is public. No names of private people, phone numbers, personal email addresses, private links, or real amounts from invoices and grants. Photos only if the people in them agreed to other groups using them.</p>
        </section>
      </aside>
    </div>`;
}
