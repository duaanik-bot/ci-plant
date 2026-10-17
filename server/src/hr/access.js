// ─── Who may open HR & Payroll, and how far ─────────────────────────────────
// Salary, bank and loan data are walled off from the plant (spec §6). Module ticks
// cannot do it — every office login is an ERP admin with every module — so HR keeps its
// own list, hr.access (user_id → level), and every /api/hr route sits behind:
//
//   r.use('/hr', hrGuard)            a row in hr.access, read FRESH from the database on
//                                    every request (never from the JWT, which only carries
//                                    id/name/role and can outlive a change); no row → 403
//   r.get('/hr/…', requireHr('approver'), …)   the route's minimum level
//
// Levels climb, each including the ones before it: viewer reads registers, payslips and
// reports; operator keeps people, setups, imports and draft runs, submits and marks paid;
// approver approves, sends back, finalises and reverses a payment; admin owns settings,
// access grants and the workbook loader.
//
// Both fail closed. No row, a level the ladder does not know, a missing user id or a
// failed read never reach the route; a misspelt requireHr() level throws when the route
// is defined.
import { one } from '../db.js';
import { withoutLedger } from '../data-tables.js';

export const HR_LEVELS = Object.freeze(['viewer', 'operator', 'approver', 'admin']);

// True when `level` is `min` or above. Anything that is not a level is no access.
export function levelAtLeast(level, min) {
  const have = HR_LEVELS.indexOf(level);
  const need = HR_LEVELS.indexOf(min);
  return have >= 0 && need >= 0 && have >= need;
}

const NO_ACCESS = Object.freeze({ error: 'You do not have access to HR & Payroll', code: 'HR_NO_ACCESS' });

// A users.id as the JWT carries it (a number; a digit string is tolerated), or null for
// anything that cannot be one — never coerced from true, ' 7 ', '1e1' or '0x10'.
const userIdOf = (value) => {
  const id = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The login's HR level, or null. hr.access.user_id is a soft link (no foreign key into
// public), so the login is checked here: a switched-off login has no HR access even on a
// token that never expires.
//
// Outside the request's ledger (as moduleGate reads users): who may ask is not part of
// any answer. A database the HR migration has not reached yet (no schema hr, no table)
// is nobody having access — the HR menu stays hidden instead of erroring on every page.
export async function hrAccessFor(userId) {
  const id = userIdOf(userId);
  if (id === null) return null;
  let row;
  try {
    row = await withoutLedger(() => one(
      `SELECT a.level
         FROM hr.access a
         JOIN public.users u ON u.id = a.user_id
        WHERE a.user_id = $1 AND u.active = 1`, [id]));
  } catch (e) {
    if (e?.code === '42P01' || e?.code === '3F000') return null;   // undefined table / schema
    throw e;
  }
  return HR_LEVELS.includes(row?.level) ? row.level : null;
}

// The guard over a given lookup. Several HR routers each install it on '/hr', so it
// remembers its answer on the request: one read of hr.access per request, however many
// routers the request passes through. Only a level it set itself counts as remembered.
export function hrGuardWith(lookup) {
  return async function hrGuard(req, res, next) {
    if (req.hr && HR_LEVELS.includes(req.hr.level)) return next();
    let level = null;
    const id = userIdOf(req.user?.id);
    if (id !== null) {
      try {
        level = await lookup(id);
      } catch (e) {
        return next(e);                       // the error handler answers; the route never runs
      }
    }
    if (!HR_LEVELS.includes(level)) return res.status(403).json({ ...NO_ACCESS });
    req.hr = Object.freeze({ level });
    return next();
  };
}

export const hrGuard = hrGuardWith(hrAccessFor);

// The route's minimum level. Without hrGuard before it, nothing passes.
export function requireHr(min) {
  if (!HR_LEVELS.includes(min)) {
    throw new TypeError(`requireHr: unknown HR level ${JSON.stringify(min)} (one of ${HR_LEVELS.join(', ')})`);
  }
  return function requireHrLevel(req, res, next) {
    if (levelAtLeast(req.hr?.level, min)) return next();
    return res.status(403).json({ error: `Needs HR ${min} access`, code: 'HR_LEVEL' });
  };
}
