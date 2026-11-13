// PDF printable -> re-brandable HTML template, without redrawing anything (see skill/TEMPLATE.md).
//
// How it works (deterministic, no LLM, only poppler-utils):
//   1. `pdftocairo -svg` turns each page into an SVG that keeps every vector shape, clip, mask and image as it is.
//      In that SVG text is drawn as <use> references to glyph outlines.
//   2. `pdftotext -bbox-layout` gives the words (text + box), `pdftohtml -xml` the font name and size of each text run.
//      Every word is matched to its glyph <use> elements by position. That gives the exact baseline and fill colour
//      of the word, and tells which outlines to take out of the artwork. Words that cannot be matched stay in the
//      artwork as outlines, so nothing is lost and nothing is drawn twice.
//   3. Matched words become live text: absolutely positioned lines (or paragraphs with fixed line breaks) on top of
//      the SVG, each with a unique `data-edit` key, anchored on the original baseline whatever font is loaded.
//      Text at 90/180/270 degrees is rotated with CSS; text at other angles stays in the artwork as outlines.
//   4. The colours used by artwork and text are ranked by the area they cover (a small `pdftoppm` render) and the
//      main ones are replaced by `var(--brand-…)` with the original colour as the default value. Exact tints of
//      the two brand colours become `color-mix()` of the variable; text on a brand-coloured surface gets
//      `var(--brand-on-color)`.
//   5. Raster images stay inside the SVG untouched (JPEG data is passed through byte for byte, everything else is
//      lossless PNG). A picture that the PDF draws through a soft mask is merged with that mask into one PNG with
//      transparency (pixels unchanged), because Chrome prints SVG masks badly. Photos get `data-photo="photo_N"`
//      on the SVG <image> element.
//
// Where it runs: on the organizer's computer, not on the server. The site serves this file as /cli/convert-pdf.mjs and
// "commons convert" (cli/commons.mjs) downloads and imports it. So it has to stay ONE file that needs only Node's own
// modules and the poppler tools on the PATH; sharp is used when it happens to be installed.
//
// Verified with poppler 26 / cairo 1.18 (tools/convert-test.mjs). Older systems (Debian 12) have cairo 1.16, which
// writes the SVG in an older form: the parser accepts it, but that form was only tested as an imitation.
//
// Output details the editor has to know about are listed at the end of this file (EDITOR NOTES).

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PT_MM = 25.4 / 72;
const POPPLER_ZOOM = 3; // pdftohtml caps -zoom at 3: font sizes come in thirds of a point
const CONTRACT_DEFAULTS = {
  '--brand-color': '#8391f6',
  '--brand-accent': '#c76d7e',
  '--brand-dark': '#252627',
  '--brand-light': '#fefee0',
  '--brand-on-color': '#ffffff',
  '--brand-on-accent': '#ffffff',
};
const QR_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='white'/%3E%3Cpath d='M8 8h28v28H8zM64 8h28v28H64zM8 64h28v28H8z' fill='none' stroke='%23252627' stroke-width='8'/%3E%3Ctext x='50' y='56' font-family='sans-serif' font-size='12' text-anchor='middle' fill='%23252627'%3EQR%3C/text%3E%3C/svg%3E";

// ---------------------------------------------------------------------------------------------------------------
// small helpers

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const unesc = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const median = (list) => {
  const a = [...list].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};
const hex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split('\n').slice(-2).join(' ');
        const e = new Error(err.code === 'ENOENT' ? `${cmd} is not installed (poppler-utils is required)` : `${cmd} failed${err.killed ? ' (timed out)' : ''}: ${detail || err.message}`);
        e.tool = cmd;
        return reject(e);
      }
      resolve({ stdout, stderr: String(stderr || '') });
    });
  });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// geometry

