// What the Setup screens decide without drawing anything (spec §10): which tabs a login sees, what a group or a ledger row may do, the
// body a ledger form sends, the next financial year, the approval rules, the access grants, and the activity log. The components in
// components/finance/ and pages/finance/Setup.jsx only draw what these say, and finance-setup-ui.test.js holds them to it.
//
// The months' own moves are periods.js (the one definition the server uses too). Dates are 'YYYY-MM-DD' text and are read as text, never
// through a Date; the one exception is finWhenText, which shows an instant in the browser's own day and time.
//
// Pure ESM, no React, no DOM: the server tests import this file by relative path and the browser bundles it as written. The relative
// imports are book.js, caps.js, money.js, fy.js, tb.js and voucher.js (this folder) and dayOf.js, none of which imports anything outside the client.
// Own-property checks are Object.prototype.hasOwnProperty.call, never Object.hasOwn.
import { finBookOf } from './book.js';
import { FIN_ROLES, finCan } from './caps.js';
import { finFormatINR } from './money.js';
import { finFyOf, finIsValidDate } from './fy.js';
import { finTbExpandable, finTbRows } from './tb.js';
import { FIN_TYPE_LABELS, finDateText, finParseAmountText } from './voucher.js';
import { dayOf } from '../dayOf.js';

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? '' : String(value));
// Optional text as the server wants it: trimmed, and nothing at all when blank.
const optional = value => { const t = text(value).trim(); return t === '' ? null : t; };
// An id from a form control: the control holds text, the server holds a number.
const idOrNull = value => (value === '' || value == null ? null : Number(value));

// ── Where a refusal is said ──────────────────────────────────────────────────────────────────────────────────────────

// The app's own refusals name the field they are about (`field`); the database's (a name or a code taken, a customer already linked) are
// mapped to a code and name none, so the code says where they belong. The sentence is the server's (finance-errors.js) either way.
export const FIN_CODE_FIELDS = Object.freeze({
  FIN_DUPLICATE_NAME: 'name',
  FIN_DUPLICATE_CODE: 'code',
  FIN_PARTY_LINKED: 'party_id',
});

// The form field a refusal belongs under, or null when it is about the form as a whole (a last Admin, something in use): the form says
// that one at its foot. A field the server names wins over the code's.
export function finProblemField(error) {
  const data = error?.data;
  if (typeof data?.field === 'string' && data.field) return data.field;
  return typeof data?.code === 'string' && has(FIN_CODE_FIELDS, data.code) ? FIN_CODE_FIELDS[data.code] : null;
}

// ── A list that has not come ─────────────────────────────────────────────────────────────────────────────────────────

// What an empty table on a Setup screen says. A table whose answer has never come is not an empty one: it is loading, or it could not load
// (reports.js finReportEmpty says the same for a report, in a report's words). `known` is whether an answer for what is on screen has
// ever arrived; `blocked` is the sentence for a read that is not being asked for at all (a period that ends before it starts).
export const finSetupEmpty = ({ known, failed, none, blocked }) => (known ? none : blocked || (failed ? 'The list couldn’t load' : 'Loading…'));

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// The six tabs, in the order of the spec. `cap` is the capability that shows a tab (caps.js finCan); the screens hide what a login
// cannot do, and the server refuses it regardless. The key is the part of the path after /finance/setup/.
export const FIN_SETUP_TABS = Object.freeze([
  Object.freeze({ key: 'chart-of-accounts', label: 'Chart of Accounts', cap: 'view' }),
  Object.freeze({ key: 'months-years', label: 'Months & Years', cap: 'view' }),
  Object.freeze({ key: 'opening-balances', label: 'Opening Balances', cap: 'import' }),
  Object.freeze({ key: 'approval-rules', label: 'Approval Rules', cap: 'admin' }),
  Object.freeze({ key: 'access', label: 'Access', cap: 'admin' }),
  Object.freeze({ key: 'activity-log', label: 'Activity Log', cap: 'view' }),
]);

// The tabs this login is shown. `can(cap)` is the shell's, finCan on the current book's roles.
export const finSetupTabs = can => FIN_SETUP_TABS.filter(tab => can(tab.cap));

