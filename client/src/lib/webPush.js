// Turning a device into one the plant can reach.
//
// The interesting part of web push is not subscribing — it is being HONEST
// about the devices that cannot. On an iPhone, push is unavailable to Safari in
// an ordinary tab: the site has to be added to the Home Screen first, and until
// it is, `window.PushManager` simply does not exist. That is Apple's rule, not
// a setting. A toggle that shrugged there would leave an approver believing
// their phone would buzz for the rest of the year.
//
// So capability is resolved into ONE state with ONE sentence, and the pure
// function that does it is separated from every browser API so it can be tested
// against devices nobody here owns.

export function pushSupport({ hasSW, hasPush, hasNotification, isIOS, isStandalone, permission, serverEnabled }) {
  if (!serverEnabled) {
    return { state: 'server_off', can: false,
      message: 'Push is not switched on for this server yet.' };
  }
  // The iOS case FIRST, because on an iPhone the generic "your browser cannot"
  // is both true and useless — there is a specific thing the reader can do.
  if (isIOS && !isStandalone && !hasPush) {
    return { state: 'ios_needs_install', can: false,
      message: 'On iPhone and iPad, add Colour Impressions to your Home Screen first — Share → Add to Home Screen — then open it from there and turn this on. Apple does not allow notifications from a Safari tab.' };
  }
  if (!hasSW || !hasPush || !hasNotification) {
    return { state: 'unsupported', can: false,
      message: 'This browser cannot show notifications. Chrome, Edge or Safari on a computer, or Chrome on Android, all can.' };
  }
  if (permission === 'denied') {
    return { state: 'blocked', can: false,
      message: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn this on again.' };
  }
  return { state: 'ready', can: true,
    message: 'Get approvals and messages on this device, even when the app is closed.' };
}

// Reads the live browser. Kept apart from the logic above on purpose.
export function readEnvironment(serverEnabled) {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const win = typeof window === 'undefined' ? {} : window;
  // iPadOS reports itself as a Mac, and has done since iPadOS 13 — the touch
  // point count is what separates an iPad from a desktop Safari.
  const ua = String(nav.userAgent || '');
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  return pushSupport({
    hasSW: 'serviceWorker' in nav,
    hasPush: 'PushManager' in win,
    hasNotification: 'Notification' in win,
    isIOS,
    isStandalone: !!(win.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone),
    permission: typeof Notification === 'undefined' ? 'default' : Notification.permission,
    serverEnabled,
  });
}

// The VAPID key travels as base64url text and the browser wants raw bytes.
export function urlBase64ToUint8Array(base64) {
  const padded = String(base64).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return (await reg?.pushManager?.getSubscription()) || null;
  } catch { return null; }
}

// Ask, subscribe, and hand the subscription back for the caller to store.
// Returns null when the reader declines — a refusal is an answer, not an error.
export async function subscribe(vapidKey) {
  const reg = (await navigator.serviceWorker.getRegistration('/')) || await registerWorker();
  if (!reg) throw new Error('This browser would not start the notification worker');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;
  // An existing subscription is reused rather than replaced: re-subscribing
  // mints a NEW endpoint and orphans the old row, so the same phone would
  // accumulate a dead subscription for every time the toggle was flipped.
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });
}
