// Finance — HR's money in the books: the setup (Cash & Bank spec §7.2, §7.3, §7.8, §7.9; ledger ruling R10). What the Admin sets
// once in Finance Setup → HR & payroll, and what HR's own doors ask of it:
//   • finHrSetupOf           a book's setup: the account each HR pay channel pays from (a ledger of either book, §7.3), the ledger
//                            that plays each role (§7.2), where its payroll expense goes by person type or department (§7.9), and
//                            when its payroll month is booked (§7.8; a book with no settings row books it at the month end); and what
//                            the form chooses from (ruling R55): HR's pay channels, and the keys the expense map can take;
//   • finSaveHrSetup         the Admin saves any of it, a channel, a role or an expense key at a time;
//   • finEnsureStaffLedgers  makes the staff ledgers a book lacks, under the groups the plan names, and gives them their roles (§7.2);
//   • finPaidFromOptions     the one "paid from" list HR's doors offer: office cash, each holder and the mapped banks, one entry per
//                            account (§7.3; ruling R17);
//   • finOffersPaidFrom      whether that list offers any account now: while it offers none, or cannot be read, an HR door that would
//                            ask for a code takes none as cash (ruling R47);
//   • finIsPaidFromChoice    whether a code an HR door was sent is one it may store: `cash`, a pay channel, or an account on that list;
//   • finResolvePaidFrom     the account a "paid from" code names, or the pay channel's own when there is no code (§7.3);
//   • finPaidFromKind        whether that account is cash or bank, for HR's monthly schedule (ruling R43);
//   • finPerPersonLedgerIds  the ledgers that take a Tally ledger per person, summed, at the import (§7.9; finance-import.js).
//
// The writes take the qc / oc of the transaction their route opened, and use nothing else (the pool is one client on Vercel). The
// route has asked finRequire for the admin capability on the book BEFORE the transaction. A channel's account may sit in the other
// book (§7.3), so pointing a channel at a ledger, or moving a channel away from one, is the admin's of THAT ledger's book too: the
// route hands over the books the caller administers (actor.adminBookIds). Each write that changes anything writes ONE audit row for
// the book (entity 'book', action 'hr_setup') holding what changed, before and after, and one more in every other book a channel's
// change touched, so that book's log shows what now pays from its bank. A ledger the setup makes or flags writes its own rows, as
// finance-masters.js does wherever a ledger is made or edited. A write that changes nothing writes nothing.
//
// Locks, in this order: the book's row FOR NO KEY UPDATE, so two saves of one book (or a save and finEnsureStaffLedgers) go one after
// the other, each reading what the last one left, and nothing a posting holds on the book is waited for; then, for a save that
// names channels, the channel map's own lock, FIN_CHANNEL_MAP_LOCK, because the map is one for both books (a channel code is its
// key) and two books' saves would otherwise not meet; then any ledger it makes system-only (finUpdateLedger, FOR NO KEY UPDATE).
//
// The reads take whatever query function they are handed: the pool's q, or a transaction's qc (HR's door validates its code inside
// its own transaction, and the HR feed resolves an account inside Finance's). HR's tables are read and never written: Finance keeps an
// HR channel code bare.

import { q } from './db.js';
import { finAudit } from './finance-audit.js';
import { finError } from './finance-errors.js';
import { finCreateLedger, finIdOf, finUpdateLedger } from './finance-masters.js';
import { finGroupKinds, finIsPartyLedger } from './finance-vouchers.js';

// The roles a ledger plays in a book, exactly fin_ledger_roles' CHECK (migration 20261121090100): the staff ledgers HR's money posts
// to (§7.2), and the ones the app posts to by itself. One ledger per role in a book; a ledger may play several.
export const FIN_LEDGER_ROLES = Object.freeze([
  'staff_advances', 'staff_loans', 'salary_payable', 'salary_expense', 'md_account',
  'advance_waiver', 'other_deductions', 'rounding', 'tds_receivable', 'tds_payable', 'cash_difference', 'intercompany',
]);

// The two whose ledger may stand for a Tally ledger per person (§7.9): several rows of a Tally import match it, and their balances are
// summed, in the Opening voucher (one line) and in the parallel run (one row). Every other ledger takes one Tally row.
export const FIN_PER_PERSON_ROLES = Object.freeze(['staff_advances', 'staff_loans']);

// The roles whose ledger takes no typed voucher (spec §7.2 and §5.5; ledger rulings R10 and R20): the four staff ledgers HR's money
// posts to, and the cash-difference ledger. A ledger that NEWLY takes one of them, or newly becomes the ledger of an expense key (the
// salary expense ledgers, §7.9), is made system-only in the same transaction (finMakeSystemOnly), whether finEnsureStaffLedgers made it,
// found it by its name, or finSaveHrSetup gave it the role. Only that move sets the flag: the Admin may switch a ledger back in the
// chart of accounts, and later saves leave it so; the ledger a role leaves keeps its flag. Every other role keeps its ledger's flags.
// The four staff roles, FIN_STAFF_ROLES, and every expense key also refuse a bank, cash or party ledger (ruling R20a, finNoStaffPlace).
const FIN_STAFF_ROLES = Object.freeze(['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense']);
const FIN_SYSTEM_ONLY_ROLES = Object.freeze([...FIN_STAFF_ROLES, 'cash_difference']);

// The ledgers finEnsureStaffLedgers gives a book that has none for a role (plan, Global Constraints), in this order: the name, and the
// group one is made under (a group of Tally's template, which is never renamed: SP1 ruling R19). The four staff ledgers are the
// system's (FIN_SYSTEM_ONLY_ROLES: H6 lets HR's entries, the Opening and its corrections in); the MD's account is an ordinary ledger,
// under Loans (Liability) › Unsecured Loans, where a director's account usually sits in Tally (§7.2).
const FIN_STAFF_LEDGERS = Object.freeze([
  Object.freeze({ role: 'staff_advances', name: 'Staff Advances', group: 'Loans & Advances (Asset)' }),
  Object.freeze({ role: 'staff_loans', name: 'Staff Loans', group: 'Loans & Advances (Asset)' }),
  Object.freeze({ role: 'salary_payable', name: 'Salary Payable', group: 'Current Liabilities' }),
  Object.freeze({ role: 'salary_expense', name: 'Salaries & Wages', group: 'Indirect Expenses' }),
  Object.freeze({ role: 'md_account', name: "MD's Account", group: 'Unsecured Loans' }),
]);