// The tab a /finance/setup/... path names, among those the login may see. Nothing, anything that is not a tab, and a tab the login may
// not see are all the first tab it may see (a viewer sent a link to Access lands on the chart); null for a login that may see none.
export function finSetupTab(path, can) {
  const tabs = finSetupTabs(can);
  const first = text(path).split('/').filter(Boolean)[0];
  return (tabs.find(tab => tab.key === first) ?? tabs[0])?.key ?? null;
}

export const finSetupTabPath = key => `/finance/setup/${key}`;

// A click on a tab: the path to move to, or null for the tab the page is already on, which would only add a history entry.
export const finSetupTabMove = (current, key) => (key === current ? null : finSetupTabPath(key));

// ── The chart of accounts: groups ────────────────────────────────────────────────────────────────────────────────────

// The groups in tree order with their depth, for a picker: { id, name, depth }. The order is the trial balance's (tb.js finTbRows, with
// everything open), so the chart and the pickers list the groups alike.
export function finGroupChoices(groups) {
  const tb = { groups: list(groups), ledgers: [] };
  return finTbRows(tb, finTbExpandable(tb), { hideEmpty: false }).map(({ id, name, depth }) => ({ id, name, depth }));
}

// The groups `group` may be moved under (spec §6.3, finUpdateGroup): of the same nature and on the same side of gross profit, and never
// the group itself or anything below it, which would tie the tree in a loop. The depths are the whole tree's. A loop already in the data
// is walked once and ends.
export function finGroupMoveTargets(groups, group) {
  const all = list(groups);
  const below = new Set([group.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of all) {
      if (!below.has(g.id) && below.has(g.parent_id)) { below.add(g.id); grew = true; }
    }
  }
  const allowed = new Set(all
    .filter(g => !below.has(g.id) && g.nature === group.nature && g.affects_gross_profit === group.affects_gross_profit)
    .map(g => g.id));
  return finGroupChoices(all).filter(choice => allowed.has(choice.id));
}

// A group can go when it is not built in and nothing is in it: no ledger (a switched-off one counts: it keeps its history) and no
// sub-group. The server says the same (finDeleteGroup) and has the last word.
export const finGroupDeletable = (group, groups) => Boolean(group)
  && !group.is_system && !(group.ledger_count > 0) && !list(groups).some(g => g.parent_id === group.id);

// What a group's row offers this login. Ruling R19: a built-in group is never renamed, moved or deleted (the books find bank and cash,
// debtors and creditors by its name), so it offers neither Edit nor Delete, whoever asks. Adding a sub-group, and editing or deleting
// one, are the admin's; adding a ledger to a group is the ledger capability's.
export function finGroupActions(group, groups, can) {
  const admin = can('admin');
  return {
    addGroup: admin,
    addLedger: can('ledger'),
    edit: admin && !group.is_system,
    remove: admin && finGroupDeletable(group, groups),
  };
}

// ── The chart of accounts: ledgers ───────────────────────────────────────────────────────────────────────────────────

// The form a ledger starts from: the ledger as it was read (text as text, nothing as empty), or, for a new one, nothing but the group
// it was added from. A party link is a kind ('customer', 'vendor', or '' for none) and the party's id.
export function finLedgerFormOf(ledger, defaults = {}) {
  return {
    name: text(ledger?.name), code: text(ledger?.code), tally_name: text(ledger?.tally_name), notes: text(ledger?.notes),
    group_id: ledger ? ledger.group_id : defaults.group_id ?? null,
    active: ledger ? ledger.active !== false : true,
    manual_entry: ledger ? ledger.manual_entry !== false : true,
    party_type: ledger?.party_type ?? '',
    party_id: ledger?.party_id ?? '',
  };
}

// POST /finance/ledgers. A new ledger is born active and open to typed vouchers, so the body says neither. Blank text is nothing.
export const finLedgerCreateBody = (form, bookId) => ({
  book_id: bookId,
  group_id: idOrNull(form.group_id),
  name: text(form.name).trim(),
  code: optional(form.code),
  tally_name: optional(form.tally_name),
  notes: optional(form.notes),
  party_type: form.party_type || null,
  party_id: idOrNull(form.party_id),
});