const IDENTITY = [1, 0, 0, 1, 0, 0];
// m then n is "apply n first": result = m * n
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function parseTransform(s) {
  let m = IDENTITY;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n = IDENTITY;
    if (t[1] === 'matrix' && v.length === 6) n = v;
    else if (t[1] === 'translate') n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
    else if (t[1] === 'scale') n = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
    else if (t[1] === 'rotate') {
      const a = ((v[0] || 0) * Math.PI) / 180;
      n = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (v.length === 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
    }
    m = mul(m, n);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// colour

function parseRgb(s) {
  const m = /rgb\(\s*([\d.]+)(%?)\s*,\s*([\d.]+)(%?)\s*,\s*([\d.]+)(%?)\s*\)/.exec(s || '');
  if (!m) return null;
  return hex([1, 3, 5].map((i) => (m[i + 1] ? (parseFloat(m[i]) * 255) / 100 : parseFloat(m[i]))));
}
function colourInfo(h) {
  const [r, g, b] = unhex(h);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const chroma = max - min;
  const s = chroma === 0 ? 0 : chroma / 255 / (1 - Math.abs(2 * l - 1) || 1);
  // very light pastels count as tinted neutrals (candidates for --brand-light), not as brand colours
  return { l, chroma, s, chromatic: chroma >= 40 && s >= 0.2 && l < 0.86 && l > 0.05 };
}
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

// Is `target` an exact mix of `base` with white or black? Returns a CSS expression or null.
function tintOf(target, base, variable) {
  const t = unhex(target);
  const b = unhex(base);
  for (const [other, name] of [[[255, 255, 255], 'white'], [[0, 0, 0], 'black']]) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < 3; i++) {
      num += (t[i] - other[i]) * (b[i] - other[i]);
      den += (b[i] - other[i]) ** 2;
    }
    if (!den) continue;
    const p = num / den;
    if (p < 0.04 || p > 0.96) continue;
    const mixed = b.map((v, i) => other[i] + (v - other[i]) * p);
    if (dist(mixed, t) <= 1.2) return `color-mix(in srgb, var(${variable}) ${round(p * 100, 2)}%, ${name})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// raster helpers (PPM from pdftoppm, PNG soft masks from cairo)

function parsePpm(buf) {
  let pos = 0;
  const token = () => {
    while (buf[pos] === 0x23 || buf[pos] <= 0x20) {
      if (buf[pos] === 0x23) while (buf[pos] !== 0x0a) pos++;
      pos++;
    }
    let s = '';
    while (buf[pos] > 0x20) s += String.fromCharCode(buf[pos++]);
    return s;
  };
  if (token() !== 'P6') return null;
  const w = +token();
  const h = +token();
  const max = +token();
  pos++;
  if (!w || !h || max !== 255 || buf.length < pos + w * h * 3) return null;
  return { w, h, data: buf.subarray(pos, pos + w * h * 3) };
}

// Colour histogram of a page render: Map of 0xRRGGBB -> number of sampled pixels.
function histogram(ppm, step = 2) {
  const map = new Map();
  let total = 0;
  for (let y = 0; y < ppm.h; y += step) {
    for (let x = 0; x < ppm.w; x += step) {
      const i = (y * ppm.w + x) * 3;
      const key = (ppm.data[i] << 16) | (ppm.data[i + 1] << 8) | ppm.data[i + 2];
      map.set(key, (map.get(key) || 0) + 1);
      total++;
    }
  }
  return { map, total };
}

// Most common colour around a box that is not the text colour itself (the surface a text line sits on).
function surfaceAt(ppm, scale, box, textRgb) {
  const x0 = Math.max(0, Math.floor(box.x0 * scale));
  const x1 = Math.min(ppm.w - 1, Math.ceil(box.x1 * scale));
  const y0 = Math.max(0, Math.floor(box.y0 * scale));
  const y1 = Math.min(ppm.h - 1, Math.ceil(box.y1 * scale));
  const bins = new Map();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * ppm.w + x) * 3;
      const rgb = [ppm.data[i], ppm.data[i + 1], ppm.data[i + 2]];
      if (dist(rgb, textRgb) < 48) continue;
      const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
      const bin = bins.get(key) || { n: 0, sum: [0, 0, 0] };
      bin.n++;
      for (let c = 0; c < 3; c++) bin.sum[c] += rgb[c];
      bins.set(key, bin);
    }
  }
  let best = null;
  let total = 0;
  for (const bin of bins.values()) {
    total += bin.n;
    if (!best || bin.n > best.n) best = bin;
  }
  if (!best || best.n < total * 0.5) return null;
  return best.sum.map((v) => v / best.n);
}

// A QR code is a near-square block of black and white modules: almost only two tones and many changes per row.
function looksLikeQr(ppm, scale, box) {
  const w = (box.x1 - box.x0) * scale;
  const h = (box.y1 - box.y0) * scale;
  if (w < 24 || h < 24 || Math.abs(w - h) / Math.max(w, h) > 0.12) return false;
  const x0 = Math.max(0, Math.round(box.x0 * scale));
  const x1 = Math.min(ppm.w - 1, Math.round(box.x1 * scale));
  const y0 = Math.max(0, Math.round(box.y0 * scale));
  const y1 = Math.min(ppm.h - 1, Math.round(box.y1 * scale));
  let dark = 0;
  let light = 0;
  let mid = 0;
  let flips = 0;
  let rows = 0;
  for (let y = y0; y <= y1; y++) {
    let last = -1;
    rows++;
    for (let x = x0; x <= x1; x++) {
      const i = (y * ppm.w + x) * 3;
      const r = ppm.data[i];
      const g = ppm.data[i + 1];
      const b = ppm.data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) {
        mid += 2;
        continue;
      }
      const v = (r + g + b) / 3;
      const cls = v < 96 ? 0 : v > 176 ? 1 : -1;
      if (cls === 0) dark++;
      else if (cls === 1) light++;
      else mid++;
      if (cls >= 0) {
        if (last >= 0 && cls !== last) flips++;
        last = cls;
      }
    }
  }
  const total = dark + light + mid;
  if (!total) return false;
  return mid / total < 0.3 && dark / total > 0.18 && light / total > 0.25 && flips / rows >= 10;
}

// Rows of an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA). `onRow(row, y)` may return false to stop.
// Returns { w, h, channels } or null when the PNG is of a kind this small reader does not handle.
function pngRows(input, onRow, maxBytes = 200e6) {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let pos = 8;
    let head = null;
    const parts = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') head = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
      else if (type === 'IDAT') parts.push(data);
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!head || head.depth !== 8 || head.interlace) return null;
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[head.type];
    if (!channels || head.w * head.h * channels > maxBytes) return null;
    const raw = zlib.inflateSync(Buffer.concat(parts));
    const stride = head.w * channels;
    let prev = new Uint8Array(stride);
    for (let y = 0; y < head.h; y++) {
      const filter = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const cur = new Uint8Array(stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0;
        const b = prev[x];
        const c = x >= channels ? prev[x - channels] : 0;
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v;
      }
      if (onRow(cur, y, channels) === false) break;
      prev = cur;
    }
    return { w: head.w, h: head.h, channels };
  } catch {
    return null;
  }
}

// Lowest value of the first channel (cairo writes soft masks as grey PNGs): 255 means the mask hides nothing.
function pngMin(base64) {
  let min = 255;
  const head = pngRows(base64, (row, y, channels) => {
    for (let x = 0; x < row.length; x += channels) if (row[x] < min) min = row[x];
    return min >= 250;
  });
  return head?.channels === 1 ? min : null;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// RGBA pixels -> PNG (filter "sub" on every row)
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[y * stride + x] - (x >= 4 ? rgba[y * stride + x - 4] : 0)) & 255;
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// A picture and its soft mask (two images in the PDF and in cairo's SVG) -> one PNG with an alpha channel.
// SVG masks print badly from Chrome (some PDF viewers show a black box), and a picture that carries its own
// transparency can be replaced without inheriting the outline of the old one.
// Uses sharp when it is installed (any picture format, any size); otherwise plain JS for PNG pictures up to 24 MP.
// Returns base64 PNG data or null.
let sharpLib;
async function bakeAlpha(picture, mask, useSharp = true) {
  if (sharpLib === undefined) sharpLib = await import('sharp').then((m) => m.default, () => null);
  const pixels = picture.w * picture.h;
  if (sharpLib && useSharp) {
    try {
      const src = sharpLib(Buffer.from(picture.data, 'base64'), { limitInputPixels: false });
      const meta = await src.metadata();
      if (!meta.hasAlpha && meta.width === picture.w && meta.height === picture.h) {
        const alpha = await sharpLib(Buffer.from(mask.data, 'base64'), { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
        if (alpha.length === pixels) {
          const out = await src.toColourspace('srgb').joinChannel(alpha, { raw: { width: picture.w, height: picture.h, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
          return out.toString('base64');
        }
      }
    } catch {
      /* try the plain reader below */
    }
  }
  if (picture.mime !== 'image/png' || pixels > 24e6) return null;
  const rgba = Buffer.alloc(pixels * 4);
  const a = pngRows(picture.data, (row, y, n) => {
    if (n !== 1 && n !== 3) return false;
    for (let x = 0; x < picture.w; x++) {
      const o = (y * picture.w + x) * 4;
      rgba[o] = row[x * n];
      rgba[o + 1] = row[x * n + (n === 3 ? 1 : 0)];
      rgba[o + 2] = row[x * n + (n === 3 ? 2 : 0)];
    }
  });
  if (!a || (a.channels !== 1 && a.channels !== 3) || a.w !== picture.w || a.h !== picture.h) return null;
  const m = pngRows(mask.data, (row, y, n) => {
    for (let x = 0; x < picture.w; x++) rgba[(y * picture.w + x) * 4 + 3] = row[x * n];
  });
  if (!m || m.channels !== 1 || m.w !== picture.w || m.h !== picture.h) return null;
  return encodePng(picture.w, picture.h, rgba).toString('base64');
}

// ---------------------------------------------------------------------------------------------------------------
// the SVG written by cairo (both the 1.18 form: <g id="glyph-0-1">, fill="rgb(..)" and the 1.16 form:
// <symbol id="glyph0-1">, style="fill:rgb(..)")

const BULLET = /^(?:[\u2022\u25cf\u25cb\u25e6\u25aa\u25ab\u25a0\u25a1\u2023\u2043\u2219\u00b7\u27a2\u2192\u2013\u2014*+>-]|\(?[0-9a-zA-Z]{1,2}[.)])$/;
const GLYPH_ID = /^glyph-?(\d+)-(\d+)$/;
const DEF_CONTAINERS = new Set(['defs', 'clipPath', 'mask', 'pattern', 'filter', 'linearGradient', 'radialGradient', 'symbol', 'marker']);

// The part of a tag before a (possibly huge) data URI, so that attribute lookups stay cheap.
function tagHead(raw) {
  const i = raw.indexOf('href="data:');
  return i < 0 ? raw : raw.slice(0, i);
}
function attr(raw, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(raw);
  return m ? m[1] : null;
}
function styleProp(raw, name) {
  const direct = attr(raw, name);
  if (direct != null) return direct;
  const style = attr(raw, 'style');
  if (!style) return null;
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
  return m ? m[1].trim() : null;
}

const tfOwn = (head, ctm) => {
  const tf = attr(head, 'transform');
  return tf ? mul(ctm, parseTransform(tf)) : ctm;
};

function analyseSvg(svg) {
  const tokens = [];
  const re = /<[^>]+>/g;
  let m;
  while ((m = re.exec(svg))) {
    const raw = m[0];
    if (raw[1] === '?' || raw[1] === '!') continue;
    const close = raw[1] === '/';
    const name = /^<\/?([\w:-]+)/.exec(raw)?.[1] || '';
    tokens.push({ raw, name, close, self: !close && raw.endsWith('/>'), head: close ? raw : tagHead(raw) });
  }
  const root = tokens.find((t) => t.name === 'svg' && !t.close);
  if (!root) throw new Error('pdftocairo did not write an SVG');
  const vb = (attr(root.raw, 'viewBox') || '').split(/[\s,]+/).map(Number);
  const size = vb.length === 4 && vb[2] > 0 ? { w: vb[2], h: vb[3] } : { w: parseFloat(attr(root.raw, 'width')), h: parseFloat(attr(root.raw, 'height')) };

  const imageIds = new Set();
  for (const t of tokens) if (t.name === 'image' && !t.close) imageIds.add(attr(t.head, 'id'));

  const fillArea = new Map(); // fill colour -> area of the boxes of the shapes painted with it (an upper bound)
  const glyphDefs = new Map(); // id -> { start, end, empty }
  const glyphUses = [];
  const images = new Map(); // id -> { index, w, h, mime, data }
  const imageUses = [];
  const masks = new Map(); // id -> { start, end, images: [] }
  const stack = [{ ctm: IDENTITY, fill: null, opacity: 1, defs: false, mask: null, maskRef: null, glyph: null, index: -1 }];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.close) {
      const top = stack.length > 1 ? stack.pop() : stack[0];
      if (top.own?.end === -1) top.own.end = i;
      continue;
    }
    const parent = stack[stack.length - 1];
    const ctx = { ...parent, own: null, index: i };
    const h = t.head;
    const id = attr(h, 'id');
    if (DEF_CONTAINERS.has(t.name)) ctx.defs = true;
    if (t.name === 'mask') {
      ctx.mask = id;
      ctx.own = { start: i, end: -1, images: [] };
      masks.set(id, ctx.own);
    }
    if (id && GLYPH_ID.test(id) && (t.name === 'g' || t.name === 'symbol') && parent.defs) {
      ctx.defs = true;
      ctx.own = { start: i, end: t.self ? i : -1, empty: true };
      ctx.glyph = ctx.own;
      glyphDefs.set(id, ctx.own);
    }
    if (parent.glyph && t.name !== 'g' && (t.name !== 'path' || /[\d]/.test(attr(h, 'd') || ''))) parent.glyph.empty = false;
    const tf = attr(h, t.name === 'pattern' ? 'patternTransform' : 'transform');
    if (tf) ctx.ctm = mul(parent.ctm, parseTransform(tf));
    const fill = styleProp(h, 'fill');
    if (!ctx.defs && (t.name === 'path' || t.name === 'rect')) {
      const colour = parseRgb(fill || parent.fill);
      if (colour) {
        const n = t.name === 'path' ? (attr(h, 'd') || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [] : [];
        const pts = [];
        if (t.name === 'rect') {
          const [x, y, w, hh] = ['x', 'y', 'width', 'height'].map((k) => parseFloat(attr(h, k) || '0'));
          pts.push([x, y], [x + w, y], [x, y + hh], [x + w, y + hh]);
        } else for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k], n[k + 1]]);
        if (pts.length > 1) {
          const m = tfOwn(h, parent.ctm);
          const q = pts.map(([x, y]) => apply(m, x, y));
          const area = (Math.max(...q.map((v) => v[0])) - Math.min(...q.map((v) => v[0]))) * (Math.max(...q.map((v) => v[1])) - Math.min(...q.map((v) => v[1])));
          fillArea.set(colour, (fillArea.get(colour) || 0) + area);
        }
      }
    }
    if (fill) ctx.fill = fill;
    const op = styleProp(h, 'fill-opacity');
    if (op != null && op !== '') ctx.opacity = parseFloat(op);
    const maskRef = /url\(#([^)]+)\)/.exec(attr(h, 'mask') || '');
    if (maskRef) ctx.maskRef = { id: maskRef[1], index: i };

    if (t.name === 'use') {
      const href = (attr(h, 'xlink:href') ?? attr(h, 'href') ?? '').replace(/^#/, '');
      const x = parseFloat(attr(h, 'x') || '0');
      const y = parseFloat(attr(h, 'y') || '0');
      const g = GLYPH_ID.exec(href);
      if (g) {
        if (!parent.defs) {
          const [px, py] = apply(ctx.ctm, x, y);
          glyphUses.push({ index: i, parent: parent.index, id: href, font: +g[1], x: px, y: py, fill: ctx.fill, opacity: ctx.opacity, word: null });
        }
      } else if (imageIds.has(href)) {
        const use = { index: i, id: href, ctm: mul(ctx.ctm, [1, 0, 0, 1, x, y]), mask: ctx.mask, maskRef: parent.defs ? null : ctx.maskRef, defs: parent.defs && !ctx.mask, filter: attr(h, 'filter') || '' };
        imageUses.push(use);
        if (ctx.mask) masks.get(ctx.mask)?.images.push(href);
      }
    } else if (t.name === 'image') {
      const hrefAt = t.raw.indexOf('href="data:');
      let mime = '';
      let data = '';
      if (hrefAt >= 0) {
        const comma = t.raw.indexOf(',', hrefAt);
        mime = /data:([^;,]+)/.exec(t.raw.slice(hrefAt, comma + 1))?.[1] || '';
        data = t.raw.slice(comma + 1, t.raw.indexOf('"', comma));
      }
      const key = id || `inline-${i}`;
      images.set(key, { id: key, index: i, w: parseFloat(attr(h, 'width')) || 0, h: parseFloat(attr(h, 'height')) || 0, mime, data, direct: !parent.defs });
      if (!parent.defs) imageUses.push({ index: i, id: key, ctm: mul(ctx.ctm, [1, 0, 0, 1, parseFloat(attr(h, 'x') || '0'), parseFloat(attr(h, 'y') || '0')]), mask: null, maskRef: ctx.maskRef, defs: false, direct: true });
    }
    if (!t.self) stack.push(ctx);
  }
  return { tokens, size, glyphDefs, glyphUses, images, imageUses, masks, fillArea };
}

// Every paint (fill, stroke, gradient stop) of a tag: [{ prop, hex }]
const PAINT = /(fill|stroke|stop-color|flood-color)(\s*=\s*"|\s*:\s*)(rgb\([^)]*\))/g;
function paintsOf(head) {
  const out = [];
  PAINT.lastIndex = 0;
  let m;
  while ((m = PAINT.exec(head))) {
    const h = parseRgb(m[3]);
    if (h) out.push({ prop: m[1], hex: h });
  }
  return out;
}
// Replace mapped paints. A presentation attribute becomes a style declaration, because var() is only guaranteed there.
function repaint(head, map) {
  const moved = [];
  let out = head.replace(/\s(fill|stroke|stop-color|flood-color)\s*=\s*"(rgb\([^)]*\))"/g, (all, prop, value) => {
    const to = map.get(parseRgb(value));
    if (!to) return all;
    moved.push(`${prop}:${to}`);
    return '';
  });
  out = out.replace(/(fill|stroke|stop-color|flood-color)(\s*:\s*)(rgb\([^)]*\))/g, (all, prop, sep, value) => {
    const to = map.get(parseRgb(value));
    return to ? `${prop}${sep}${to}` : all;
  });
  if (moved.length) {
    if (/\sstyle\s*=\s*"/.test(out)) out = out.replace(/(\sstyle\s*=\s*")/, `$1${moved.join(';')};`);
    else out = out.replace(/^(<[\w:-]+)/, `$1 style="${moved.join(';')}"`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// text sources

// pdftotext -bbox-layout: pages -> blocks -> lines -> words (boxes in points, y down)
function parseBbox(html) {
  const pages = [];
  const re = /<(page|block|line|word)\b([^>]*)>([^<]*)|<\/(page|block|line)>/g;
  let page = null;
  let block = null;
  let line = null;
  let m;
  const num = (s, k) => parseFloat(new RegExp(`${k}="([^"]*)"`).exec(s)?.[1] || '0');
  while ((m = re.exec(html))) {
    if (m[1] === 'page') {
      page = { w: num(m[2], 'width'), h: num(m[2], 'height'), blocks: [] };
      pages.push(page);
    } else if (m[1] === 'block' && page) {
      block = { lines: [] };
      page.blocks.push(block);
    } else if (m[1] === 'line' && page) {
      if (!block) {
        block = { lines: [] };
        page.blocks.push(block);
      }
      line = { words: [] };
      block.lines.push(line);
    } else if (m[1] === 'word' && page) {
      if (!line) {
        block = { lines: [] };
        page.blocks.push(block);
        line = { words: [] };
        block.lines.push(line);
      }
      const text = unesc(m[3]);
      if (text.trim()) line.words.push({ text, x0: num(m[2], 'xMin'), y0: num(m[2], 'yMin'), x1: num(m[2], 'xMax'), y1: num(m[2], 'yMax'), glyphs: [] });
    } else if (m[4] === 'line') line = null;
    else if (m[4] === 'block') {
      block = null;
      line = null;
    } else if (m[4] === 'page') page = block = line = null;
  }
  return pages;
}

