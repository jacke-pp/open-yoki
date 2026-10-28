// Build the optional browser SDK from package-lock.json, with its third-party licenses.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSimliSdk } from './simli-sdk-patch.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public/vendor/simli');
let build;
try { ({ build } = await import('esbuild')); }
catch { throw new Error('Install build dependencies first: npm install --include=dev'); }

const result = await build({
  absWorkingDir: root,
  entryPoints: ['tools/simli-entry.mjs'],
  outfile: path.join(out, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
  plugins: [{
    name: 'simli-trial-lifecycle',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]simli-client[\\/]dist[\\/]client\.js$/ }, async args => {
        const source = await fs.readFile(args.path, 'utf8');
        const info = JSON.parse(await fs.readFile(path.join(path.dirname(args.path), '../package.json'), 'utf8'));
        return { contents: patchSimliSdk(source, { version: info.version }), loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  }],
});

// Include each bundled package's complete license in addition to esbuild's legal comments.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let dir = path.dirname(path.resolve(root, input));
  while (dir.startsWith(path.join(root, 'node_modules') + path.sep)) {
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      if (info.name && info.version) { packages.set(info.name, { dir, info }); break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    dir = path.dirname(dir);
  }
}
const notices = ['Simli browser SDK bundle — package versions and licenses', ''];
for (const [name, { dir, info }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push(`${name}@${info.version} (${info.license || 'see package license'})`);
  const files = (await fs.readdir(dir)).filter(file => /^(licen[cs]e|notice|copying)(\.|$)/i.test(file));
  for (const file of files) notices.push(await fs.readFile(path.join(dir, file), 'utf8'));
  notices.push('');
}
await fs.writeFile(path.join(out, 'THIRD_PARTY.txt'), notices.join('\n'));
console.log('Simli browser SDK built: public/vendor/simli/client.js');
