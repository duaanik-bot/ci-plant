// ─── Device tier — the ONE place the app asks "what am I running on" ─────────
// Four answers: phone / tabp (tablet portrait) / tabl (tablet landscape) /
// desktop. The split mirrors tailwind.config.js `screens` exactly:
//
//   phone   < 768px                       — width alone; a phone is a phone
//   tabp    ≥ 768px + coarse pointer + portrait  — tablet held upright
//   tabl    ≥ 768px + coarse pointer + landscape — tablet on its side
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
  // Orientation, not width, splits the tablet tiers — a 13" iPad reports
  // 1024 CSS px held UPRIGHT, wider than many laptops. Portrait is portrait
  // on every tablet; desktop still can't match either (pointer: fine).
  tabp: '(min-width: 768px) and (pointer: coarse) and (orientation: portrait)',
  tabl: '(min-width: 768px) and (pointer: coarse) and (orientation: landscape)',
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
// The card-first presentation: phones always, and tablets held UPRIGHT —
// portrait is a reading posture, landscape a console posture. Wide tables
// belong to landscape; upright gets cards, two abreast.
export const isCardTier = t => t === 'phone' || t === 'tabp';
