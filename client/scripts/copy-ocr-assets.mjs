// Stage the OCR engine's runtime files as static assets.
//
// tesseract.js does not bundle: at run time it fetches a worker script, a wasm
// core and a ~11MB language model, and by default it fetches all three from a
// public CDN. A plant floor should not depend on a third-party CDN being
// reachable to read a purchase order, and the files must match the engine
// version exactly — so they are copied out of node_modules at build time,
// which keeps them version-locked to the installed package and keeps ~19MB of
// binaries out of git.
//
// Runs from `predev` and `prebuild`, so `vite` and `vite build` both have them.
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

// Resolved through require.resolve so this follows npm's actual layout rather
// than assuming deps are hoisted to the workspace root (they may not be).
const pkgDir = (name, from = require) => dirname(from.resolve(`${name}/package.json`));

// tesseract.js-core is not a direct dependency — it belongs to tesseract.js.
// Resolve it FROM tesseract.js: if npm nests it under that package rather than
// hoisting it, a lookup from here walks past it and never looks inside, and the
// build fails on Vercel while passing on a machine that happened to hoist.
const coreDir = () => {
  const fromTesseract = createRequire(join(pkgDir('tesseract.js'), 'package.json'));
  try {
    return pkgDir('tesseract.js-core', fromTesseract);
  } catch {
    return pkgDir('tesseract.js-core');
  }
};

const JOBS = [
  // The worker script tesseract.js loads to run the engine off the main thread.
  [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'tesseract/worker.min.js'],
  // BOTH lstm cores. corePath is given as a directory, and tesseract.js picks
  // between them by probing for wasm SIMD at run time; shipping only the SIMD
  // build would leave an older browser with no engine and no clear error.
  [join(coreDir(), 'tesseract-core-simd-lstm.wasm.js'), 'tesseract/tesseract-core-simd-lstm.wasm.js'],
  [join(coreDir(), 'tesseract-core-lstm.wasm.js'), 'tesseract/tesseract-core-lstm.wasm.js'],
  // The 4.0.0 model — the same data the engine fetches from its own CDN by
  // default, which is what this feature's accuracy was measured against. Do not
  // quietly swap it for a smaller variant.
  [join(pkgDir('@tesseract.js-data/eng'), '4.0.0', 'eng.traineddata.gz'), 'tessdata/eng.traineddata.gz'],
];

let copied = 0;
for (const [from, rel] of JOBS) {
  const to = join(publicDir, rel);
  if (!existsSync(from)) {
    console.error(`[ocr-assets] MISSING ${from}\n  Run npm install; OCR of scanned POs cannot work without it.`);
    process.exit(1);
  }
  // Skip an identical copy so a dev server restart is not a 19MB file shuffle.
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied++;
}
console.log(`[ocr-assets] ${copied ? `staged ${copied} file(s)` : 'already up to date'} in client/public`);
