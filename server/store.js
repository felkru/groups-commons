// Storage backends. STORE=local keeps everything under ./data (development and tests);
// STORE=gcp uses Firestore (named database) for items and votes and a Cloud Storage bucket for files.
//
// Both expose the same async interface:
//   allItems() getItem(slug) putItem(item) deleteItem(slug)
//   patchItem(slug, patch) -> the item, or null when it does not exist (any more)
//   putFile(slug, path, buffer, contentType) readFile(slug, path) -> Buffer|null
//   fileStream(slug, path) -> Readable|null   copyFiles(from, to, paths)   deleteFiles(slug, prefix)
//   vote(slug, clientId, dir) -> {up, down, my}   votesOf(clientId) -> {slug: dir}
//   incr(slug, field, n)   takeQuota(name, limit) -> boolean
//   getDoc(collection, id) setDoc(collection, id, data) deleteDoc(collection, id) listDocs(collection)
//   createDoc(collection, id, data) -> false when the id is taken (atomic, unlike getDoc + setDoc)
//   ping() resolves when the store answers   close() flushes pending writes

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
// Ids come from addresses. A plain object would also answer for "constructor" or "__proto__"; only own keys count.
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const notFound = () => Object.assign(new Error('No material with that name.'), { status: 404, expose: true });