const FIN_PAYROLL_BOOK = 'CI';         // the book HR's own payouts are kept in (§7.2: COLOUR and no firm → CI)
const FIN_CASH_CHANNEL = 'CASH';       // HR's cash channel: the code `cash` stands for (§7.3), which older HR rows store
const FIN_PAYROLL_BOOKINGS = Object.freeze(['month_end', 'when_paid']);
// The channel map's lock: pg_advisory_xact_lock(7301, 0). Every write to fin_hr_channels is a save here, and takes it.
const FIN_CHANNEL_MAP_LOCK = Object.freeze([7301, 0]);
const FIN_SETUP_MAX = 200;             // channels, or expense keys, one save takes
const FIN_CODE_MAX = 100;              // an HR channel code
const FIN_KEY_MAX = 200;               // an expense key, 'type:…' or 'dept:…'
const FIN_EXPENSE_KEY = /^(type|dept):(.*)$/s;

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────

const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});
const finForbidden = field => finError(403, 'FIN_FORBIDDEN', undefined, { field });

// Who is acting, as the audit log wants it. A write with nobody to blame is a bug in the caller.
function finWho(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!name) throw new Error('An HR setup write needs to know who is acting: pass { id, name }');
  return { id: Number.isInteger(actor.id) ? actor.id : null, name };
}

// Book ids from a list the route worked out; anything else in it is dropped.
const finBookIds = list => (Array.isArray(list) ? list.map(finIdOf).filter(id => id != null) : []);

// A book's row, held FOR NO KEY UPDATE for the rest of the transaction (see the header).
async function finLockBook(oc, bookId) {
  const book = await oc('SELECT id, name FROM fin_books WHERE id = $1 FOR NO KEY UPDATE', [bookId]);
  if (!book) throw finError(404, 'FIN_NOT_FOUND');
  return book;
}

// Make ledgers system-only (FIN_SYSTEM_ONLY_ROLES) through finUpdateLedger, which writes each one's own edit row, and nothing for one
// that is so already. In ascending id order, the order a posting takes its ledgers in (FOR SHARE, finance-vouchers.js), so a setup
// write and a posting never wait for one another in a circle.
async function finMakeSystemOnly(qc, oc, ledgerIds, by) {
  for (const id of [...new Set(ledgerIds)].sort((a, b) => a - b)) {
    await finUpdateLedger(qc, oc, id, { manual_entry: false }, by, { isAdmin: true });
  }
}

// The CASH channel's account while fin_hr_channels has no row for it (spec §7.3, "CASH → office cash, by default"; ruling R19): the CI
// book's office cash, its ONE switched-on Cash-in-Hand ledger with no holder, as { book_id, ledger_id }. None, or more than one, is no
// answer: CASH then stays unmapped (the HR feed's FIN_UNMAPPED_CHANNEL), and nothing is guessed. A row for CASH wins over it, and taking
// that row away lets it apply again. It is never written: the channel map holds the rows an Admin saved, and no others.
async function finCashDefault(qx) {
  const book = (await qx('SELECT id FROM fin_books WHERE code = $1', [FIN_PAYROLL_BOOK]))[0];
  if (!book) return null;
  const kinds = await finGroupKinds(qx, book.id);
  const tills = (await qx('SELECT id, group_id FROM fin_ledgers WHERE book_id = $1 AND active AND holder_name IS NULL', [book.id]))
    .filter(l => kinds.get(l.group_id)?.account_kind === 'cash');
  return tills.length === 1 ? { book_id: book.id, ledger_id: tills[0].id } : null;
}

// ── Reading the setup ────────────────────────────────────────────────────────────────────────

// What the HR & payroll form chooses from (ruling R55): HR's own lists, the same whichever book is read and whoever reads it, and never
// anything of a person. HR's tables are read here and never written.
//   • FIN_HR_CHANNELS_SQL   HR's pay channels, by code: each channel's code, its name and its kind (bank or cash), mapped or not and
//                           switched off in HR or not, so the form has a row for each. A channel's bank details stay in HR.
//   • FIN_EXPENSE_KEYS_SQL  the person types and departments HR's people have, each once, as the payroll journal matches them
//                           (finHrRunLines: lower(btrim(...)), a department only when there is one), with a spelling of HR's own to
//                           label it by. Every person counts, a hidden one too: a department is no person (ruling R55). No name, code,
//                           count or amount is read. The journal books a hidden person's gross to the salary_expense role whatever
//                           their type or department (ruling R75), so a key only hidden people have takes nothing.
const FIN_HR_CHANNELS_SQL = 'SELECT code, label AS name, kind FROM hr.pay_channels ORDER BY code';
const FIN_EXPENSE_KEYS_SQL = `
SELECT k.part, k.value, min(k.spelt COLLATE "C") AS spelt
  FROM (SELECT 'type' AS part, lower(btrim(p.worker_type)) AS value, btrim(p.worker_type) AS spelt FROM hr.people p
        UNION ALL
        SELECT 'dept', lower(btrim(p.department)), btrim(p.department) FROM hr.people p) k
 WHERE k.value <> ''
 GROUP BY k.part, k.value
 ORDER BY k.part = 'dept', k.value COLLATE "C"`;
const FIN_KEY_PART_LABELS = Object.freeze({ type: 'Person type', dept: 'Department' });

