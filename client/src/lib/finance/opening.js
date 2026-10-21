// The Opening Balances wizard's decisions, and the Tally trial balance upload's, without drawing anything (spec §11.2, §11.3). The
// screens (pages/finance/OpeningBalances.jsx, components/finance/Opening*.jsx, ParallelUpload.jsx) draw what these functions say; the
// files themselves are read by tally.js.
//
// The wizard has four steps and an import that lives on the server between visits (fin_imports):
//   Upload   the List of Accounts, the Trial Balance and, if there are any, the bills       POST /finance/imports
//   Match    what every Tally ledger is in Finance: a ledger it is, a ledger to make, or undecided   PUT …/matches (EVERY row, ruling R33)
//   Check    the tie-out: problems, warnings, the two sides                                   the import's own view
//   Build    the Opening voucher, which waits for the MD unless an Approver builds it           POST …/build-opening
// An import is `draft` until its matches are confirmed, `matched` after, and `used` once its Opening voucher is built; a used import is
// never changed, and after a rejection the files are uploaded again (ruling R37).
//
// What the Match step shows is the server's rows with whatever the person has touched laid over them (`touched`, row id → decision), so a
// refresh of the rows underneath never wipes an edit, and nothing is sent until the person confirms.
//
// Pure ESM, no React, no DOM: the server tests import this file by relative path and the browser bundles it as written. The relative
// imports are this folder's own (caps.js, fy.js, money.js, voucher.js). Own-property checks are Object.prototype.hasOwnProperty.call, never
// Object.hasOwn: the browser baseline in this ERP predates it (finance-wiring.test.js holds all client code to that).
import { finCan } from './caps.js';
import { finDayBefore, finIsValidDate } from './fy.js';
import { finFormatINR } from './money.js';
import { finDateText } from './voucher.js';

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const list = value => (Array.isArray(value) ? value : []);

// ── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const FIN_OPENING_STEPS = Object.freeze([
  Object.freeze({ key: 'upload', label: 'Upload' }),
  Object.freeze({ key: 'match', label: 'Match' }),
  Object.freeze({ key: 'check', label: 'Check' }),
  Object.freeze({ key: 'build', label: 'Build' }),
]);

// The day the opening balances are as at (ruling R34): the day before the books begin, which is the date of the Opening voucher. It is
// not a choice, so the screen shows it and offers no picker. null for books that begin on no day.
export const finOpeningAsAt = booksBegin => (finIsValidDate(booksBegin) ? finDayBefore(booksBegin) : null);

const newestOf = imports => list(imports).reduce((best, i) => (best == null || i.id > best.id ? i : best), null);

// The import the wizard continues (ruling R37): the newest one, when it is not used. A draft behind a used import is stale: it cannot be
// built while that import's Opening voucher stands, and the screen reports on the used one instead (finBuiltImport). The list comes newest
// first, but the choice does not rely on it. A status nobody knows is not something to continue.
export function finResumeImport(imports) {
  const newest = newestOf(imports);
  return newest && (newest.status === 'draft' || newest.status === 'matched') ? newest : null;
}

// The newest import, when it is a used one: the import whose Opening voucher the wizard reports on.
export function finBuiltImport(imports) {
  const newest = newestOf(imports);
  return newest && newest.status === 'used' ? newest : null;
}

// The step an import is at when the person has not moved: a draft needs its matches confirmed, a matched one is checked, a used one is
// built. No import is the Upload. A matched import with edits on the Match step that are not confirmed (`dirty`: restored from the
// tab's session after a reload, say) is at Match, where they are: Check is closed to it (finStepsOpen), and would be of the old matches.
export function finStepOfImport(imp, { dirty = false } = {}) {
  if (imp?.status === 'draft') return 'match';
  if (imp?.status === 'matched') return dirty ? 'match' : 'check';
  if (imp?.status === 'used') return 'build';
  return 'upload';
}

// The steps a person may move to now. Upload starts another import: it is open unless `canUpload` says it is not, which the wizard does
// when the Opening voucher of a used import still stands or waits (finOutcomeFreesUpload: a book cannot hold a second beside it, ruling R37).
// Match is open while there is an import to change. Check and Build need the matches confirmed (ruling R33), and nothing on the Match
// step left unconfirmed: the Check would be of the old matches. A used import is read, never changed, so it opens the Build step (what
// became of its voucher) and nothing between.
export function finStepsOpen({ imp, dirty = false, canUpload = true } = {}) {
  const live = Boolean(imp) && imp.status !== 'used';
  const confirmed = Boolean(imp) && imp.status === 'matched' && !dirty;
  return { upload: canUpload, match: live, check: confirmed, build: confirmed || imp?.status === 'used' };
}

