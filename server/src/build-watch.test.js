// A floor tablet sits on one page for a whole shift, and a deploy pulls the
// hashed files out from under it. The guard in index.html catches that — but
// only AFTER something has already failed to load, by which time the reader is
// looking at Live Floor in raw browser-default HTML with real figures on it.
//
// On 2026-08-26 a Printing tablet sat like that for five hours. Worse, it runs
// as an installed PWA: no address bar, no reload button, no pull-to-refresh.
// The operator had no way out at all, and nothing on the screen said what was
// wrong. It took closing the app from the recents switcher.
//
// So the page now notices a new build WHILE IT STILL WORKS, by comparing the
// assets it was built from against the ones the server is serving right now.
// No build-time constant and no server change: the document already names its
// own files, and `/` is served must-revalidate, so asking is cheap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetsIn, ownAssets, isNewBuild, shouldAutoReload, IDLE_MS } from '../../client/src/lib/buildWatch.js';

const shell = (js, css) => `<!doctype html><html><head>
  <script type="module" crossorigin src="/assets/index-${js}.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-${css}.css">
</head><body><div id="root"></div></body></html>`;

test('the assets a document was built from are read off its own tags', () => {
  assert.deepEqual(assetsIn(shell('AAA', 'BBB')),
    ['/assets/index-AAA.js', '/assets/index-BBB.css']);
});

test('the same build is not a new build', () => {
  const mine = assetsIn(shell('AAA', 'BBB'));
  assert.equal(isNewBuild(mine, assetsIn(shell('AAA', 'BBB'))), false);
});

test('a changed hash on either file is a new build', () => {
  const mine = assetsIn(shell('AAA', 'BBB'));
  assert.equal(isNewBuild(mine, assetsIn(shell('ZZZ', 'BBB'))), true, 'the app module moved');
  assert.equal(isNewBuild(mine, assetsIn(shell('AAA', 'ZZZ'))), true, 'the stylesheet moved');
});

test('a reply with no assets in it is NEVER treated as a new build', () => {
  // A captive portal on plant wi-fi, a proxy error page, an offline stub. Acting
  // on one of these would reload a working screen into a worse one, repeatedly,
  // and the floor cannot tell you that is what is happening.
  const mine = assetsIn(shell('AAA', 'BBB'));
  for (const junk of ['', '<html><body>Sign in to the network</body></html>', '<h1>502 Bad Gateway</h1>']) {
    assert.equal(isNewBuild(mine, assetsIn(junk)), false, `must ignore: ${junk.slice(0, 30)}`);
  }
});

test('a document that names no assets of its own cannot judge anything', () => {
  assert.equal(isNewBuild([], assetsIn(shell('AAA', 'BBB'))), false);
});

// ── When may it reload BY ITSELF ────────────────────────────────────────────
// It used to be "only while hidden", full stop. That was safe and it left the
// fleet behind: a plant tablet is an installed PWA that stays VISIBLE all shift,
// so it kept an old bundle for days and never received a client-side fix. So a
// visible page may now reload too — but only once nobody has touched it for
// IDLE_MS and nothing on it could be lost: no dialog, sheet or popover open, no
// request in flight, no field focused for typing, no form holding edits it has
// not saved. The same busy checks guard the hidden path, which used to reload
// with no look at what the page was holding at all.
const quiet = { idleMs: IDLE_MS, overlayOpen: false, inFlight: 0, editingFocused: false, dirty: false };
const base = { stale: true, hidden: true, servedSig: 'sig-new', reloadedFor: null, wasReload: false, persistent: true, ...quiet };