// PUT /finance/ledgers/:id. An admin's edit is the whole form. Anyone else's is the text they may change (name, code, Tally name,
// notes) and NOTHING of the group, the flags or the party link, which are the admin's (final review M-7): finUpdateLedger compares
// only the fields it is given, so a field left out is never an admin act. The ledger the form was opened on may have been moved,
// switched off or relinked by an admin since; it does not matter, because none of that is sent, and none of it is undone, so the body
// is made from the form alone. An admin's types are the ones the server holds (numbers for ids, booleans for flags).
export function finLedgerEditBody(form, { isAdmin = false } = {}) {
  const own = {
    name: text(form.name).trim(), code: optional(form.code), tally_name: optional(form.tally_name), notes: optional(form.notes),
  };
  if (!isAdmin) return own;
  return {
    ...own, group_id: idOrNull(form.group_id), active: form.active === true, manual_entry: form.manual_entry === true,
    party_type: form.party_type || null, party_id: idOrNull(form.party_id),
  };
}

// Which fields of the ledger form the login can change, so a field it cannot is shown as text and not offered. For an existing ledger
// the group, "active", "system-only" (manual_entry off) and the party link are the admin's; a built-in ledger cannot be moved or
// switched off. For a new one the group and the link are given by whoever may add a ledger, and the two flags are not on the form.
export function finLedgerFields(ledger, { isAdmin = false } = {}) {
  if (!ledger) return { group: true, active: false, systemOnly: false, party: true };
  return { group: isAdmin && !ledger.is_system, active: isAdmin && !ledger.is_system, systemOnly: isAdmin, party: isAdmin };
}

// The chips on a ledger row, in this order: { key, label, tone }. "Name differs" is amber: the ledger keeps the name it had in Tally and
// is no longer the name of the customer or vendor it is linked to, which is a hint and never a fault (spec §6.4).
export function finLedgerChips(ledger) {
  if (!ledger) return [];
  return [
    ledger.is_system && { key: 'built-in', label: 'Built-in', tone: 'neutral' },
    ledger.active === false && { key: 'off', label: 'Switched off', tone: 'muted' },
    ledger.manual_entry === false && { key: 'system-only', label: 'System-only', tone: 'neutral' },
    ledger.name_differs === true && { key: 'name-differs', label: 'Name differs', tone: 'amber' },
  ].filter(Boolean);
}

export const FIN_PARTY_KINDS = Object.freeze([
  Object.freeze({ key: '', label: 'No link' }),
  Object.freeze({ key: 'customer', label: 'Customer' }),
  Object.freeze({ key: 'vendor', label: 'Vendor' }),
]);
const PARTY_LABEL = Object.freeze({ customer: 'Customer', vendor: 'Vendor' });

// The party link in words: 'Customer · Acme Pharma Ltd', or nothing for a ledger with none. A link whose party cannot be found says so.
export function finPartyText(ledger) {
  const kind = ledger?.party_type;
  if (typeof kind !== 'string' || !has(PARTY_LABEL, kind)) return '';
  return `${PARTY_LABEL[kind]} · ${ledger.party_name ?? 'not found'}`;
}

// The options of the party picker for one kind, from GET /customers or /vendors: the switched-on ones, in the order they came, and the
// party the ledger is ALREADY linked to even if it has since been switched off (a former customer can have a balance) or is missing from
// the list. { value, label, hint, search } each. `current` is the ledger being edited, or null.
export function finPartyOptions(kind, parties, current) {
  if (kind !== 'customer' && kind !== 'vendor') return [];
  const linked = current && current.party_type === kind && current.party_id != null ? current : null;
  const options = [];
  let found = false;
  for (const party of list(parties)) {
    const on = !(party.active === 0 || party.active === false);
    const isLinked = linked != null && Number(party.id) === Number(linked.party_id);
    if (!on && !isLinked) continue;
    if (isLinked) found = true;
    options.push({
      value: party.id,
      label: on ? party.name : `${party.name} (switched off)`,
      hint: party.city ?? '',
      search: [party.name, party.city, party.gstin].filter(Boolean).join(' '),
    });
  }
  if (linked && !found) {
    options.push({
      value: linked.party_id,
      label: `${linked.party_name ?? `${PARTY_LABEL[kind]} #${linked.party_id}`} (not in the list)`,
      hint: '',
      search: text(linked.party_name),
    });
  }
  return options;
}

