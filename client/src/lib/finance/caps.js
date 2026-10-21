// Who may do what in Finance (spec §8.1): the ONE table. The screens read it to hide what a login cannot do, and the
// server reads it to refuse what a login may not do (finance-access.js, through finance-rules.js, which re-exports
// it). With one table behind both, a screen never offers a button the server will refuse, and never hides one it would
// accept. The server still refuses regardless: this is the cosmetic half (spec §8.2).
//
// Pure ESM, no React, no DOM, no imports: the server tests import this file by relative path and the browser bundles
// it as written. Own-property checks are Object.prototype.hasOwnProperty.call, never Object.hasOwn: this runs in the
// browser, whose baseline in this ERP predates it and which Vite does not polyfill (finance-wiring.test.js holds all
// client code to that).

// ── Who may do what (spec §8.1) ──────────────────────────────────────────────────────────────
export const FIN_ROLES = Object.freeze(['viewer', 'accountant', 'approver', 'admin']);

// Which roles hold each capability. There is no 'export' here: spec §8.1 gives it to every role,
// and the grant's can_export flag decides.
const FIN_CAPABILITY_ROLES = {
  view: ['viewer', 'accountant', 'approver', 'admin'],
  enter: ['accountant', 'approver'],
  ledger: ['accountant', 'admin'],
  import: ['accountant', 'admin'],
  approve: ['approver'],
  admin: ['admin'],
};

// Roles combine (the MD holds approver and admin), so a login holds a capability when ANY of its
// roles does. Anything unrecognised is no: an unknown capability, an unknown role, an empty list,
// or something that is not a list at all.
export function finCan(roles, cap) {
  if (!Array.isArray(roles) || !Object.prototype.hasOwnProperty.call(FIN_CAPABILITY_ROLES, cap)) return false;
  return FIN_CAPABILITY_ROLES[cap].some(role => roles.includes(role));
}
