// Removes text, logos and QR codes from a finished raster design (a poster or social post exported as an image),
// so that the artwork can become the background of a template with live text on top.
//
// An image model repaints the picture without the text. Its output is smaller and slightly different everywhere, so
// it is NOT used as it is: the original pixels are kept wherever the two pictures agree, and the model's pixels are
// taken only where something was removed (found by comparing the two). Print quality outside those areas is untouched.
//
// Used by server/convert-image.js and by the command-line tool tools/extract-background.mjs.
// Needs Google Cloud application default credentials with Vertex AI access.

import sharp from 'sharp';

export const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'cs-project-tvcmny79';
const DEFAULT_KEEP = 'the photograph, the background, colours, lighting and framing';

let auth;
export async function accessToken() {
  if (!auth) {
    const { GoogleAuth } = await import('google-auth-library');
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  return auth.getAccessToken();
}

// POST to a Vertex AI publisher model. Retries on 429/5xx (the image model is often short of capacity).
export async function vertex(region, model, body, timeout = 180000) {
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${PROJECT}/locations/${region}/publishers/google/models/${model}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, [4000, 10000, 20000, 30000][attempt]));
      continue;
    }
    throw new Error(`Vertex ${model} ${res.status}: ${json.error?.message || res.statusText}`);
  }
}

/**
 * Asks the image model for a copy of the picture without text, logos and QR codes.
 * Returns the model's picture as it came (PNG or JPEG bytes; its own size and aspect ratio).
 */
export async function repaintWithoutText(buffer, { model = IMAGE_MODEL, region = 'global', keep = DEFAULT_KEEP } = {}) {
  const prompt =
    `Edit this image: remove ALL text, every logo, every QR code and every small icon next to text. ` +
    `Fill the places where they were with the background that would be behind them, continuing nearby texture, colour and lighting. ` +
    `Keep ${keep} exactly as they are. Do not move, crop, restyle or add anything. Return only the edited image, same aspect ratio.`;
  // The model does not need full resolution to repaint; a 1600 px copy keeps the request small.
  const small = await sharp(buffer).rotate().removeAlpha().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const json = await vertex(region, model, {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.2 },
  });
  const part = (json.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error(`${model} returned no image: ${JSON.stringify(json).slice(0, 300)}`);
  return Buffer.from(part.inlineData.data, 'base64');
}

const clampBox = (b, W, H, grow = 0) => {
  const x0 = Math.max(0, Math.floor(b.x - grow));
  const y0 = Math.max(0, Math.floor(b.y - grow));
  const x1 = Math.min(W, Math.ceil(b.x + b.w + grow));
  const y1 = Math.min(H, Math.ceil(b.y + b.h + grow));
  return { x0, y0, x1, y1 };
};

/**
 * @param {Buffer} buffer            the finished design (JPEG, PNG, WebP, ...)
 * @param {object} [options]
 * @param {string} [options.model]   image model (default gemini-2.5-flash-image)
 * @param {string} [options.region]  Vertex AI location (default global)
 * @param {string} [options.keep]    what the model must keep
 * @param {Buffer} [options.modelOutput]  reuse an earlier answer of the model instead of calling it
 * @param {Array|Promise<Array>} [options.limitTo]  boxes {x,y,w,h} in pixels of the original: only changes that touch
 *        one of these boxes are taken from the model (and only up to `limitMargin` px around it). Everything else keeps
 *        the original pixels, whatever the model did there. Without it every strong difference is taken.
 * @param {Array|Promise<Array>} [options.protect]  boxes {x,y,w,h} that always keep the original pixels (inset photos, icons)
 * @param {number} [options.limitMargin]  px around a `limitTo` box that may still be repainted (default 3% of the width)
 * @param {number} [options.threshold]    how different (0-255, on slightly blurred copies) a pixel must be to count (default 50)
 * @returns {Promise<{width:number,height:number,data:Buffer,original:Buffer,repaint:Buffer,strength:Uint8Array,mask:Buffer,
 *   modelOutput:Buffer,modelSize:number[],registration:object,repaintedShare:number,ignoredShare:number,model:string}>}
 *   `data` (the result), `original` and `repaint` (the model's picture laid over the original) are raw RGB, 3 bytes
 *   per pixel; `mask` is raw single-channel (255 = taken from the model); `strength` is how much the two differ.
 */