// ── Months and years ─────────────────────────────────────────────────────────────────────────────────────────────────

// The years the server takes (finYearLabel in finance-masters.js, pinned by finance-setup-ui.test.js): 2000-01 to 2099-00.
export const FIN_FIRST_YEAR = 2000;
export const FIN_LAST_YEAR = 2099;

// The label of the year "Add next financial year" adds: the one after the latest year the book has, whatever order they come in. A
// book with none yet starts with the year its books begin in. null when there is no next year to add (the server stops at 2099-00) or
// nothing to work it out from. A label that is not a real year (its second half is not the next year) is ignored, not guessed at.
export function finNextYearLabel(years, booksBegin) {
  let latest = null;
  for (const year of list(years)) {
    const m = /^(\d{4})-(\d{2})$/.exec(typeof year?.label === 'string' ? year.label : '');
    if (!m) continue;
    const start = Number(m[1]);
    if (Number(m[2]) !== (start + 1) % 100) continue;
    if (latest === null || start > latest) latest = start;
  }
  const next = latest !== null ? latest + 1 : finIsValidDate(booksBegin) ? Number(finFyOf(booksBegin).label.slice(0, 4)) : null;
  if (next === null || next < FIN_FIRST_YEAR || next > FIN_LAST_YEAR) return null;
  return `${next}-${String((next + 1) % 100).padStart(2, '0')}`;
}

// ── Approval rules ───────────────────────────────────────────────────────────────────────────────────────────────────

// The entry each rule governs: the voucher types (voucher.js) and the reversal rule, which every reversal uses (spec §7.3).
export const FIN_RULE_LABELS = Object.freeze({ ...FIN_TYPE_LABELS, reversal: 'Reversal' });
export const finRuleLabel = key => (typeof key === 'string' && has(FIN_RULE_LABELS, key) ? FIN_RULE_LABELS[key] : String(key));

export const FIN_RULE_MODES = Object.freeze([
  Object.freeze({ key: 'always', label: 'Always', hint: 'An Approver must approve every entry of this kind before it posts.' }),
  Object.freeze({ key: 'above_limit', label: 'Above a limit', hint: 'An Approver must approve an entry only when its total is more than the limit.' }),
  Object.freeze({ key: 'never', label: 'Never', hint: 'An entry of this kind posts as soon as it is submitted.' }),
]);

// A rule as the table says it: 'Always', 'Never', or 'Above ₹1,00,000.00'. A mode nobody has named is shown as it came.
export function finRuleText(rule) {
  if (rule?.mode === 'always') return 'Always';
  if (rule?.mode === 'never') return 'Never';
  if (rule?.mode === 'above_limit') return `Above ${finFormatINR(rule.limit_paise)}`;
  return String(rule?.mode ?? '—');
}

// The form a rule starts from: its mode, and its limit as the typed form takes it (rupees with the Indian grouping, no ₹).
export const finRuleFormOf = rule => ({
  mode: rule.mode,
  limitText: Number.isFinite(rule.limit_paise) ? finFormatINR(rule.limit_paise).replace(/^₹/, '') : '',
});

// PUT /finance/approval-rules/:id from the form: { ok: true, body } or { ok: false, error }. The limit is typed in RUPEES and goes in
// paise (finParseAmountText, money.js's finToPaiseTyped: at most two decimals, Indian or Western grouping, nothing rounded), and only a
// rule that applies above a limit has one: a limit sent with always or never is refused by the server, so it is left off.
export function finRuleBody({ mode, limitText } = {}) {
  if (!FIN_RULE_MODES.some(m => m.key === mode)) return { ok: false, error: 'Choose when an Approver is needed.' };
  if (mode !== 'above_limit') return { ok: true, body: { mode } };
  if (text(limitText).trim() === '') return { ok: false, error: 'Enter the limit in rupees.' };
  const { paise, error } = finParseAmountText(limitText);
  return error ? { ok: false, error } : { ok: true, body: { mode, limit_paise: paise } };
}