// ── The groups: which are a party's ──────────────────────────────────────────────────────────────────────────────────

// The ids of the groups that are a party's: the ones the groups read marks `is_party` (GET /finance/books/:id/groups). Whether a group is a
// party's (it, or a group above it, is Sundry Debtors or Sundry Creditors) is the SERVER's word, finGroupKinds (finance-vouchers.js, ruling
// R23): this file knows no group name and walks no tree, because a second definition is one more thing to keep equal to the first. A Set,
// worked out once for the groups, since the Match step asks it of thousands of rows.
export const finPartyGroupIds = groups => new Set(list(groups).filter(g => g?.is_party === true).map(g => g.id));

// ── A row's decision ─────────────────────────────────────────────────────────────────────────────────────────────────

// `label` is the action in full (a tooltip), `short` what its button says.
export const FIN_MATCH_ACTIONS = Object.freeze([
  Object.freeze({ key: 'match', label: 'Match to a ledger', short: 'Match' }),
  Object.freeze({ key: 'create', label: 'Create a new ledger', short: 'Create' }),
  Object.freeze({ key: 'unmatched', label: 'Not decided yet', short: 'Undecided' }),
]);

const ACTION_OF_STATUS = Object.freeze({ matched: 'match', create: 'create', unmatched: 'unmatched' });

// A row of the import as the server holds it, as a decision: { action, ledger_id, group_id, party_type, party_id }. A status nobody
// knows is undecided, never a match.
export function finRowDecision(row) {
  return {
    action: has(ACTION_OF_STATUS, row.match_status) ? ACTION_OF_STATUS[row.match_status] : 'unmatched',
    ledger_id: row.ledger_id ?? null, group_id: row.group_id ?? null, party_type: row.party_type ?? null, party_id: row.party_id ?? null,
  };
}

// The decision a row stands at now: the person's, if they have touched it, else the server's.
export const finDecisionOf = (row, touched) => (touched && has(touched, row.id) ? touched[row.id] : finRowDecision(row));

// Whether a new ledger for this row goes under a party group, so it may be linked to a customer or a vendor. For the group the server
// proposed, the import view's own answer (its fresh `is_party`, read with the row); for a group the person chose, the groups' (`partyGroups`,
// finPartyGroupIds). Both are the server's word.
export function finRowIsParty(row, decision, partyGroups) {
  if (decision.group_id == null) return false;
  if (decision.group_id === row.group_id) return row.is_party === true;
  return partyGroups?.has(decision.group_id) === true;
}

// A decision changed by one thing, the rest kept (so going back to an earlier action loses nothing): { action }, { ledger_id },
// { group_id }, or { party } (a { party_type, party_id }, or null for none). A party goes when the new group is not a party's.
export function finEditDecision(row, decision, change, partyGroups) {
  if (has(change, 'action')) return { ...decision, action: change.action };
  if (has(change, 'ledger_id')) return { ...decision, ledger_id: change.ledger_id };
  if (has(change, 'party')) return { ...decision, party_type: change.party?.party_type ?? null, party_id: change.party?.party_id ?? null };
  if (has(change, 'group_id')) {
    const next = { ...decision, group_id: change.group_id };
    return finRowIsParty(row, next, partyGroups) ? next : { ...next, party_type: null, party_id: null };
  }
  return decision;
}

// The entry the server takes for a row (PUT …/matches): the action and what that action names and nothing else, since the server refuses
// a stray field. A party goes only whole and only under a party group. null while the decision is not enough to send: a match with no
// ledger, a new ledger with no group.
export function finEntryOf(row, decision, partyGroups) {
  if (decision.action === 'match') {
    return decision.ledger_id == null ? null : { row_id: row.id, action: 'match', ledger_id: decision.ledger_id };
  }
  if (decision.action === 'create') {
    if (decision.group_id == null) return null;
    const entry = { row_id: row.id, action: 'create', group_id: decision.group_id };
    if (decision.party_type && decision.party_id != null && finRowIsParty(row, decision, partyGroups)) {
      entry.party_type = decision.party_type;
      entry.party_id = decision.party_id;
    }
    return entry;
  }
  return { row_id: row.id, action: 'unmatched' };
}

