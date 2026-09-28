// ─── What a login's ticked modules open, on the server ──────────────────────
// Masters → Users ticks the modules a login may open (users.modules: NULL = all
// the role allows, or a list). The screens have always honoured the ticks; this
// is where the API honours them too, so a tick is a real limit and not only a
// hidden menu item. One rule, the client's own (modules.js):
//
//   • a Colour Impressions login — anything but Fluence ticked, or no ticks at
//     all — is answered as before: its pages share reference data across
//     modules, and every Fluence door in the plant reads the Fluence master;
//   • a login with ONLY the Fluence module ticked — a customer's own — reaches
//     the Fluence module's routes and nothing of the plant. It signs every change
//     with its login ID (its name on every record carries it), and what it may
//     change stops at the Fluence master: product masters, billing codes and the
//     manufacturing spec stay with the Masters tick (`masters` below).
//
// Kit Studio's routes answer a login that can open the Fluence module.
//
// Inside the Fluence module, the tabs ticked for a login (users.fluence_tabs,
// NULL = all) are held here as well: what only an unticked tab reads or changes
// is refused (TAB_ROUTES below).
//
// Every request also re-reads whether the login is still switched on: a token
// outlives a deactivation otherwise (a "keep me signed in" one never expires).
import { one } from './db.js';
import { withoutLedger } from './data-tables.js';
import { canAccess, isFluenceOnly, fluenceTabsOf, FLUENCE_TABS, FLUENCE_TAB_KEYS, KIT_EDIT_TABS } from '../../client/src/modules.js';

// Looked up per request, like floorScope — ticks change mid-session and the
// token carries only id/name/role — and held a few seconds per server instance.
const HOLD_MS = 10_000;
const held = new Map();
export function forgetAccess(userId = null) {
  if (userId == null) held.clear(); else held.delete(Number(userId));
}

async function loginRow(id) {
  const hit = held.get(id);
  if (hit && Date.now() - hit.at < HOLD_MS) return hit.row;
  // Outside the request's ledger: who may ask is not part of any answer, and a
  // read of users here would tie every cached response to that table.
  const row = await withoutLedger(() => one(
    'SELECT id, name, email, role, active, modules, fluence_tabs FROM users WHERE id = $1', [id]));
  held.set(id, { at: Date.now(), row: row || null });
  return row || null;
}

// The name a customer's login signs with: its name and its login ID, on every
// revision, audit line, job-card stamp and notification its changes leave.
export const signedName = (name, login) => `${String(name ?? '').trim()} (ID ${login})`;

// What one login may do, from its users row.
export function accessOf(u) {
  const user = { role: u.role, modules: Array.isArray(u.modules) ? u.modules : null, fluence_tabs: Array.isArray(u.fluence_tabs) ? u.fluence_tabs : null };
  return {
    outside: isFluenceOnly(user),
    fluence: canAccess(user, 'fluence'),
    masters: canAccess(user, 'masters'),
    tabs: fluenceTabsOf(user),     // the Fluence tabs it may open — every one unless ticked otherwise
    login: u.email,
  };
}