export async function extractBackground(buffer, options = {}) {
  const model = options.model || IMAGE_MODEL;
  const original = sharp(buffer).rotate().removeAlpha().toColourspace('srgb');
  const { data: orig, info } = await original.clone().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (info.channels !== 3) throw new Error(`expected an RGB image, got ${info.channels} channels`);
  const modelPng = options.modelOutput || (await repaintWithoutText(buffer, { model, region: options.region, keep: options.keep }));
  const modelMeta = await sharp(modelPng).metadata();

  // The model returns its own size and aspect ratio, so the picture has to be registered to the original first:
  // try small stretches and shifts on a coarse grey copy and keep the one where the two pictures agree best
  // (the median difference ignores the areas where text was removed).
  const grey = async (img, w, h) => (await img.clone().greyscale().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })).data;
  const cw = 240;
  const ch = Math.round((cw * H) / W);
  const origGrey = await grey(original, cw, ch);
  const modelImg = sharp(modelPng).removeAlpha().toColourspace('srgb');
  let best = { score: Infinity, sx: 1, sy: 1, dx: 0, dy: 0 };
  for (const sx of [0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06]) {
    for (const sy of [0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06]) {
      const mw = Math.round(cw * sx);
      const mh = Math.round(ch * sy);
      const m = await grey(modelImg, mw, mh);
      for (const fx of [0, 0.5, 1]) {
        for (const fy of [0, 0.5, 1]) {
          const dx = Math.round((cw - mw) * fx);
          const dy = Math.round((ch - mh) * fy);
          const diffs = [];
          for (let y = 4; y < ch - 4; y += 3) {
            for (let x = 4; x < cw - 4; x += 3) {
              const mx = x - dx;
              const my = y - dy;
              if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
              diffs.push(Math.abs(origGrey[y * cw + x] - m[my * mw + mx]));
            }
          }
          diffs.sort((p, q) => p - q);
          const score = diffs[Math.floor(diffs.length * 0.5)] + diffs[Math.floor(diffs.length * 0.3)];
          if (score < best.score) best = { score, sx, sy, dx: dx / cw, dy: dy / ch };
        }
      }
    }
  }
  // Refine on a larger copy, one parameter at a time: a stretch that is off by one percent moves a bright detail by
  // many pixels at full size, and every such detail would then count as "changed".
  {
    const fw = Math.min(W, 640);
    const fh = Math.round((fw * H) / W);
    const fine = await grey(original, fw, fh);
    const scaledCache = new Map();
    const scaledModel = async (sx, sy) => {
      const mw = Math.round(fw * sx);
      const mh = Math.round(fh * sy);
      const key = `${mw}x${mh}`;
      if (!scaledCache.has(key)) scaledCache.set(key, { mw, mh, data: await grey(modelImg, mw, mh) });
      return scaledCache.get(key);
    };
    const hist = new Uint32Array(256);
    const cost = async (p) => {
      const { mw, mh, data } = await scaledModel(p.sx, p.sy);
      hist.fill(0);
      let n = 0;
      for (let y = 6; y < fh - 6; y += 2) {
        const my = y - p.dy;
        if (my < 0 || my >= mh) continue;
        for (let x = 6; x < fw - 6; x += 2) {
          const mx = x - p.dx;
          if (mx < 0 || mx >= mw) continue;
          hist[Math.abs(fine[y * fw + x] - data[my * mw + mx])]++;
          n++;
        }
      }
      // mean of the smaller 60% of the differences (the rest is where text was removed)
      let left = n * 0.6;
      let sum = 0;
      for (let v = 0; v < 256 && left > 0; v++) {
        const take = Math.min(left, hist[v]);
        sum += take * v;
        left -= take;
      }
      return n ? sum / (n * 0.6) : Infinity;
    };
    let cur = { sx: best.sx, sy: best.sy, dx: Math.round(best.dx * fw), dy: Math.round(best.dy * fh) };
    let curCost = await cost(cur);
    const moves = [
      ['sx', [-0.012, -0.008, -0.004, 0.004, 0.008, 0.012]],
      ['sy', [-0.012, -0.008, -0.004, 0.004, 0.008, 0.012]],
      ['dx', [-4, -3, -2, -1, 1, 2, 3, 4]],
      ['dy', [-4, -3, -2, -1, 1, 2, 3, 4]],
    ];
    for (let round = 0; round < 4; round++) {
      let improved = false;
      for (const [param, deltas] of moves) {
        for (const d of deltas) {
          const trial = { ...cur, [param]: cur[param] + d };
          // a stretch is anchored at the corner: keep the centre in place while trying another scale
          if (param === 'sx') trial.dx = Math.round(cur.dx - (d * fw) / 2);
          if (param === 'sy') trial.dy = Math.round(cur.dy - (d * fh) / 2);
          const c = await cost(trial);
          if (c < curCost - 1e-6) {
            cur = trial;
            curCost = c;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    best = { score: +curCost.toFixed(3), sx: +cur.sx.toFixed(4), sy: +cur.sy.toFixed(4), dx: cur.dx / fw, dy: cur.dy / fh };
  }
  // Render the model's picture at full size with that placement (edges it does not cover fall back to the original).
  const rw = Math.round(W * best.sx);
  const rh = Math.round(H * best.sy);
  const left = Math.round(best.dx * W);
  const top = Math.round(best.dy * H);
  const scaled = await modelImg.clone().resize(rw, rh, { fit: 'fill', kernel: 'lanczos3' }).toBuffer();
  const cropL = Math.max(0, -left);
  const cropT = Math.max(0, -top);
  const visW = Math.min(rw - cropL, W - Math.max(0, left));
  const visH = Math.min(rh - cropT, H - Math.max(0, top));
  const piece = await sharp(scaled).extract({ left: cropL, top: cropT, width: visW, height: visH }).toBuffer();
  const repaint = await sharp(orig, { raw: { width: W, height: H, channels: 3 } }).composite([{ input: piece, left: Math.max(0, left), top: Math.max(0, top) }]).removeAlpha().raw().toBuffer();

  // How strongly do the two differ? Compare slightly blurred copies so that fine detail and compression do not count.
  const soft = async (buf) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).blur(Math.max(1.5, W / 600)).raw().toBuffer();
  const [a, b] = await Promise.all([soft(orig), soft(repaint)]);
  const strength = new Uint8Array(W * H);
  for (let i = 0, q = 0; i < W * H; i++, q += 3) strength[i] = Math.max(Math.abs(a[q] - b[q]), Math.abs(a[q + 1] - b[q + 1]), Math.abs(a[q + 2] - b[q + 2]));
  const state = { width: W, height: H, original: orig, repaint, strength, modelOutput: modelPng, modelSize: [modelMeta.width, modelMeta.height], registration: best, model };
  return { ...state, ...(await blendBackground(state, options)) };
}

/**
 * Second half of extractBackground: decides which pixels are taken from the model's picture and blends them in.
 * Can be called again on the result of extractBackground with tighter limits (nothing is asked of the model again).
 * @param {object} state  result of extractBackground (uses width, height, original, repaint, strength)
 * @param {object} [options]  threshold, limitTo, protect, limitMargin as for extractBackground, and
 * @param {Array}  [options.only]  boxes {x,y,w,h}: take the model's pixels ONLY for changes inside these boxes (plus the
 *        small rim that every change gets). Inside them weaker changes count as well (`onlyThreshold`, default 28).
 * @returns {Promise<{data:Buffer,mask:Buffer,repaintedShare:number,ignoredShare:number}>}
 */
export async function blendBackground(state, options = {}) {
  const { width: W, height: H, original: orig, repaint, strength } = state;
  const only = options.only || null;
  const threshold = options.threshold || 50;
  const diff = Buffer.alloc(W * H);
  if (only) {
    const low = options.onlyThreshold || 28;
    for (const bx of only) {
      const c = clampBox(bx, W, H, 0);
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (strength[y * W + x] > low) diff[y * W + x] = 255;
    }
  } else {
    for (let i = 0; i < W * H; i++) diff[i] = strength[i] > threshold ? 255 : 0;
  }
  // Fill the insides of letters, drop specks, grow a little and feather the edge. Every step stays single-channel.
  const one = (buf) => sharp(buf, { raw: { width: W, height: H, channels: 1 } });
  const single = async (img) => (await img.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true })).data;
  const r = Math.max(2, Math.round(W / 300));
  const clean = await single(one(diff).blur(Math.max(1, r * 0.5)).threshold(110)); // drop single-pixel specks
  // Grow a little: work on a coarse grid (one cell is about 1/200 of the width), mark every cell that contains
  // changed pixels plus its neighbours, then scale back up with a soft edge. Letters are covered with a margin of
  // one to two cells, and no more of the picture than that is taken from the model.
  const cell = Math.max(5, Math.round(W / 200));
  const sw = Math.ceil(W / cell);
  const sh = Math.ceil(H / cell);
  const coarse = await single(one(clean).resize(sw, sh, { fit: 'fill', kernel: 'cubic' }));
  const hit = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) hit[i] = coarse[i] > 8 ? 1 : 0;
  const grown = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < sh && xx < sw && hit[yy * sw + xx]) on = 1;
      }
      grown[y * sw + x] = on;
    }
  }

  // Optional limits, on the coarse grid: a connected patch of changes is kept only when it touches one of the
  // `limitTo` boxes, and then only up to `limitMargin` around the boxes; `protect` boxes are never repainted.
  const limitTo = !only && options.limitTo ? await options.limitTo : null;
  const protect = !only && options.protect ? await options.protect : null;
  let ignored = 0;
  const cellBox = (bx, growPx) => {
    const c = clampBox(bx, W, H, growPx);
    return { x0: Math.floor(c.x0 / cell), y0: Math.floor(c.y0 / cell), x1: Math.min(sw, Math.ceil(c.x1 / cell)), y1: Math.min(sh, Math.ceil(c.y1 / cell)) };
  };
  if (protect?.length) {
    // a text that lies on a protected photo is still removed: the protection stops a little outside its box
    const open = new Uint8Array(sw * sh);
    for (const bx of limitTo || []) {
      const c = cellBox(bx, Math.round(W * 0.012));
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) open[y * sw + x] = 1;
    }
    for (const bx of protect) {
      const c = cellBox(bx, 0);
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (!open[y * sw + x]) grown[y * sw + x] = 0;
    }
  }
  if (limitTo) {
    const margin = options.limitMargin ?? Math.round(W * 0.03);
    const inside = new Uint8Array(sw * sh); // 1 = within the margin of a box, 2 = within a box itself
    for (const bx of limitTo) {
      const outer = cellBox(bx, margin);
      for (let y = outer.y0; y < outer.y1; y++) for (let x = outer.x0; x < outer.x1; x++) inside[y * sw + x] ||= 1;
      const inner = cellBox(bx, 0);
      for (let y = inner.y0; y < inner.y1; y++) for (let x = inner.x0; x < inner.x1; x++) inside[y * sw + x] = 2;
    }
    if (protect?.length) {
      // inside a protected box nothing beyond the removable boxes themselves (plus the small rim above)
      for (const bx of protect) {
        const c = cellBox(bx, 0);
        for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (!grown[y * sw + x]) inside[y * sw + x] = 0;
      }
    }
    const label = new Int32Array(sw * sh).fill(-1);
    const stack = [];
    for (let start = 0; start < sw * sh; start++) {
      if (!grown[start] || label[start] >= 0) continue;
      const cells = [];
      let touches = false;
      label[start] = start;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        cells.push(p);
        if (inside[p] === 2) touches = true;
        const px = p % sw;
        const py = (p - px) / sw;
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const n = ny * sw + nx;
          if (grown[n] && label[n] < 0) {
            label[n] = start;
            stack.push(n);
          }
        }
      }
      for (const p of cells) {
        if (!touches || !inside[p]) {
          grown[p] = 0;
          ignored++;
        }
      }
    }
  }

  const grownBuf = Buffer.alloc(sw * sh);
  for (let i = 0; i < sw * sh; i++) grownBuf[i] = grown[i] ? 255 : 0;
  const mask = await single(sharp(grownBuf, { raw: { width: sw, height: sh, channels: 1 } }).resize(W, H, { fit: 'fill', kernel: 'nearest' }).blur(cell * 0.6));
  let covered = 0;
  for (let i = 0; i < W * H; i++) covered += mask[i] > 127 ? 1 : 0;

  // The model's colours are a little off (a plain grey comes back a shade lighter), which would show as faint
  // patches. Measure the offset between the two pictures around every patch, where nothing was removed, carry it
  // smoothly into the patch and add it to the model's pixels.
  const tone = toneCorrection(orig, repaint, mask, W, H);

  const out = Buffer.alloc(W * H * 3);
  for (let y = 0, i = 0, q = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++, q += 3) {
      const m = mask[i] / 255;
      if (m === 0) {
        out[q] = orig[q];
        out[q + 1] = orig[q + 1];
        out[q + 2] = orig[q + 2];
        continue;
      }
      const t = tone(x, y);
      for (let c = 0; c < 3; c++) {
        const v = orig[q + c] * (1 - m) + (repaint[q + c] + t[c]) * m;
        out[q + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return {
    data: out,
    mask,
    repaintedShare: +(covered / (W * H)).toFixed(4),
    ignoredShare: +((ignored * cell * cell) / (W * H)).toFixed(4), // changes of the model that were not taken (outside the limits)
  };
}

// Smooth field of (original - model) colour offsets, known outside the mask and carried into it.
// Returns a function (x, y) -> [r, g, b] offset.
function toneCorrection(orig, repaint, mask, W, H) {
  const cell = Math.max(4, Math.round(W / 200));
  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);
  const sum = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const weight = new Float32Array(gw * gh);
  for (let y = 0; y < H; y += 2) {
    const gy = Math.floor(y / cell);
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x;
      if (mask[i] > 2) continue;
      const q = i * 3;
      const d0 = orig[q] - repaint[q];
      const d1 = orig[q + 1] - repaint[q + 1];
      const d2 = orig[q + 2] - repaint[q + 2];
      if (Math.abs(d0) > 40 || Math.abs(d1) > 40 || Math.abs(d2) > 40) continue; // a different detail, not a tone
      const g = gy * gw + Math.floor(x / cell);
      sum[0][g] += d0;
      sum[1][g] += d1;
      sum[2][g] += d2;
      weight[g] += 1;
    }
  }
  // normalised blur, growing the reach until every cell has neighbours that know the offset
  const box = (src, radius) => {
    const tmp = new Float32Array(gw * gh);
    const dst = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      let acc = 0;
      for (let x = -radius; x < gw + radius; x++) {
        if (x + radius < gw) acc += src[y * gw + Math.max(0, x + radius)] * (x + radius >= 0 ? 1 : 0);
        if (x - radius - 1 >= 0) acc -= src[y * gw + x - radius - 1];
        if (x >= 0 && x < gw) tmp[y * gw + x] = acc;
      }
    }
    for (let x = 0; x < gw; x++) {
      let acc = 0;
      for (let y = -radius; y < gh + radius; y++) {
        if (y + radius < gh && y + radius >= 0) acc += tmp[(y + radius) * gw + x];
        if (y - radius - 1 >= 0) acc -= tmp[(y - radius - 1) * gw + x];
        if (y >= 0 && y < gh) dst[y * gw + x] = acc;
      }
    }
    return dst;
  };
  const field = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const done = new Uint8Array(gw * gh);
  for (const radius of [3, 6, 12, 24, 48, 96]) {
    const den = box(box(weight, radius), radius);
    const nums = sum.map((ch) => box(box(ch, radius), radius));
    const need = radius * radius * 2; // enough known samples nearby
    let open = 0;
    for (let g = 0; g < gw * gh; g++) {
      if (done[g]) continue;
      if (den[g] >= need || radius === 96) {
        if (den[g] > 0) for (let c = 0; c < 3; c++) field[c][g] = nums[c][g] / den[g];
        done[g] = 1;
      } else open++;
    }
    if (!open) break;
  }
  const smooth = field.map((ch) => box(ch, 1).map((v) => v / 9));
  // edges of the grid: the 3x3 box above divides by 9 everywhere; fix the border cells
  for (let c = 0; c < 3; c++) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) smooth[c][y * gw + x] = field[c][y * gw + x];
  const out = [0, 0, 0];
  return (x, y) => {
    const fx = Math.min(gw - 1.001, Math.max(0, x / cell - 0.5));
    const fy = Math.min(gh - 1.001, Math.max(0, y / cell - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const g = y0 * gw + x0;
    for (let c = 0; c < 3; c++) {
      const f = smooth[c];
      out[c] = (f[g] * (1 - ax) + f[g + 1] * ax) * (1 - ay) + (f[g + gw] * (1 - ax) + f[g + gw + 1] * ax) * ay;
    }
    return out;
  };
}

export default extractBackground;
