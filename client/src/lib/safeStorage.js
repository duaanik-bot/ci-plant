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
// The fallback is an in-memory store, so the app RUNS. What is lost is only
// persistence across reloads — staying signed in, a remembered sidebar, the
// timeline's last range. A floor tablet that works and forgets is enormously
// better than one that shows nothing at all.

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

export const storage = wrap(hasWindow ? usable('localStorage') : null);
export const sessionStore = wrap(hasWindow ? usable('sessionStorage') : null);

// True when the real thing is behind us. Nothing branches on this today; it is
// here so a "your device will not remember this" notice stays a one-liner away.
export const storageIsPersistent = hasWindow ? usable('localStorage') !== null : false;
