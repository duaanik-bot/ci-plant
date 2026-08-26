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

// ── The tablet still could not stay signed in ────────────────────────────────
//
// Booting was only half of it. With the real store gone the fallback is memory,
// so `ci_token` lived exactly as long as the document did — and the Printing
// tablet reloads more than most: the stale-build guard in index.html reloads it
// on purpose after a deploy, Android discards a backgrounded tab, and a floor
// tablet gets pulled-to-refresh by hand all shift. Every one of those returned
// the printing section to the login screen.
//
// Cookies are a SEPARATE permission from DOM storage. An Android WebView built
// with `domStorageEnabled(false)` keeps them; so do the browser privacy modes
// that throw SecurityError on `window.localStorage`. And `document.cookie` never
// throws — blocked, it reads back empty — so trying it can only ever help.
//
// Hence a middle rung: real store, else cookies, else memory.

// A cookie jar that behaves like the real accessor: writes are one at a time,
// reads are the whole jar, and an expiry in the past deletes.
function fakeCookieJar({ maxBytes = 4096 } = {}) {
  const jar = new Map();
  return {
    get jarSize() { return jar.size; },
    raw: jar,
    install(target) {
      Object.defineProperty(target, 'cookie', {
        configurable: true,
        get: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
        set: (str) => {
          const [pair, ...attrs] = String(str).split(';');
          const eq = pair.indexOf('=');
          if (eq < 0) return;
          const k = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          const dead = attrs.some(a => /max-age\s*=\s*0/i.test(a) || /expires\s*=\s*Thu, 01 Jan 1970/i.test(a));
          if (dead) { jar.delete(k); return; }
          // Real browsers silently DROP a cookie that is over the per-cookie cap.
          if (`${k}=${v}`.length > maxBytes) return;
          jar.set(k, v);
        },
      });
    },
  };
}

async function freshStorage(tag) {
  const url = pathToFileURL(path.join(clientSrc, 'lib/safeStorage.js')).href;
  return import(`${url}?${tag}`);
}

function blockDomStorage() {
  const boom = () => { throw new Error('SecurityError: The operation is insecure.'); };
  const fake = {};
  Object.defineProperty(fake, 'localStorage', { get: boom });
  Object.defineProperty(fake, 'sessionStorage', { get: boom });
  globalThis.window = fake;
  return fake;
}

test('a device that blocks DOM storage but allows cookies stays signed in across a reload', async () => {
  blockDomStorage();
  const jar = fakeCookieJar();
  globalThis.document = {};
  jar.install(globalThis.document);
  try {
    const first = await freshStorage('cookies-write');
    first.storage.setItem('ci_token', 'header.payload.signature');
    first.storage.setItem('ci_user', JSON.stringify({ id: 7, name: 'Printing', role: 'operator' }));

    assert.ok(jar.jarSize > 0, 'the session must reach the cookie jar, not just memory');

    // The reload: a brand-new module instance, nothing carried over but the jar.
    const afterReload = await freshStorage('cookies-read');
    assert.equal(afterReload.storage.getItem('ci_token'), 'header.payload.signature',
      'the printing tablet must still hold its token after a reload');
    assert.equal(JSON.parse(afterReload.storage.getItem('ci_user')).name, 'Printing');
    assert.equal(afterReload.storageIsPersistent, true,
      'a session that survives a reload IS persistent, whatever is carrying it');
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('a cookie-carried value can be removed, and does not come back', async () => {
  blockDomStorage();
  const jar = fakeCookieJar();
  globalThis.document = {};
  jar.install(globalThis.document);
  try {
    const s = await freshStorage('cookies-remove');
    s.storage.setItem('ci_token', 'abc');
    assert.ok(jar.jarSize > 0, 'the token has to be IN the jar before removing it proves anything');
    s.storage.removeItem('ci_token');
    assert.equal(jar.jarSize, 0, 'signing out must clear the cookie, not just the memory copy');
    assert.equal(s.storage.getItem('ci_token'), null);
    const afterReload = await freshStorage('cookies-remove-2');
    assert.equal(afterReload.storage.getItem('ci_token'), null,
      'signing out has to outlive the reload too, or the tablet signs itself back in');
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('a value the cookie jar refuses reads back as written, not as stale', async () => {
  blockDomStorage();
  const jar = fakeCookieJar({ maxBytes: 64 });   // smaller than the second write
  globalThis.document = {};
  jar.install(globalThis.document);
  try {
    const s = await freshStorage('cookies-toobig');
    s.storage.setItem('ci_user', 'small');
    assert.ok(jar.jarSize > 0, 'the write that FITS must reach the jar, or the next assertion is vacuous');
    s.storage.setItem('ci_user', 'x'.repeat(4000));
    assert.equal(s.storage.getItem('ci_user'), 'x'.repeat(4000),
      'a write the jar dropped must still read back for the rest of the session, '
      + 'never the value it replaced');
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('cookies carry values that contain the characters a cookie cannot', async () => {
  blockDomStorage();
  const jar = fakeCookieJar();
  globalThis.document = {};
  jar.install(globalThis.document);
  try {
    const s = await freshStorage('cookies-encode');
    // ci_user is JSON: semicolons, commas, quotes and spaces all end a cookie early.
    const hostile = JSON.stringify({ name: 'A; B, C="D"', note: 'x=y; path=/' });
    s.storage.setItem('ci_user', hostile);
    const afterReload = await freshStorage('cookies-encode-2');
    assert.equal(afterReload.storage.getItem('ci_user'), hostile);
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('with DOM storage AND cookies both refused it still runs, on memory', async () => {
  blockDomStorage();
  globalThis.document = {};
  // A jar that accepts nothing — cookies blocked outright.
  Object.defineProperty(globalThis.document, 'cookie', {
    configurable: true, get: () => '', set: () => {},
  });
  try {
    const s = await freshStorage('nothing-works');
    assert.equal(s.storageIsPersistent, false, 'nothing here survives a reload, and it must say so');
    s.storage.setItem('ci_token', 'abc');
    assert.equal(s.storage.getItem('ci_token'), 'abc', 'the app still has to RUN');
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('a device that can remember nothing at all SAYS so on the login screen', () => {
  // The last rung is memory, and on it the app runs but cannot hold a session:
  // every reload returns to /login. Left silent that reads as the app signing
  // you out at random — undiagnosable from the floor, and the Printing tablet
  // reloads often enough to do it several times a shift.
  const login = readFileSync(new URL('../../client/src/pages/Login.jsx', import.meta.url), 'utf8');
  assert.match(login, /storageIsPersistent/,
    'Login must branch on whether this device can hold a session at all');
  assert.match(login, /site data/i,
    'and the notice has to name the setting that fixes it, not just report failure');
});