// pdftohtml -xml: text runs with font id; fontspecs with size, family and colour. Coordinates are scaled to points.
function parseRuns(xml) {
  const pages = new Map();
  const fonts = new Map();
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
  let p;
  while ((p = pageRe.exec(xml))) {
    const number = +(/number="(\d+)"/.exec(p[1])?.[1] || 0);
    const width = +(/width="(\d+)"/.exec(p[1])?.[1] || 0);
    const runs = [];
    const fs = /<fontspec\b([^>]*)\/>/g;
    let f;
    while ((f = fs.exec(p[2]))) {
      fonts.set(/id="(\d+)"/.exec(f[1])?.[1], { px: +(/size="(-?\d+)"/.exec(f[1])?.[1] || 0), family: unesc(/family="([^"]*)"/.exec(f[1])?.[1] || ''), color: /color="([^"]*)"/.exec(f[1])?.[1] || '#000000', page: number });
    }
    const tx = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let t;
    while ((t = tx.exec(p[2]))) {
      const n = (k) => +(new RegExp(`${k}="(-?\\d+)"`).exec(t[1])?.[1] || 0);
      // plain text plus a bold/italic flag per character
      let plain = '';
      const flags = [];
      let bold = 0;
      let italic = 0;
      for (const part of t[2].split(/(<[^>]+>)/)) {
        if (/^<b>$/i.test(part)) bold++;
        else if (/^<\/b>$/i.test(part)) bold = Math.max(0, bold - 1);
        else if (/^<i>$/i.test(part)) italic++;
        else if (/^<\/i>$/i.test(part)) italic = Math.max(0, italic - 1);
        else if (part[0] !== '<') {
          const s = unesc(part);
          plain += s;
          for (let i = 0; i < s.length; i++) flags.push((bold ? 1 : 0) | (italic ? 2 : 0));
        }
      }
      runs.push({ x: n('left'), y: n('top'), w: n('width'), h: n('height'), font: /font="(\d+)"/.exec(t[1])?.[1], plain, flags });
    }
    pages.set(number, { width, runs });
  }
  return { pages, fonts };
}

// The size pdftohtml reports is rounded to 1/zoom points; prefer the whole or half point inside that interval.
function snapSize(px, zoom) {
  const lo = (px - 0.5) / zoom;
  const hi = (px + 0.5) / zoom;
  for (const step of [1, 0.5]) {
    const v = Math.round(px / zoom / step) * step;
    if (v >= lo - 1e-9 && v < hi - 1e-9 && v > 0) return v;
  }
  return round(px / zoom, 3);
}

// ---------------------------------------------------------------------------------------------------------------
// fonts

const STYLE_WORDS = /^(thin|hairline|extra|ultra|light|regular|book|roman|normal|medium|semi|demi|bold|heavy|black|italic|ital|it|oblique|mt|ps|psmt|std|pro)$/i;
const ALIASES = {
  'linux libertine g': 'Libertinus Serif',
  'linux libertine': 'Libertinus Serif',
  'linux libertine o': 'Libertinus Serif',
  'linux biolinum g': 'Libertinus Sans',
  'linux biolinum': 'Libertinus Sans',
  arial: 'Arimo',
  helvetica: 'Arimo',
  'helvetica neue': 'Arimo',
  'liberation sans': 'Arimo',
  'times new roman': 'Tinos',
  times: 'Tinos',
  'liberation serif': 'Tinos',
  'courier new': 'Cousine',
  courier: 'Cousine',
  'liberation mono': 'Cousine',
  calibri: 'Carlito',
  cambria: 'Caladea',
};
// Used only when Google Fonts cannot be asked (offline): families known to exist there.
const KNOWN_GOOGLE = new Set(
  'vollkorn,newsreader,fraunces,playfair display,lora,source serif 4,merriweather,libre baskerville,dm serif display,bitter,hanken grotesk,inter,space grotesk,sora,archivo,bricolage grotesque,montserrat,poppins,ibm plex sans,work sans,manrope,dm sans,outfit,roboto,open sans,lato,noto sans,noto serif,raleway,nunito,oswald,libertinus serif,libertinus sans,arimo,tinos,cousine,carlito,caladea,frank ruhl libre,frank ruhl hofshi'.split(','),
);
const SERIF = /serif|times|tinos|garamond|georgia|libertin|minion|caslon|baskerville|antiqua|palatino|cambria|caladea|charter|ruhl|merriweather|playfair|lora|vollkorn|newsreader|fraunces|bitter|bodoni|didot|century|book/i;
const MONO = /mono|courier|cousine|consol|code|menlo|typewriter/i;

function parseFontName(raw, bold, italic) {
  const name = raw.replace(/^[A-Z]{6}\+/, '');
  const words = name
    .replace(/[_,-]+/g, ' ')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  let cut = words.length;
  while (cut > 1 && STYLE_WORDS.test(words[cut - 1])) cut--;
  const style = words.slice(cut).join(' ').toLowerCase();
  let weight = 400;
  if (/thin|hairline/.test(style)) weight = 100;
  else if (/(extra|ultra) light/.test(style)) weight = 200;
  else if (/light/.test(style)) weight = 300;
  else if (/medium/.test(style)) weight = 500;
  else if (/(semi|demi)( bold)?/.test(style)) weight = 600;
  else if (/(extra|ultra) bold|heavy/.test(style)) weight = 800;
  else if (/black/.test(style)) weight = 900;
  else if (/bold/.test(style) || bold) weight = 700;
  return { pdfName: name, family: words.slice(0, cut).join(' '), weight, italic: !!italic || /ital|oblique|\bit\b/.test(style) };
}

const fontCache = new Map();
async function askGoogle(family, weight, italic) {
  const key = `${family}|${weight}|${italic}`;
  if (fontCache.has(key)) return fontCache.get(key);
  const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}`;
  const ok = async (url) => (await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' } })).ok;
  let result;
  try {
    if (await ok(`${base}:ital,wght@${italic ? 1 : 0},${weight}`)) result = { available: true, exact: true, checked: true };
    else if (await ok(base)) result = { available: true, exact: weight === 400 && !italic, checked: true };
    else result = { available: false, exact: false, checked: true };
    fontCache.set(key, result);
  } catch {
    result = { available: KNOWN_GOOGLE.has(family.toLowerCase()), exact: false, checked: false };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// page formats

function formatLabel(w, h) {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const dir = w > h ? 'landscape' : w < h ? 'portrait' : 'square';
  const named = [['A6', 105, 148], ['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['A2', 420, 594], ['A1', 594, 841], ['A0', 841, 1189], ['US Letter', 215.9, 279.4], ['US Legal', 215.9, 355.6]];
  for (const [name, a, b] of named) if (Math.abs(short - a) <= 1.5 && Math.abs(long - b) <= 1.5) return `${name} ${dir}`;
  if (w > h && Math.abs(w / h - 16 / 9) < 0.01) return `Slide 16:9 (${round(w, 0)} × ${round(h, 0)} mm)`;
  if (w > h && Math.abs(w / h - 4 / 3) < 0.01) return `Slide 4:3 (${round(w, 0)} × ${round(h, 0)} mm)`;
  return `${round(w, 0)} × ${round(h, 0)} mm ${dir}`;
}

// ---------------------------------------------------------------------------------------------------------------
// text: match words to glyphs, build lines and paragraphs

function buildText(page, svg, runs, fonts, zoomScale, warnings, pageNo) {
  const { glyphUses, glyphDefs } = svg;
  const sx = page ? svg.size.w / (page.w || svg.size.w) : 1;
  const sy = page ? svg.size.h / (page.h || svg.size.h) : 1;
  const words = [];
  for (const [bi, block] of (page?.blocks || []).entries()) {
    for (const [li, line] of block.lines.entries()) {
      for (const w of line.words) {
        Object.assign(w, { x0: w.x0 * sx, x1: w.x1 * sx, y0: w.y0 * sy, y1: w.y1 * sy, block: bi, line: li });
        words.push(w);
      }
    }
  }

  // 1. every visible glyph goes to the word whose box holds its origin (the best fitting baseline wins)
  const visible = glyphUses.filter((g) => !glyphDefs.get(g.id)?.empty);
  const byY = [...visible].sort((a, b) => a.y - b.y);
  const best = new Map();
  for (const w of words) {
    let lo = 0;
    let hi = byY.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byY[mid].y < w.y0 - 0.5) lo = mid + 1;
      else hi = mid;
    }
    const expected = w.y0 + (w.y1 - w.y0) * 0.78;
    // the box of a word can start a little after the origin of its first glyph (side bearing), never a whole glyph
    const slack = Math.max(0.6, (w.y1 - w.y0) * 0.08);
    for (let i = lo; i < byY.length && byY[i].y <= w.y1 + 0.5; i++) {
      const g = byY[i];
      if (g.x < w.x0 - slack || g.x > w.x1 - 0.05) continue;
      const score = Math.abs(g.y - expected) + Math.max(0, w.x0 - g.x) * 4;
      const cur = best.get(g);
      if (!cur || score < cur.score) best.set(g, { word: w, score });
    }
  }
  for (const [g, b] of best) {
    g.word = b.word;
    b.word.glyphs.push(g);
  }

  // direction of the text at each glyph, from its neighbours in drawing order (a line break is a lone outlier)
  const angle = (a, b) => (Math.hypot(b.x - a.x, b.y - a.y) > 0.3 ? (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI : null);
  const alike = (p, q) => p != null && q != null && Math.abs(((p - q + 540) % 360) - 180) < 3;
  const pair = visible.map((g, i) => (i + 1 < visible.length && visible[i + 1].font === g.font ? angle(g, visible[i + 1]) : null));
  visible.forEach((g, i) => {
    const next = pair[i];
    const prev = i > 0 ? pair[i - 1] : null;
    g.theta = alike(next, pair[i + 1]) || alike(next, prev) ? next : alike(prev, i > 1 ? pair[i - 2] : null) ? prev : null;
  });
  const snapAngle = (t) => {
    const right = Math.round(t / 90) * 90;
    return (((Math.abs(t - right) < 2 ? right : Math.round(t)) % 360) + 360) % 360;
  };
  const spaces = glyphUses.filter((g) => glyphDefs.get(g.id)?.empty);
  const fontsWithSpaces = new Set(spaces.map((g) => g.font));

  // 2. the font of each glyph set (cairo numbers them per font and size) by vote of the pdftohtml runs
  const votes = new Map();
  const fuzzy = new Map();
  const pageRuns = runs?.runs || [];
  for (const w of words) {
    const chars = [...w.text].length;
    w.ok = w.glyphs.length >= Math.max(1, Math.ceil(chars * 0.34));
    if (!w.ok) continue;
    w.glyphs.sort((a, b) => a.x - b.x || a.y - b.y);
    const count = new Map();
    for (const g of w.glyphs) count.set(g.font, (count.get(g.font) || 0) + 1);
    w.font = [...count].sort((a, b) => b[1] - a[1])[0][0];
    const fills = new Map();
    for (const g of w.glyphs) fills.set(`${g.fill}|${g.opacity}`, (fills.get(`${g.fill}|${g.opacity}`) || 0) + 1);
    const [fill, opacity] = [...fills].sort((a, b) => b[1] - a[1])[0][0].split('|');
    w.color = parseRgb(fill);
    w.opacity = parseFloat(opacity);
    const cx = ((w.x0 + w.x1) / 2) * zoomScale;
    const cy = ((w.y0 + w.y1) / 2) * zoomScale;
    let hit = null;
    for (const r of pageRuns) {
      if (cx < r.x - 2 || cx > r.x + r.w + 2 || cy < r.y - 2 || cy > r.y + r.h + 2) continue;
      if (!hit || r.w * r.h < hit.w * hit.h) hit = r;
    }
    if (!hit) {
      // rotated text: pdftohtml reports it as short pieces with a box of no width; take the nearest piece
      let near = Infinity;
      for (const r of pageRuns) {
        const d = Math.hypot(Math.max(r.x - cx, 0, cx - r.x - r.w), Math.max(r.y - cy, 0, cy - r.y - r.h));
        if (d < near && d <= Math.max(r.h, r.w) * 1.5 && fonts.has(r.font)) {
          near = d;
          hit = r;
        }
      }
      if (hit) {
        const key = `${hit.font}|${hit.flags[0] || 0}`;
        if (!fuzzy.has(w.font)) fuzzy.set(w.font, new Map());
        fuzzy.get(w.font).set(key, (fuzzy.get(w.font).get(key) || 0) + chars);
      }
      continue;
    }
    if (!fonts.has(hit.font)) continue;
    // where in the run is this word? (for bold / italic parts of a run)
    const guess = Math.round(((cx - hit.x) / Math.max(1, hit.w)) * hit.plain.length);
    let at = -1;
    for (let i = hit.plain.indexOf(w.text); i >= 0; i = hit.plain.indexOf(w.text, i + 1)) {
      if (at < 0 || Math.abs(i + w.text.length / 2 - guess) < Math.abs(at + w.text.length / 2 - guess)) at = i;
    }
    const flag = hit.flags[Math.max(0, Math.min(hit.flags.length - 1, at >= 0 ? at : guess))] || 0;
    const key = `${hit.font}|${flag}`;
    if (!votes.has(w.font)) votes.set(w.font, new Map());
    votes.get(w.font).set(key, (votes.get(w.font).get(key) || 0) + chars);
  }
  const styleOfFont = new Map();
  for (const [font, v] of fuzzy) if (!votes.has(font)) votes.set(font, v);
  for (const [font, v] of votes) {
    const [fontId, flag] = [...v].sort((a, b) => b[1] - a[1])[0][0].split('|');
    const spec = fonts.get(fontId);
    styleOfFont.set(font, { raw: spec.family, size: snapSize(spec.px, POPPLER_ZOOM), bold: !!(+flag & 1), italic: !!(+flag & 2) });
  }

  // 3. words -> line segments (a wide gap starts a new segment, so table columns keep their place)
  let unmatched = 0;
  let doubled = 0;
  let slanted = 0;
  const segments = [];
  for (const [bi, block] of (page?.blocks || []).entries()) {
    for (const [li, line] of block.lines.entries()) {
      let seg = null;
      for (const w of line.words) {
        const st = w.ok ? styleOfFont.get(w.font) : null;
        if (!st || !w.color) {
          if (w.ok) for (const g of w.glyphs) g.word = null;
          w.ok = false;
          unmatched++;
          seg = null;
          continue;
        }
        if (w.glyphs.length >= [...w.text].length * 1.8 && [...w.text].length > 2) doubled++;
        // direction of the baseline from the first to the last glyph
        const a = w.glyphs[0];
        const far = w.glyphs.reduce((p, g) => (Math.hypot(g.x - a.x, g.y - a.y) > Math.hypot(p.x - a.x, p.y - a.y) ? g : p), a);
        let theta = null;
        const seen = new Map();
        for (const g of w.glyphs) if (g.theta != null) seen.set(snapAngle(g.theta), (seen.get(snapAngle(g.theta)) || 0) + 1);
        if (seen.size) theta = [...seen].sort((x, y) => y[1] - x[1])[0][0];
        else if (Math.hypot(far.x - a.x, far.y - a.y) > 0.5 && Math.abs(far.x - a.x) < Math.abs(far.y - a.y)) theta = snapAngle((Math.atan2(far.y - a.y, far.x - a.x) * 180) / Math.PI);
        if (theta != null && theta % 90 !== 0) {
          // text at an odd angle: pdftotext cuts it into pieces that cannot be put together again; it stays artwork
          for (const g of w.glyphs) g.word = null;
          w.ok = false;
          slanted++;
          seg = null;
          continue;
        }
        w.theta = theta;
        w.style = `${st.raw}|${st.size}|${st.bold}|${st.italic}|${w.color}|${w.opacity}`;
        w.st = st;
        const th = theta ?? seg?.theta ?? 0;
        const rad = (th * Math.PI) / 180;
        const u = (x, y) => x * Math.cos(rad) + y * Math.sin(rad);
        const v = (x, y) => -x * Math.sin(rad) + y * Math.cos(rad);
        const corners = [[w.x0, w.y0], [w.x1, w.y0], [w.x0, w.y1], [w.x1, w.y1]].map(([x, y]) => u(x, y));
        // glyphs of an unrotated word start at its left edge; otherwise take the first glyph along the baseline
        w.glyphs.sort((p, q) => u(p.x, p.y) - u(q.x, q.y));
        // The origin of the first glyph is where a browser starts the word. (The box pdftotext reports can start up
        // to 0.7pt before or after it.) Only when the first glyph seems to be missing is the box used.
        const first = u(w.glyphs[0].x, w.glyphs[0].y);
        const boxStart = Math.min(...corners);
        w.u0 = first - boxStart > st.size * 0.25 ? boxStart : first;
        w.u1 = Math.max(...corners);
        w.v = median(w.glyphs.map((g) => v(g.x, g.y)));
        const em = st.size;
        // a gap much wider than a space (a tab, a table column, the distance after a list bullet) starts a new segment
        const gap = seg ? w.u0 - seg.u1 : 0;
        const afterBullet = seg && seg.words.length === 1 && BULLET.test(seg.words[0].text);
        const spaced = seg && seg.words.length >= 3 && seg.words.every((x) => [...x.text].length <= 2); // letter-spaced heading
        const fits = seg && seg.theta === th && gap < em * (afterBullet ? 0.45 : spaced ? 1.8 : 0.8) && gap > -em * 0.5 && Math.abs(w.v - seg.v) < em * 0.45;
        if (!fits) {
          seg = { words: [], theta: th, u0: w.u0, u1: w.u1, v: w.v, block: bi, line: li, page: pageNo };
          segments.push(seg);
        }
        seg.words.push(w);
        seg.u1 = Math.max(seg.u1, w.u1);
      }
    }
  }
  if (unmatched) warnings.push(`Page ${pageNo}: ${unmatched} word(s) reported by pdftotext have no visible glyphs or no known font (hidden OCR text, clipped text or an unusual font); they were not made editable.`);
  if (slanted) warnings.push(`Page ${pageNo}: ${slanted} piece(s) of text are rotated by an angle that is not a multiple of 90°; they stay in the artwork as outlines and are not editable.`);
  if (doubled) warnings.push(`Page ${pageNo}: ${doubled} word(s) are drawn more than once in the PDF (shadow or fake bold); the copies were merged into one live text.`);

  // 4. style of each segment: the style carrying the most characters; other styles become inline spans
  for (const s of segments) {
    const weight = new Map();
    for (const w of s.words) weight.set(w.style, (weight.get(w.style) || 0) + w.text.length);
    const main = [...weight].sort((a, b) => b[1] - a[1])[0][0];
    const lead = s.words.find((w) => w.style === main);
    s.style = main;
    s.st = lead.st;
    s.color = lead.color;
    s.opacity = lead.opacity;
    s.v = median(s.words.filter((w) => w.style === main).map((w) => w.v));
    // Letter-spaced text ("S P A C E D") arrives as one-letter words. Where the PDF draws no space glyph between
    // two of them they are one word: joined again, with the gap as CSS letter-spacing.
    s.tracking = 0;
    if (s.theta === 0 && s.words.length >= 4 && fontsWithSpaces.has(lead.font) && s.words.filter((w) => [...w.text].length <= 2).length >= s.words.length * 0.7) {
      const em = lead.st.size;
      const gaps = s.words.slice(1).map((w, i) => {
        const from = s.words[i].u1 - em * 0.1;
        const real = spaces.some((g) => Math.abs(g.y - s.v) < em * 0.3 && g.x >= from && g.x <= w.u0 + 0.05);
        return { size: w.u0 - s.words[i].u1, real };
      });
      const tight = gaps.filter((g) => !g.real).map((g) => g.size);
      if (tight.length >= gaps.length * 0.6 && median(tight) > em * 0.02) {
        s.tracking = median(tight);
        s.words.forEach((w, i) => {
          if (i) w.sep = gaps[i - 1].real ? ' ' : '';
        });
      }
    }
    s.parts = [];
    for (const w of s.words) {
      const last = s.parts[s.parts.length - 1];
      const sep = w.sep ?? ' ';
      if (last && last.style === w.style) last.text += sep + w.text;
      else {
        if (last) last.text += sep;
        s.parts.push({ style: w.style, st: w.st, color: w.color, opacity: w.opacity, text: w.text });
      }
    }
    s.text = s.parts.map((p) => p.text).join('');
  }
  const leftover = visible.filter((g) => !g.word).length;
  return { segments, leftover, words: words.filter((w) => w.ok).length };
}

// Lines of one block with the same style, edge and pitch become one editable paragraph (line breaks are kept).
function buildElements(segments) {
  const elements = [];
  const perLine = new Map();
  for (const s of segments) perLine.set(`${s.block}|${s.line}`, (perLine.get(`${s.block}|${s.line}`) || 0) + 1);
  let cur = null;
  for (const s of segments) {
    const size = s.st.size;
    const tol = Math.max(0.75, size * 0.03);
    const alone = perLine.get(`${s.block}|${s.line}`) === 1 && s.theta === 0;
    let joined = false;
    if (cur && alone && cur.joinable && cur.block === s.block && cur.style === s.style && Math.abs((cur.segs[0].tracking || 0) - (s.tracking || 0)) < 0.05) {
      const prev = cur.segs[cur.segs.length - 1];
      const pitch = s.v - prev.v;
      const okPitch = pitch > size * 0.8 && pitch < size * 2.2 && (cur.pitch == null || Math.abs(pitch - cur.pitch) < Math.max(0.3, cur.pitch * 0.02));
      const fit = { left: Math.abs(s.u0 - cur.segs[0].u0) <= tol, center: Math.abs((s.u0 + s.u1) / 2 - (cur.segs[0].u0 + cur.segs[0].u1) / 2) <= tol, right: Math.abs(s.u1 - cur.segs[0].u1) <= tol };
      const modes = cur.modes.filter((mo) => fit[mo]);
      if (okPitch && modes.length) {
        cur.segs.push(s);
        cur.modes = modes;
        cur.pitch = cur.pitch ?? pitch;
        joined = true;
      }
    }
    if (!joined) {
      cur = { segs: [s], block: s.block, style: s.style, joinable: alone, modes: ['left', 'center', 'right'], pitch: null, theta: s.theta, size };
      elements.push(cur);
    }
  }
  for (const e of elements) {
    e.left = Math.min(...e.segs.map((s) => s.u0));
    e.right = Math.max(...e.segs.map((s) => s.u1));
    e.v = e.segs[0].v;
    e.vLast = e.segs[e.segs.length - 1].v;
    e.top = e.v - e.size * 0.85;
    e.bottom = e.vLast + e.size * 0.3;
    e.st = e.segs[0].st;
    e.color = e.segs[0].color;
    e.opacity = e.segs[0].opacity;
    e.chars = e.segs.reduce((n, s) => n + s.text.length, 0);
    e.tracking = e.segs[0].tracking || 0;
  }
  return elements;
}

function alignElements(elements, W) {
  const flat = elements.filter((e) => e.theta === 0);
  for (const e of elements) {
    e.align = 'left';
    if (e.theta !== 0) continue;
    const tol = Math.max(0.75, e.size * 0.03);
    const c = (e.left + e.right) / 2;
    const pageCentred = Math.abs(c - W / 2) <= Math.max(1.5, W * 0.015);
    if (e.segs.length > 1) {
      // a paragraph: the edge its lines share (ragged lines that share only the centre are centred)
      const distinctWidths = e.segs.some((s) => Math.abs(s.u1 - s.u0 - (e.segs[0].u1 - e.segs[0].u0)) > tol * 2);
      if (e.modes.includes('left') && (distinctWidths || !pageCentred)) e.align = 'left';
      else if (e.modes.includes('center')) e.align = 'center';
      else if (e.modes.includes('right')) e.align = 'right';
      continue;
    }
    let l = 0;
    let cc = 0;
    let r = 0;
    for (const o of flat) {
      if (o === e) continue;
      const differs = Math.abs(o.right - o.left - (e.right - e.left)) > tol * 2;
      if (Math.abs(o.left - e.left) <= tol) l++;
      if (differs && Math.abs((o.left + o.right) / 2 - c) <= tol) cc++;
      if (differs && Math.abs(o.right - e.right) <= tol) r++;
    }
    if (pageCentred && (l === 0 || cc >= l)) e.align = 'center';
    else if (cc >= 1 && cc > l) e.align = 'center';
    else if (r >= 1 && r > l && cc === 0) e.align = 'right';
  }
  // the box a retyped text may grow into before it wraps: up to the page margin or the next text
  const margin = flat.length ? Math.max(0, Math.min(W * 0.05, ...flat.map((e) => e.left), ...flat.map((e) => W - e.right))) : 0;
  for (const e of flat) {
    let lo = margin;
    let hi = W - margin;
    for (const o of flat) {
      if (o === e || o.top >= e.bottom || o.bottom <= e.top) continue;
      if (o.left >= e.right - 1) hi = Math.min(hi, o.left - e.size * 0.4);
      else if (o.right <= e.left + 1) lo = Math.max(lo, o.right + e.size * 0.4);
    }
    const width = e.right - e.left;
    const need = width * 1.12 + 2;
    if (e.align === 'center') {
      const c = (e.left + e.right) / 2;
      const half = Math.max(Math.min(c - lo, hi - c), need / 2);
      e.box = { x: c - half, w: half * 2 };
    } else if (e.align === 'right') {
      const x = Math.min(lo, e.right - need);
      e.box = { x, w: e.right - x };
    } else e.box = { x: e.left, w: Math.max(hi - e.left, need) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// main

/**
 * Convert a finished PDF printable into a template (skill/TEMPLATE.md) without redrawing it.
 *
 * @param {Buffer|Uint8Array} buffer  the PDF
 * @param {object} [options]
 * @param {number} [options.maxPages=6]       pages converted at most (the rest is reported and left out)
 * @param {string} [options.title]            <title> of the template (default: the PDF's title)
 * @param {string} [options.lang='en']
 * @param {boolean} [options.checkFonts=true] ask fonts.googleapis.com whether each font family exists there
 * @param {(family: string, weight: number, italic: boolean) => Promise<{available: boolean, exact?: boolean}>} [options.fontLookup]
 *                                            replaces the Google Fonts request (tests, offline use)
 * @param {'keep'|'placeholder'} [options.qr='keep']  what to do with raster images that look like a QR code:
 *                                            keep them as artwork, or swap them for the contract's placeholder with data-qr
 * @param {boolean} [options.markLogos=false] give small images with transparency data-logo="wide|square" instead of data-photo
 * @param {boolean|'plain'} [options.bakeMasks=true]  merge a picture and its soft mask into one PNG with transparency
 *                                            ('plain': without sharp, as on a machine where sharp is missing)
 * @param {number} [options.timeoutMs=90000]  per poppler call
 * @returns {Promise<{html: string, pages: number, report: object}>}
 */
export async function pdfToTemplate(buffer, options = {}) {
  const opt = { maxPages: 6, title: '', lang: 'en', checkFonts: true, fontLookup: null, qr: 'keep', markLogos: false, bakeMasks: true, timeoutMs: 90000, ...options };
  const warnings = [];
  const report = { source: {}, pages: [], text: { lines: 0, elements: 0, words: 0, characters: 0, glyphsLeftAsOutlines: 0 }, images: [], colors: { variables: {}, tints: [], untouched: [] }, fonts: [], warnings, bytes: 0 };
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const startAt = data.subarray(0, 1024).indexOf('%PDF-');
  if (startAt < 0) throw new Error('This file is not a PDF (no %PDF header). Only PDF files can be converted.');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commons-convert-'));
  try {
    const file = path.join(dir, 'in.pdf');
    await fsp.writeFile(file, data);
    const T = opt.timeoutMs;

    // ---- document facts
    let info;
    try {
      info = (await run('pdfinfo', [file], T)).stdout.toString();
    } catch (e) {
      if (/password|encrypt/i.test(e.message)) throw new Error('This PDF is password protected and cannot be converted.');
      throw new Error(e.tool && /not installed/.test(e.message) ? e.message : `This PDF cannot be read (${e.message.replace(/\s+/g, ' ').slice(0, 200)}).`);
    }
    const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(info)?.[1]?.trim() || '';
    const total = parseInt(field('Pages'), 10) || 0;
    if (!total) throw new Error('This PDF has no pages.');
    const maxPages = Math.max(1, Math.floor(Number(opt.maxPages) || 6));
    const count = Math.min(total, maxPages);
    report.source = { pages: total, converted: count, title: field('Title'), creator: field('Creator'), producer: field('Producer'), bytes: data.length };
    if (total > count) warnings.push(`The PDF has ${total} pages; only the first ${count} were converted (maxPages = ${maxPages}).`);
    if (/^yes/i.test(field('Encrypted')) && /copy:no/i.test(field('Encrypted'))) warnings.push('The PDF forbids copying its text; poppler extracted it anyway, check that the author allows reuse.');
    const numbers = Array.from({ length: count }, (_, i) => i + 1);

    // ---- run poppler: one SVG and one small render per page; words, runs and fonts for the whole range
    const range = ['-f', '1', '-l', String(count)];
    const soft = async (promise, what) => {
      try {
        return await promise;
      } catch (e) {
        warnings.push(`${what} failed (${e.message.slice(0, 160)}).`);
        return null;
      }
    };
    const [bboxOut, xmlOut, fontsOut, perPage] = await Promise.all([
      soft(run('pdftotext', ['-bbox-layout', ...range, file, path.join(dir, 'words.html')], T).then(() => fsp.readFile(path.join(dir, 'words.html'), 'utf8')), 'Reading the text (pdftotext)'),
      soft(run('pdftohtml', ['-xml', '-i', '-zoom', String(POPPLER_ZOOM), '-stdout', ...range, file], T).then((r) => r.stdout.toString('utf8')), 'Reading the fonts of the text (pdftohtml)'),
      soft(run('pdffonts', [...range, file], T).then((r) => r.stdout.toString('utf8')), 'Listing the fonts (pdffonts)'),
      pool(numbers, 3, async (n) => {
        const base = path.join(dir, `p${n}`);
        let svg = null;
        let error = null;
        try {
          await run('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), file, `${base}.svg`], T);
          svg = await fsp.readFile(`${base}.svg`, 'utf8');
        } catch (e) {
          error = e;
        }
        let ppm = null;
        try {
          await run('pdftoppm', ['-f', String(n), '-l', String(n), '-singlefile', '-scale-to', '900', file, base], T);
          ppm = parsePpm(await fsp.readFile(`${base}.ppm`));
        } catch {
          /* colours are then ranked by how often they are used */
        }
        return { n, svg, ppm, error };
      }),
    ]);
    const failed = perPage.filter((p) => !p.svg);
    if (failed.length === perPage.length) throw new Error(`This PDF cannot be converted: ${failed[0].error?.message || 'pdftocairo wrote no page'}`);
    for (const p of failed) warnings.push(`Page ${p.n} could not be converted (${p.error?.message.slice(0, 160)}); it was left out.`);

    const bboxPages = bboxOut ? parseBbox(bboxOut) : [];
    const runData = xmlOut ? parseRuns(xmlOut) : { pages: new Map(), fonts: new Map() };

    // ---- per page: analyse the SVG, match the text
    const pages = [];
    for (const p of perPage) {
      if (!p.svg) continue;
      let svg;
      try {
        svg = analyseSvg(typeof opt.svgFilter === 'function' ? opt.svgFilter(p.svg, p.n) : p.svg); // svgFilter: test hook
      } catch (e) {
        warnings.push(`Page ${p.n}: the SVG could not be read (${e.message}); the page was left out.`);
        continue;
      }
      p.svg = null;
      const runs = runData.pages.get(p.n);
      const zoomScale = runs?.width ? runs.width / svg.size.w : POPPLER_ZOOM;
      const text = buildText(bboxPages[p.n - 1], svg, runs, runData.fonts, zoomScale, warnings, p.n);
      const elements = buildElements(text.segments);
      alignElements(elements, svg.size.w);
      pages.push({ n: p.n, svg, ppm: p.ppm, scale: p.ppm ? p.ppm.w / svg.size.w : 0, text, elements, zoomScale });
    }
    if (!pages.length) throw new Error('This PDF cannot be converted: no page could be read.');

    // ---- fonts: family, weight and whether Google Fonts has it
    const fontUse = new Map(); // key -> { parsed, chars, maxSize, lines }
    const fontOf = (st) => {
      const parsed = parseFontName(st.raw, st.bold, st.italic);
      const key = `${parsed.family}|${parsed.weight}|${parsed.italic}`;
      if (!fontUse.has(key)) fontUse.set(key, { ...parsed, key, chars: 0, maxSize: 0, lines: 0 });
      return fontUse.get(key);
    };
    for (const pg of pages) {
      for (const e of pg.elements) {
        e.font = fontOf(e.st);
        e.font.chars += e.chars;
        e.font.lines += e.segs.length;
        e.font.maxSize = Math.max(e.font.maxSize, e.size);
        for (const s of e.segs) for (const part of s.parts) part.font = fontOf(part.st);
      }
    }
    const families = new Map(); // original family -> { css family, google, variants }
    await Promise.all(
      [...fontUse.values()].map(async (f) => {
        const alias = ALIASES[f.family.toLowerCase()];
        const candidates = [alias, f.family].filter(Boolean);
        let found = null;
        let checked = true;
        for (const cand of candidates) {
          const offline = { available: KNOWN_GOOGLE.has(cand.toLowerCase()), exact: false, checked: false };
          const r = opt.fontLookup ? await Promise.resolve(opt.fontLookup(cand, f.weight, f.italic)).then((v) => ({ checked: true, exact: true, ...v }), () => offline) : opt.checkFonts ? await askGoogle(cand, f.weight, f.italic) : offline;
          checked = checked && r.checked !== false;
          if (r.available) {
            found = { family: cand, exact: !!r.exact, substitute: cand !== f.family };
            break;
          }
        }
        f.google = found;
        f.checked = checked;
      }),
    );
    for (const f of fontUse.values()) {
      const fam = families.get(f.family) || { original: f.family, css: f.google?.family || f.family, google: !!f.google, variants: [], chars: 0, maxSize: 0 };
      fam.google = fam.google || !!f.google;
      if (f.google) fam.css = f.google.family;
      fam.variants.push(f);
      fam.chars += f.chars;
      fam.maxSize = Math.max(fam.maxSize, f.maxSize);
      families.set(f.family, fam);
    }
    const famList = [...families.values()];
    const generic = (name) => (MONO.test(name) ? 'ui-monospace, monospace' : SERIF.test(name) ? 'Georgia, serif' : 'system-ui, sans-serif');
    const stack = (fam) => `'${fam.css.replace(/'/g, '')}', ${fam.css !== fam.original ? `'${fam.original.replace(/'/g, '')}', ` : ''}${generic(fam.css + ' ' + fam.original)}`;
    let headingFam = null;
    let bodyFam = null;
    let headingFrom = Infinity; // with one family: sizes from here on count as headings
    if (famList.length === 1) {
      headingFam = bodyFam = famList[0];
      const sizes = [];
      for (const pg of pages) for (const e of pg.elements) for (let i = 0; i < e.chars; i += 4) sizes.push(e.size);
      const mid = median(sizes);
      const max = Math.max(...sizes);
      headingFrom = max > mid * 1.25 ? mid * 1.25 : max >= 20 ? 0 : Infinity;
    } else if (famList.length > 1) {
      headingFam = [...famList].sort((a, b) => b.maxSize - a.maxSize || b.chars - a.chars)[0];
      bodyFam = famList.filter((f) => f !== headingFam).sort((a, b) => b.chars - a.chars)[0];
    }
    const familyCss = (font, size) => {
      const fam = families.get(font.family);
      if (fam === headingFam && fam === bodyFam) return size >= headingFrom ? 'var(--brand-font-heading)' : 'var(--brand-font-body)';
      if (fam === headingFam) return 'var(--brand-font-heading)';
      if (fam === bodyFam) return 'var(--brand-font-body)';
      return stack(fam);
    };
    // Google Fonts stylesheet for the default fonts (only variants that exist, or the whole request fails)
    const linkParts = [];
    for (const fam of famList) {
      if (!fam.google) continue;
      const name = fam.css.replace(/ /g, '+');
      const exact = [...new Set(fam.variants.filter((v) => v.google?.exact).map((v) => `${v.italic ? 1 : 0},${v.weight}`))].sort((x, y) => {
        const [xi, xw] = x.split(',').map(Number);
        const [yi, yw] = y.split(',').map(Number);
        return xi - yi || xw - yw;
      });
      if (exact.length) linkParts.push(exact.some((t) => t[0] === '1') ? `family=${name}:ital,wght@${exact.join(';')}` : `family=${name}:wght@${exact.map((t) => t.split(',')[1]).join(';')}`);
      if (fam.variants.some((v) => v.google && !v.google.exact)) linkParts.push(`family=${name}`); // regular weight: the browser synthesises the rest
    }
    const fontRows = pdfFontRows(fontsOut);
    for (const fam of famList) {
      for (const v of fam.variants) {
        const row = fontRows.find((r) => r.name.replace(/^[A-Z]{6}\+/, '').startsWith(v.pdfName));
        report.fonts.push({
          pdfName: v.pdfName,
          family: v.family,
          weight: v.weight,
          italic: v.italic,
          type: row?.type || '',
          embedded: row ? row.embedded : null,
          googleFonts: v.google ? { available: true, family: v.google.family, sameFamily: !v.google.substitute, weightAvailable: v.google.exact } : { available: false },
          checkedOnline: v.checked,
          role: fam === headingFam && fam === bodyFam ? 'heading and body' : fam === headingFam ? 'heading' : fam === bodyFam ? 'body' : 'kept as it is',
          lines: v.lines,
          characters: v.chars,
        });
        if (!v.google) warnings.push(`Font "${v.family}" (${v.pdfName}) is not on Google Fonts${v.checked ? '' : ' (could not ask Google Fonts, judged from a short built-in list)'}: its text renders in a fallback font unless the font is installed, so line widths differ from the original.`);
        else if (v.google.substitute) warnings.push(`Font "${v.family}" is not on Google Fonts; the closest family there, "${v.google.family}", is used as the default. Letter shapes and widths can differ slightly.`);
        else if (!v.google.exact) warnings.push(`Google Fonts has "${v.google.family}" but not in weight ${v.weight}${v.italic ? ' italic' : ''}; the browser synthesises it, so these lines look slightly different.`);
      }
    }
    for (const row of fontRows) {
      if (!report.fonts.some((f) => row.name.replace(/^[A-Z]{6}\+/, '').startsWith(f.pdfName))) report.fonts.push({ pdfName: row.name.replace(/^[A-Z]{6}\+/, ''), type: row.type, embedded: row.embedded, role: 'not used by editable text', lines: 0 });
    }

    // ---- images: classify, find masks that do nothing, decide the photo slots
    const shared = new Map(); // hash -> image record used across pages
    const baked = new Map(); // picture + mask -> PNG with alpha
    let masksKept = 0;
    let slot = 0;
    for (const pg of pages) {
      const { svg } = pg;
      const W = svg.size.w;
      const H = svg.size.h;
      pg.dropMasks = new Set();
      for (const [id, mask] of svg.masks) {
        if (mask.images.length !== 1) continue;
        const img = svg.images.get(mask.images[0]);
        const use = svg.imageUses.find((u) => u.mask === id);
        // only the mask form of cairo 1.18 is understood: a grey PNG whose luminance becomes the alpha
        mask.luminance = /color-to-alpha/.test(use?.filter || '') && img?.mime === 'image/png';
        if (mask.luminance && (pngMin(img.data) ?? 0) >= 254) pg.dropMasks.add(id);
      }
      // a picture drawn alone through its own soft mask becomes one picture with an alpha channel
      const maskRefs = new Map();
      for (const t of svg.tokens) {
        const ref = t.close ? null : /\smask="url\(#([^)]+)\)"/.exec(t.head);
        if (ref) maskRefs.set(ref[1], (maskRefs.get(ref[1]) || 0) + 1);
      }
      for (const u of svg.imageUses) {
        if (u.mask || u.defs || u.direct || !u.maskRef || pg.dropMasks.has(u.maskRef.id)) continue;
        const mask = svg.masks.get(u.maskRef.id);
        const maskUse = svg.imageUses.find((x) => x.mask === u.maskRef.id);
        const picture = svg.images.get(u.id);
        const alpha = mask?.images.length === 1 ? svg.images.get(mask.images[0]) : null;
        const alone = u.index === u.maskRef.index + 1 && svg.tokens[u.index + 1]?.close && maskRefs.get(u.maskRef.id) === 1;
        if (!opt.bakeMasks || !alpha || !maskUse || !alone || !mask.luminance || alpha.w !== picture.w || alpha.h !== picture.h || maskUse.ctm.some((v, k) => Math.abs(v - u.ctm[k]) > 1e-6)) {
          masksKept++;
          continue;
        }
        const key = crypto.createHash('sha1').update(picture.data).update(alpha.data).digest('hex');
        if (!baked.has(key)) baked.set(key, await bakeAlpha(picture, alpha, opt.bakeMasks !== 'plain'));
        const data = baked.get(key);
        if (!data) {
          masksKept++;
          continue;
        }
        const id = `baked-${u.index}`;
        svg.images.set(id, { id, index: -1, w: picture.w, h: picture.h, mime: 'image/png', data, alpha: true, from: picture.mime });
        pg.dropMasks.add(u.maskRef.id);
        u.id = id;
        u.maskRef = null;
      }
      pg.imageOf = new Map();
      let covered = 0;
      for (const [id, img] of svg.images) {
        const uses = svg.imageUses.filter((u) => u.id === id);
        const painted = uses.filter((u) => !u.mask);
        const onlyMask = uses.length > 0 && !painted.length;
        if (onlyMask && uses.every((u) => pg.dropMasks.has(u.mask))) {
          pg.imageOf.set(id, null); // goes away with its mask
          continue;
        }
        const hash = crypto.createHash('sha1').update(img.mime).update(img.data).digest('hex');
        let rec = shared.get(hash);
        if (!rec) {
          rec = { hash, mime: img.mime, data: img.data, w: img.w, h: img.h, uses: 0, maskUses: 0, pages: new Set(), kind: null, placed: null, alpha: !!img.alpha, from: img.from, coverage: 0, qr: false, id: `commons-img-${shared.size + 1}` };
          shared.set(hash, rec);
        }
        pg.imageOf.set(id, rec);
        rec.pages.add(pg.n);
        for (const u of uses) {
          if (u.mask) {
            rec.maskUses++;
            continue;
          }
          rec.uses++;
          if (u.defs) rec.indirect = true; // painted through a pattern or a group in <defs>
          if (u.maskRef && !pg.dropMasks.has(u.maskRef.id)) rec.alpha = true;
          const pts = [[0, 0], [img.w, 0], [0, img.h], [img.w, img.h]].map(([x, y]) => apply(u.ctm, x, y));
          const box = { x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), y1: Math.max(...pts.map((q) => q[1])) };
          const visibleArea = Math.max(0, Math.min(W, box.x1) - Math.max(0, box.x0)) * Math.max(0, Math.min(H, box.y1) - Math.max(0, box.y0));
          const cover = visibleArea / (W * H);
          covered += cover;
          if (!rec.placed || cover > rec.coverage) {
            rec.placed = { page: pg.n, wMm: round((box.x1 - box.x0) * PT_MM, 1), hMm: round((box.y1 - box.y0) * PT_MM, 1) };
            rec.coverage = cover;
            rec.pageHasText = pg.elements.length > 0;
          }
          if (pg.ppm && !rec.alpha && looksLikeQr(pg.ppm, pg.scale, box)) rec.qr = true;
        }
      }
      pg.imageCoverage = Math.min(1, covered);
    }
    for (const rec of shared.values()) {
      if (!rec.uses) rec.kind = 'mask';
      else if (rec.qr) rec.kind = 'qr-like';
      else if (rec.placed && (Math.max(rec.placed.wMm, rec.placed.hMm) < 12 || rec.w * rec.h < 64 * 64)) rec.kind = 'small';
      else if (rec.coverage >= 0.85 && !rec.pageHasText) rec.kind = 'page-image';
      else if (rec.alpha) rec.kind = 'graphic';
      else if (rec.coverage >= 0.85) rec.kind = 'background';
      else rec.kind = 'photo';
      if (['photo', 'background', 'graphic'].includes(rec.kind)) {
        rec.slot = `photo_${++slot}`;
        if (rec.kind === 'graphic' && opt.markLogos && rec.coverage < 0.15) rec.logo = rec.w / rec.h > 1.6 ? 'wide' : 'square';
      }
      if (rec.kind === 'qr-like' && opt.qr === 'placeholder') rec.swapQr = true;
      const bytes = Math.floor((rec.data.length * 3) / 4);
      if (rec.kind !== 'mask') {
        report.images.push({
          kind: rec.kind,
          slot: rec.logo ? `data-logo="${rec.logo}"` : rec.slot ? `data-photo="${rec.slot}"` : rec.swapQr ? 'data-qr="join_url" (placeholder)' : null,
          format: rec.mime.replace('image/', '') + (rec.from ? ` (${rec.from.replace('image/', '')} picture and its soft mask merged into one picture with transparency)` : ''),
          pixels: `${rec.w}×${rec.h}`,
          bytes,
          placedMm: rec.placed ? `${rec.placed.wMm}×${rec.placed.hMm}` : null,
          pageCoverage: round(rec.coverage, 3),
          pages: [...rec.pages],
          uses: rec.uses,
          transparency: rec.alpha,
        });
        if (bytes > 400 * 1024 && !rec.swapQr) warnings.push(`Image ${rec.slot || rec.kind} (${rec.w}×${rec.h} ${rec.mime.replace('image/', '')}, ${Math.round(bytes / 1024)} KB) is larger than the contract's 400 KB per image; it was kept at full quality inside the file.`);
      }
      if (rec.kind === 'qr-like') warnings.push(opt.qr === 'placeholder' ? 'An image that looks like a QR code was replaced by the contract placeholder (data-qr="join_url").' : 'An image looks like a QR code. It was kept as artwork; the contract forbids real QR codes in templates (convert with qr: "placeholder" to swap it).');
    }
    const graphics = [...shared.values()].filter((r) => r.kind === 'graphic' && !r.logo);
    if (graphics.length) warnings.push(`${graphics.length} image(s) with transparency (${graphics.map((r) => r.slot).join(', ')}) are probably logos or cut-outs. They are replaceable photo slots; if one is the group's logo, give it data-logo in place of data-photo (the markLogos option, "commons convert --logos", does that for small ones).`);
    if (masksKept) warnings.push(`${masksKept} masked image(s) could not be merged with their mask and keep an SVG mask. Chrome prints SVG masks as flattened layers that some PDF viewers (macOS Preview) show with a black background: check the printed PDF.`);

    // ---- colours: rank what artwork and text use, choose the brand variables
    const usage = new Map(); // hex -> { uses, pixels }
    const note = (h, n = 1) => {
      if (!h) return;
      const u = usage.get(h) || { uses: 0, pixels: 0, text: 0, art: 0 };
      u.uses += n;
      usage.set(h, u);
      return u;
    };
    for (const pg of pages) {
      const keptParents = new Set(pg.svg.glyphUses.filter((g) => !g.word).map((g) => g.parent));
      const glyphParents = new Set(pg.svg.glyphUses.map((g) => g.parent));
      for (const [i, t] of pg.svg.tokens.entries()) {
        if (t.close || t.name === 'image') continue;
        if (glyphParents.has(i) && !keptParents.has(i)) continue; // wrapper of text that became live text
        for (const paint of paintsOf(t.head)) note(paint.hex).art++;
      }
      for (const e of pg.elements) for (const s of e.segs) for (const part of s.parts) note(part.color, part.text.length).text += part.text.length;
    }
    let sampled = 0;
    for (const pg of pages) {
      if (!pg.ppm) continue;
      const hist = histogram(pg.ppm);
      sampled += hist.total;
      const list = [...usage.keys()].map((h) => ({ h, rgb: unhex(h) }));
      for (const [key, n] of hist.map) {
        const rgb = [key >> 16, (key >> 8) & 255, key & 255];
        let bestHex = null;
        let bestD = 7;
        for (const c of list) {
          const d = dist(c.rgb, rgb);
          if (d < bestD) {
            bestD = d;
            bestHex = c.h;
          }
        }
        if (bestHex) usage.get(bestHex).pixels += n;
      }
    }
    const ranked = [...usage.entries()].map(([h, u]) => ({ hex: h, ...u, share: sampled ? u.pixels / sampled : 0, ...colourInfo(h) }));
    for (const c of ranked) c.score = c.share + Math.min(c.uses, 200) * 1e-5;
    ranked.sort((a, b) => b.score - a.score);
    const vars = {};
    const chromatic = ranked.filter((c) => c.chromatic);
    if (chromatic[0]) vars['--brand-color'] = chromatic[0].hex;
    const tints = new Map(); // hex -> css expression
    if (vars['--brand-color']) {
      for (const c of ranked) {
        if (c.hex === vars['--brand-color'] || c.chroma < 6) continue;
        const expr = tintOf(c.hex, vars['--brand-color'], '--brand-color');
        if (expr) tints.set(c.hex, expr);
      }
    }
    const second = chromatic.find((c) => c.hex !== vars['--brand-color'] && !tints.has(c.hex));
    if (second) {
      vars['--brand-accent'] = second.hex;
      for (const c of ranked) {
        if (Object.values(vars).includes(c.hex) || tints.has(c.hex) || c.chroma < 6) continue;
        const expr = tintOf(c.hex, second.hex, '--brand-accent');
        if (expr) tints.set(c.hex, expr);
      }
    }
    const darks = ranked.filter((c) => !c.chromatic && c.l <= 0.3 && !tints.has(c.hex));
    if (darks.length) {
      const floor = darks[0].score * 0.1;
      vars['--brand-dark'] = darks.filter((c) => c.score >= floor).sort((a, b) => a.l - b.l)[0].hex;
    }
    const lights = ranked.filter((c) => !c.chromatic && c.l >= 0.82 && c.l < 0.99 && !tints.has(c.hex));
    if (lights.length) vars['--brand-light'] = (lights.find((c) => c.chroma >= 4) || lights[0]).hex;

    // text that sits on a brand-coloured surface follows --brand-on-color / --brand-on-accent
    const onVotes = { '--brand-on-color': new Map(), '--brand-on-accent': new Map() };
    for (const pg of pages) {
      if (!pg.ppm) continue;
      for (const e of pg.elements) {
        if (e.theta !== 0) continue;
        const surface = surfaceAt(pg.ppm, pg.scale, { x0: e.left, x1: e.right, y0: e.top, y1: e.bottom }, unhex(e.color));
        if (!surface) continue;
        for (const [on, base] of [['--brand-on-color', '--brand-color'], ['--brand-on-accent', '--brand-accent']]) {
          if (vars[base] && e.color !== vars[base] && dist(surface, unhex(vars[base])) <= 14) {
            e.on = on;
            onVotes[on].set(e.color, (onVotes[on].get(e.color) || 0) + e.chars);
          }
        }
      }
    }
    for (const [on, v] of Object.entries(onVotes)) if (v.size) vars[on] = [...v].sort((a, b) => b[1] - a[1])[0][0];

    const paintMap = new Map();
    for (const [name, value] of Object.entries(vars)) if (!name.includes('-on-') && !paintMap.has(value)) paintMap.set(value, `var(${name})`);
    for (const [h, expr] of tints) if (!paintMap.has(h)) paintMap.set(h, expr);
    const textColour = (h, op, on) => {
      const css = on && vars[on] === h ? `var(${on})` : paintMap.get(h) || h;
      return op < 0.995 ? `color-mix(in srgb, ${css} ${round(op * 100, 1)}%, transparent)` : css;
    };
    for (const name of Object.keys(CONTRACT_DEFAULTS)) {
      const c = ranked.find((r) => r.hex === vars[name]);
      report.colors.variables[name] = vars[name]
        ? { original: vars[name], pageShare: round(c?.share || 0, 4), usedByArtwork: c?.art || 0, usedByTextCharacters: c?.text || 0 }
        : { original: null, note: `nothing in the document fits this role; the contract default ${CONTRACT_DEFAULTS[name]} is declared but unused` };
    }
    for (const [h, expr] of tints) report.colors.tints.push({ original: h, replacedBy: expr });
    for (const c of ranked) {
      if (paintMap.has(c.hex) || Object.values(vars).includes(c.hex)) continue;
      report.colors.untouched.push({ color: c.hex, pageShare: round(c.share, 4), uses: c.uses, why: c.hex === '#ffffff' ? 'white stays white' : c.chromatic ? 'a third colour: only two chromatic colours become brand variables' : 'a neutral that is neither the darkest nor the light tinted one' });
    }
    for (const name of ['--brand-color', '--brand-accent']) {
      const c = ranked.find((r) => r.hex === vars[name]);
      if (!c || !sampled) continue;
      const vector = pages.reduce((sum, pg) => sum + Math.min(pg.svg.size.w * pg.svg.size.h, pg.svg.fillArea.get(c.hex) || 0), 0) / pages.reduce((sum, pg) => sum + pg.svg.size.w * pg.svg.size.h, 0);
      if (c.share > 0.03 && c.share > vector * 1.5 + 0.02 && c.text < 20) {
        report.colors.variables[name].alsoInsideImages = true;
        warnings.push(`${name} (${c.hex}) covers ${Math.round(c.share * 100)} % of the pages but the vector shapes painted with it at most ${Math.round(vector * 100)} %: the rest is inside raster images, which keep their colours. A re-brand will recolour only part of the design.`);
      }
    }
    if (!vars['--brand-color']) warnings.push('No chromatic colour was found in the vector artwork or text (colours inside raster images cannot be changed), so a brand colour will not change the look.');

    // ---- write the pages
    const sharedDefs = [];
    const emitted = new Set();
    const imageTag = (rec, extra = '') => {
      const slotAttr = rec.logo ? ` data-logo="${rec.logo}"` : rec.slot ? ` data-photo="${rec.slot}"` : rec.swapQr ? ' data-qr="join_url"' : '';
      const fit = rec.swapQr || rec.logo || rec.kind === 'graphic' ? 'xMidYMid meet' : 'xMidYMid slice';
      const href = rec.swapQr ? QR_PLACEHOLDER : `data:${rec.mime};base64,${rec.data}`;
      return `<image${extra}${slotAttr} width="${rec.w}" height="${rec.h}" preserveAspectRatio="${slotAttr ? fit : 'none'}" href="${href}"/>`;
    };
    let editCount = 0;
    const sections = [];
    for (const pg of pages) {
      const { svg } = pg;
      const prefix = `p${pg.n}-`;
      const W = svg.size.w;
      const H = svg.size.h;
      const usedGlyphs = new Set(svg.glyphUses.filter((g) => !g.word && !svg.glyphDefs.get(g.id)?.empty).map((g) => g.id));
      const dropUse = new Set(svg.glyphUses.filter((g) => g.word || svg.glyphDefs.get(g.id)?.empty).map((g) => g.index));
      const skip = new Uint8Array(svg.tokens.length);
      for (const [id, d] of svg.glyphDefs) if (!usedGlyphs.has(id) && d.end >= 0) skip.fill(1, d.start, d.end + 1);
      for (const id of pg.dropMasks) {
        const d = svg.masks.get(id);
        if (d.end >= 0) skip.fill(1, d.start, d.end + 1);
      }
      const useOf = new Map(svg.imageUses.map((u) => [u.index, u]));
      const rewrite = (head) =>
        repaint(head, paintMap)
          .replace(/\sid="([^"]+)"/g, ` id="${prefix}$1"`)
          .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
          .replace(/\sxlink:href="#([^"]+)"/g, ` href="#${prefix}$1"`)
          .replace(/\shref="#(?!p\d+-)([^"]+)"/g, ` href="#${prefix}$1"`);
      const out = [];
      const open = []; // { at, kept, name }
      const keep = () => {
        if (open.length) open[open.length - 1].kept = true;
      };
      for (let i = 0; i < svg.tokens.length; i++) {
        if (skip[i]) continue;
        const t = svg.tokens[i];
        if (t.name === 'svg') continue;
        if (t.close) {
          const o = open.pop();
          if (o && o.name === 'g' && !o.kept) {
            out[o.at] = '';
            continue;
          }
          keep();
          out.push(t.raw);
          continue;
        }
        if (dropUse.has(i)) continue;
        let raw;
        if (t.name === 'image') {
          const rec = pg.imageOf.get(attr(t.head, 'id') || `inline-${i}`);
          if (!rec) continue;
          const direct = useOf.get(i);
          if (direct) raw = imageTag(rec, attr(t.head, 'transform') ? ` transform="${attr(t.head, 'transform')}"` : '').replace('<image', `<image x="${attr(t.head, 'x') || 0}" y="${attr(t.head, 'y') || 0}"`);
          else continue; // the image itself is written where it is used (or once in the shared block)
        } else if (t.name === 'use' && useOf.has(i)) {
          const u = useOf.get(i);
          const rec = pg.imageOf.get(u.id);
          if (!rec) continue;
          const rest = t.head.replace(/\s(xlink:)?href="[^"]*"/, '').replace(/^<use/, '').replace(/\/?>$/, '');
          if (rec.uses === 1 && !rec.maskUses && !rec.indirect && !u.mask) raw = imageTag(rec, rewrite(rest));
          else {
            if (!emitted.has(rec.hash)) {
              emitted.add(rec.hash);
              sharedDefs.push(imageTag(rec, ` id="${rec.id}"`));
            }
            raw = `<use href="#${rec.id}"${rec.slot && !u.mask ? ` data-photo-ref="${rec.slot}"` : ''}${rewrite(rest)}/>`;
          }
        } else {
          let head = t.head;
          const maskRef = /\smask="url\(#([^)]+)\)"/.exec(head);
          if (maskRef && pg.dropMasks.has(maskRef[1])) head = head.replace(maskRef[0], '');
          raw = rewrite(head);
        }
        if (t.self) {
          keep();
          out.push(raw);
        } else {
          open.push({ at: out.length, kept: false, name: t.name });
          out.push(raw);
        }
      }
      let art = out.filter(Boolean).join('\n');
      // parents of kept children were marked late: one more pass removes groups that ended up empty
      for (let n = 0; n < 6; n++) {
        const next = art.replace(/<g\b[^>]*>\s*<\/g>\n?/g, '');
        if (next === art) break;
        art = next;
      }
      if (!/filter="url\(/.test(art)) art = art.replace(/<filter\b[\s\S]*?<\/filter>\n?/g, '');
      art = art.replace(/<defs>\s*<\/defs>\n?/g, '');
      const artwork = `<svg class="art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">\n${art}\n</svg>`;

      // live text
      const texts = [];
      let lines = 0;
      editCount = 0;
      for (const e of pg.elements) {
        const key = `p${pg.n}_t${++editCount}`;
        e.key = key;
        const size = round(e.size, 3);
        const css = [];
        const rad = (e.theta * Math.PI) / 180;
        const place = (u, v) => [u * Math.cos(rad) - v * Math.sin(rad), u * Math.sin(rad) + v * Math.cos(rad)];
        // Chrome snaps the baseline of a text to whole CSS pixels inside its box. So the strut is a whole number of
        // pixels and the box is moved with a transform, which keeps the fraction (in print and on screen).
        const PX = 96 / 72;
        const strut = Math.ceil(2 * size * PX);
        const [x, y] = e.theta === 0 ? [e.box.x, e.v] : place(e.left, e.v);
        css.push(`--s:${strut}px`, `transform:translate(${round(x * PX, 3)}px,${round(y * PX - strut, 3)}px)${e.theta === 0 ? '' : ` rotate(${round(e.theta, 2)}deg)`}`);
        css.push(e.theta === 0 ? `width:${round(e.box.w)}pt` : 'white-space:pre');
        css.push(`font-family:${familyCss(e.font, e.size)}`, `font-size:${size}pt`);
        if (e.font.weight !== 400) css.push(`font-weight:${e.font.weight}`);
        if (e.font.italic) css.push('font-style:italic');
        css.push(`color:${textColour(e.color, e.opacity, e.on)}`);
        if (e.segs.length > 1) css.push(`line-height:${round(e.pitch / e.size, 4)}`);
        if (e.align !== 'left') css.push(`text-align:${e.align}`);
        if (e.tracking) css.push(`letter-spacing:${round(e.tracking, 2)}pt`);
        const inner = e.segs
          .map((s) =>
            s.parts
              .map((part) => {
                if (part.style === e.style) return esc(part.text);
                const ps = [];
                const family = familyCss(part.font, part.st.size);
                if (family !== familyCss(e.font, e.size)) ps.push(`font-family:${family}`);
                if (part.st.size !== e.size) ps.push(`font-size:${round(part.st.size, 3)}pt`);
                if (part.font.weight !== e.font.weight) ps.push(`font-weight:${part.font.weight}`);
                if (part.font.italic !== e.font.italic) ps.push(`font-style:${part.font.italic ? 'italic' : 'normal'}`);
                if (part.color !== e.color || part.opacity !== e.opacity) ps.push(`color:${textColour(part.color, part.opacity, e.on)}`);
                return ps.length ? `<span style="${escAttr(ps.join(';'))}">${esc(part.text)}</span>` : esc(part.text);
              })
              .join(''),
          )
          .join('\n');
        texts.push(`<div class="tx" style="${escAttr(css.join(';'))}"><div data-edit="${key}">${inner}</div></div>`);
        lines += e.segs.length;
        report.text.characters += e.chars;
      }
      report.text.lines += lines;
      report.text.elements += pg.elements.length;
      report.text.words += pg.text.words;
      report.text.glyphsLeftAsOutlines += pg.text.leftover;

      const wMm = round(W * PT_MM, 2);
      const hMm = round(H * PT_MM, 2);
      const vectorShapes = svg.tokens.filter((t, i) => !t.close && !skip[i] && /^(path|rect|circle|ellipse|polygon|polyline|line)$/.test(t.name)).length;
      const kind = pg.elements.length ? 'live text over artwork' : pg.imageCoverage >= 0.8 ? 'image only' : pg.text.leftover ? 'text kept as outlines' : 'artwork without text';
      if (!pg.elements.length) {
        if (pg.imageCoverage >= 0.8) warnings.push(`Page ${pg.n} is one or more raster images covering the page (a scan or a rasterised export): the images were kept as the artwork and no text could be made editable. Ask the author for a PDF exported with live text, or use OCR.`);
        else if (pg.text.leftover) warnings.push(`Page ${pg.n}: the text could not be read (${pg.text.leftover} glyphs without usable Unicode text); it stays in the artwork as outlines and is not editable.`);
        else warnings.push(`Page ${pg.n} has no text to edit (text may have been converted to outlines by the author).`);
      } else if (pg.text.leftover) warnings.push(`Page ${pg.n}: ${pg.text.leftover} glyph(s) could not be matched to text and stay in the artwork as outlines (not editable).`);
      report.pages.push({ page: pg.n, widthMm: wMm, heightMm: hMm, format: formatLabel(wMm, hMm), kind, textLines: lines, editableElements: pg.elements.length, vectorShapes, imagesOnPage: [...new Set([...pg.imageOf.values()].filter((r) => r && r.kind !== 'mask'))].length, imageCoverage: round(pg.imageCoverage, 3) });
      sections.push({ n: pg.n, wMm, hMm, html: `<section class="page" data-page="${pg.n}">\n${artwork}\n${texts.join('\n')}\n</section>` });
    }
    if (report.text.elements === 0) warnings.push('No text in this document could be made editable. The template is the original artwork; only colours of vector shapes (if any) and photos can be changed.');
    const rotated = pages.reduce((n, pg) => n + pg.elements.filter((e) => e.theta !== 0).length, 0);
    if (rotated) warnings.push(`${rotated} rotated text line(s) were made editable with a CSS rotation; check their position.`);

    // ---- assemble the document
    const first = sections[0];
    const sameSize = sections.every((s) => Math.abs(s.wMm - first.wMm) < 0.1 && Math.abs(s.hMm - first.hMm) < 0.1);
    if (!sameSize) warnings.push('The pages have different sizes; each page keeps its own size (named @page rules). The previewer meta declares the first page.');
    const rootVars = { ...CONTRACT_DEFAULTS };
    for (const [k, v] of Object.entries(vars)) rootVars[k] = v;
    const fallbackHeading = "'Vollkorn', Georgia, serif";
    const fallbackBody = "'Hanken Grotesk', system-ui, sans-serif";
    const css = [
      `:root{${Object.entries(rootVars).map(([k, v]) => `${k}:${v}`).join(';')};--brand-font-heading:${headingFam ? stack(headingFam) : fallbackHeading};--brand-font-body:${bodyFam ? stack(bodyFam) : fallbackBody}}`,
      '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      'body{margin:0;background:#e9e9ee}',
      `.page{position:relative;width:${first.wMm}mm;height:${first.hMm}mm;margin:24px auto;background:#fff;overflow:hidden;break-after:page}`,
      '.art{position:absolute;left:0;top:0;width:100%;height:100%;display:block}',
      '.commons-images{position:absolute;width:0;height:0;overflow:hidden}',
      // Each text sits in a flex row next to an empty strut of height --s (about 2em): the first baseline of the
      // text is then exactly --s below the top of the row whatever font is loaded, so re-branding cannot shift a line.
      '.tx{position:absolute;left:0;top:0;display:flex;align-items:baseline;margin:0;line-height:1.2;white-space:pre-wrap;overflow-wrap:break-word;transform-origin:0 var(--s);font-kerning:normal}',
      '.tx::before{content:"";flex:none;width:0;height:var(--s)}',
      '.tx>[data-edit]{flex:1 1 auto;min-width:0}',
      `@page{size:${first.wMm}mm ${first.hMm}mm;margin:0}`,
      ...(sameSize ? [] : sections.map((s) => `@page pg${s.n}{size:${s.wMm}mm ${s.hMm}mm;margin:0}\n.page[data-page="${s.n}"]{page:pg${s.n};width:${s.wMm}mm;height:${s.hMm}mm}`)),
      '@media print{body{background:none}.page{margin:0}}',
    ].join('\n');
    const title = String(opt.title || report.source.title || 'Converted printable').slice(0, 200);
    const link = linkParts.map((part) => `<link href="https://fonts.googleapis.com/css2?${part}&amp;display=swap" rel="stylesheet">\n`).join('');
    const defs = sharedDefs.length ? `<svg class="commons-images" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true"><defs>\n${sharedDefs.join('\n')}\n</defs></svg>\n` : '';
    const html = `<!doctype html>
<html lang="${escAttr(opt.lang)}"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="commons:page" content="${first.wMm}mm ${first.hMm}mm"><meta name="commons:format" content="${escAttr(formatLabel(first.wMm, first.hMm))}">
<meta name="generator" content="groups-commons pdfToTemplate (artwork preserved, text live)">
${link}<style>
${css}
</style></head><body>
${defs}${sections.map((s) => s.html).join('\n')}
</body></html>
`;
    report.bytes = Buffer.byteLength(html);
    report.fontStylesheets = linkParts.map((part) => `https://fonts.googleapis.com/css2?${part}&display=swap`);
    if (report.bytes > 6 * 1024 * 1024) warnings.push(`The template is ${round(report.bytes / 1048576, 1)} MB because its images are stored inside the file at full quality.`);
    return { html, pages: sections.length, report };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function pdfFontRows(text) {
  const rows = [];
  const lines = String(text || '').split('\n');
  const head = lines[0] || '';
  const typeAt = head.indexOf('type');
  const encAt = head.indexOf('encoding');
  const embAt = head.indexOf('emb');
  if (typeAt < 0 || embAt < 0) return rows;
  const seen = new Set();
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const name = line.slice(0, typeAt).trim();
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, type: line.slice(typeAt, encAt).trim(), embedded: line.slice(embAt, embAt + 3).trim() === 'yes' });
  }
  return rows;
}

