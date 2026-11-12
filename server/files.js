// Where the bytes of files live: a local folder (development, tests) or a Cloud Storage bucket.
// Every store (store.js, store-pg.js) keeps its files through one of these two classes:
//   putFile(slug, path, buffer, contentType)   readFile(slug, path) -> Buffer|null
//   fileStream(slug, path) -> Readable|null     copyFiles(from, to, paths)
//   deleteFiles(slug, prefix)                   deleteAll(slug)
//   stat(slug, path) -> { size, contentType }|null      ping()
// `slug` is the owner of the files: a material, or "_sites" / "_accounts" with the name as the first folder.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class FolderFiles {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  // Paths are validated by the routes; this is the second lock on the door.
  full(slug, p = '') {
    const full = path.join(this.dir, slug, p);
    if (!slug || full === this.dir || !full.startsWith(this.dir + path.sep)) throw new Error(`path outside the store: ${slug}/${p}`);
    return full;
  }
  async ping() {
    await fsp.access(this.dir);
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
  async deleteAll(slug) {
    await fsp.rm(this.full(slug), { recursive: true, force: true });
  }
  async copyFiles(from, to, paths) {
    for (const p of paths) {
      const buf = await this.readFile(from, p);
      if (buf) await this.putFile(to, p, buf);
    }
  }
  async stat(slug, p) {
    try {
      const s = await fsp.stat(this.full(slug, p));
      return s.isFile() ? { size: s.size, contentType: null } : null;
    } catch {
      return null;
    }
  }
}

// Objects are named items/<slug>/<path>.
export class BucketFiles {
  async init(name) {
    const { Storage } = await import('@google-cloud/storage');
    this.bucket = new Storage().bucket(name);
    return this;
  }
  async ping() {
    await this.bucket.getFiles({ maxResults: 1, autoPaginate: false });
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
  async deleteFiles(slug, prefix) {
    if (!prefix) throw new Error('deleteFiles needs a prefix');
    if (prefix.endsWith('/')) await this.bucket.deleteFiles({ prefix: `items/${slug}/${prefix}`, force: true });
    else await this.bucket.file(`items/${slug}/${prefix}`).delete({ ignoreNotFound: true });
  }
  async deleteAll(slug) {
    await this.bucket.deleteFiles({ prefix: `items/${slug}/`, force: true });
  }
  async copyFiles(from, to, paths) {
    await Promise.all(paths.map((p) => this.bucket.file(`items/${from}/${p}`).copy(this.bucket.file(`items/${to}/${p}`))));
  }
  async stat(slug, p) {
    try {
      const [m] = await this.bucket.file(`items/${slug}/${p}`).getMetadata();
      return { size: Number(m.size), contentType: m.contentType || null };
    } catch {
      return null;
    }
  }
  // Every object of the bucket (current versions only), as plain records. Used by tools/migrate-to-postgres.mjs.
  async list(prefix = 'items/') {
    const [files] = await this.bucket.getFiles({ prefix });
    return files.map((f) => ({ name: f.name, size: Number(f.metadata.size), contentType: f.metadata.contentType || null, updated: f.metadata.updated || null }));
  }
}
