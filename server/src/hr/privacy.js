// ─── Who a viewer / accounts login may see (owner's request 2026-11-05) ──────
// "Give access to my accounts id, but I don't want to reveal all the employees and their salaries to him —
// selective, at my discretion; hide anyone's salary and even the name."
//
// hr.access_hidden lists, per login, the people it must not see: mode 'pay' (the name shows, no amount of theirs
// does) or 'all' (the person is not there). It applies to the two reading levels, viewer and accounts — operator
// and up keep the payroll and see everyone.
//
// An accounts login, and a viewer with anyone hidden, is RESTRICTED, and two things hold for it, both failing closed:
//   1. Only the routes in ALLOW are open (the registers, payslips, reports, ledgers and the payment actions);
//      every other /hr route, and any route added later, answers 403 HR_RESTRICTED before it runs.
//   2. Each open route leaves the hidden people out at the source — lines, inputs, ledgers AND every total, which
//      is worked out again from what the login sees (the owner's choice: totals leave hidden people out, so nothing
//      about them can be worked out from a difference). A 'pay' person appears only by name, in the
//      `pay_hidden_people` list of a run. As a net under that, every JSON answer is walked and any object that
//      carries a hidden person's person_id is removed.
// req.hr carries { level, restricted, gone (Set of 'all' ids), noPay (Set of 'pay' and 'all' ids) }.
import { q } from '../db.js';
import { withoutLedger } from '../data-tables.js';

export const RESTRICTABLE = Object.freeze(['viewer', 'accounts']);
export const HIDE_MODES = Object.freeze(['pay', 'all']);

const NONE = Object.freeze({ restricted: false, gone: new Set(), noPay: new Set() });

// The login's hide list as two sets. A level that cannot be restricted has none.
export async function privacyFor(userId, level) {
  if (!RESTRICTABLE.includes(level)) return NONE;
  let rows = [];
  try {
    rows = await withoutLedger(() => q(`SELECT person_id, mode FROM hr.access_hidden WHERE user_id = $1`, [userId]));
  } catch (e) {
    if (e?.code !== '42P01') throw e;   // no table yet: nobody hidden, still restricted to ALLOW
  }
  // An accounts login is always restricted (it is the level made for this); a viewer only once someone is hidden
  // from it, so a plain viewer keeps reading everything it always could.
  if (level !== 'accounts' && !rows.length) return NONE;
  const gone = new Set(rows.filter((r) => r.mode === 'all').map((r) => r.person_id));
  const noPay = new Set(rows.map((r) => r.person_id));
  return { restricted: true, gone, noPay };
}

// The routes a restricted login may reach (method, path after /api). Everything else is refused.
const M = '\\d{4}-\\d{2}';
const ALLOW = [
  ['GET', '/hr/me'], ['GET', '/hr/people'], ['GET', '/hr/people/\\d+'], ['GET', '/hr/people/\\d+/ledger'], ['GET', '/hr/people/\\d+/salary-ledger'],
  ['GET', '/hr/pay-channels'], ['GET', '/hr/settings'], ['GET', '/hr/dashboard'],
  ['GET', '/hr/runs'], ['GET', `/hr/runs/${M}`], ['GET', `/hr/runs/${M}/payslips`],
  ['GET', `/hr/runs/${M}/lines/\\d+/history`], ['GET', '/hr/reports/monthly'], ['GET', '/hr/reports/pending-pay'],
  ['GET', '/hr/loans'], ['GET', '/hr/loans/\\d+'], ['GET', '/hr/advances'], ['GET', '/hr/advances/\\d+'],
  // Paying (accounts; a viewer is stopped by requireHr): batches, one line, paid / unpaid / hold, staff advances.
  ['POST', `/hr/runs/${M}/payments`], ['PUT', `/hr/runs/${M}/lines/\\d+/payment`], ['POST', `/hr/runs/${M}/lines/status`],
  ['POST', '/hr/staff-payments'], ['POST', '/hr/advances'],
  // Activate / deactivate a person it can see (2026-11-14).
  ['POST', '/hr/people/\\d+/deactivate'], ['POST', '/hr/people/\\d+/activate'], ['DELETE', '/hr/people/\\d+'],
  // A loan's instalment for a month, or from a month on (2026-11-14): only for a person the login can see.
  ['PUT', '/hr/loans/\\d+/month-instalment'],
  // Bulk advance sheets: the restricted login sees and enters only its visible people (routes/hr-ledgers.js).
  ['GET', '/hr/advance-sheets'], ['GET', '/hr/advance-sheets/\\d+'], ['POST', '/hr/advance-sheets'], ['PUT', '/hr/advance-sheets/\\d+'],
  ['PUT', '/hr/advance-sheets/\\d+/lines'], ['POST', '/hr/advance-sheets/\\d+/submit'], ['POST', '/hr/advance-sheets/\\d+/post'],
  ['DELETE', '/hr/advance-sheets/\\d+'],
  // Importing the month's sheet (owner's request 2026-11-14): a restricted login reviews only the rows of people it
  // can see; the hidden people's rows apply as the sheet has them (routes/hr-payroll.js importPayload / apply).
  ['POST', '/hr/imports'], ['GET', '/hr/imports/\\d+'], ['PUT', '/hr/imports/\\d+/map'],
  ['PUT', '/hr/imports/\\d+/rows/\\d+'], ['POST', '/hr/imports/\\d+/rows/\\d+/new-person'], ['POST', '/hr/imports/\\d+/discard'], ['POST', '/hr/imports/\\d+/apply'],
].map(([method, path]) => [method, new RegExp(`^${path}/?$`)]);