// The keys of FIN_EXPENSE_KEYS_SQL's rows: [{ key, label }], the person types first, then the departments, each in order. A key is
// 'type:<value>' or 'dept:<value>', exactly as finSaveHrSetup takes and stores it, so a form may send it back as it came; a value no
// key could hold (too long, a control character, a space of its own at either end) is left out. The label is HR's spelling, a person
// type's with a capital: 'Person type · Contractor', 'Department · Pasting'.
function finExpenseKeysOf(rows) {
  return rows.flatMap(row => {
    const key = `${row.part}:${row.value}`;
    if (key.length > FIN_KEY_MAX || /[\u0000-\u001f\u007f]/.test(key) || row.value !== row.value.trim()) return [];
    const spelt = row.part === 'type' ? `${row.spelt.charAt(0).toUpperCase()}${row.spelt.slice(1)}` : row.spelt;
    return [{ key, label: `${FIN_KEY_PART_LABELS[row.part]} · ${spelt}` }];
  });
}

// A book's setup as it stands, read through `qx`: { channels: [{ channel_code, book_id, ledger_id }] (by code), cash_default:
// { book_id, ledger_id } | null, roles: { [role]: ledger_id }, expense_map: [{ hr_key, ledger_id }] (by key), payroll_booking,
// hr_channels: [{ code, name, kind }], expense_keys: [{ key, label }] }.
// The channel map is one for both books, each channel with the book of the ledger it pays from, and holds the rows an Admin saved and
// no others. cash_default is what CASH resolves to while it has no row of its own (finCashDefault, ruling R19), said beside the
// channels and never among them, so a form that sends its whole state back never saves the default by accident. `seeBookIds`, when
// given, leaves out a channel, and the default, of a book outside them: a login that cannot read the other book is told nothing of
// its ledgers. hr_channels and expense_keys are what the form chooses from (ruling R55): HR's, the same for every book and login.
async function finSetupRead(qx, bookId, seeBookIds = null) {
  const inSight = id => seeBookIds == null || seeBookIds.includes(id);
  const channels = await qx(
    `SELECT channel_code, book_id, ledger_id FROM fin_hr_channels
      WHERE $1::int[] IS NULL OR book_id = ANY($1::int[])
      ORDER BY channel_code`, [seeBookIds]);
  const fallback = await finCashDefault(qx);
  const roles = await qx('SELECT role, ledger_id FROM fin_ledger_roles WHERE book_id = $1 ORDER BY role', [bookId]);
  const expense = await qx('SELECT hr_key, ledger_id FROM fin_hr_expense_map WHERE book_id = $1 ORDER BY hr_key', [bookId]);
  const setting = (await qx('SELECT payroll_booking FROM fin_book_settings WHERE book_id = $1', [bookId]))[0];
  return {
    channels,
    cash_default: fallback && inSight(fallback.book_id) ? fallback : null,
    roles: Object.fromEntries(roles.map(r => [r.role, r.ledger_id])),
    expense_map: expense,
    payroll_booking: setting?.payroll_booking ?? 'month_end',
    hr_channels: await qx(FIN_HR_CHANNELS_SQL),
    expense_keys: finExpenseKeysOf(await qx(FIN_EXPENSE_KEYS_SQL)),
  };
}

// One book's setup, for its screen: a pool read. The route has asked finRequire for the right to view the book, and passes the books
// the caller may read as `seeBookIds` (see finSetupRead).
export async function finHrSetupOf(bookId, { seeBookIds = null } = {}) {
  const id = finIdOf(bookId);
  if (id == null) throw finError(404, 'FIN_NOT_FOUND');
  return finSetupRead(q, id, seeBookIds == null ? null : finBookIds(seeBookIds));
}

// ── Saving it ────────────────────────────────────────────────────────────────────────────────

// A ledger an entry names: a ledger id, or null for none, which takes the channel, role or key away. Left out is no answer.
function finTargetOf(value, field, sentence) {
  if (value === null) return null;
  const id = finIdOf(value);
  if (id == null) throw finBad(sentence, field);
  return id;
}

function finListOf(value, field, what) {
  if (!Array.isArray(value)) throw finBad(`${what} must be a list.`, field);
  if (value.length > FIN_SETUP_MAX) throw finBad(`${what} takes ${FIN_SETUP_MAX} entries at most.`, field);
  return value;
}

function finEntryOf(raw, at) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw finBad(`${at} must be an object.`, at);
  return raw;
}

// [{ channel_code, ledger_id }], each channel once.
function finCleanChannels(value) {
  const seen = new Set();
  return finListOf(value, 'channels', 'The channels').map((raw, i) => {
    const at = `channels[${i}]`;
    finEntryOf(raw, at);
    const code = typeof raw.channel_code === 'string' ? raw.channel_code.trim() : '';
    if (!code || code.length > FIN_CODE_MAX) throw finBad('Say which HR pay channel.', `${at}.channel_code`);
    if (seen.has(code)) throw finBad(`${code} is in the list twice. Say once which account it pays from.`, `${at}.channel_code`);
    seen.add(code);
    return { at, code, ledger_id: finTargetOf(raw.ledger_id, `${at}.ledger_id`, 'Say which bank or cash account the channel pays from, or none.') };
  });
}

// { [role]: ledger_id }.
function finCleanRoles(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw finBad('Send the roles as each role with its ledger.', 'roles');
  return Object.entries(value).map(([role, ledger]) => {
    const at = `roles.${role}`;
    if (!FIN_LEDGER_ROLES.includes(role)) throw finBad(`${role} isn't a ledger role. The roles are ${FIN_LEDGER_ROLES.join(', ')}.`, at);
    return { at, role, ledger_id: finTargetOf(ledger, at, 'Say which ledger plays this role, or none.') };
  });
}

// [{ hr_key, ledger_id }]. A key is 'type:<person type>' or 'dept:<department>', trimmed, with the value as HR spells it. Two keys
// that differ only in capitals are one key: the payroll journal finds a person's type or department whatever its capitals (§7.9).
function finCleanExpense(value) {
  const seen = new Set();
  return finListOf(value, 'expense_map', 'The expense map').map((raw, i) => {
    const at = `expense_map[${i}]`;
    finEntryOf(raw, at);
    const parts = FIN_EXPENSE_KEY.exec(typeof raw.hr_key === 'string' ? raw.hr_key.trim() : '');
    const rest = parts ? parts[2].trim() : '';
    const key = `${parts?.[1]}:${rest}`;
    if (!rest || key.length > FIN_KEY_MAX || /[\u0000-\u001f\u007f]/.test(key)) {
      throw finBad('An expense key is type:<person type> or dept:<department>.', `${at}.hr_key`);
    }
    if (seen.has(key.toLowerCase())) throw finBad(`${key} is in the list twice. Say once which ledger it goes to.`, `${at}.hr_key`);
    seen.add(key.toLowerCase());
    return { at, key, ledger_id: finTargetOf(raw.ledger_id, `${at}.ledger_id`, 'Say which ledger the payroll expense goes to, or none.') };
  });
}