// ── The Match step as a whole ────────────────────────────────────────────────────────────────────────────────────────

export const FIN_MATCH_FILTERS = Object.freeze([
  Object.freeze({ key: 'all', label: 'All' }),
  Object.freeze({ key: 'attention', label: 'Needs a decision' }),
  Object.freeze({ key: 'match', label: 'Matched' }),
  Object.freeze({ key: 'create', label: 'New ledgers' }),
]);

const countOf = n => `${n} more`;

// "Row 2 is", "Row 2 and Row 3 are", "Row 2, Row 3 and 2 more are": the other rows that want the same thing.
function finOthersText(others) {
  const shown = others.length > 2 ? [others[0], others[1], countOf(others.length - 2)] : others;
  const text = shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `${text} ${others.length === 1 ? 'is' : 'are'}`;
}

// Everything the Match screen needs about its rows, in one pass over them:
//   partyGroups  the ids of the groups that are a party's (finPartyGroupIds), for the screen to ask of the group a person chooses
//   states   Map of row id → { kind, note, tone }. kind is 'match' (a ledger chosen), 'create' (a group chosen) or 'attention' (not decided,
//            half decided, or in conflict); note says why in a few words, or is null; tone is the note's colour ('amber', 'red') or null.
//   counts   { all, match, create, attention }, for the filters.
//   matches  the confirmation to send, EVERY row once and in order (ruling R33), or null while a row stops it.
//   blocked  how many rows stop a confirmation: half decided, or sharing one Finance ledger or one party with another row. The server
//            refuses both, naming the rows; this says it first and marks them. A row left undecided does NOT stop it: it is confirmed as
//            undecided, and the Check step says it stops the build.
//   ready    blocked === 0
// `ledgerById` (the book's ledgers, optional) lets a match to a ledger that is switched off be flagged: the server refuses an opening
// row with a balance matched to one, but the note is advice, not a block, because the server has the last word.
export function finMatchView(rows, touched, groups, { ledgerById } = {}) {
  const all = list(rows);
  const partyGroups = finPartyGroupIds(groups);
  const entries = [];
  const decisions = new Map();
  const onLedger = new Map();
  const onParty = new Map();
  const group = (map, key, row) => { if (!map.has(key)) map.set(key, []); map.get(key).push(row); };

  for (const row of all) {
    const decision = finDecisionOf(row, touched);
    const entry = finEntryOf(row, decision, partyGroups);
    decisions.set(row.id, decision);
    entries.push(entry);
    if (entry?.action === 'match') group(onLedger, entry.ledger_id, row);
    if (entry?.party_type) group(onParty, `${entry.party_type}:${entry.party_id}`, row);
  }

  const clash = new Map();
  for (const rowsOn of onLedger.values()) {
    if (rowsOn.length > 1) for (const row of rowsOn) clash.set(row.id, `${finOthersText(rowsOn.filter(r => r !== row).map(r => r.tally_name))} matched to the same ledger`);
  }
  for (const [key, rowsOn] of onParty) {
    if (rowsOn.length > 1) {
      for (const row of rowsOn) clash.set(row.id, `${finOthersText(rowsOn.filter(r => r !== row).map(r => r.tally_name))} linked to the same ${key.split(':')[0]}`);
    }
  }

  const states = new Map();
  const counts = { all: all.length, match: 0, create: 0, attention: 0 };
  let blocked = 0;
  all.forEach((row, i) => {
    const decision = decisions.get(row.id);
    let state;
    if (clash.has(row.id)) {
      state = { kind: 'attention', note: clash.get(row.id), tone: 'red' };
      blocked += 1;
    } else if (entries[i] === null) {
      state = { kind: 'attention', note: decision.action === 'match' ? 'Choose a ledger' : 'Choose a group', tone: 'amber' };
      blocked += 1;
    } else if (decision.action === 'unmatched') {
      state = { kind: 'attention', note: 'Not decided yet', tone: 'amber' };
    } else if (decision.action === 'match') {
      const ledger = ledgerById?.get(decision.ledger_id);
      const off = ledger && ledger.active === false && row.debit_paise !== row.credit_paise;
      state = { kind: 'match', note: off ? `${ledger.name} is switched off` : null, tone: off ? 'amber' : null };
    } else {
      state = { kind: 'create', note: null, tone: null };
    }
    counts[state.kind] += 1;
    states.set(row.id, state);
  });
  return { partyGroups, states, counts, matches: blocked === 0 ? entries : null, blocked, ready: blocked === 0 };
}

