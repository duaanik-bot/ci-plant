// One door for storage, and the reason it has to be one door.
//
// A Printing tablet showed nothing at all — a blank screen, while every other
// device was fine. Nothing 404'd, the stylesheet applied, and the network log
// was clean; the bundle simply threw while it was still being imported:
//
//   Uncaught SecurityError: The operation is insecure.
//
// On a device with site data blocked, `window.localStorage` throws on the
// PROPERTY ACCESS — not on getItem, on merely naming it. `lib/tier.js` read it
// at module top level to check a debug escape hatch, so React never mounted.
// Being device-local, it survived every reload and was untouched by three
// deploys, and it looked exactly like "the app has stopped loading" while being
// a completely different fault from the stale-asset one.
//
// Hence the rule this file enforces: nothing outside `lib/safeStorage.js` may
// name localStorage or sessionStorage. A try/catch at the call site is not
// enough — the accesses that broke the floor were the ones nobody thought could
// throw, and half this codebase's call sites were already wrapped, which is
// exactly how the unwrapped half went unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const clientSrc = fileURLToPath(new URL('../../client/src/', import.meta.url));
const DOOR = 'lib/safeStorage.js';

function sourceFiles(dir = clientSrc, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (/\.jsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// Comments and strings talk about storage all over this codebase; only real
// code counts.
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

test('nothing outside safeStorage.js touches localStorage or sessionStorage', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(clientSrc, file).split(path.sep).join('/');
    if (rel === DOOR) continue;
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (/\b(localStorage|sessionStorage)\b/.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these reach storage directly instead of through lib/safeStorage.js. On a tablet '
    + 'with site data blocked the property access itself throws, and one at module '
    + 'scope takes the whole app down to a blank screen:\n  ' + offenders.join('\n  '));
});

test('the tier escape hatch cannot take the app down', () => {
  // This exact line was the one that did it: read at import time, unguarded.
  const tier = readFileSync(new URL('../../client/src/lib/tier.js', import.meta.url), 'utf8');
  assert.match(tier, /storage\.getItem\('ci_tier_force'\)/,
    'tier.js must read its escape hatch through safeStorage — it runs at module scope, '
    + 'so a throw there means React never mounts at all');
});

test('safeStorage degrades to memory when the store throws on access', async () => {
  const boom = () => { throw new Error('SecurityError: The operation is insecure.'); };
  const fake = {};
  Object.defineProperty(fake, 'localStorage', { get: boom });
  Object.defineProperty(fake, 'sessionStorage', { get: boom });
  globalThis.window = fake;
  try {
    const url = pathToFileURL(path.join(clientSrc, 'lib/safeStorage.js')).href;
    const { storage, storageIsPersistent } = await import(`${url}?throwing`);
    assert.equal(storageIsPersistent, false, 'a throwing store is not persistent');
    // The whole point: these must not throw, and must behave like a store.
    assert.equal(storage.getItem('nothing'), null);
    storage.setItem('ci_token', 'abc');
    assert.equal(storage.getItem('ci_token'), 'abc', 'the in-memory fallback must actually hold values');
    storage.removeItem('ci_token');
    assert.equal(storage.getItem('ci_token'), null);
  } finally { delete globalThis.window; }
});

test('safeStorage uses the real store when it works, and survives a write that fails', async () => {
  const backing = new Map();
  let writesFail = false;
  const real = {
    getItem: k => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { if (writesFail) throw new Error('QuotaExceededError'); backing.set(k, String(v)); },
    removeItem: k => { backing.delete(k); },
  };
  globalThis.window = { localStorage: real, sessionStorage: real };
  try {
    const url = pathToFileURL(path.join(clientSrc, 'lib/safeStorage.js')).href;
    const { storage, storageIsPersistent } = await import(`${url}?working`);
    assert.equal(storageIsPersistent, true);
    storage.setItem('ci_sidebar_collapsed', '1');
    assert.equal(backing.get('ci_sidebar_collapsed'), '1', 'a working store must be used, not shadowed');

    // A store can start throwing mid-shift when the device fills up.
    writesFail = true;
    storage.setItem('ci_floor_nav', '0');           // must not throw
    assert.equal(storage.getItem('ci_floor_nav'), '0',
      'a write the device refused must still read back for the rest of the session');
  } finally { delete globalThis.window; }
});