// ─── The Fluence module's tabs ──────────────────────────────────────────────
// Each route the module's screens use, with the tabs that use it: any one of
// them ticked opens it. A route not listed belongs to no single tab — a kit's
// dossier and history, the inner products a kit is built from, the Fluence
// doors in the plant's own modules — and answers every login the module does.
const STUDIO_TABS = FLUENCE_TABS.filter(t => t.view).map(t => t.key);
const TAB_ROUTES = [
  // The Fluence master's own tables.
  ['GET', /^\/fluence\/products$/, ['products', 'customer']],
  ['GET', /^\/fluence\/kits$/, ['customer']],
  ['GET', /^\/fluence\/changes$/, ['changes']],
  ['PUT', /^\/fluence\/(products|kits)\/[^/]+\/(kit|prescription|components)$/, KIT_EDIT_TABS],
  ['POST', /^\/fluence\/inner-products$/, ['inner']],
  ['PUT', /^\/fluence\/inner-products\/[^/]+$/, ['inner']],
  ['POST', /^\/fluence\/kits\/[^/]+\/(link|unlink)$/, ['customer']],
  // Kit Studio. A kit's save is New kit's when it adds the kit and Kits' when it
  // changes one — the route tells which (routes/kitstudio.js).
  ['GET', /^\/kit-studio\/state$/, STUDIO_TABS],
  ['PUT', /^\/kit-studio\/kits\/[^/]+$/, ['kits', 'build']],
  ['DELETE', /^\/kit-studio\/kits\/[^/]+$/, ['kits']],
  ['POST', /^\/kit-studio\/kits\/[^/]+\/(erp-size|erp-unlink)$/, ['kits']],
  ['GET', /^\/kit-studio\/kits\/[^/]+\/erp-options$/, ['kits', 'build']],
  ['POST', /^\/kit-studio\/kits\/[^/]+\/(erp-product|erp-link)$/, ['kits', 'build']],
  ['PUT', /^\/kit-studio\/products\/[^/]+$/, ['inner']],
  ['PUT', /^\/kit-studio\/drafts\/[^/]+$/, ['build', 'drafts']],
  ['DELETE', /^\/kit-studio\/drafts\/[^/]+$/, ['build', 'drafts']],
  ['PUT', /^\/kit-studio\/settings\/[^/]+$/, ['settings']],
];
export function tabsForRequest(method, path) {
  const hit = TAB_ROUTES.find(([m, re]) => m === method && re.test(path));
  return hit ? hit[2] : null;
}
export const mayUseTab = (access, key) => (access?.tabs ?? FLUENCE_TAB_KEYS).includes(key);
const tabLabel = key => FLUENCE_TABS.find(t => t.key === key)?.label ?? key;
export function tabRefusal(tabs) {
  const names = tabs.map(k => `“${tabLabel(k)}”`);
  if (names.length === 1) return `The Fluence tab ${names[0]} is not ticked for this login.`;
  return `This needs the Fluence tab ${names.slice(0, -1).join(', ')} or ${names.at(-1)} — ${names.length === 2 ? 'neither' : 'none of them'} is ticked for this login.`;
}
const TAB_REFUSAL = /^(The Fluence tab|This needs the Fluence tab) /;
// The code a refusal goes out with: a tab's refusal inside Kit Studio is shown by
// the studio itself, next to what was refused (api.js HANDLED_BY); any other
// reaches the ERP's central toast.
export function refusalCode(path, verdict) {
  if (!TAB_REFUSAL.test(String(verdict))) return 'FLUENCE_ONLY';
  return STUDIO_API.test(path) ? 'KIT_STUDIO_REFUSED' : 'FLUENCE_TAB';
}

// Where a request may go. Pure, so the rule is tested on its own.
const FLUENCE_API = /^\/fluence(\/|$)/;
const STUDIO_API = /^\/kit-studio(\/|$)/;
// Fluence reads that exist for the plant's own documents — which cartons does
// this invoice, challan or job card carry — never a customer's.
const PLANT_FLUENCE = /^\/fluence\/resolve(\/|$)/;

export function gateDecision(path, access, method = 'GET') {
  if (STUDIO_API.test(path) && !access.fluence) return 'Kit Studio is part of the Fluence module, which is not ticked for this login.';
  const inModule = STUDIO_API.test(path) || (FLUENCE_API.test(path) && !(access.outside && PLANT_FLUENCE.test(path)));
  if (!inModule) return access.outside ? 'This login is for the Fluence module only.' : 'ok';
  const tabs = tabsForRequest(method, path);
  if (tabs && !tabs.some(t => mayUseTab(access, t))) return tabRefusal(tabs);
  return 'ok';
}

export async function moduleGate(req, res, next) {
  try {
    const u = await loginRow(Number(req.user?.id));
    if (!u || !+u.active) return res.status(401).json({ error: 'This login is switched off — sign in again or ask Colour Impressions.' });
    const access = accessOf(u);
    req.access = access;
    if (access.outside) {
      req.user.name = signedName(u.name, u.email);
      req.user.login = u.email;
      req.user.outside = true;
    }
    const verdict = gateDecision(req.path, access, req.method);
    if (verdict !== 'ok') return res.status(403).json({ error: verdict, code: refusalCode(req.path, verdict) });
    return next();
  } catch (e) { return next(e); }
}

// A route only a login with the Masters tick may use — creating or linking a
// product master, its size, its print spec.
export function needsMasters(req, res, next) {
  if (req.access?.masters === true) return next();
  return res.status(403).json({
    error: 'Product masters, billing codes and the print spec are kept in Masters — this login does not have the Masters tick.',
    code: 'KIT_STUDIO_REFUSED',
  });
}

// The manufacturing spec a product master carries — board, sheets, die, print
// references — is Colour Impressions' own. A login without the Masters tick
// sees what the carton is (its codes, name, MRP, size), not how it is made.
const SPEC_FIELDS = ['internal_carton_code', 'output_number', 'shade_card_number', 'shade_card_date', 'board_name', 'gsm',
  'child_l', 'child_w', 'ups', 'coating', 'pasting_type', 'die_number'];
export function dossierFor(dossier, access) {
  if (!dossier?.product || access?.masters === true) return dossier;
  const product = { ...dossier.product };
  for (const f of SPEC_FIELDS) delete product[f];
  return { ...dossier, product };
}
