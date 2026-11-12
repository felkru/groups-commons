// Talks to the server and keeps small bits of state in localStorage.

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: the page still works, it just forgets */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
let client = store.get('commons_client', null);
if (!client) store.set('commons_client', (client = uuid()));

export const adminToken = () => store.get('commons_admin', '') || '';
export const editKeys = () => store.get('commons_keys', {});
export function rememberKey(slug, key) {
  store.set('commons_keys', { ...editKeys(), [slug]: key });
}

export async function api(path, { method = 'GET', body, raw, type, editKey } = {}) {
  const headers = { 'X-Client-Id': client };
  const session = store.get('commons_session', '');
  if (session) headers['X-Session'] = session;
  if (adminToken()) headers['X-Admin-Token'] = adminToken();
  if (editKey) headers['X-Edit-Key'] = editKey;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status });
  noteFileKeys(json);
  return json;
}

// Files of a material that is not published yet are served only with a key, which the server puts on the material
// when it answers someone who may see it (the uploader, moderators). The key goes into the address of its files.
const fileKeys = {};
function noteFileKeys(json) {
  for (const item of [json, ...(Array.isArray(json?.items) ? json.items : []), ...(Array.isArray(json?.materials) ? json.materials : [])]) {
    if (!item || typeof item.slug !== 'string' || !('status' in item)) continue;
    if (item.file_key) fileKeys[item.slug] = item.file_key;
    else delete fileKeys[item.slug];
  }
}
// The folder a material's files are served from; relative addresses inside a template resolve against it.
export const fileBase = (slug) => (fileKeys[slug] ? `/files/~${fileKeys[slug]}/${slug}/` : `/files/${slug}/`);
export const filePath = (slug, path) => fileBase(slug) + String(path).split('/').map(encodeURIComponent).join('/');

// The three-step upload used by the web form (the CLI does the same).
// files: [{ path, data (Blob | string), type }]
export async function uploadItem(meta, files = []) {
  const created = await api('/items', { method: 'POST', body: { ...meta, auto_slug: true } });
  rememberKey(created.slug, created.edit_key);
  for (const f of files) {
    await api(`/items/${created.slug}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', raw: f.data, type: f.type, editKey: created.edit_key });
  }
  const done = await api(`/items/${created.slug}/publish`, { method: 'POST', body: {}, editKey: created.edit_key });
  return { slug: created.slug, status: done.status };
}