// The rows a filter shows. An unknown filter shows them all.
export function finFilterRows(rows, view, filter) {
  if (filter !== 'attention' && filter !== 'match' && filter !== 'create') return list(rows);
  return list(rows).filter(row => view.states.get(row.id)?.kind === filter);
}

// The rows whose decision on screen is not the one the server holds: the same entry would not be sent. A decision put back as it was is no
// change, nor is a field the action does not send; a half-made decision is one. Only rows on the screen are looked at.
export function finChangedRows(rows, touched, groups) {
  if (!touched) return [];
  const partyGroups = finPartyGroupIds(groups);
  return list(rows).filter(row => {
    if (!has(touched, row.id)) return false;
    return JSON.stringify(finEntryOf(row, touched[row.id], partyGroups)) !== JSON.stringify(finEntryOf(row, finRowDecision(row), partyGroups));
  });
}

// ── The edits not yet confirmed, kept for a reload ───────────────────────────────────────────────────────────────────

// The edits are the wizard's, in memory, so leaving the Match step loses nothing; kept in the tab's session as well (sessionStore), a reload
// (the update bar, a pull to refresh, a tablet that discards a tab in the background) loses nothing either. They belong to ONE login's view of
// ONE import at ONE status: the same import once confirmed, or built, is another set, and a tab that is signed in as someone else never finds
// another's. The key says all three.
export const finEditsKey = (userId, importId, status) => `fin:opening-edits:${userId ?? 'anon'}:${importId}:${status}`;

// The edits (`touched`, row id → decision) as the text a tab keeps them in; '' for none.
export function finEditsPack(touched) {
  if (touched === null || typeof touched !== 'object' || Array.isArray(touched) || Object.keys(touched).length === 0) return '';
  return JSON.stringify(touched);
}

const EDIT_ACTIONS = new Set(['match', 'create', 'unmatched']);
const EDIT_PARTIES = new Set(['customer', 'vendor']);
const isId = value => Number.isSafeInteger(value) && value > 0;
const noneOr = (value, ok) => value === undefined || value === null || ok(value);

// The edits back from the text a tab kept: a row stays only when its decision is whole and of the shape finRowDecision makes (the five
// fields it has, a missing one meaning none), and its id is a whole number above zero, as the server's are. Whatever a tab holds is not
// trusted: a row that is not that is left out, not repaired, and text that is no edits is no edits.
export function finEditsUnpack(text) {
  let held;
  try { held = typeof text === 'string' && text !== '' ? JSON.parse(text) : null; } catch { held = null; }
  const out = {};
  if (held === null || typeof held !== 'object' || Array.isArray(held)) return out;
  for (const [key, d] of Object.entries(held)) {
    if (!/^[1-9]\d*$/.test(key) || !isId(Number(key)) || d === null || typeof d !== 'object' || Array.isArray(d)) continue;
    if (!EDIT_ACTIONS.has(d.action)) continue;
    if (!noneOr(d.ledger_id, isId) || !noneOr(d.group_id, isId) || !noneOr(d.party_id, isId) || !noneOr(d.party_type, t => EDIT_PARTIES.has(t))) continue;
    out[key] = { action: d.action, ledger_id: d.ledger_id ?? null, group_id: d.group_id ?? null, party_type: d.party_type ?? null, party_id: d.party_id ?? null };
  }
  return out;
}

// The row a refusal of the confirmation is about, as its id: the server names the entry (`matches[3].ledger_id`) and `sent` is what was
// sent, so entry 3 is the row sent third. null when the refusal is about the list as a whole, or names nothing.
export function finRefusedRowId(error, sent) {
  const field = error?.data?.field;
  const hit = typeof field === 'string' ? /^matches\[(\d+)\]/.exec(field) : null;
  return hit && Array.isArray(sent) && sent[Number(hit[1])] ? sent[Number(hit[1])].row_id : null;
}

// ── The party picker ─────────────────────────────────────────────────────────────────────────────────────────────────

const PARTY_WORD = Object.freeze({ customer: 'Customer', vendor: 'Vendor' });