// The save as sent, checked for its shape before the database is asked anything: { book_id, channels?, roles?, expense_map?,
// payroll_booking? }. A part left out is left as it is. Within a part, an entry sets one channel, role or key (null takes it away),
// and one not sent is left as it is, so a form may send its whole state back, or only what changed.
function finCleanSetup(input) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const book_id = finIdOf(raw.book_id);
  if (book_id == null) throw finBad('Say which book this is for.', 'book_id');
  const clean = { book_id, channels: null, roles: null, expense: null, payroll_booking: null };
  if (raw.channels !== undefined) clean.channels = finCleanChannels(raw.channels);
  if (raw.roles !== undefined) clean.roles = finCleanRoles(raw.roles);
  if (raw.expense_map !== undefined) clean.expense = finCleanExpense(raw.expense_map);
  if (raw.payroll_booking !== undefined) {
    if (!FIN_PAYROLL_BOOKINGS.includes(raw.payroll_booking)) {
      throw finBad('The payroll month is booked at the month end (month_end) or on the day it is paid (when_paid).', 'payroll_booking');
    }
    clean.payroll_booking = raw.payroll_booking;
  }
  return clean;
}

// A ledger newly pointed at by a channel, a role or an expense key must be switched on (400): a map to a switched-off ledger would only
// turn every later HR entry through it into an exception (FIN_LEDGER_INACTIVE at posting). One mapped before it was switched off is
// left as it is: a save may send it back unchanged, or take it away.
const finSwitchedOff = (name, field) => finBad(
  `${name} is switched off, so HR's entries could not post to it. Switch it on in the chart of accounts first, or choose another ledger.`, field);

// Whether a ledger is no place for staff money (ruling R20a): a bank or cash account (finGroupKinds' is_bank_cash), or a party's
// (finIsPartyLedger, its group's or its link to a customer or vendor). A staff ledger or a salary expense ledger is made system-only
// (R20), which would shut a till, a bank or a party's account to every typed entry, and HR's totals would mix with their own. Asked of
// the four staff roles (FIN_STAFF_ROLES) and every expense key, when a ledger newly takes one; cash_difference has its own guard.
// `ledger` carries group_id and party_type; `kinds` is finGroupKinds' map for its book.
const finNoStaffPlace = (ledger, kinds) => kinds.get(ledger.group_id)?.is_bank_cash === true || finIsPartyLedger(ledger, kinds);

// What the channels sent would change, judged whole: [{ code, was, to }], `was` and `to` each { book_id, ledger_id } or null.
//   • The code is one of HR's pay channels (400).
//   • A channel's account is a bank or cash ledger, judged in the groups of its own book (400): it may be either book's (§7.3).
//   • The book a channel pays from now, and the book it is to pay from, are both books the caller administers (403). A ledger that is
//     not there is the same 403 as one in a book out of reach, so a refusal never says whether another book has a ledger of an id,
//     and nothing about such a ledger (its name, what it is, whether it is switched on) is said before that is asked.
//   • A ledger a channel is newly pointed at is switched on (400, finSwitchedOff).
// An entry that leaves its channel as it is, in a book the caller may read (`mayView`), is passed over before any of that is asked
// (Important 2): a form sends its whole state back, the maps into a book the caller only reads included, and a ledger that has changed
// since it was mapped (switched off, moved out of its group) is no new mapping. A map into a book out of sight is never in what the
// caller read, so one sent as it stands is asked like any change, and refused: the refusal still says nothing of it.
async function finChannelChanges(qc, entries, mayAdminister, mayView) {
  const codes = entries.map(e => e.code);
  const known = new Set((await qc('SELECT code FROM hr.pay_channels WHERE code = ANY($1::text[])', [codes])).map(c => c.code));
  const unknown = entries.find(e => !known.has(e.code));
  if (unknown) throw finBad(`HR has no pay channel called ${unknown.code}. Pay channels are added in HR.`, `${unknown.at}.channel_code`);
  const now = new Map((await qc(
    'SELECT channel_code, book_id, ledger_id FROM fin_hr_channels WHERE channel_code = ANY($1::text[])', [codes])).map(c => [c.channel_code, c]));
  const ledgers = new Map((await qc('SELECT id, book_id, name, group_id, active FROM fin_ledgers WHERE id = ANY($1::int[])',
    [[...new Set(entries.map(e => e.ledger_id).filter(id => id != null))]])).map(l => [l.id, l]));
  const kindsOf = new Map();   // book id -> its group kinds
  const changes = [];
  for (const e of entries) {
    const row = now.get(e.code);
    const was = row ? { book_id: row.book_id, ledger_id: row.ledger_id } : null;
    if ((was?.ledger_id ?? null) === e.ledger_id && (was == null || mayView.has(was.book_id))) continue;
    if (was && !mayAdminister.has(was.book_id)) throw finForbidden(`${e.at}.ledger_id`);
    let to = null;
    if (e.ledger_id != null) {
      const ledger = ledgers.get(e.ledger_id);
      if (!ledger || !mayAdminister.has(ledger.book_id)) throw finForbidden(`${e.at}.ledger_id`);
      if (!kindsOf.has(ledger.book_id)) kindsOf.set(ledger.book_id, await finGroupKinds(qc, ledger.book_id));
      if (kindsOf.get(ledger.book_id).get(ledger.group_id)?.account_kind == null) {
        throw finBad(`${ledger.name} isn't a bank or cash account: an HR pay channel pays from one.`, `${e.at}.ledger_id`);
      }
      if (!ledger.active) throw finSwitchedOff(ledger.name, `${e.at}.ledger_id`);
      to = { book_id: ledger.book_id, ledger_id: ledger.id };
    }
    changes.push({ code: e.code, was, to });
  }
  return changes;
}

