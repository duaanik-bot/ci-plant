// ─── Device tier — the ONE place the app asks "what am I running on" ─────────
// Four answers: phone / tabp (tablet portrait) / tabl (tablet landscape) /
// desktop. The split mirrors tailwind.config.js `screens` exactly:
//
//   phone   < 768px                       — width alone; a phone is a phone
//   tabp    768–1023.98px + coarse pointer — tablet held upright
//   tabl    ≥ 1024px      + coarse pointer — tablet on its side (1180–1366px!)
//   desktop ≥ 768px       + fine pointer   — every laptop and monitor
//
// A tablet in LANDSCAPE reports more CSS pixels than many laptops, so width
// cannot separate the two — the primary pointer does. `pointer: coarse` stays
// true on an iPad even with a Magic Keyboard attached (primary input remains
// touch), and stays FALSE on a touch-screen Windows laptop (mouse is primary),
// which is exactly the split we want. Components branch on this to render a
// different tree for touch devices while desktop falls through to the same
// JSX it rendered before this file existed.
import { useSyncExternalStore } from 'react';

const QUERIES = {
  phone: '(max-width: 767.98px)',
  tabp: '(min-width: 768px) and (max-width: 1023.98px) and (pointer: coarse)',
  tabl: '(min-width: 1024px) and (pointer: coarse)',
};

const lists = typeof window !== 'undefined' && window.matchMedia
  ? Object.fromEntries(Object.entries(QUERIES).map(([k, q]) => [k, window.matchMedia(q)]))
  : null;

function current() {
  if (!lists) return 'desktop';
  // Escape hatch — `localStorage.ci_tier_force = 'tabl'` pins the tier on a
  // device that misreports its pointer (and lets a desktop browser preview the
  // touch shells). Inert unless someone deliberately sets it.
  const forced = localStorage.getItem('ci_tier_force');
  if (forced === 'phone' || forced === 'tabp' || forced === 'tabl' || forced === 'desktop') return forced;
  if (lists.phone.matches) return 'phone';
  if (lists.tabp.matches) return 'tabp';
  if (lists.tabl.matches) return 'tabl';
  return 'desktop';
}

// One shared snapshot so every subscriber re-renders off the same value in the
// same commit — and matchMedia 'change' only fires on real transitions, so
// desktop resize noise costs nothing.
let snapshot = current();
const subs = new Set();
if (lists) {
  const onChange = () => {
    const next = current();
    if (next === snapshot) return;
    snapshot = next;
    subs.forEach(fn => fn());
  };
  Object.values(lists).forEach(l => l.addEventListener('change', onChange));
}

export function useTier() {
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn); },
    () => snapshot,
  );
}

// Non-hook read for event handlers and one-shot layout math.
export const tierNow = () => snapshot;

// Convenience predicates — `useTier() !== 'desktop'` reads worse than isTouch.
export const isTouchTier = t => t !== 'desktop';
export const isTabletTier = t => t === 'tabp' || t === 'tabl';