// The customers and vendors a new ledger under a party group may be linked to, as one list of options { value, label, hint, search }:
// `customer:7`, `vendor:3`, the customers first. Both sides are offered under every party group, because a name that is only a vendor is
// proposed under Sundry Debtors too (ruling R32); the server marks a group as a party's and not on which side (is_party), so the order does
// not follow the group. Only the switched-on ones are offered, except the one the row is already linked to (`current`, a { party_type,
// party_id, party_name }): a former customer can have a balance, and a party the lists do not hold is still shown, as what it is, so the row
// never looks unlinked when it is not.
export function finPartyChoices(customers, vendors, current) {
  const linked = current && PARTY_WORD[current.party_type] && current.party_id != null ? `${current.party_type}:${current.party_id}` : null;
  let found = false;
  const options = [];
  for (const [type, parties] of [['customer', list(customers)], ['vendor', list(vendors)]]) {
    for (const party of parties) {
      const value = `${type}:${party.id}`;
      const on = !(party.active === 0 || party.active === false);
      if (!on && value !== linked) continue;
      if (value === linked) found = true;
      options.push({
        value,
        label: on ? party.name : `${party.name} (switched off)`,
        hint: party.city ? `${PARTY_WORD[type]} · ${party.city}` : PARTY_WORD[type],
        search: [party.name, party.city, party.gstin].filter(Boolean).join(' '),
      });
    }
  }
  if (linked && !found) {
    options.push({
      value: linked, label: `${current.party_name ?? `${PARTY_WORD[current.party_type]} #${current.party_id}`} (not in the list)`,
      hint: PARTY_WORD[current.party_type], search: String(current.party_name ?? ''),
    });
  }
  return options;
}

// A choice of the picker as the entry names it: { party_type, party_id }, or null for none or for anything that is not a choice.
export function finPartyOfChoice(value) {
  const hit = typeof value === 'string' ? /^(customer|vendor):([1-9]\d*)$/.exec(value) : null;
  return hit ? { party_type: hit[1], party_id: Number(hit[2]) } : null;
}

// The picker's value for a decision: '' when it names no party.
export const finPartyChoiceOf = decision => (PARTY_WORD[decision?.party_type] && decision.party_id != null ? `${decision.party_type}:${decision.party_id}` : '');

// ── The month ends of a trial balance ────────────────────────────────────────────────────────────────────────────────

// The days a month-end trial balance may be as at: the last day of each month of the book's years (GET /finance/books/:id/years) that ends
// on or after the day the books begin (ruling R34; the server also needs the day to fall in one of the years, M9, which these do),
// oldest first, as { value, label, hint } for a picker. A month with no end date, or books that begin on no day, offer nothing.
export function finMonthEnds(years, booksBegin) {
  if (!finIsValidDate(booksBegin)) return [];
  const out = [];
  for (const year of [...list(years)].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))) {
    for (const month of list(year.periods)) {
      if (finIsValidDate(month.end_date) && month.end_date >= booksBegin) out.push({ value: month.end_date, label: finDateText(month.end_date), hint: month.label });
    }
  }
  return out;
}

// The month end offered first: the latest that has come by `today`, and, before the first has, the first, so there is always one to
// choose. '' when there is none.
export function finDefaultMonthEnd(options, today) {
  const ends = list(options).map(o => o.value);
  const by = ends.filter(day => day <= today);
  return by[by.length - 1] ?? ends[0] ?? '';
}

// ── What an upload sends ─────────────────────────────────────────────────────────────────────────────────────────────

// The server takes twenty file names of 255 characters at most (they are kept for the audit trail and the uploads list).
const FILE_NAMES_MAX = 20;
const FILE_NAME_MAX = 255;
const fileNames = names => names.filter(Boolean).map(name => String(name).slice(0, FILE_NAME_MAX)).slice(0, FILE_NAMES_MAX);

// POST /finance/imports for the opening balances. Each of `accounts` and `tb` is a { rows, fileName } as the upload read them; `bills` is
// the list of the bills files read (finBillsRead), whose rows are put together in the order the files were chosen.
export function finUploadBody({ bookId, asAt, accounts, tb, bills }) {
  const billFiles = list(bills);
  return {
    book_id: bookId, purpose: 'opening', as_at: asAt,
    file_names: fileNames([accounts.fileName, tb.fileName, ...billFiles.map(b => b.fileName)]),
    accounts: accounts.rows, tb: tb.rows, bills: billFiles.flatMap(b => b.rows),
  };
}