// The ledgers of THIS book among `ids`, by id. Another book's ledger and one that is not there are the same answer: not this book's.
async function finBookLedgers(qc, bookId, ids) {
  return new Map((await qc('SELECT id, name, group_id, party_type, active FROM fin_ledgers WHERE book_id = $1 AND id = ANY($2::int[])',
    [bookId, [...new Set(ids.filter(id => id != null))]])).map(l => [l.id, l]));
}

// What the roles sent would change: [{ role, was, to }], ledger ids or null. A role left where it is is passed over, whatever has
// become of its ledger since (Important 2: a form sends its whole state back). A role newly given to a ledger: that ledger is one of
// the book's own (400) and switched on (400, finSwitchedOff); the cash-difference ledger is never a bank or cash account (400): setting
// the role makes its ledger system-only (ruling R10), and a till made system-only would take no typed entry at all; and a staff ledger
// (FIN_STAFF_ROLES) is never a bank, cash or party ledger (400, finNoStaffPlace: ruling R20a).
async function finRoleChanges(qc, bookId, entries) {
  const now = new Map((await qc('SELECT role, ledger_id FROM fin_ledger_roles WHERE book_id = $1', [bookId])).map(r => [r.role, r.ledger_id]));
  const ledgers = await finBookLedgers(qc, bookId, entries.map(e => e.ledger_id));
  let kinds = null;
  const changes = [];
  for (const e of entries) {
    const was = now.get(e.role) ?? null;
    if (was === e.ledger_id) continue;
    if (e.ledger_id != null) {
      const ledger = ledgers.get(e.ledger_id);
      if (!ledger) throw finBad("That ledger isn't one of this book's ledgers.", e.at);
      if (e.role === 'cash_difference') {
        kinds ??= await finGroupKinds(qc, bookId);
        if (kinds.get(ledger.group_id)?.account_kind != null) {
          throw finBad(`Cash differences go to a ledger such as Cash Short & Excess, and ${ledger.name} is a bank or cash account.`, e.at);
        }
      }
      if (FIN_STAFF_ROLES.includes(e.role)) {
        kinds ??= await finGroupKinds(qc, bookId);
        if (finNoStaffPlace(ledger, kinds)) throw finBad(`A staff ledger can't be a bank, cash or party ledger, and ${ledger.name} is one.`, e.at);
      }
      if (!ledger.active) throw finSwitchedOff(ledger.name, e.at);
    }
    changes.push({ role: e.role, was, to: e.ledger_id });
  }
  return changes;
}

// What the expense keys sent would change: [{ key, row, to }], `row` the key's row as it stands (found whatever its capitals) or null,
// `to` a ledger id or null. A key left as it is is passed over (Important 2). A key's ledger is one of the book's own (400), and one a
// key is newly pointed at is no bank, cash or party ledger (400, finNoStaffPlace: ruling R20a) and is switched on (400,
// finSwitchedOff); a key only spelt again in other capitals keeps its ledger, whatever that ledger is now.
async function finExpenseChanges(qc, bookId, entries) {
  const now = new Map((await qc('SELECT id, hr_key, ledger_id FROM fin_hr_expense_map WHERE book_id = $1', [bookId]))
    .map(r => [r.hr_key.toLowerCase(), r]));
  const ledgers = await finBookLedgers(qc, bookId, entries.map(e => e.ledger_id));
  let kinds = null;
  const changes = [];
  for (const e of entries) {
    const row = now.get(e.key.toLowerCase()) ?? null;
    const same = e.ledger_id == null ? row == null : row != null && row.ledger_id === e.ledger_id && row.hr_key === e.key;
    if (same) continue;
    const ledger = e.ledger_id == null ? null : ledgers.get(e.ledger_id);
    if (e.ledger_id != null && !ledger) throw finBad("That ledger isn't one of this book's ledgers.", `${e.at}.ledger_id`);
    if (ledger && row?.ledger_id !== ledger.id) {
      kinds ??= await finGroupKinds(qc, bookId);
      if (finNoStaffPlace(ledger, kinds)) {
        throw finBad(`A salary expense ledger can't be a bank, cash or party ledger, and ${ledger.name} is one.`, `${e.at}.ledger_id`);
      }
      if (!ledger.active) throw finSwitchedOff(ledger.name, `${e.at}.ledger_id`);
    }
    changes.push({ key: e.key, row, to: e.ledger_id });
  }
  return changes;
}

const finPart = (list, keyOf, valueOf) => Object.fromEntries(list.map(item => [keyOf(item), valueOf(item)]));

