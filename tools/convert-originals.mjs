// Turns original PDFs that are already in the seed (as downloadable files) into editable templates, with the
// converter that keeps the artwork as it is. Each template links back to the original file it was made from.
// Usage: node tools/convert-originals.mjs            (writes seed/<slug>/ for every entry below)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfToTemplate } from '../server/convert-pdf.js';
import { validateItem } from '../server/ingest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'seed');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// from: seed folder and file of the original; slug: the template's folder
const JOBS = [
  { slug: 'wayfinding-signs-template', from: 'wayfinding-signage-pack/wayfinding-signs-all.pdf', pages: 22, category: 'event', title: 'Wayfinding signs for events (22 signs, editable)', what: 'door and corridor signs' },
  { slug: 'speaker-time-cards-template', from: 'speaker-time-cards/speaker-time-cards.pdf', pages: 3, category: 'event', title: 'Speaker time cards: 10, 5 and 1 minute (editable)', what: 'time cards to hold up for speakers' },
  { slug: 'welcome-signs-template', from: 'welcome-signs-portrait/welcome-signs-portrait.pdf', pages: 2, category: 'event', title: 'Welcome signs with arrows for the entrance (editable)', what: 'entrance signs' },
  { slug: 'rollup-banner-template', from: 'rollup-banner-print-file/rollup-banner-80x200cm.pdf', pages: 1, category: 'print', title: 'Roll-up banner, 80 x 200 cm (editable)', what: 'roll-up banner' },
  { slug: 'semester-overview-slides-template', from: 'semester-overview-deck/semester-overview-deck.pdf', pages: 13, category: 'slides', title: 'Semester overview deck: programme, projects and how to join (editable)', what: 'semester kick-off slides' },
  { slug: 'lecture-hall-pitch-slides-template', from: 'lecture-hall-pitch-deck/lecture-hall-pitch-deck.pdf', pages: 8, category: 'slides', title: 'Lecture hall pitch deck (editable)', what: 'slides for a five-minute pitch in a lecture' },
  { slug: 'feedback-survey-template', from: 'feedback-survey-questions/feedback-survey-questions.pdf', pages: 2, category: 'event', title: 'Printed feedback survey for an event (editable)', what: 'paper feedback survey' },
];

const only = process.argv[2];
const results = [];
for (const job of JOBS) {
  if (only && job.slug !== only) continue;
  const srcDir = job.from.split('/')[0];
  let pdfPath = path.join(SEED, job.from);
  if (!fs.existsSync(pdfPath)) {
    const alt = fs.existsSync(path.join(SEED, srcDir)) ? fs.readdirSync(path.join(SEED, srcDir)).find((f) => f.endsWith('.pdf')) : null;
    if (!alt) {
      results.push({ slug: job.slug, error: `no PDF in ${srcDir}` });
      continue;
    }
    pdfPath = path.join(SEED, srcDir, alt);
  }
  const source = JSON.parse(fs.readFileSync(path.join(SEED, srcDir, 'item.json'), 'utf8'));
  const out = await pdfToTemplate(fs.readFileSync(pdfPath), { maxPages: job.pages, qr: 'placeholder', title: job.title });
  const dir = path.join(SEED, job.slug);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'template.html'), out.html);
  for (const logo of ['logo-square.svg', 'logo-wide.svg', 'logo-square-light.svg', 'logo-wide-light.svg']) fs.copyFileSync(path.join(ROOT, 'public', 'assets', 'brand', logo), path.join(dir, logo));

  // preview: the first page as rendered by a browser
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-prev-'));
  try {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'p')}`, '--no-pdf-header-footer', `--print-to-pdf=${path.join(tmp, 'o.pdf')}`, `file://${path.join(dir, 'template.html')}`], { stdio: 'ignore', timeout: 120000 });
    execFileSync('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to', '1400', '-f', '1', '-l', '1', '-singlefile', path.join(tmp, 'o.pdf'), path.join(dir, 'preview')]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const rep = out.report;
  const editable = (rep.pages || []).reduce((a, p) => a + (p.editableElements || 0), 0);
  const format = /commons:format" content="([^"]{1,60})"/.exec(out.html)?.[1] || rep.pages?.[0]?.format;
  const fonts = (rep.fonts || []).map((f) => (typeof f === 'string' ? f : f.family || f.name)).filter(Boolean);
  const item = {
    slug: job.slug,
    title: job.title.slice(0, 90),
    category: job.category,
    kind: 'template',
    summary: `${source.summary}`.slice(0, 330) + ' As a template: the original design, with the texts editable.',
    description: [
      `This is the original ${job.what} of ${source.group}, converted into a template without redrawing it: the artwork is the original, ${editable} texts are live text at the place where they were printed, and the main colours follow your brand kit.`,
      '',
      '**How to use it**',
      '- Click any text to change it. Text does not re-flow the layout, so keep replacements about as long as the original.',
      '- Pictures in the artwork can be clicked and replaced with your own.',
      '- Print or save as PDF from the editor. The page size is the original\'s.',
      '',
      `The untouched original is here as a file: **${source.title}**.`,
    ].join('\n'),
    tags: [...new Set([...(source.tags || []), 'editable'])].slice(0, 8),
    language: source.language || 'en',
    group: source.group,
    source: 'adapted',
    provenance: `Converted from the original PDF by the commons' converter: artwork unchanged, text made editable. Original: ${source.title}.`.slice(0, 300),
    forked_from: srcDir,
    template: { path: 'template.html', format: format ? String(format).slice(0, 60) : undefined },
    preview: 'preview.jpg',
  };
  validateItem(item);
  fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify(item, null, 2) + '\n');
  results.push({ slug: job.slug, pages: out.pages, editable, kb: Math.round(out.html.length / 1024), fonts: fonts.slice(0, 3).join('/'), warnings: (rep.warnings || []).length });
}
console.table(results);