// Whether the opening upload can be sent: the List of Accounts and the Trial Balance have been read and hold rows. The bills are optional.
export function finUploadReady({ accounts, tb } = {}) {
  return list(accounts?.rows).length > 0 && list(tb?.rows).length > 0;
}

// The bills files that have been read, from the slots they are chosen in (slot key → { rows, fileName } or nothing), in the order of
// `order`: those with rows in them, the rest being slots left empty or files that were turned back.
export function finBillsRead(slots, order) {
  return list(order).map(key => slots?.[key]).filter(file => file && list(file.rows).length > 0);
}

// A bills file taken off the screen: its slot goes with it. The only slot is not removed but emptied, and emptied as a NEW slot (`fresh` is
// a key nobody has used), so there is always a place to choose a file, and the screen, which keeps what a slot has read for as long as its
// key stands, draws the emptied one from nothing. { slots, order } as the screen keeps them (finBillsRead). A slot that is not on the
// screen changes nothing, and neither list given is changed.
export function finRemoveBillsSlot(slots, order, key, fresh) {
  const keys = list(order);
  const held = slots !== null && typeof slots === 'object' ? slots : {};
  if (!keys.includes(key)) return { slots: { ...held }, order: [...keys] };
  const rest = keys.filter(k => k !== key);
  if (rest.length === 0) return { slots: { [fresh]: null }, order: [fresh] };
  return { slots: Object.fromEntries(rest.map(k => [k, held[k] ?? null])), order: rest };
}

// POST /finance/imports for a month-end trial balance: the one file, and neither accounts nor bills (the server refuses both).
export function finParallelBody({ bookId, asAt, tb }) {
  return { book_id: bookId, purpose: 'parallel_tb', as_at: asAt, file_names: fileNames([tb.fileName]), tb: tb.rows };
}

// ── What became of the Opening voucher ───────────────────────────────────────────────────────────────────────────────

// The Opening voucher a used import built, as the screen says it: { state, text }. A rejection returns a voucher to draft with its reason
// (spec §7.1), which is how a sent-back Opening voucher looks. null for no voucher.
export function finOpeningOutcome(voucher) {
  if (!voucher) return null;
  switch (voucher.status) {
    case 'submitted':
      return { state: 'waiting', text: 'Waiting for MD approval' };
    case 'posted':
      return voucher.reversed_by_id != null
        ? { state: 'reversed', text: `${voucher.number} was posted and has since been reversed` }
        : { state: 'posted', text: `Posted as ${voucher.number}` };
    case 'draft':
      return { state: 'returned', text: voucher.last_reject_reason ? `The MD sent it back: ${voucher.last_reject_reason}` : 'It was sent back to draft' };
    case 'discarded':
      return { state: 'discarded', text: 'The Opening voucher was discarded' };
    default:
      return { state: 'unknown', text: `The Opening voucher is ${voucher.status}` };
  }
}

// Whether the files can be uploaded again: only once the Opening voucher is gone. One that waits for the MD, or holds the books' opening,
// is not to be built beside (ruling R37; the server refuses it, FIN_OPENING_EXISTS, and the screen does not send a person that far).
export const finOutcomeFreesUpload = outcome => ['returned', 'discarded', 'reversed'].includes(outcome?.state);

// What building does, said before the button is pressed. An Approver's own Opening voucher posts at once; anyone else's waits for the MD.
export const finBuildNote = roles => (finCan(roles, 'approve')
  ? 'You are an Approver, so the Opening voucher posts at once, marked self-approved.'
  : 'The Opening voucher waits for the MD to approve it; the books have no opening balances until then.');

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────────

// A row's figures in a sentence, for the rows the import left out as group totals: its balance, Dr or Cr, or both sides when it has both
// (a Grand Total row does).
export function finFiguresText(row) {
  const debit = row?.debit_paise ?? 0;
  const credit = row?.credit_paise ?? 0;
  return debit && credit ? `Dr ${finFormatINR(debit)}, Cr ${finFormatINR(credit)}` : finFormatINR(debit - credit, { drcr: true });
}

// How far apart the two sides of the trial balance are, in paise.
export const finTotalsGap = totals => Math.abs((totals?.dr ?? 0) - (totals?.cr ?? 0));