export default pdfToTemplate;

// ---------------------------------------------------------------------------------------------------------------
// EDITOR NOTES: what public/template.js has to support for these templates
//
// - Photos are SVG <image data-photo="photo_N" href="data:..."> elements inside the artwork (not <img>).
//   To replace one, set its `href` attribute to the new image (data: URI or URL). The element keeps its box and
//   has preserveAspectRatio="xMidYMid slice" (photos, like object-fit: cover) or "xMidYMid meet" (graphics with
//   transparency), so a picture of another shape fits. An image used more than once (a logo on every page) is
//   stored once in <svg class="commons-images"> and drawn with <use href="#commons-img-N" data-photo-ref="photo_N">:
//   a click on such a <use> has to be mapped to image[data-photo="photo_N"]. Selector for click targets:
//   `image[data-photo], use[data-photo-ref]`. serialize() must keep or restore `href` like it does for img[src].
// - With option markLogos, likely logos are <image data-logo="wide|square">: set `href` as for img[data-logo].
// - With option qr: 'placeholder', QR codes are <image data-qr="join_url">: set `href` to the generated code.
// - Editable text is `.tx > [data-edit]`; the wrapper carries position (a CSS transform), font and colour, the inner
//   element the text. Line breaks inside a paragraph are "\n" characters (white-space: pre-wrap), not <br>, so
//   `contenteditable="plaintext-only"` is the right mode. A text that grows wraps at the page margin or at the
//   next text; nothing else moves (the layout is absolute, unlike hand-made templates).
// - Brand variables work as in any template. Fonts: the editor's own font stylesheet is enough.