// The Admin saves the book's HR setup (spec §7.3, §7.8, §7.9): `input` is { book_id, channels: [{ channel_code, ledger_id }],
// roles: { [role]: ledger_id }, expense_map: [{ hr_key, ledger_id }], payroll_booking }, any part left out (finCleanSetup). `actor` is
// { id, name, adminBookIds, seeBookIds }: the books the caller administers and the books it may read, which the route works out. A
// channel may point only at, or move only away from, the administered books' ledgers; an entry that changes nothing is passed over
// when its book is one the caller may read, so the whole state a read gave may be sent back (Important 2). Everything sent is checked
// before the first write, so a refusal writes nothing:
//   400 FIN_BAD_INPUT  the shape; a channel HR doesn't have; a channel's account that is no bank or cash account; a role's or a key's
//                      ledger that is not the book's own; a bank or cash account as the cash-difference ledger; a switched-off ledger
//                      newly pointed at by a channel, a role or a key (one mapped before it was switched off stays: finSwitchedOff)
//   403 FIN_FORBIDDEN  a channel pointed at, or moved away from, a book the caller does not administer, or one sent as it stands
//                      into a book the caller cannot read
// A ledger that newly takes a system-only role (FIN_SYSTEM_ONLY_ROLES: cash_difference, ledger ruling R10; the four staff roles, R20),
// or newly becomes an expense key's ledger (R20), is made system-only through finUpdateLedger, which writes that ledger's own edit row
// as any flag change does. Moving a role or a key to another ledger leaves the old one's flag as it is, and a save that leaves the role
// or the key where it is does not set the flag again: the Admin may switch a ledger back in the chart of accounts, and it stays so.
// Returns { changed }: whether anything was written.
export async function finSaveHrSetup(qc, oc, input, actor) {
  const by = finWho(actor);
  const ask = finCleanSetup(input);
  const book = await finLockBook(oc, ask.book_id);
  const mayAdminister = new Set([book.id, ...finBookIds(actor?.adminBookIds)]);
  const mayView = new Set([...mayAdminister, ...finBookIds(actor?.seeBookIds)]);   // an admin of a book may read it

  let channels = [];
  if (ask.channels) {
    await qc('SELECT pg_advisory_xact_lock($1::int, $2::int)', [...FIN_CHANNEL_MAP_LOCK]);
    channels = await finChannelChanges(qc, ask.channels, mayAdminister, mayView);
  }
  const roles = ask.roles ? await finRoleChanges(qc, book.id, ask.roles) : [];
  const expense = ask.expense ? await finExpenseChanges(qc, book.id, ask.expense) : [];
  let payroll = null;
  if (ask.payroll_booking) {
    const now = (await qc('SELECT payroll_booking FROM fin_book_settings WHERE book_id = $1', [book.id]))[0]?.payroll_booking ?? 'month_end';
    if (now !== ask.payroll_booking) payroll = { was: now, to: ask.payroll_booking };
  }
  if (!channels.length && !roles.length && !expense.length && !payroll) return { changed: false };

  for (const c of channels) {
    if (c.to == null) await qc('DELETE FROM fin_hr_channels WHERE channel_code = $1', [c.code]);
    else {
      await qc(
        `INSERT INTO fin_hr_channels (channel_code, book_id, ledger_id) VALUES ($1, $2, $3)
         ON CONFLICT (channel_code) DO UPDATE SET book_id = EXCLUDED.book_id, ledger_id = EXCLUDED.ledger_id`,
        [c.code, c.to.book_id, c.to.ledger_id]);
    }
  }
  for (const r of roles) {
    if (r.to == null) await qc('DELETE FROM fin_ledger_roles WHERE book_id = $1 AND role = $2', [book.id, r.role]);
    else {
      await qc(
        `INSERT INTO fin_ledger_roles (book_id, role, ledger_id) VALUES ($1, $2, $3)
         ON CONFLICT (book_id, role) DO UPDATE SET ledger_id = EXCLUDED.ledger_id`, [book.id, r.role, r.to]);
    }
  }
  for (const x of expense) {
    if (x.to == null) await qc('DELETE FROM fin_hr_expense_map WHERE id = $1', [x.row.id]);
    else if (x.row) await qc('UPDATE fin_hr_expense_map SET hr_key = $2, ledger_id = $3 WHERE id = $1', [x.row.id, x.key, x.to]);
    else await qc('INSERT INTO fin_hr_expense_map (book_id, hr_key, ledger_id) VALUES ($1, $2, $3)', [book.id, x.key, x.to]);
  }
  if (payroll) {
    await qc(
      `INSERT INTO fin_book_settings (book_id, payroll_booking, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (book_id) DO UPDATE SET payroll_booking = EXCLUDED.payroll_booking, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [book.id, payroll.to, by.name]);
  }
  // Rulings R10 and R20: a ledger that newly takes a system-only role (cash_difference: only a cash count's clearing reaches it; the
  // staff ledgers: only HR's entries), or newly becomes an expense key's ledger, takes no typed entry from now on. A key spelt again
  // in other capitals keeps its ledger, so that is no move.
  await finMakeSystemOnly(qc, oc, [
    ...roles.filter(r => r.to != null && FIN_SYSTEM_ONLY_ROLES.includes(r.role)).map(r => r.to),
    ...expense.filter(x => x.to != null && x.row?.ledger_id !== x.to).map(x => x.to),
  ], by);

  // The log row holds what changed and nothing else, keyed by channel code, role and expense key.
  const before = { name: book.name };
  const after = { name: book.name };
  if (channels.length) {
    before.channels = finPart(channels, c => c.code, c => c.was);
    after.channels = finPart(channels, c => c.code, c => c.to);
  }
  if (roles.length) {
    before.roles = finPart(roles, r => r.role, r => r.was);
    after.roles = finPart(roles, r => r.role, r => r.to);
  }
  if (expense.length) {
    before.expense_map = finPart(expense, x => x.row?.hr_key ?? x.key, x => x.row?.ledger_id ?? null);
    after.expense_map = finPart(expense, x => x.key, x => x.to);
  }
  if (payroll) {
    before.payroll_booking = payroll.was;
    after.payroll_booking = payroll.to;
  }
  await finAudit(qc, { bookId: book.id, entity: 'book', entityId: book.id, action: 'hr_setup', userId: by.id, userName: by.name, before, after });

  // Every other book a channel now pays from, or paid from: its own row, with those channels alone.
  const touched = new Map();   // other book id -> the channels that touch it
  for (const c of channels) {
    for (const side of [c.was, c.to]) {
      if (side && side.book_id !== book.id) {
        if (!touched.has(side.book_id)) touched.set(side.book_id, []);
        if (!touched.get(side.book_id).includes(c)) touched.get(side.book_id).push(c);
      }
    }
  }
  for (const [otherId, list] of touched) {
    const other = await oc('SELECT id, name FROM fin_books WHERE id = $1', [otherId]);
    await finAudit(qc, {
      bookId: other.id, entity: 'book', entityId: other.id, action: 'hr_setup', userId: by.id, userName: by.name,
      before: { name: other.name, channels: finPart(list, c => c.code, c => c.was) },
      after: { name: other.name, channels: finPart(list, c => c.code, c => c.to) },
    });
  }
  return { changed: true };
}

// ── The staff ledgers ────────────────────────────────────────────────────────────────────────

// Give a book its staff ledgers (spec §7.2; plan, Global Constraints; ruling R20): for each of FIN_STAFF_LEDGERS' roles the book does
// not have yet, the ledger of its name if the book has one (capitals aside), left in the group it is filed under, as a Tally import
// makes it; else a new one under its group (finCreateLedger). The ledger then takes the role, and each of the four staff ledgers, made
// or found, is made system-only (finMakeSystemOnly, its own edit row): Finance's staff ledgers must never take a typed journal, or they
// would drift from HR's totals (§7.2). MD's Account keeps its flags. A role the book has already, the accountant's own pick or one made
// before, is left exactly as it is, its ledger's flags too, so a second call makes nothing and writes nothing. Judged whole before
// anything is written: a ledger of the name that is switched off (R20), or one of the four that is a bank, cash or party ledger
// (finNoStaffPlace, R20a), is never given the role, and the call is refused (400 FIN_BAD_INPUT, naming it) with nothing made. The
// route has asked for the admin capability on the book. Returns { created, found, system_only }, each a list of names in
// FIN_STAFF_LEDGERS' order: the ledgers made; the ledgers found by their name and given their role (Task 15 fix round, F1: a call that
// made nothing may still have moved up to five roles); and the ledgers this call keeps for the system's entries, made or found (the
// four staff ledgers among them), which take no typed entry from now on. A book with every role set gives three empty lists.
export async function finEnsureStaffLedgers(qc, oc, bookId, actor) {
  const by = finWho(actor);
  const id = finIdOf(bookId);
  if (id == null) throw finBad('Say which book this is for.', 'book_id');
  const book = await finLockBook(oc, id);
  const roles = new Map((await qc('SELECT role, ledger_id FROM fin_ledger_roles WHERE book_id = $1', [book.id])).map(r => [r.role, r.ledger_id]));
  const missing = FIN_STAFF_LEDGERS.filter(s => !roles.has(s.role));
  if (!missing.length) return { created: [], found: [], system_only: [] };

  const byName = new Map((await qc('SELECT id, name, group_id, party_type, active FROM fin_ledgers WHERE book_id = $1', [book.id]))
    .map(l => [l.name.toLowerCase(), l]));
  const groups = new Map((await qc('SELECT id, name FROM fin_groups WHERE book_id = $1', [book.id])).map(g => [g.name.toLowerCase(), g.id]));
  const plan = missing.map(s => ({ s, found: byName.get(s.name.toLowerCase()) ?? null }));
  const off = plan.find(p => p.found && !p.found.active);
  if (off) throw finBad(`Switch '${off.found.name}' back on, or rename it, before creating the staff ledgers.`);
  const kinds = await finGroupKinds(qc, book.id);
  const misfiled = plan.find(p => p.found && FIN_STAFF_ROLES.includes(p.s.role) && finNoStaffPlace(p.found, kinds));
  if (misfiled) {
    throw finBad(`A staff ledger can't be a bank, cash or party ledger, and '${misfiled.found.name}' is one: file it elsewhere, or rename it, `
      + 'before creating the staff ledgers.');
  }
  const homeless = plan.find(p => !p.found && !groups.has(p.s.group.toLowerCase()));
  if (homeless) throw new Error(`${book.name} has no group called ${homeless.s.group}: its groups are Tally's template, and that one is in it`);

  const created = [];
  const found = [];
  const set = {};
  for (const p of plan) {
    set[p.s.role] = p.found ? p.found.id : (await finCreateLedger(qc, oc, { book_id: book.id, group_id: groups.get(p.s.group.toLowerCase()), name: p.s.name }, by)).id;
    (p.found ? found : created).push(p.found ? p.found.name : p.s.name);
  }
  const kept = plan.filter(p => FIN_SYSTEM_ONLY_ROLES.includes(p.s.role));
  await finMakeSystemOnly(qc, oc, kept.map(p => set[p.s.role]), by);
  for (const { s } of plan) await qc('INSERT INTO fin_ledger_roles (book_id, role, ledger_id) VALUES ($1, $2, $3)', [book.id, s.role, set[s.role]]);
  await finAudit(qc, {
    bookId: book.id, entity: 'book', entityId: book.id, action: 'hr_setup', userId: by.id, userName: by.name,
    before: { name: book.name, roles: finPart(missing, s => s.role, () => null) },
    after: { name: book.name, roles: set, created, found },
  });
  return { created, found, system_only: kept.map(p => (p.found ? p.found.name : p.s.name)) };
}

