// Running the service: health check, start and graceful shutdown, response headers, bounded in-memory tables
// and housekeeping. Kept apart from the routes in index.js.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { critical } from './log.js';

// ---- headers ----
export const HSTS = 'max-age=31536000; includeSubDomains';
// The site uses none of these browser features; hosted pages and uploaded files must not either.
export const PERMISSIONS_POLICY = 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()';
export const commonHeaders = (req, res, next) => {
  res.set({ 'Strict-Transport-Security': HSTS, 'Permissions-Policy': PERMISSIONS_POLICY });
  next();
};

// Static assets: there is no build step and so no fingerprinted file names. Pages, scripts and styles revalidate on
// every load (a cheap 304), so a deploy is visible at once; the intro video, images and fonts may be kept for a day.
const MEDIA = /\.(mp4|webm|jpe?g|png|webp|gif|svg|ico|woff2?)$/i;
export const staticHeaders = (siteHeaders) => (res, filePath) => {
  siteHeaders(res);
  if (MEDIA.test(filePath)) res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
};

// ---- errors ----
// What a visitor may be told. Errors this code raises are plain Error objects with a message written for people
// (and usually a status). Errors from libraries (Firestore, Cloud Storage, the auth client, Node itself) carry
// project names, addresses and the like: they are logged, and the visitor gets a general sentence.
export const isOurs = (err) => err?.expose === true || (err?.constructor === Error && err.code === undefined && err.response === undefined && err.config === undefined);
export function publicError(err) {
  const type = err?.type;
  if (type === 'entity.too.large') return { status: 413, message: 'That file is too large.' };
  if (type === 'entity.parse.failed') return { status: 400, message: 'The request body is not valid JSON.' };
  if (typeof type === 'string' && err.status >= 400 && err.status < 500) return { status: err.status, message: 'The request could not be read.' };
  if (err instanceof URIError) return { status: 400, message: 'The address is not valid.' };
  if (isOurs(err) && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) return { status: err.status, message: err.message };
  return { status: 500, message: 'Something went wrong on the server.' };
}

// ---- bounded tables (rate limits, counters): the oldest entries go first, so memory cannot grow without limit ----
export function boundedMap(max) {
  const map = new Map();
  const set = map.set.bind(map);
  map.set = (k, v) => {
    map.delete(k); // re-inserting moves the key to the end
    set(k, v);
    while (map.size > max) map.delete(map.keys().next().value);
    return map;
  };
  return map;
}

// Rate limits count per address. One IPv6 customer usually holds a whole /64, so those count as one address.
export const addressKey = (ip = '') => (ip.includes(':') && !ip.includes('.') ? ip.split(':').slice(0, 4).join(':') : ip);

// ---- health ----
// GET /api/health: 200 when the store answers, 503 when it does not. The answer is kept for a few seconds, so
// probes and curious visitors cannot turn into a stream of database reads.
export function health(store, { ttl = 5000, timeout = 4000 } = {}) {
  let last = null;
  const started = Date.now();
  const check = async () => {
    let timer;
    try {
      await Promise.race([store.ping(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), timeout)))]);
      return { ok: true };
    } catch (e) {
      console.error('health check failed:', e);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  };
  return async (req, res) => {
    if (!last || Date.now() - last.at > ttl) last = { at: Date.now(), result: check() };
    const { ok } = await last.result;
    res.status(ok ? 200 : 503).json({ ok, store: ok ? 'ok' : 'unreachable', uptime_s: Math.round((Date.now() - started) / 1000) });
  };
}

// ---- housekeeping ----
// A material that was created but never submitted (the upload broke off) is removed after two days.
export const DRAFT_MAX_AGE_MS = 48 * 3600e3;
export async function sweepDrafts(store, { now = Date.now(), onDelete = () => {} } = {}) {
  let removed = 0;
  for (const item of await store.allItems()) {
    const at = Date.parse(item.updated_at || item.created_at || ''); // no date: NaN, and the draft is left alone
    if (item.status !== 'draft' || !(at < now - DRAFT_MAX_AGE_MS)) continue;
    await store.deleteItem(item.slug);
    onDelete(item);
    removed++;
  }
  return removed;
}

// ---- start and stop ----
export const isMain = (metaUrl) => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
};

// Starts listening. Returns { server, port, close }. close() stops accepting connections, lets requests that are
// under way finish (up to `grace` ms) and flushes the store.
export function serve(app, { port, store, grace = 9000, hourly = [], banner = '' }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('error', reject);
    server.once('listening', () => {
      // An error on the listening socket later on (for example no file handles left) is logged, not thrown.
      server.on('error', (e) => console.error('server error:', e));
      const actual = server.address().port;
      console.log(`groups-commons listening on :${actual}${banner ? ` (${banner})` : ''}`);
      const jobs = setInterval(() => {
        for (const job of hourly) Promise.resolve().then(job).catch((e) => console.error('housekeeping failed:', e));
      }, 3600e3);
      jobs.unref();
      let closing = null;
      const close = () =>
        (closing ||= new Promise((done) => {
          clearInterval(jobs);
          const force = setTimeout(() => server.closeAllConnections?.(), grace);
          force.unref();
          server.close(async () => {
            clearTimeout(force);
            await Promise.resolve(store?.close?.()).catch((e) => console.error('closing the store failed:', e));
            done();
          });
          server.closeIdleConnections?.(); // keep-alive connections with no request in flight
        }));
      resolve({ server, port: actual, close });
    });
  });
}

// For `node server/index.js`: Cloud Run sends SIGTERM before it removes an instance and waits ten seconds.
export function handleSignals(running) {
  const stop = (signal) => {
    console.log(`${signal} received: finishing open requests, then exiting`);
    running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 9500).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  // A rejected promise nobody handled is a bug in one request; it is logged and the other requests go on.
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason));
  // After an exception nobody caught the state of the process is unknown: log it, finish what is open, restart.
  process.on('uncaughtException', (err) => {
    critical('uncaught exception:', err);
    running.close().then(() => process.exit(1));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
