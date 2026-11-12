// Accounts: a user name, a group and a password. No email, so there is no password reset yet.
// A session is a signed token the browser sends in the X-Session header. Nothing is stored per session; a token is
// checked against the account on every request (see sessions()), so it stops working when the account is deleted
// or its password changes, and a role change applies at once.

import crypto from 'node:crypto';

// SESSION_SECRET signs sessions, preview links and file keys. Without it the moderator token is used (the first
// deployments had only that), and without either a random key that lasts until the process restarts.
const SECRET = (process.env.SESSION_SECRET || '').trim() || (process.env.ADMIN_TOKEN || '').trim();
if (!(process.env.SESSION_SECRET || '').trim()) {
  console.warn(SECRET ? 'SESSION_SECRET is not set: sessions are signed with a key derived from ADMIN_TOKEN. Set SESSION_SECRET to keep the two apart.' : 'SESSION_SECRET is not set: sessions end when this process restarts.');
}
const KEY = crypto
  .createHash('sha256')
  .update('commons-session:' + (SECRET || crypto.randomBytes(32).toString('hex')))
  .digest();
const mac = (body) => crypto.createHmac('sha256', KEY).update(body).digest('base64url');
const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const USERNAME = /^[a-z0-9][a-z0-9-]{2,29}$/;
export const SESSION_DAYS = 30;

export function sign(payload, days = SESSION_DAYS) {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + days * 864e5 })).toString('base64url');
  return `${body}.${mac(body)}`;
}

// Returns the signed payload ({ u, ..., exp }) or null. Used for sessions and for preview links of hosted sites.
export function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  if (!sameText(sig, mac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() && USERNAME.test(p.u) ? p : null;
  } catch {
    return null;
  }
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

export function checkPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !/^[0-9a-f]{64}$/.test(hash || '')) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(password), salt, 32), Buffer.from(hash, 'hex'));
}

export const publicAccount = (a) => ({ username: a.username, group: a.group, role: a.role, created_at: a.created_at });
export const sessionFor = (a) => ({ token: sign({ u: a.username, g: a.group, r: a.role }), account: publicAccount(a) });

// Sessions, checked against the stored account. Accounts are kept in memory for `ttl` ms, so a signed-in visitor
// costs one database read per half minute, and a deletion or role change made on another server instance takes
// effect within that time (at once on the instance that made it, through forget()).
export function sessions(store, { ttl = 30000, max = 5000 } = {}) {
  const cache = new Map();
  const load = async (username) => {
    const hit = cache.get(username);
    if (hit && Date.now() - hit.at < ttl) return hit.acct;
    const acct = await store.getDoc('accounts', username);
    if (cache.size >= max) cache.delete(cache.keys().next().value);
    cache.set(username, { acct, at: Date.now() });
    return acct;
  };
  return {
    // Returns { u: user name, g: group, r: role } or null.
    async resolve(token) {
      if (!token) return null;
      const p = verify(token);
      // A preview link of a hosted site is signed with the same key and names a site; it is not a session.
      if (!p || p.site !== undefined) return null;
      const acct = await load(p.u);
      if (!acct || acct.username !== p.u) return null;
      // Tokens from before the account existed (the name belonged to someone else) or before its password changed.
      const issued = p.iat ?? p.exp - SESSION_DAYS * 864e5;
      if (issued < Math.max(Date.parse(acct.created_at) || 0, acct.valid_from || 0)) return null;
      return { u: acct.username, g: acct.group, r: acct.role };
    },
    forget: (username) => cache.delete(username),
  };
}

// Sign-in throttle per user name: after `max` wrong passwords within `windowMs` the name is locked for `windowMs`.
// Kept in memory, so it counts per server instance. It comes on top of the per-address rate limit.
export function throttle({ max = 5, windowMs = 15 * 60e3, entries = 20000 } = {}) {
  const table = new Map();
  return {
    // Seconds until the name can be tried again, or 0.
    blocked(name) {
      const t = table.get(name);
      if (!t) return 0;
      if (t.until && t.until > Date.now()) return Math.ceil((t.until - Date.now()) / 1000);
      if (t.first + windowMs < Date.now()) table.delete(name);
      return 0;
    },
    fail(name) {
      const now = Date.now();
      let t = table.get(name);
      if (!t || t.first + windowMs < now) {
        if (table.size >= entries) table.delete(table.keys().next().value);
        table.set(name, (t = { n: 0, first: now, until: 0 }));
      }
      if (++t.n >= max) Object.assign(t, { until: now + windowMs, first: now, n: 0 });
    },
    clear: (name) => table.delete(name),
  };
}

// Files of a material that is not published yet are served only to people who may see the material. Pictures and
// frames cannot send headers, so those people get a key that goes into the address: /files/~<key>/<slug>/<path>.
// It expires, so the address cannot serve as a lasting public link to something no moderator has looked at.
export const FILE_KEY_HOURS = 6;
export function fileKey(slug, hours = FILE_KEY_HOURS) {
  const exp = (Date.now() + hours * 3600e3).toString(36);
  return `${exp}.${mac(`file:${slug}:${exp}`).slice(0, 32)}`;
}
export function checkFileKey(key, slug) {
  const [exp, sig] = String(key || '').split('.');
  if (!exp || !sig || !(parseInt(exp, 36) > Date.now())) return false;
  return sameText(sig, mac(`file:${slug}:${exp}`).slice(0, 32));
}