// Whether a rule body says anything the rule does not already say.
export const finRuleChanged = (rule, body) => rule.mode !== body.mode || (rule.limit_paise ?? null) !== (body.limit_paise ?? null);

// ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// The books a grant can be given on: those this login administers (GET /finance/access lists only grants on those).
export const finAdminBooks = books => list(books).filter(book => finCan(book.roles, 'admin'));

// Whether the login administers THIS book, from the books the shell holds (caps.js: admin). The Access screen asks it of the shell's new
// answer after a change to the login's own grant: a login that no longer administers the book has no Access tab, and one that
// administers nothing at all is refused the list (GET /finance/access answers 403), so the list is not read for it.
export const finAdministers = (books, bookId) => finCan(finBookOf(books, bookId)?.roles, 'admin');

// The grant a login already has on a book, or null.
export const finGrantFor = (grants, userId, bookId) =>
  list(grants).find(g => String(g.user_id) === String(userId) && String(g.book_id) === String(bookId)) ?? null;

// The roles and the export flag the grant form starts from for a login and a book: what the stored grant says when there is one (an
// export that was switched off is shown switched off), otherwise a NEW grant's defaults: no role ticked and export on. `existing` is
// the stored grant, so the form can say it is changing one.
export function finGrantFormOf(grants, userId, bookId) {
  const existing = finGrantFor(grants, userId, bookId);
  return { roles: existing ? [...existing.roles] : [], canExport: existing ? existing.can_export === true : true, existing };
}

// POST /finance/access. Ruling R31: can_export is ALWAYS sent, as the boolean the form shows. An omitted flag keeps the stored value on
// an update, so a form that left it out would say one thing and do another. The roles go in the order the server keeps them.
export const finGrantBody = ({ userId, bookId, roles, canExport }) => ({
  user_id: Number(userId),
  book_id: Number(bookId),
  roles: FIN_ROLES.filter(role => list(roles).includes(role)),
  can_export: canExport === true,
});

// What the grant form still lacks, as a sentence, or ''.
export function finGrantProblem({ userId, bookId, roles }) {
  if (userId == null || userId === '') return 'Choose a login.';
  if (bookId == null || bookId === '') return 'Choose a book.';
  if (!FIN_ROLES.some(role => list(roles).includes(role))) return 'Pick at least one role.';
  return '';
}

// Ruling R60: a grant for the logged-in user's own id changes the books and roles the shell holds, so the shell is asked again.
export const finIsOwnGrant = (grant, me) => grant?.user_id != null && me?.user?.id != null && Number(grant.user_id) === Number(me.user.id);

// The four roles, with what each one does (the capability table, caps.js and spec §8.1).
export const FIN_ROLE_CHOICES = Object.freeze([
  Object.freeze({ key: 'viewer', label: 'Viewer', hint: 'Reads the books and the reports.' }),
  Object.freeze({ key: 'accountant', label: 'Accountant', hint: 'Keys in vouchers, keeps the ledgers and imports from Tally.' }),
  Object.freeze({ key: 'approver', label: 'Approver', hint: 'Keys in and approves vouchers, and closes and locks months.' }),
  Object.freeze({ key: 'admin', label: 'Admin', hint: 'Sets the approval rules, the groups, the years and who has access.' }),
]);
export const finRoleLabel = role => FIN_ROLE_CHOICES.find(r => r.key === role)?.label ?? String(role);

// ── The activity log ─────────────────────────────────────────────────────────────────────────────────────────────────

// The server sends the newest 500 rows and no flag to say it cut the rest (FIN_ACTIVITY_MAX in finance-reports.js, pinned by the
// test), so a full answer is taken to have been cut and the screen says so.
export const FIN_ACTIVITY_CAP = 500;
export const finActivityCut = rows => Array.isArray(rows) && rows.length >= FIN_ACTIVITY_CAP;
export const FIN_ACTIVITY_CUT_NOTE = 'Showing the newest 500 changes. Narrow the dates, or choose a person or a kind of change, to see older ones.';

// GET /finance/activity: the book and the period always, the person and the kind only when they were chosen.
export function finActivityUrl({ bookId, from, to, user, entity }) {
  const params = new URLSearchParams({ book: String(bookId), from, to });
  const who = text(user).trim();
  if (who) params.set('user', who);
  if (entity) params.set('entity', entity);
  return `/finance/activity?${params}`;
}

