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

// Only Vite's own emitted files. Anything else on the page is not a build id.
const ASSET_REF = /(?:src|href)="(\/assets\/[^"]+)"/g;

export function assetsIn(html) {
  const found = new Set();
  for (const m of String(html || '').matchAll(ASSET_REF)) found.add(m[1]);
  return [...found].sort();
}

export function ownAssets(doc) {
  const found = new Set();
  for (const el of doc.querySelectorAll('script[src], link[href]')) {
    const raw = el.getAttribute('src') || el.getAttribute('href') || '';
    if (raw.startsWith('/assets/')) found.add(raw);
  }
  return [...found].sort();
}

// Both lists arrive sorted, so this is an ordered compare.
export function isNewBuild(mine, served) {
  // An empty `served` is a captive portal on plant wi-fi, a proxy error page, an
  // offline stub — NOT a deploy. Acting on one would reload a working screen
  // into a worse one, over and over, and the floor cannot tell you that is what
  // is happening. An empty `mine` means this document names no assets at all
  // and has no standing to judge.
  if (!mine?.length || !served?.length) return false;
  if (mine.length !== served.length) return true;
  return mine.some((a, i) => a !== served[i]);
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