const pathOf = (req) => {
  const raw = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  const at = raw.indexOf('/hr/') >= 0 ? raw.indexOf('/hr/') : raw.indexOf('/hr');
  return at >= 0 ? raw.slice(at) : raw;
};

export function allowedForRestricted(method, path) {
  return ALLOW.some(([m, re]) => m === method && re.test(path));
}

// The net: every object in an array that carries a hidden person's person_id goes (on the people list, a person
// hidden completely goes by id; a 'pay' person stays there, by name, with no pay).
// `pay_hidden_people` is the one list that may name a 'pay' person (by name only), so only 'all' ids go from it.
function scrub(value, hr, key = '') {
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const pid = Number(v.person_id);
        if (Number.isInteger(pid) && (key === 'pay_hidden_people' ? hr.gone.has(pid) : hr.noPay.has(pid))) continue;
        if (key === 'people' && hr.gone.has(Number(v.id))) continue;
      }
      out.push(scrub(v, hr, key));
    }
    return out;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, hr, k);
    return out;
  }
  return value;
}

// After hrGuard: a restricted login meets the allow-list, and its answers go through the net.
export function restrictedGate(req, res, next) {
  if (!req.hr?.restricted) return next();
  const path = pathOf(req);
  if (!allowedForRestricted(req.method, path)) {
    return res.status(403).json({ error: 'Your HR access does not include this', code: 'HR_RESTRICTED' });
  }
  if (!res.__hrScrubbed) {
    const send = res.json.bind(res);
    res.json = (body) => send(res.statusCode >= 400 ? body : scrub(body, req.hr, path === '/hr/people' ? 'people' : ''));
    res.__hrScrubbed = true;
  }
  return next();
}

// For the route handlers.
export const restricted = (req) => Boolean(req.hr?.restricted);
export const hiddenIds = (req) => (restricted(req) ? [...req.hr.noPay] : []);       // no pay of theirs is shown
export const goneIds = (req) => (restricted(req) ? [...req.hr.gone] : []);           // not shown at all
export const canSeePay = (req, personId) => !restricted(req) || !req.hr.noPay.has(Number(personId));
export const canSeePerson = (req, personId) => !restricted(req) || !req.hr.gone.has(Number(personId));

export const notThere = (what = 'Person') => Object.assign(new Error(`${what} not found`), { status: 404, body: {} });

// A write naming a hidden person is answered as if the person did not exist.
export function assertPayVisible(req, ids, what = 'Person') {
  for (const id of [].concat(ids ?? [])) if (!canSeePay(req, id)) throw notThere(what);
}

// What a 'pay' person shows: who they are, nothing about money or bank.
const IDENTITY = ['id', 'code', 'name', 'display_name', 'department', 'designation', 'status', 'worker_type',
  'joined_on', 'exited_on', 'pay_channel', 'firm'];
export function identityOnly(person) {
  const out = { pay_hidden: true };
  for (const k of IDENTITY) if (Object.hasOwn(person, k)) out[k] = person[k];
  return out;
}
