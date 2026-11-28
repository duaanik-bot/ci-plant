// iPhone Duo only: the field you tap stays in sight above the keyboard.
//
// iOS raises the keyboard over the page rather than shrinking it, and Safari's
// own "scroll the field into view" only moves the PAGE. A field inside a dialog
// body or a sheet (its own scroller) can end up under the keys, with only the
// dialog's bottom edge visible. Once the keyboard has settled, this scrolls the
// focused field's nearest scroller so the field sits in the middle of what is
// still visible. It does nothing if the field is already in view, and nothing
// at all off the Duo (same media query as the auto-cards).
import { DUO_Q } from './autoCards.js';

const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]), textarea, select, [contenteditable="true"]';

let installed = false;
export function installDuoFocus() {
  if (installed || typeof window === 'undefined' || !window.matchMedia) return;
  installed = true;
  // The keyboard shrinks the window on some browsers, which can drop the page
  // out of DUO_Q exactly when this is needed, so it also accepts the Duo by its
  // SCREEN: touch, shorter side 450–743 and longer side under 1024 (outer
  // 466 x 678, inner 669 x 951). Regular iPhones are under 450 on the short
  // side; every iPad is 744+.
  const duoQ = window.matchMedia(DUO_Q);
  const coarse = window.matchMedia('(pointer: coarse)');
  const duoScreen = () => {
    const a = Math.min(screen.width, screen.height), b = Math.max(screen.width, screen.height);
    return coarse.matches && a >= 450 && a < 744 && b < 1024;
  };
  const mq = { get matches() { return duoQ.matches || duoScreen(); } };
  let timer = 0;
  const reveal = el => {
    if (!el.isConnected || document.activeElement !== el) return;
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const r = el.getBoundingClientRect();
    // 56px clear of the bottom keeps the field above the keyboard's toolbar.
    if (r.top >= top + 8 && r.bottom <= bottom - 56) return;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
  };
  document.addEventListener('focusin', e => {
    if (!mq.matches) return;
    const el = e.target;
    if (!(el instanceof Element) || !el.matches(FIELD)) return;
    clearTimeout(timer);
    // The keyboard animates up over ~250–300ms; measure once it has landed.
    timer = setTimeout(() => reveal(el), 320);
  });
  // A keyboard that changes height (emoji, a different language, the
  // predictive bar) re-checks the field that has focus.
  window.visualViewport?.addEventListener('resize', () => {
    if (!mq.matches) return;
    const el = document.activeElement;
    if (el instanceof Element && el.matches(FIELD)) { clearTimeout(timer); timer = setTimeout(() => reveal(el), 120); }
  });
}