// The kinds of thing the log records (the audit log's `entity`), in the words of the screens. The filter offers these.
export const FIN_ENTITY_CHOICES = Object.freeze([
  Object.freeze({ key: 'voucher', label: 'Voucher' }),
  Object.freeze({ key: 'ledger', label: 'Ledger' }),
  Object.freeze({ key: 'group', label: 'Group' }),
  Object.freeze({ key: 'period', label: 'Month' }),
  Object.freeze({ key: 'rule', label: 'Approval rule' }),
  Object.freeze({ key: 'access', label: 'Access' }),
  Object.freeze({ key: 'import', label: 'Tally import' }),
  Object.freeze({ key: 'year', label: 'Financial year' }),
  Object.freeze({ key: 'book', label: 'Book' }),
]);
export const finEntityLabel = entity => FIN_ENTITY_CHOICES.find(c => c.key === entity)?.label ?? String(entity);

// What was done, by the kind of thing it was done to. An action nobody has named is shown as it came. The voucher's words are the
// voucher detail's own history.
const ACTION_LABELS = Object.freeze({
  voucher: { create: 'Draft made', edit: 'Edited', discard: 'Discarded', submit: 'Sent for approval', approve: 'Approved', reject: 'Sent back', post: 'Posted', reverse: 'Reversal entered' },
  ledger: { create: 'Added', edit: 'Edited' },
  group: { create: 'Added', edit: 'Edited', delete: 'Deleted' },
  period: { status: 'Status changed' },
  rule: { edit: 'Changed' },
  access: { grant: 'Access given or changed', revoke: 'Access taken away' },
  import: { upload: 'Uploaded', match: 'Matches confirmed', build: 'Opening voucher built' },
  year: { create: 'Added' },
  book: { setup: 'Set up' },
});
export function finActionLabel(entity, action) {
  const table = typeof entity === 'string' && has(ACTION_LABELS, entity) ? ACTION_LABELS[entity] : null;
  return table && typeof action === 'string' && has(table, action) ? table[action] : String(action);
}

// When it happened: the browser's own day and time to the minute, '17 Oct 2026, 23:45'. The audit log stamps an instant; the screen
// shows it where the person is (the plant's browsers run on IST). '—' for anything that is no instant.
export function finWhenText(at) {
  const when = at ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${finDateText(dayOf(when))}, ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

// The words a log row is shown in, for the search: what was done and to what kind of thing ("Sent back Voucher"). A row carries the
// server's keys ('reject', 'voucher'), and a person searches for what the screen says. Who, which one (`label`) and why are the row's own.
export const finActivitySearchText = row => `${finActionLabel(row?.entity, row?.action)} ${finEntityLabel(row?.entity)}`;

// What a log row is about, in a word or two, from what was recorded about it (after, else before): a ledger's or group's name, a
// month's or year's label, a voucher's number, a rule's entry, whose access it was. Otherwise its number, or nothing at all. The
// ONE definition: the server makes each row's `label` with it (finance-reports.js, ruling R71), from the few fields of the record
// it reads, since the list no longer carries the record itself, and the screen shows that label.
export function finActivityTarget(row) {
  if (!row) return '';
  const snapshot = row.after ?? row.before ?? {};
  let named = null;
  switch (row.entity) {
    case 'ledger': case 'group': case 'book': named = snapshot.name; break;
    case 'period': case 'year': named = snapshot.label; break;
    case 'voucher': named = snapshot.number || (snapshot.status === 'draft' ? `Draft #${row.entity_id}` : null); break;
    case 'rule': named = snapshot.rule_key ? finRuleLabel(snapshot.rule_key) : null; break;
    case 'access': named = snapshot.user_name; break;
    default: break;
  }
  if (named) return named;
  return row.entity_id == null ? '' : `#${row.entity_id}`;
}

// What was recorded before and after a change, pretty-printed for the side-by-side view. Nothing recorded is nothing shown; a value
// JSON cannot hold is said and not thrown, since a throw inside a render takes the page with it.
export function finJsonText(value) {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return '[could not be shown]'; }
}