class LocalStore {
  constructor(dir) {
    this.dir = dir;
    this.dbPath = path.join(dir, 'db.json');
    this.filesDir = path.join(dir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = { items: {}, votes: {}, quota: {}, docs: {} };
    if (fs.existsSync(this.dbPath)) this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.dbPath, 'utf8')) };
  }
  save() {
    clearTimeout(this.timer);
    this.dirty = true;
    this.timer = setTimeout(() => this.flush(), 50);
  }
  // Written to a second file and renamed, so a crash in the middle never leaves half a database.
  flush() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.writeFileSync(this.dbPath + '.tmp', JSON.stringify(this.db));
      fs.renameSync(this.dbPath + '.tmp', this.dbPath);
    } catch (e) {
      console.error('could not write', this.dbPath, e);
    }
  }
  async close() {
    this.flush();
  }
  async ping() {
    await fsp.access(this.filesDir);
  }
  // Paths are validated by the routes; this is the second lock on the door.
  full(slug, p = '') {
    const full = path.join(this.filesDir, slug, p);
    if (!slug || full === this.filesDir || !full.startsWith(this.filesDir + path.sep)) throw new Error(`path outside the store: ${slug}/${p}`);
    return full;
  }
  async allItems() {
    return Object.values(this.db.items);
  }
  async getItem(slug) {
    return own(this.db.items, slug) || null;
  }
  async putItem(item) {
    this.db.items[item.slug] = item;
    this.save();
  }
  async patchItem(slug, patch) {
    const item = own(this.db.items, slug);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }
  async deleteItem(slug) {
    if (Object.hasOwn(this.db.items, slug)) delete this.db.items[slug];
    for (const k of Object.keys(this.db.votes)) if (k.startsWith(slug + '__')) delete this.db.votes[k];
    await fsp.rm(this.full(slug), { recursive: true, force: true });
    this.save();
  }
  async putFile(slug, p, buffer) {
    const full = this.full(slug, p);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
  }
  async readFile(slug, p) {
    try {
      return await fsp.readFile(this.full(slug, p));
    } catch {
      return null;
    }
  }
  async fileStream(slug, p) {
    const full = this.full(slug, p);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return fs.createReadStream(full);
  }
  // Removes one file, or everything below a folder when the prefix ends in "/".
  async deleteFiles(slug, prefix) {
    if (!prefix) throw new Error('deleteFiles needs a prefix');
    await fsp.rm(this.full(slug, prefix), { recursive: true, force: true });
  }
  async copyFiles(from, to, paths) {
    for (const p of paths) {
      const buf = await this.readFile(from, p);
      if (buf) await this.putFile(to, p, buf);
    }
  }
  async vote(slug, clientId, dir) {
    const item = own(this.db.items, slug);
    if (!item) throw notFound();
    const key = `${slug}__${clientId}`;
    const prev = this.db.votes[key] || 0;
    item.up = (item.up || 0) + (dir === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
    item.down = (item.down || 0) + (dir === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
    if (dir === 0) delete this.db.votes[key];
    else this.db.votes[key] = dir;
    this.save();
    return { up: item.up, down: item.down, my: dir };
  }
  async votesOf(clientId) {
    const out = {};
    for (const [k, dir] of Object.entries(this.db.votes)) {
      const i = k.lastIndexOf('__');
      if (k.slice(i + 2) === clientId) out[k.slice(0, i)] = dir;
    }
    return out;
  }
  async incr(slug, field, n = 1) {
    const item = own(this.db.items, slug);
    if (item) item[field] = (item[field] || 0) + n;
    this.save();
  }
  async getDoc(coll, id) {
    return own(own(this.db.docs, coll), id) || null;
  }
  async createDoc(coll, id, data) {
    if (own(own(this.db.docs, coll), id)) return false;
    await this.setDoc(coll, id, data);
    return true;
  }
  async setDoc(coll, id, data) {
    (this.db.docs[coll] ||= {})[id] = data;
    this.save();
  }
  async deleteDoc(coll, id) {
    const docs = own(this.db.docs, coll);
    if (docs && Object.hasOwn(docs, id)) delete docs[id];
    this.save();
  }
  async listDocs(coll) {
    return Object.values(own(this.db.docs, coll) || {});
  }
  async takeQuota(name, limit) {
    const key = `${today()}:${name}`;
    const used = this.db.quota[key] || 0;
    if (used >= limit) return false;
    this.db.quota[key] = used + 1;
    this.save();
    return true;
  }
}

class GcpStore {
  async init() {
    const { Firestore, FieldValue } = await import('@google-cloud/firestore');
    const { Storage } = await import('@google-cloud/storage');
    this.FieldValue = FieldValue;
    this.db = new Firestore({ databaseId: process.env.FIRESTORE_DB || 'commons', ignoreUndefinedProperties: true });
    this.items = this.db.collection('items');
    this.votes = this.db.collection('votes');
    this.meta = this.db.collection('meta');
    this.bucket = new Storage().bucket(process.env.BUCKET);
    this.cache = new Map();
    this.loadedAt = 0;
    this.ready = false;
    // A failed first read must not stop the server from starting (e.g. permissions still propagating after a deploy).
    await this.refresh().catch((e) => console.error('initial load failed, will retry on the first request:', e.message));
    return this;
  }
  // Items are few (hundreds), so every instance keeps them in memory and re-reads periodically.
  async refresh() {
    const snap = await this.items.get();
    const next = new Map();
    snap.forEach((d) => next.set(d.id, d.data()));
    this.cache = next;
    this.loadedAt = Date.now();
    this.ready = true;
  }
  async fresh() {
    if (!this.ready) return this.refresh();
    if (Date.now() - this.loadedAt > 20000) {
      this.loadedAt = Date.now();
      this.refresh().catch((e) => console.error('refresh failed', e.message));
    }
  }
  async allItems() {
    await this.fresh();
    return [...this.cache.values()];
  }
  async getItem(slug) {
    await this.fresh();
    if (this.cache.has(slug)) return this.cache.get(slug);
    const d = await this.items.doc(slug).get();
    if (!d.exists) return null;
    this.cache.set(slug, d.data());
    return d.data();
  }
  async putItem(item) {
    await this.items.doc(item.slug).set(item);
    this.cache.set(item.slug, item);
  }
  async patchItem(slug, patch) {
    try {
      await this.items.doc(slug).update(patch);
    } catch (e) {
      if (e.code !== 5) throw e; // 5 = NOT_FOUND: deleted in the meantime, possibly by another instance
      this.cache.delete(slug);
      return null;
    }
    const cur = this.cache.get(slug);
    return cur ? Object.assign(cur, patch) : { slug, ...patch };
  }
  async deleteItem(slug) {
    await this.items.doc(slug).delete();
    this.cache.delete(slug);
    const votes = await this.votes.where('slug', '==', slug).get();
    // A batch takes at most 500 writes.
    for (let i = 0; i < votes.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const d of votes.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
    await this.bucket.deleteFiles({ prefix: `items/${slug}/`, force: true });
  }
  async deleteFiles(slug, prefix) {
    if (!prefix) throw new Error('deleteFiles needs a prefix');
    if (prefix.endsWith('/')) await this.bucket.deleteFiles({ prefix: `items/${slug}/${prefix}`, force: true });
    else await this.bucket.file(`items/${slug}/${prefix}`).delete({ ignoreNotFound: true });
  }
  async ping() {
    await Promise.all([this.meta.doc('health').get(), this.bucket.getFiles({ maxResults: 1, autoPaginate: false })]);
  }
  async close() {
    await this.db.terminate();
  }
  async putFile(slug, p, buffer, contentType) {
    await this.bucket.file(`items/${slug}/${p}`).save(buffer, { resumable: false, contentType, metadata: { cacheControl: 'public, max-age=300' } });
  }
  async readFile(slug, p) {
    try {
      const [buf] = await this.bucket.file(`items/${slug}/${p}`).download();
      return buf;
    } catch {
      return null;
    }
  }
  async fileStream(slug, p) {
    return this.bucket.file(`items/${slug}/${p}`).createReadStream();
  }
  async copyFiles(from, to, paths) {
    await Promise.all(paths.map((p) => this.bucket.file(`items/${from}/${p}`).copy(this.bucket.file(`items/${to}/${p}`))));
  }
  async vote(slug, clientId, dir) {
    const vref = this.votes.doc(`${slug}__${clientId}`);
    const iref = this.items.doc(slug);
    const result = await this.db.runTransaction(async (tx) => {
      const [v, i] = await Promise.all([tx.get(vref), tx.get(iref)]);
      if (!i.exists) throw notFound();
      const prev = v.exists ? v.data().dir : 0;
      const up = (i.data().up || 0) + (dir === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
      const down = (i.data().down || 0) + (dir === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
      tx.update(iref, { up, down });
      if (dir === 0) tx.delete(vref);
      else tx.set(vref, { slug, client: clientId, dir, at: new Date().toISOString() });
      return { up, down, my: dir };
    });
    const cur = this.cache.get(slug);
    if (cur) Object.assign(cur, { up: result.up, down: result.down });
    return result;
  }
  async votesOf(clientId) {
    const snap = await this.votes.where('client', '==', clientId).get();
    const out = {};
    snap.forEach((d) => (out[d.data().slug] = d.data().dir));
    return out;
  }
  async incr(slug, field, n = 1) {
    const cur = this.cache.get(slug);
    if (cur) cur[field] = (cur[field] || 0) + n;
    await this.items.doc(slug).update({ [field]: this.FieldValue.increment(n) }).catch((e) => {
      if (e.code !== 5) throw e; // the material was deleted: nothing to count
    });
  }
  async createDoc(coll, id, data) {
    try {
      await this.db.collection(coll).doc(id).create(data);
      return true;
    } catch (e) {
      if (e.code === 6) return false; // ALREADY_EXISTS
      throw e;
    }
  }
  async getDoc(coll, id) {
    const d = await this.db.collection(coll).doc(id).get();
    return d.exists ? d.data() : null;
  }
  async setDoc(coll, id, data) {
    await this.db.collection(coll).doc(id).set(data);
  }
  async deleteDoc(coll, id) {
    await this.db.collection(coll).doc(id).delete();
  }
  async listDocs(coll) {
    const snap = await this.db.collection(coll).get();
    return snap.docs.map((d) => d.data());
  }
  async takeQuota(name, limit) {
    const ref = this.meta.doc(`quota-${today()}`);
    const d = await ref.get();
    if (((d.exists && d.data()[name]) || 0) >= limit) return false;
    await ref.set({ [name]: this.FieldValue.increment(1) }, { merge: true });
    return true;
  }
}

export async function openStore() {
  if ((process.env.STORE || 'local') === 'gcp') return new GcpStore().init();
  return new LocalStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
}
