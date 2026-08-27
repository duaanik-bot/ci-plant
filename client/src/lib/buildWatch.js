// Notice a new build WHILE THE PAGE STILL WORKS.
//
// A floor tablet sits on one page for a whole shift. When a deploy lands, the
// hashed files that page is holding are gone. The guard in index.html catches
// that, but only once something has already FAILED to load — by which time the
// reader is looking at Live Floor in raw browser-default HTML, real figures and
// no stylesheet, which reads exactly like the app having died.
//
// On 2026-08-26 a Printing tablet sat like that for five hours. It runs as an
// installed PWA: no address bar, no reload button, no pull-to-refresh. Nothing
// on screen said what was wrong and there was no way out of it — it took closing
// the app from the recents switcher. Reacting to breakage is too late on a
// device like that.
//
// So: compare the assets this document was built from against the ones the
// server is serving now. There is no build-time constant to keep in sync and no
// server change — the document already names its own files, and `/` is served
// `must-revalidate`, so asking is usually a 304.
import { sessionStore, storageIsPersistent } from './safeStorage.js';

// What counts as a file this document was BUILT FROM: the entry module and the
// stylesheet — the two tags a Vite build writes into index.html. The icons, the
// manifest and the font sheet are not build identity, and neither is a
// modulepreload link.
//
// That last one is the whole reason this rule exists. Vite's own preload helper
// appends `<link rel="modulepreload" href="/assets/…">` to <head> for every
// dependency of a lazily-imported route — five of them for the Dashboard alone,
// more on every navigation. Those are files the page FETCHED, not files it was
// built from, and counting them made the live DOM a permanent superset of the
// shell the server serves. The compare below then read "new build" on every
// check, on every device, with nothing deployed: a bar across the top of the
// app that reloading could not clear, because the reloaded document pollutes
// its own DOM again within one render.
//
// The rule has to hold on BOTH sides. Applying it to the DOM alone would trade
// that bug for its mirror image the day the shell itself carries a preload link
// — the served list would name a file the document has no tag for, which reads
// as a deploy just as permanently.
function isBuildAsset(tag, rel, url) {
  if (!url || !url.startsWith('/assets/')) return false;
  if (tag === 'SCRIPT') return true;      // the preload helper only ever makes links
  return tag === 'LINK' && rel === 'stylesheet';
}

const TAG = /<(script|link)\b([^>]*)>/gi;
const ATTR = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

export function assetsIn(html) {
  const found = new Set();
  for (const [, tag, attrs] of String(html || '').matchAll(TAG)) {
    const a = {};
    for (const [, name, value] of attrs.matchAll(ATTR)) a[name.toLowerCase()] = value;
    const url = a.src || a.href;
    if (isBuildAsset(tag.toUpperCase(), a.rel, url)) found.add(url);
  }
  return [...found].sort();
}

export function ownAssets(doc) {
  const found = new Set();
  for (const el of doc.querySelectorAll('script, link')) {
    const url = el.getAttribute('src') || el.getAttribute('href') || '';
    if (isBuildAsset(el.tagName, el.getAttribute('rel'), url)) found.add(url);
  }
  return [...found].sort();
}

// Does the server name a file this document does not have?
//
// Not "are the two lists identical". A page that has been running collects tags
// of its own — the preload links above are only today's example — and an
// equality test hands every one of them the power to raise a banner nobody can
// dismiss. Growth in the document is inert here; only a name the document has
// never seen counts as a deploy.
export function isNewBuild(mine, served) {
  // An empty `served` is a captive portal on plant wi-fi, a proxy error page, an
  // offline stub — NOT a deploy. Acting on one would reload a working screen
  // into a worse one, over and over, and the floor cannot tell you that is what
  // is happening. An empty `mine` means this document names no assets at all
  // and has no standing to judge.
  if (!mine?.length || !served?.length) return false;
  const have = new Set(mine);
  return served.some(a => !have.has(a));
}

// When may it reload BY ITSELF, with nobody asking?
export function shouldAutoReload({ stale, hidden, servedSig, reloadedFor, wasReload, persistent }) {
  if (!stale) return false;
  // Only while nobody is looking. An operator keying production figures must
  // never have the page pulled out from under them; visible staleness is the
  // banner's job, not this one's.
  if (!hidden) return false;
  // Already reloaded for THIS build and still stale: reloading again cannot
  // help, and an unattended loop on a hidden page is invisible until the
  // battery is flat. One attempt per distinct build, ever.
  if (reloadedFor && reloadedFor === servedSig) return false;
  // On a device that remembers nothing, the record above cannot survive the
  // reload it is meant to bound. Navigation Timing needs no permission and
  // still cannot loop: a reloaded document refuses to reload again.
  if (!persistent && wasReload) return false;
  return true;
}

const KEY = 'ci:build-reloaded-for';
const POLL_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 30 * 1000;      // visibility flaps; do not hammer the origin

export function startBuildWatch({ onNewBuild } = {}) {
  if (typeof document === 'undefined' || typeof fetch !== 'function') return () => {};
  const mine = ownAssets(document);
  if (!mine.length) return () => {};   // dev server: no hashed assets to compare

  let stopped = false;
  let announced = false;
  let lastCheck = 0;

  const wasReload = (() => {
    try { return performance.getEntriesByType('navigation')[0]?.type === 'reload'; }
    catch { return false; }
  })();

  async function check(force = false) {
    if (stopped) return;
    const t = Date.now();
    if (!force && t - lastCheck < MIN_GAP_MS) return;
    lastCheck = t;

    let html;
    try {
      const res = await fetch('/', { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) return;                 // a 502 is not a deploy
      html = await res.text();
    } catch { return; }                    // offline, or a blip: never act on a failed ask

    const served = assetsIn(html);
    if (!isNewBuild(mine, served)) return;

    const servedSig = served.join('|');
    if (!announced) { announced = true; onNewBuild?.(); }

    if (shouldAutoReload({
      stale: true,
      hidden: document.hidden,
      servedSig,
      reloadedFor: sessionStore.getItem(KEY),
      wasReload,
      persistent: storageIsPersistent,
    })) {
      sessionStore.setItem(KEY, servedSig);
      location.reload();
    }
  }

  const timer = setInterval(() => check(true), POLL_MS);
  const onVisibility = () => check();
  // A tab restored from the back/forward cache is replaying an OLD document —
  // precisely the one whose files may be gone.
  const onPageShow = e => { if (e.persisted) check(true); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
  };
}