test('a hidden page reloads by itself; a visible one only once it has sat idle', () => {
  // Rewritten ON PURPOSE (was: "it reloads itself only while the page is
  // hidden", asserting hidden:false → false). The visible path is new policy.
  assert.equal(shouldAutoReload({ ...base }), true, 'hidden and stale — the tablet is down, take it');
  assert.equal(shouldAutoReload({ ...base, hidden: true, idleMs: 0 }), true,
    'nobody is looking at a hidden page, so it does not wait out the idle clock');
  assert.equal(shouldAutoReload({ ...base, hidden: false }), true,
    'visible, untouched for the whole idle window, nothing open or half-typed');
  assert.equal(shouldAutoReload({ ...base, hidden: false, idleMs: IDLE_MS - 1 }), false,
    'somebody touched this screen inside the idle window and may still be at it');
  assert.equal(shouldAutoReload({ ...base, hidden: false, idleMs: undefined }), false,
    'no idle reading is no permission');
  assert.equal(shouldAutoReload({ ...base, stale: false }), false);
});

test('the idle window is fifteen minutes', () => {
  // Long enough that a floor operator stepping away to the press comes back to
  // the screen they left; short enough that a deploy reaches an idle wall screen
  // inside the same shift.
  assert.equal(IDLE_MS, 15 * 60 * 1000);
});

test('an open dialog, sheet or popover stops the reload — on either path', () => {
  for (const hidden of [true, false]) {
    assert.equal(shouldAutoReload({ ...base, hidden, overlayOpen: true }), false,
      `hidden=${hidden}: a dialog is open — what is in it is not saved anywhere`);
  }
});

test('a request in flight stops the reload — on either path', () => {
  for (const hidden of [true, false]) {
    assert.equal(shouldAutoReload({ ...base, hidden, inFlight: 1 }), false,
      `hidden=${hidden}: a save may be half-way; reloading now leaves the operator not knowing if it landed`);
  }
});

test('a field focused for typing stops the reload — on either path', () => {
  for (const hidden of [true, false]) {
    assert.equal(shouldAutoReload({ ...base, hidden, editingFocused: true }), false,
      `hidden=${hidden}: the caret is in a field; the operator switched to WhatsApp mid-entry`);
  }
});

test('a form holding unsaved edits stops the reload — on either path', () => {
  for (const hidden of [true, false]) {
    assert.equal(shouldAutoReload({ ...base, hidden, dirty: true }), false,
      `hidden=${hidden}: a form holds figures that were typed and never saved`);
  }
});

test('a caller that does not say whether the page is busy is treated as busy', () => {
  // The vetoes are opt-OUT by stating "not busy". A future caller that forgets
  // one must get a page that stays put, never one that reloads over a form.
  for (const key of ['overlayOpen', 'inFlight', 'editingFocused', 'dirty']) {
    const args = { ...base };
    delete args[key];
    assert.equal(shouldAutoReload(args), false, `${key} missing must veto`);
  }
});

test('it will not reload twice for the same build', () => {
  // The loop this prevents is the one that already happened once: a guard that
  // refilled its own budget reloaded a Printing tablet ~70 times a second.
  assert.equal(shouldAutoReload({ ...base, reloadedFor: 'sig-new' }), false,
    'already reloaded for this build and still stale — reloading again cannot help');
  assert.equal(shouldAutoReload({ ...base, reloadedFor: 'sig-older' }), true,
    'a genuinely different build gets its own single attempt');
});

test('with no persistent storage it falls back to Navigation Timing', () => {
  // On a device that remembers nothing, the record of "already tried" cannot
  // survive the reload it is meant to bound. Whether THIS document is itself a
  // reload needs no permission and still cannot loop.
  assert.equal(shouldAutoReload({ ...base, persistent: false, wasReload: false }), true);
  assert.equal(shouldAutoReload({ ...base, persistent: false, wasReload: true }), false,
    'this document is already the product of a reload — stop there');
});

test('the app actually starts the watch, and offers a way to act on it', () => {
  // Both halves are invisible in the diff of any later change and silent when
  // they regress: the watch stops noticing deploys, or it notices and the reader
  // is given no way to act. The tablet this was built for has no reload control
  // of its own, so the button is not a convenience.
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /startBuildWatch\(/, 'App must start the build watch');
  assert.match(app, /window\.location\.reload\(\)/, 'and give the reader a control that reloads');
});

