// Removes text, logos and QR codes from a finished raster design (a poster or social post exported as an image),
// so that the artwork can become the background of a template with live text on top.
// The work is done by server/extract-background.js (see there for how); this is the command-line wrapper.
//
// Usage: node tools/extract-background.mjs <in.jpg|png> <out.png> [--model gemini-2.5-flash-image] [--region global]
//                                          [--keep "what to keep"] [--reuse-model-output <file>]
//        also writes <out>.mask.png (white = repainted) and <out>.model.png (the raw model output) for checking.
// Needs Google Cloud application default credentials with Vertex AI access.

import fs from 'node:fs';
import sharp from 'sharp';
import { extractBackground, IMAGE_MODEL } from '../server/extract-background.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const [input, output] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
if (!input || !output) {
  console.error('Usage: node tools/extract-background.mjs <in> <out.png> [--model M] [--region R] [--keep "..."] [--reuse-model-output <file>]');
  process.exit(2);
}
const reuse = flag('--reuse-model-output', '');
const result = await extractBackground(fs.readFileSync(input), {
  model: flag('--model', IMAGE_MODEL),
  region: flag('--region', 'global'),
  keep: flag('--keep', undefined),
  modelOutput: reuse ? fs.readFileSync(reuse) : undefined,
});
const { width: W, height: H } = result;
const base = output.replace(/\.png$/, '');
if (!reuse) fs.writeFileSync(base + '.model.png', result.modelOutput);
await sharp(result.data, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(output);
await sharp(result.mask, { raw: { width: W, height: H, channels: 1 } }).png().toFile(base + '.mask.png');
console.log(JSON.stringify({ model: result.model, original: [W, H], model_output: result.modelSize, registration: result.registration, repainted_share: +result.repaintedShare.toFixed(3), output }));
