// Ranking, modelled on Reddit / Hacker News.
//
// hot  : Reddit's "hot" formula, sign * log10(max(|score|, 1)) + age_term, with a slow clock:
//        organizing materials stay useful for semesters, so an item needs 10x the score to outrank
//        one that was posted one semester (180 days) later. (Reddit uses 12.5 hours.)
// best : the formula from the proposal: upvotes / downloads * ln(downloads). It rewards materials that
//        people who actually used them liked, and discounts tiny samples.
// top  : upvotes - downvotes.
// new  : newest first.

export const HOT_PERIOD_DAYS = 180;
const EPOCH = Date.parse('2026-01-01T00:00:00Z') / 1000;

export function score(item) {
  return (item.up || 0) - (item.down || 0);
}

export function hot(item) {
  const s = score(item);
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  const seconds = Date.parse(item.created_at || 0) / 1000 - EPOCH;
  return sign * order + seconds / (HOT_PERIOD_DAYS * 86400);
}

export function best(item) {
  const up = item.up || 0;
  // Every upvote implies at least one use, so downloads can never be below upvotes.
  const downloads = Math.max(item.uses || 0, up, 1);
  return (up / downloads) * Math.log(downloads + 1);
}

export function sortItems(items, sort = 'hot') {
  const key = sort === 'best' ? best : sort === 'top' ? score : sort === 'new' ? (i) => Date.parse(i.created_at || 0) : hot;
  return [...items].sort((a, b) => key(b) - key(a) || Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}
