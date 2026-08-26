// Every storage read and write in the app goes through here.
//
// On a device with site data blocked, `window.localStorage` throws SecurityError
// on the PROPERTY ACCESS — not on a method call, on merely naming it. One such
// read sat at module top level in lib/tier.js, so the bundle threw while it was
// still being imported and React never mounted. The result was a blank screen on
// that one tablet, with every asset served correctly and nothing in the network
// log to look at, immune to reloading and to every deploy. It looked exactly
// like the app "not loading", and it was not the stale-asset fault at all.
//
// Android does this with site data blocked, a WebView does it with DOM storage
// disabled, and Safari's private mode does the quota variant where reads work
// and writes throw. All three end up here.
//
// There are three rungs: the real store, then COOKIES, then memory.
//
// The cookie rung is what keeps the Printing tablet signed in. Memory alone
// made `ci_token` live exactly as long as the document did, and that tablet
// reloads more than most — the stale-build guard in index.html reloads it on
// purpose after a deploy, Android discards a backgrounded tab, and a floor
// tablet gets pulled-to-refresh by hand all shift. Every one of those was a
// trip back to the login screen, all day, on the one device that could least
// afford it.
//
// Memory is still the last rung, and it is not nothing: the app RUNS. What is
// lost there is only persistence across reloads — staying signed in, a
// remembered sidebar, the timeline's last range. A floor tablet that works and
// forgets is enormously better than one that shows nothing at all.

function usable(kind) {
  try {
    // The property access is itself the throwing step, so it has to be inside
    // the try — and a probe write catches the quota/private-mode variant that a
    // read alone would sail past.
    const real = window[kind];
    const probe = '__ci_storage_probe__';
    real.setItem(probe, '1');
    real.removeItem(probe);
    return real;
  } catch { return null; }
}

function inMemory() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

// ── The middle rung: cookies ────────────────────────────────────────────────
//
// Cookies are a SEPARATE permission from DOM storage on every engine that
// matters. An Android WebView built with `domStorageEnabled(false)` — which is
// how a great many kiosk and vendor shells are built — keeps cookies working,
// and so do the browser privacy modes that throw SecurityError on
// `window.localStorage`. So the device that cannot do one of them can very
// often still do the other.
//
// `document.cookie` never throws. Blocked, it reads back empty — which is why
// the only honest probe is to write one and go looking for it, and why adding
// this rung cannot cost anything on a device that does not need it.

const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;   // 400 days — the cap Chrome enforces
// A cookie rides on EVERY request to this origin, API calls included. Nothing
// the app stores is more than a few hundred bytes, so a value that would bloat
// the request header is refused here and shadowed in memory instead.
const COOKIE_MAX_BYTES = 3500;

function cookieJar() {
  try { return String(document.cookie || ''); } catch { return ''; }
}

function readCookie(name) {
  for (const part of cookieJar().split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    // A jar written by something else can hold a malformed escape.
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

function writeCookie(name, encoded, session) {
  // Secure only where it is meaningful; on plain http it would stop the cookie
  // being set at all, and the dev server is http.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; secure' : '';
  // No max-age is a session cookie, which is exactly sessionStorage's lifetime.
  const life = session ? '' : `; max-age=${COOKIE_MAX_AGE}`;
  // SameSite=Lax because this never needs to travel on a cross-site request.
  // It widens no CSRF surface: the SERVER never reads it — the client reads it
  // back and sends a Bearer header — so a cookie the browser attaches to a
  // forged request authorises nothing.
  try { document.cookie = `${name}=${encoded}; path=/; samesite=lax${life}${secure}`; } catch { /* blocked */ }
}

function dropCookie(name) {
  try { document.cookie = `${name}=; path=/; max-age=0`; } catch { /* blocked */ }
}

function cookieBacked(kind) {
  if (typeof document === 'undefined') return null;
  const session = kind === 'sessionStorage';
  // Namespaced so the two stores cannot read each other's keys out of the one
  // jar they share, and so nothing else on the origin collides with either.
  const prefix = session ? 'ci.s.' : 'ci.l.';
  const nameOf = k => prefix + encodeURIComponent(String(k));

  const probe = nameOf('__ci_cookie_probe__');
  writeCookie(probe, '1', session);
  const usableJar = readCookie(probe) === '1';
  dropCookie(probe);
  if (!usableJar) return null;

  return {
    getItem: k => readCookie(nameOf(k)),
    setItem(k, v) {
      const name = nameOf(k);
      // Encoded, because a raw `;` `,` `=` or space ends a cookie early and
      // `ci_user` is JSON — it contains all four.
      const encoded = encodeURIComponent(String(v));
      if (name.length + encoded.length > COOKIE_MAX_BYTES) throw new Error('cookie too large');
      writeCookie(name, encoded, session);
      // A browser DROPS an oversized or otherwise refused cookie in silence, so
      // an unchecked write would read back as the value it meant to replace.
      // Throwing hands the caller to wrap()'s shadow, which is honest.
      if (readCookie(name) !== String(v)) throw new Error('cookie refused');
    },
    removeItem: k => dropCookie(nameOf(k)),
  };
}

// Even a store that probed clean can start throwing later — a quota fills up
// mid-shift — so every call keeps its own guard and falls back per operation.
//
// `shadowed` is what makes that fallback honest. A write the device REFUSED has
// to read back for the rest of the session, or the caller silently reads a stale
// value it believes it just overwrote; reading straight through to the real
// store would hand back exactly that. A later write that succeeds, or a remove,
// retires the shadow.
function wrap(real) {
  const mem = inMemory();
  if (!real) return mem;
  const shadowed = new Set();
  return {
    getItem(k) {
      if (shadowed.has(k)) return mem.getItem(k);
      try { return real.getItem(k); } catch { return mem.getItem(k); }
    },
    setItem(k, v) {
      try { real.setItem(k, String(v)); shadowed.delete(k); }
      catch { mem.setItem(k, v); shadowed.add(k); }
    },
    removeItem(k) {
      shadowed.delete(k);
      mem.removeItem(k);
      try { real.removeItem(k); } catch { /* the shadow is already gone */ }
    },
  };
}

const hasWindow = typeof window !== 'undefined';

// The three rungs, in order. Only the first two survive a reload; the third
// keeps the app running, which is the floor's real minimum.
function backing(kind) {
  if (!hasWindow) return { store: null, persistent: false };
  const real = usable(kind);
  if (real) return { store: real, persistent: true };
  const cookies = cookieBacked(kind);
  if (cookies) return { store: cookies, persistent: true };
  return { store: null, persistent: false };
}

const local = backing('localStorage');
const session = backing('sessionStorage');

export const storage = wrap(local.store);
export const sessionStore = wrap(session.store);

// True when a value written here is still going to be here after a reload —
// whichever rung is carrying it. False means this device will forget the login
// the moment the page reloads, which is worth SAYING rather than letting the
// floor rediscover it every time.
export const storageIsPersistent = local.persistent;
