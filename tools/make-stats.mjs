// Writes seed/_stats.json: simulated votes, use counts and dates for the seed materials, so that ranking can be
// tried out before real people vote. Numbers follow a judgment of what matters most when running a university group:
// recruiting at the start of term (stall, intro talk, announcements) first, event logistics next, association admin last.
// Usage: node tools/make-stats.mjs && commons add seed/*/ --stats seed/_stats.json   (moderator token required)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const TIERS = {
  S: { score: [105, 150], slugs: 'tabling-kit poster-series-template trifold-flyer-template outreach-announcement-texts event-slide-kit' },
  A: {
    score: [58, 98],
    slugs: 'instagram-series-template rollup-banner-template speaker-invitation-email lecture-pitch-request-to-professor welcome-new-members-message intro-talk-kit outreach-channels-checklist group-landing-page-template semester-overview-slides-template organizer-role-handover-doc ai-safety-workshops-web-demos aisa-brand-kit rollup-banner-print-file slide-master-template group-website-aisafetyaachen marketing-master-doc event-day-runsheet wayfinding-signs-template',
  },
  B: {
    score: [26, 56],
    slugs: 'speaker-invitation-email event-reminder-message feedback-survey-template event-planning-timeline name-badges-template event-runsheet-template event-kit-checklist meeting-agenda-and-minutes-template semester-budget-template group-website-copy-blocks post-event-follow-up registration-received-confirmation university-room-or-stall-request share-request-with-ready-blurb program-application-responses training-data-detector-demo feedback-survey-questions lecture-hall-pitch-deck semester-overview-deck attendee-guide guest-invitation-email-policymakers event-sponsorship-request event-runsheet-forum-2025 group-budget-workbook volunteer-roles-and-mandates event-budget-planned-vs-actual',
  },
  D: { score: [3, 9], slugs: 'notary-appointment-board-change members-assembly-invitation founding-a-registered-association-checklist small-grants-guideline-and-register venue-screens-brief in-kind-sponsor-request testimonial-request-past-attendee notary-emails-founding-an-association tax-office-enquiry-research-stipends small-grants-award-guideline event-postponement-notice-to-speakers event-registration-sheet' },
};
const C = [9, 25]; // everything else: useful for one event type

// Deterministic pseudo-random numbers per slug, so re-running gives the same stats.
function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
// Share of the people who used a material that also upvoted it, by tier.
const LIKED = { S: [0.5, 0.64], A: [0.4, 0.54], B: [0.3, 0.44], C: [0.2, 0.36], D: [0.14, 0.26] };

const stats = {};
for (const slug of fs.readdirSync(SEED).sort()) {
  const file = path.join(SEED, slug, 'item.json');
  if (!fs.existsSync(file)) continue;
  const item = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = rng(slug);
  const between = ([a, b]) => a + r() * (b - a);
  const tier = Object.values(TIERS).find((t) => t.slugs.split(' ').includes(slug));
  let range = tier ? tier.score : C;
  if (!tier && item.category === 'photo') range = [12, 40];
  if (!tier && item.category === 'brand') range = [30, 60];
  const score = Math.round(between(range));
  const down = Math.round(score * between([0.02, 0.14]));
  const up = score + down;
  const tierName = Object.keys(TIERS).find((k) => TIERS[k] === tier) || 'C';
  const uses = Math.round(up / between(LIKED[tierName]));
  // Popular materials tend to be older (they had time to collect votes), with exceptions so that Hot differs from Top.
  const age = Math.round(between(score > 55 ? [45, 235] : [6, 200]));
  const created = new Date(Date.UTC(2026, 10, 11, 9 + Math.floor(r() * 10), Math.floor(r() * 60)) - age * 864e5);
  stats[slug] = { up, down, uses, created_at: created.toISOString() };
}
fs.writeFileSync(path.join(SEED, '_stats.json'), JSON.stringify(stats, null, 1) + '\n');
const sorted = Object.entries(stats).sort((a, b) => b[1].up - b[1].down - (a[1].up - a[1].down));
console.log(`${sorted.length} materials. Top: ${sorted.slice(0, 6).map(([s, v]) => `${s} ${v.up - v.down}`).join(', ')}`);
