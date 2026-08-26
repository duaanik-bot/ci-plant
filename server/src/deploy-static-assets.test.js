// The deploy contract that keeps a plant tablet alive across a release.
//
// 2026-08-26, 15:44: a tablet showed Live Floor with real figures — 1 running,
// 56 queued — rendered in raw browser-default HTML. It was not down. Its page
// came from the deployment before the one that had just gone out, so it asked
// for that build's hashed stylesheet; the SPA catch-all matched `/assets/…`
// like any other path and answered index.html at HTTP 200 with
// `Content-Type: text/html`. A browser will not accept HTML as a stylesheet,
// so it dropped the CSS and said nothing. The old JS was still in the device
// cache under `immutable, max-age=31536000`, so React booted and the API
// answered — which is exactly why it read as live data with no styling rather
// than as an error. When the app module is the file that has gone instead, the
// screen simply stays blank, which is the same fault wearing "the app has
// stopped loading".
//
// Two properties have to hold, and neither is visible by reading the diff of a
// later change, which is why they are pinned here:
//
//   1. a hashed asset that is gone answers 404 — a truth the browser reports as
//      a load error — instead of being handed a document it will silently
//      refuse;
//   2. index.html listens for that error and reloads once, so the reader gets a
//      working screen without knowing to force-refresh.
//
// Skew Protection is already enabled on the project (12h) and did NOT prevent
// this: nothing in a static Vite SPA sends `__vdpl`, `?dpl` or
// `x-deployment-id`, so the CDN cannot tell which deployment a stale tablet
// belongs to. The platform is not the backstop here. This file is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const vercel = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));
const indexHtml = readFileSync(new URL('client/index.html', root), 'utf8');
const mainJsx = readFileSync(new URL('client/src/main.jsx', root), 'utf8');

// Which rewrite claims a path — Vercel applies these only after the filesystem
// misses, so this answers "what happens to a file that is NOT there".
function rewriteFor(pathname) {
  for (const r of vercel.rewrites) {
    if (new RegExp(`^${r.source}$`).test(pathname)) return r.destination;
  }
  return null; // no rewrite → a real 404
}

test('a hashed asset that no longer exists 404s instead of returning a document', () => {
  for (const gone of [
    '/assets/index-CKCWB1Dq.css',   // the shape of the file the tablet asked for
    '/assets/index-CY9bImcK.js',
    '/assets/Planning-ZFk7Vq8w.js', // a lazily-imported route chunk
    '/assets/exceljs.min-y9gEfTol.js',
  ]) {
    assert.equal(rewriteFor(gone), null,
      `${gone} must fall through to a 404. Rewriting it to index.html hands the `
      + 'browser HTML for a stylesheet or a module — which it refuses in silence, '
      + 'and the floor gets an unreadable screen with live figures on it.');
  }
});

test('every real screen still falls through to the SPA', () => {
  for (const route of [
    '/', '/login', '/floor', '/floor/sort-paste', '/floor/printing', '/track',
    '/print-planning', '/planning', '/orders', '/procurement', '/masters',
    '/production/jobcard/2211', '/invoices/42', '/dispatch/challan/7',
  ]) {
    assert.equal(rewriteFor(route), '/index.html',
      `${route} is a client route and must still be served the app shell`);
  }
});

test('the API is still routed to the function, not the shell', () => {
  for (const p of ['/api/health', '/api/orders', '/api/board/stock']) {
    assert.equal(rewriteFor(p), '/api/index', `${p} must reach the API`);
  }
});

test('the asset exclusion is scoped to /assets/ and nothing else', () => {
  // Files Vite copies from client/public sit at the root and keep their names
  // across builds, so they are not part of the skew problem — and they must keep
  // falling through, because that is how the SPA serves a deep link.
  assert.equal(rewriteFor('/manifest.webmanifest'), '/index.html');
  assert.equal(rewriteFor('/assetsomething'), '/index.html',
    'the exclusion must match the /assets/ directory, not any path starting "assets"');
});

test('index.html recovers from a stale build, in the head, before Vite injects', () => {
  const guard = indexHtml.indexOf('ci:stale-build-reload');
  assert.ok(guard > 0, 'the stale-build recovery guard is gone from client/index.html');
  assert.ok(guard < indexHtml.indexOf('</head>'),
    'the guard must sit in <head>: Vite appends the stylesheet and module tags to the '
    + 'end of <head>, so a listener placed after them is attached too late to hear '
    + 'them fail');

  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
  assert.match(head, /addEventListener\('error',[\s\S]{0,600}?,\s*true\)/,
    'the error listener must be in the CAPTURE phase — resource load failures do not bubble');
  assert.match(head, /vite:preloadError/,
    'a lazily-imported route chunk fails as a rejected promise, not an element error; '
    + 'without this a stale tablet recovers the shell and then dies on the first route');
  assert.match(head, /location\.reload\(\)/, 'the guard must actually reload');
});

// The Printing tablet, 2026-08-26. The shell booted, the app then failed to
// fetch the Section route chunk, and the guard reloaded — about seventy times a
// second, because the budget was a single flag that main.jsx cleared on every
// successful boot. A shell that boots is not an app that works, and anything
// that refills the budget on a boot restores that loop exactly.
test('the reload budget is bounded and nothing refills it on boot', () => {
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));

  assert.match(head, /MAX_TRIES\s*=\s*[1-3]\b/,
    'the guard needs a hard cap on reloads. Two reloads and a broken screen is a bad '
    + 'outcome; an endless reload is a worse one, and the floor cannot tell them apart');
  assert.match(head, /n\s*>=\s*MAX_TRIES/, 'the cap has to actually be enforced');
  assert.match(head, /WINDOW_MS/,
    'the budget must lapse on TIME, so the next deploy is recovered without anything '
    + 'having to declare success');

  assert.doesNotMatch(mainJsx, /removeItem\(['\"]ci:stale-build-reload/,
    'main.jsx must NOT clear the recovery budget. That single line turned a bounded '
    + 'retry into an infinite reload loop on any screen whose route chunk was missing.');
  assert.doesNotMatch(indexHtml, /removeItem\(['\"]ci:stale-build-reload/,
    'nothing may clear the budget — it expires on its own');
});

// A plant hands out locked-down tablets. On a device with site data blocked,
// every sessionStorage access throws, and the first version of this guard
// treated that as "do nothing" — silently inert on exactly those devices.
test('the guard still works where sessionStorage throws', () => {
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
  assert.match(head, /getEntriesByType\(['\"]navigation/,
    'with no storage to record an attempt in, Navigation Timing still says whether this '
    + 'document is itself a reload — which allows exactly one retry and can never loop');
  assert.match(head, /catch[\s\S]{0,80}?return null/,
    'an unusable sessionStorage must route to the storage-free path, not abort recovery');
});

test('hashed assets are still served immutable', () => {
  const rule = vercel.headers.find(h => h.source.startsWith('/assets/'));
  assert.ok(rule, '/assets/ must keep its cache header');
  const cc = rule.headers.find(h => h.key.toLowerCase() === 'cache-control');
  assert.match(cc.value, /immutable/,
    'the filenames are content-hashed, so the long immutable cache is correct — it is '
    + 'also why a stale document keeps working long enough to reach a deploy');
});
