#!/usr/bin/env node
// Install optional, pinned browser bundles. Obtain Cubism Core from Live2D under its license, then pass --core.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DEST = fileURLToPath(new URL('../public/vendor/live2d/', import.meta.url));
const PACKAGES = [
  { name: 'pixi.js', version: '6.5.10', url: 'https://registry.npmjs.org/pixi.js/-/pixi.js-6.5.10.tgz',
    integrity: 'Z2mjeoISml2iuVwT1e/BQwERYM2yKoiR08ZdGrg8y5JjeuVptfTrve4DbPMRN/kEDodesgQZGV/pFv0fE9Q2SA==',
    entry: 'package/dist/browser/pixi.min.js', output: 'pixi.min.js', license: 'pixi.LICENSE' },
  { name: 'pixi-live2d-display', version: '0.4.0', url: 'https://registry.npmjs.org/pixi-live2d-display/-/pixi-live2d-display-0.4.0.tgz',
    integrity: 'xeYC6y4Y0Bxe9ksWNlGFZC1rII/MPrzPQK7t1c3ubA8RhkOISIqHJl38fNumXqhGEs+yItmgDOkFT+9dsyGDjA==',
    entry: 'package/dist/cubism4.min.js', output: 'cubism4.min.js', license: 'pixi-live2d-display.LICENSE' },
];

// Extract only named regular files in memory. No archive pathname is ever used as an output path.
export function tarEntries(buffer, names) {
  const found = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(n => n === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '');
    const prefix = text(345, 500), filename = text(0, 100);
    const name = prefix ? prefix + '/' + filename : filename;
    const size = parseInt(text(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw new Error('Invalid runtime archive');
    if ((header[156] === 0 || header[156] === 48) && names.includes(name)) {
      found.set(name, buffer.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const name of names) if (!found.has(name)) throw new Error('Runtime archive is missing ' + name);
  return found;
}

export async function installLive2D(corePath, { dest = DEST, fetchImpl = fetch } = {}) {
  if (!corePath) throw new Error('Pass --core PATH to an officially obtained live2dcubismcore.min.js');
  const core = await readFile(corePath);
  if (!core.includes(Buffer.from('Live2DCubismCore'))) throw new Error('The supplied file is not Cubism Core');
  const files = new Map([['live2dcubismcore.min.js', core]]);
  for (const pkg of PACKAGES) {
    const response = await fetchImpl(pkg.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Cannot download ' + pkg.name + ': HTTP ' + response.status);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > 25 * 1024 * 1024 || createHash('sha512').update(archive).digest('base64') !== pkg.integrity) {
      throw new Error('Integrity check failed for ' + pkg.name);
    }
    const entries = tarEntries(gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }), [pkg.entry, 'package/LICENSE']);
    files.set(pkg.output, entries.get(pkg.entry));
    files.set(pkg.license, entries.get('package/LICENSE'));
  }
  files.set('SOURCES.txt', PACKAGES.map(p => `${p.name}@${p.version}\n${p.url}`).join('\n\n') +
    '\n\nCubism Core and the bundled Cubism Framework are subject to Live2D licensing.\nhttps://www.live2d.com/en/sdk/license/\nModel assets require their own permission.\n');
  await mkdir(dest, { recursive: true });
  for (const [name, content] of files) await writeFile(path.join(dest, name), content);
  return dest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: node tools/setup-live2d.mjs --core PATH\nDownload Cubism SDK for Web from Live2D first, and use its Core/live2dcubismcore.min.js.');
  else if (args.length !== 2 || args[0] !== '--core') { console.error('Usage: node tools/setup-live2d.mjs --core PATH'); process.exitCode = 1; }
  else installLive2D(args[1]).then(dest => console.log('Live2D runtime installed in ' + dest)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
