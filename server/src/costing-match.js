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

// The Costing module holds quotation prices, so it opens for admins and for logins with the Costing
// tick — never merely because a login has no ticks at all (modules.js TICK_ONLY_MODULES).
export const mayCost = u => !!u && canAccess(u, 'costing');
export const mayEditCostingRates = u => !!u && u.role === 'admin';
// Approving a costing is a management decision — the same users.is_management right that approves
// planning requests (approvals.js), read fresh from users on every request.
export const mayApproveCosting = u => mayCost(u) && canDecideManagement(u);
