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
import { assetsIn, isNewBuild, shouldAutoReload } from '../../client/src/lib/buildWatch.js';

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
// Only while nobody is looking. An operator keying production figures must
// never have the page pulled out from under them.
const base = { stale: true, hidden: true, servedSig: 'sig-new', reloadedFor: null, wasReload: false, persistent: true };

test('it reloads itself only while the page is hidden', () => {
  assert.equal(shouldAutoReload({ ...base }), true, 'hidden and stale — the tablet is down, take it');
  assert.equal(shouldAutoReload({ ...base, hidden: false }), false,
    'somebody is looking at this screen and may be typing into it');
  assert.equal(shouldAutoReload({ ...base, stale: false }), false);
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