// ── Paid from (spec §7.3) ────────────────────────────────────────────────────────────────────

// The "paid from" list HR's doors offer (Pay staff, Give advance, New loan; Prepay's "received into"; an advance sheet's paid via): the
// spec's list, "office cash, each holder, and the mapped banks" (§7.3; ruling R17), one entry per account, each `fin:<ledger id>`,
// names only and never a balance: [{ code, label }].
//   • Every switched-on Cash-in-Hand ledger of the CI book (FIN_PAYROLL_BOOK, where HR's own payouts are kept): office cash and the
//     other cash ledgers by name, then each holder, labelled "Holder · <holder_name>". These are offered whether or not the CASH
//     channel is mapped yet: HR is never held up by Finance's setup (§7.7).
//   • Every switched-on bank ledger that some HR pay channel pays from (fin_hr_channels), in either book, once however many channels
//     pay from it, whether or not HR still uses the channel: CI's by name, then the other book's, labelled "<ledger> · <its book>" so
//     a Darbi Print Pack bank reads as Darbi Print Pack's. A bank no channel pays from is not offered.
// `cash` and the channel codes are no options of their own: each names an account listed here. finResolvePaidFrom still takes them,
// as older HR rows store them. `qc` is any query function: the pool's q, or a transaction's qc.
export async function finPaidFromOptions(qc) {
  const book = (await qc('SELECT id FROM fin_books WHERE code = $1', [FIN_PAYROLL_BOOK]))[0] ?? null;
  const kindsOf = new Map();   // book id -> its group kinds
  const kindOf = async (bookId, groupId) => {
    if (!kindsOf.has(bookId)) kindsOf.set(bookId, await finGroupKinds(qc, bookId));
    return kindsOf.get(bookId).get(groupId)?.account_kind ?? null;
  };
  const byLabel = (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id - b.id;

  const cash = [];
  if (book) {
    for (const l of await qc('SELECT id, name, group_id, holder_name FROM fin_ledgers WHERE book_id = $1 AND active', [book.id])) {
      if (await kindOf(book.id, l.group_id) !== 'cash') continue;
      cash.push({ id: l.id, holder: l.holder_name != null, label: l.holder_name != null ? `Holder · ${l.holder_name}` : l.name });
    }
  }
  const banks = [];
  const mapped = await qc(
    `SELECT DISTINCT l.id, l.name, l.group_id, l.book_id, b.name AS book_name
       FROM fin_hr_channels c
       JOIN fin_ledgers l ON l.id = c.ledger_id AND l.book_id = c.book_id
       JOIN fin_books b ON b.id = l.book_id
      WHERE l.active`);
  for (const l of mapped) {
    if (await kindOf(l.book_id, l.group_id) !== 'bank') continue;
    const own = l.book_id === book?.id;
    banks.push({ id: l.id, own, label: own ? l.name : `${l.name} · ${l.book_name}` });
  }
  cash.sort((a, b) => Number(a.holder) - Number(b.holder) || byLabel(a, b));
  banks.sort((a, b) => Number(b.own) - Number(a.own) || byLabel(a, b));
  return [...cash, ...banks].map(a => ({ code: `fin:${a.id}`, label: a.label }));
}

// Whether Finance offers HR any account to name now (ruling R47): finPaidFromOptions lists at least one. While it lists none (its books
// are not set up yet), or the list cannot be read at all, nothing of Finance's holds HR up (§7.7): a door that would ask for a code takes
// a missing one as `cash`, which Finance resolves once it has its accounts (R19, the channel map). Asked with the pool's q, before HR's
// transaction: a read that fails inside one would abort it.
export async function finOffersPaidFrom(qx) {
  try {
    return (await finPaidFromOptions(qx)).length > 0;
  } catch {
    return false;
  }
}

// Whether `code` is a "paid from" choice an HR door may store (§7.3; Task 9's M3): `cash`, the code of one of HR's pay channels, or a
// `fin:<ledger id>` that finPaidFromOptions lists, read through `qc` (the door's own transaction). A door takes only what it offers:
// finResolvePaidFrom takes more (any bank or cash ledger), for the codes HR's older rows already hold. `cash` and a channel code are HR's
// own, so they ask nothing of Finance.
export async function finIsPaidFromChoice(qc, code) {
  if (typeof code !== 'string' || code === '') return false;
  if (code === 'cash') return true;
  if (code.startsWith('fin:')) return (await finPaidFromOptions(qc)).some(o => o.code === code);
  return (await qc('SELECT 1 AS one FROM hr.pay_channels WHERE code = $1', [code])).length > 0;
}

// The channel map's account for a channel code: { book_id, ledger_id }, or null when the channel pays from nothing yet. CASH with no
// row of its own pays from office cash, by default (finCashDefault, ruling R19).
async function finChannelAccount(qc, code) {
  const row = (await qc('SELECT book_id, ledger_id FROM fin_hr_channels WHERE channel_code = $1', [code]))[0];
  if (row) return row;
  return code === FIN_CASH_CHANNEL ? finCashDefault(qc) : null;
}

// The account an HR payout came from, or went into (§7.3): { book_id, ledger_id }, or null when there is none to name, which the HR
// feed records as an unmapped channel (FIN_UNMAPPED_CHANNEL) and posts once the channel is mapped.
//   • `fin:<id>`      that ledger, when it is a bank or cash ledger; any other ledger is no account to pay from, so nothing;
//   • `cash`          the CASH channel's account: its row, else office cash by default (finCashDefault, ruling R19);
//   • a channel code  that channel's account (CASH's as `cash` is);
//   • null            `channelCode`'s account: a payout that named no account came from its channel's (a batch of a bank channel).
// What is found is the map as it stands when it is asked: the account is resolved when the event posts.
export async function finResolvePaidFrom(qc, code, channelCode) {
  if (code == null) return channelCode == null ? null : finChannelAccount(qc, channelCode);
  if (typeof code !== 'string') return null;
  if (code === 'cash') return finChannelAccount(qc, FIN_CASH_CHANNEL);
  if (code.startsWith('fin:')) {
    const id = /^fin:[0-9]{1,10}$/.test(code) ? finIdOf(code.slice(4)) : null;
    const ledger = id == null ? null : (await qc('SELECT id, book_id, group_id FROM fin_ledgers WHERE id = $1', [id]))[0];
    if (!ledger) return null;
    const kind = (await finGroupKinds(qc, ledger.book_id)).get(ledger.group_id)?.account_kind ?? null;
    return kind == null ? null : { book_id: ledger.book_id, ledger_id: ledger.id };
  }
  return finChannelAccount(qc, code);
}

// What kind of account a paid-from code names (ruling R43; HR's monthly schedule splits its money into cash and bank by it):
// 'cash' or 'bank', the kind of the group of the ledger finResolvePaidFrom finds for the code, or null when it names no account
// (no channel is fallen back on). `qc` is any query function.
export async function finPaidFromKind(qc, code) {
  const account = await finResolvePaidFrom(qc, code, null);
  if (!account) return null;
  const ledger = (await qc('SELECT group_id FROM fin_ledgers WHERE id = $1', [account.ledger_id]))[0];
  const kind = ledger ? (await finGroupKinds(qc, account.book_id)).get(ledger.group_id)?.account_kind ?? null : null;
  return kind === 'cash' || kind === 'bank' ? kind : null;
}

// ── The Tally import (spec §7.9) ─────────────────────────────────────────────────────────────

// The ledgers of a book that may stand for a Tally ledger per person (FIN_PER_PERSON_ROLES), as a Set of ids, read through `qx`.
export async function finPerPersonLedgerIds(qx, bookId) {
  const rows = await qx('SELECT ledger_id FROM fin_ledger_roles WHERE book_id = $1 AND role = ANY($2::text[])', [bookId, FIN_PER_PERSON_ROLES]);
  return new Set(rows.map(r => r.ledger_id));
}
