// Size checks for the Costing module — pure, so they are tested without a database.
//
// A typed size is held against two lists that are kept apart and shown apart:
//   • the Size Library (costing_sizes): every size the plant has costed
//   • the Die Master (dies): the dies actually in the factory
// Neither is assumed to imply the other — a size costed once may never have had a die made, and a die
// may never have been costed here.
//
//   exact — the same size key (L × W × H in mm, the order kept)
//   near  — each side within NEAR_MM of the typed size, or the same three numbers in another order:
//           most often the same carton typed slightly wrong, so the screen asks "Did you mean …?"
//
// The size proposals also hold it against the die list (die_register: the 2024 register and the dies found in the
// studio's Drive drawings, 15 Nov 2026), whose sizes are written in whichever order the studio wrote them:
//   exact     — the same three numbers in the same order
//   reordered — the same three numbers in another order: the carton may open another way, so it is a check
//   near      — each side within REGISTER_MM as written, or once both sizes are sorted (other_order: true)
// dieMasterMatches holds the Die Master to the same rule on that screen, so hiding the die list's copies of Die Master
// dies (they showed twice) loses nothing — matchDies, used by the other checks, keeps its 2 mm.
import { parseSize } from './costing-engine.js';
import { canAccess } from '../../client/src/modules.js';
import { canDecideManagement } from './approvals.js';

export const NEAR_MM = 2;

const sorted = s => [s.l, s.w, s.h].filter(x => x != null).sort((a, b) => a - b).join('x');

export function sizeRelation(target, other) {
  if (!target || !other || target.kind === 'other' || other.kind === 'other') {
    return target && other && target.key === other.key ? 'exact' : null;
  }
  if (target.key === other.key) return 'exact';
  if (target.kind !== other.kind) return null;
  if (sorted(target) === sorted(other)) return 'near';
  const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= NEAR_MM);
  return close(target.l, other.l) && close(target.w, other.w) && close(target.h, other.h) ? 'near' : null;
}

// dies → { exact: [...], near: [...] }, each die carrying its parsed size. Dies whose carton size
// does not read as a size are skipped (they cannot be matched by size at all).
export function matchDies(target, dies) {
  const out = { exact: [], near: [] };
  if (!target) return out;
  for (const d of dies || []) {
    const size = parseSize(d.carton_size);
    if (!size || size.kind === 'other') continue;
    const rel = sizeRelation(target, size);
    if (rel) out[rel].push({ ...d, size_key: size.key });
  }
  return out;
}

export const REGISTER_MM = 3;
const sides = s => [s.l, s.w, s.h].map(Number).sort((a, b) => a - b);
const apart = (xs, ys) => xs.reduce((sum, x, i) => sum + Math.abs(x - ys[i]), 0);
const within = (xs, ys) => xs.every((x, i) => Math.abs(x - ys[i]) <= REGISTER_MM);
const whole = s => s && [s.l, s.w, s.h].every(x => x != null && Number.isFinite(Number(x)));
export const sameNumbers = (a, b) => apart(sides(a), sides(b)) === 0;

// die_register rows ({ die_no, l, w, h, … }, already near the size) → { exact, reordered, near }: near nearest first
// (the smaller of the written-order and the sorted difference), at most `limit`, each marked other_order.
export function registerMatchesFrom(size, rows, { limit = 8 } = {}) {
  const out = { exact: [], reordered: [], near: [] };
  if (!whole(size)) return out;
  const typed = [size.l, size.w, size.h], typedSorted = sides(size);
  const close = [];
  for (const d of rows || []) {
    if (!whole(d)) continue;
    const written = [d.l, d.w, d.h].map(Number), sorted = sides(d);
    if (apart(written, typed) === 0) out.exact.push(d);
    else if (apart(sorted, typedSorted) === 0) out.reordered.push(d);
    else {
      const asWritten = within(written, typed);
      if (!asWritten && !within(sorted, typedSorted)) continue;
      close.push({ d: { ...d, other_order: !asWritten }, gap: Math.min(asWritten ? apart(written, typed) : Infinity, apart(sorted, typedSorted)) });
    }
  }
  const id = x => String(x.d.die_no ?? x.d.code ?? '');
  close.sort((a, b) => a.gap - b.gap || id(a).localeCompare(id(b), 'en', { numeric: true }));
  out.near = close.slice(0, limit).map(x => x.d);
  return out;
}

// Die Master dies (tools rows with carton_size) → { exact, reordered, near } by the die list's rule; dies whose size
// does not read as L × W × H cannot be matched and are skipped.
export function dieMasterMatches(size, tools, { limit = 8 } = {}) {
  const rows = [];
  for (const t of tools || []) {
    const s = parseSize(t.carton_size);
    if (s?.kind === 'carton') rows.push({ ...t, size_key: s.key, l: s.l, w: s.w, h: s.h });
  }
  return registerMatchesFrom(size, rows, { limit });
}

// The Costing module holds quotation prices, so it opens for admins and for logins with the Costing
// tick — never merely because a login has no ticks at all (modules.js TICK_ONLY_MODULES).
export const mayCost = u => !!u && canAccess(u, 'costing');
export const mayEditCostingRates = u => !!u && u.role === 'admin';
// Approving a costing is a management decision — the same users.is_management right that approves
// planning requests (approvals.js), read fresh from users on every request.
export const mayApproveCosting = u => mayCost(u) && canDecideManagement(u);
