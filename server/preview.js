// Preview images: pages of a PDF (pdftoppm, from poppler-utils), Office files converted with LibreOffice (soffice),
// and resized thumbnails (sharp, optional).

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.warn('sharp not available: thumbnails are served at full size');
}

export async function pdfFirstPage(buffer) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commons-pdf-'));
  try {
    await fsp.writeFile(path.join(dir, 'in.pdf'), buffer);
    await new Promise((resolve, reject) =>
      execFile('pdftoppm', ['-jpeg', '-r', '70', '-f', '1', '-l', '1', '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'out')], { timeout: 30000 }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    return await fsp.readFile(path.join(dir, 'out.jpg'));
  } catch (e) {
    console.warn('pdf preview failed:', e.message);
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const cache = new Map();
// Returns a JPEG buffer at most `width` px wide, or null when resizing is unavailable.
export async function thumbnail(key, buffer, width) {
  if (!sharp) return null;
  const k = `${key}@${width}`;
  if (cache.has(k)) return cache.get(k);
  try {
    const out = await sharp(buffer).rotate().resize({ width, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(k, out);
    return out;
  } catch (e) {
    console.warn('thumbnail failed:', e.message);
    return null;
  }
}
export function dropThumbnails(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

// The first `max` pages of a PDF as JPEG buffers.
export async function pdfPages(buffer, max = 12) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commons-pages-'));
  try {
    await fsp.writeFile(path.join(dir, 'in.pdf'), buffer);
    await new Promise((resolve, reject) =>
      execFile('pdftoppm', ['-jpeg', '-r', '72', '-f', '1', '-l', String(max), path.join(dir, 'in.pdf'), path.join(dir, 'p')], { timeout: 60000 }, (err) => (err ? reject(err) : resolve())),
    );
    const names = (await fsp.readdir(dir)).filter((n) => /^p-\d+\.jpg$/.test(n)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    return Promise.all(names.map((n) => fsp.readFile(path.join(dir, n))));
  } catch (e) {
    console.warn('pdf pages failed:', e.message);
    return [];
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// PowerPoint, Word, Excel and OpenDocument files to PDF. Returns null when LibreOffice is not installed or fails.
export async function officeToPdf(buffer, extension) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commons-office-'));
  try {
    const input = path.join(dir, `in.${extension}`);
    await fsp.writeFile(input, buffer);
    await new Promise((resolve, reject) =>
      execFile('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], { timeout: 120000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await fsp.readFile(path.join(dir, 'in.pdf'));
  } catch (e) {
    console.warn('office conversion failed:', e.message);
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