// ── What the LIVE document actually looks like ──────────────────────────────
//
// Every test above compares one parsed shell against another — apples to
// apples. Production never does that. `served` is the shell as the server
// serves it; `mine` is read off the DOM of a page that has been running, and by
// the time the watch starts, Vite's own preload helper has already appended a
// <link rel="modulepreload" href="/assets/…"> for every dependency of the first
// lazily-imported route. Five of them for the Dashboard alone, more on every
// navigation. Counting those made the document a permanent SUPERSET of the
// shell, so the compare said "new build" on every check, on every device, with
// nothing deployed — and the bar it raised could not be cleared by reloading,
// because the reloaded document pollutes its own DOM again within one render.

// A stand-in for the document. It hands back every tag and lets ownAssets do
// its own filtering, so the rule is tested rather than a CSS selector string.
function documentOf(tags) {
  const els = tags.map(t => ({
    tagName: t.tag.toUpperCase(),
    getAttribute: name => (name in t ? t[name] : null),
  }));
  return { querySelectorAll: () => els };
}

// The two tags a Vite build writes into index.html, plus the icons and manifest
// that sit beside them.
const shellTags = (js, css) => [
  { tag: 'script', type: 'module', crossorigin: '', src: `/assets/index-${js}.js` },
  { tag: 'link', rel: 'stylesheet', crossorigin: '', href: `/assets/index-${css}.css` },
  { tag: 'link', rel: 'icon', href: '/icon.svg' },
  { tag: 'link', rel: 'manifest', href: '/manifest.webmanifest' },
];

// What `__vitePreload` appends to <head> when React renders the first lazy
// route. It creates <link> elements — never a <script>.
const preloaded = [
  { tag: 'link', rel: 'modulepreload', as: 'script', crossorigin: '', href: '/assets/Dashboard-Cg4ZiiVx.js' },
  { tag: 'link', rel: 'modulepreload', as: 'script', crossorigin: '', href: '/assets/factory-CA91lVby.js' },
  { tag: 'link', rel: 'modulepreload', as: 'script', crossorigin: '', href: '/assets/trending-up-C5IuocXO.js' },
  { tag: 'link', rel: 'modulepreload', as: 'script', crossorigin: '', href: '/assets/percent-CPfzRiQ7.js' },
  { tag: 'link', rel: 'modulepreload', as: 'script', crossorigin: '', href: '/assets/clock-BdCocA0F.js' },
];

test('a route chunk this page fetched is not a file this page was built from', () => {
  assert.deepEqual(ownAssets(documentOf([...shellTags('AAA', 'BBB'), ...preloaded])),
    ['/assets/index-AAA.js', '/assets/index-BBB.css']);
});

test('a page that has been RUNNING is still on the build it was served', () => {
  // The whole bug in one line: same build, nothing deployed, banner anyway.
  const mine = ownAssets(documentOf([...shellTags('AAA', 'BBB'), ...preloaded]));
  assert.equal(isNewBuild(mine, assetsIn(shell('AAA', 'BBB'))), false);
});

test('and it still sees a real deploy from that same running page', () => {
  const mine = ownAssets(documentOf([...shellTags('AAA', 'BBB'), ...preloaded]));
  assert.equal(isNewBuild(mine, assetsIn(shell('ZZZ', 'BBB'))), true, 'the app module moved');
  assert.equal(isNewBuild(mine, assetsIn(shell('AAA', 'ZZZ'))), true, 'the stylesheet moved');
});

test('the rule is the same on both sides, or the bug comes back mirrored', () => {
  // Vite writes modulepreload links into index.html itself as soon as the entry
  // has a static chunk to split off. Reading them on one side and not the other
  // is this same permanent false positive, pointing the other way.
  const withPreload = shell('AAA', 'BBB').replace('</head>',
    '<link rel="modulepreload" crossorigin href="/assets/vendor-VVV.js"></head>');
  const mine = ownAssets(documentOf([...shellTags('AAA', 'BBB'), ...preloaded]));
  assert.equal(isNewBuild(mine, assetsIn(withPreload)), false);
});
