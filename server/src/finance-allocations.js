// Finance — bill-wise adjustment (Cash & Bank spec §6). A party's posted lines are its items: for a customer, the debits are
// what it owes (an opening bill, an opening lump, later an invoice) and the credits settle them (a receipt, later a credit
// note); a vendor is the mirror image. An allocation (fin_allocations) pairs a debit item and a credit item of one party ledger
// with an amount. It changes no balance, only which items are open:
//   • a receipt or a payment settles bills as it posts, by the plan its draft carries (finApplyPlan, which finPostLocked calls):
//     Auto, oldest first, or Pick, the bills ticked (client/src/lib/finance/allocation.js, which the screen shares);
//   • an accountant redoes a line's adjustment later, Auto or Pick, in a month of any status (finRedoAllocations): the whole line again
//     (a Redo, from the book), or only the money it still holds on account, keeping what it settles already (an Adjust, from the
//     Unadjusted money list: ruling R71), which may settle more of a bill the line part-settles, on the same allocation (R76);
//   • a reversal releases what the entry it reverses settled, so its bills are open again (finReleaseAllocations, which
//     finPostLocked calls);
// and, for every party ledger, Σ outstanding − Σ on account is the ledger's balance (finPartyCheck, finPartyFigures). Across a
// book it also answers the Cash & Bank screen (finance-cash.js): the party money still on account, counted and listed
// (finOnAccountSummary, finOnAccountItems), what a book's entries settled (finSettledOf), and what a redo of a line would work
// against, for the preview before it is saved (finRedoPreviewOf).
//
// Never a refusal for not matching (spec §2 G2, §3). A plan is worked out again as it posts, under the party lock, against the
// items open then: a bill settled or reversed since the plan was written is not offered (Auto passes it by, a Pick of it is
// dropped), and money with nowhere to go stays on account. A plan that names no party line of a live voucher settles nothing.
//
// Items (spec §6.1): every posted line on a party ledger, of a live voucher (ruling R9): one not reversed, at an even depth in
// its reversal chain. An entry that reverses nothing is at depth 0, its reversal at 1, and a reversal of that reversal at 2,
// which puts the entry back, so its lines are items again; a plain reversal's never are. fin_allocation_guard holds the same
// rule (migration 20261121090100), and both find the depth by walking reversal_of_id. Each goes out as
// the pure allocators take an Item (line_id, date, due_date, bill_ref, is_opening_lump, open_paise), and, for the screens, with
// its voucher, number, label and amount. The label is its bill_ref; "Opening balance" for an opening line without one;
// otherwise its voucher's number. Its date is its bill_date, or else its voucher's date. The opening lump is a line of the
// Opening (or of an opening correction, spec §9.4) with no bill_ref, which Auto settles first (spec §9.3). What is open is
// worked out in SQL: the line's amount less its allocations.
//
// Locks: the party-lock protocol (ruling R7; the comment above fin_allocation_guard in migration 20261121090100 says why). The
// guard and the sum check order nothing; the party lock, pg_advisory_xact_lock(7300, <party ledger id>), does:
//   1. every write to fin_allocations is made under the lock of its party ledger: apply, redo and release each take it here,
//      and a transaction that holds it already (finPostLocked) takes nothing new, since an advisory lock a transaction holds is
//      its own to take again;
//   2. a posting takes the lock of every party ledger among its own lines, in ascending id, right after the voucher lock
//      (finLockPartiesOf, from finPostLocked's first statement, and from finSubmitVoucher before it reads its months): series →
//      voucher → party → months → ledgers. A reversal's lines mirror the original's, so a reversal and an allocation onto the
//      original wait for one another, even one written while the original had none;
//   3. a reversal releases the original's allocations after marking it reversed, under those locks.
// Whichever takes a party's lock second reads what the first committed (READ COMMITTED: each statement after the lock reads
// afresh). So two postings never spend one bill twice, an allocation that comes after a reversal is never offered the reversed
// bill, and one that came before is released by it. A redo posts nothing and takes the party lock alone. Nothing here takes a
// row lock on a voucher, a month or a ledger.
//
// The writes take the qc / oc of the transaction their caller opened, and append their finAudit row in it (entity
// 'allocation', entity_id the voucher whose line's allocations changed): apply, redo (with before and after) and release. The
// reads take a qc too, which may be the pool's q, outside any transaction.
//
// Amounts are whole paise in JS and NUMERIC in the database, written with finFromPaise.
//
// This module and finance-vouchers.js import one another: a posting calls the engine, and the engine asks the one group walk
// (finGroupKinds, finIsPartyLedger) what a party ledger is. Neither reads the other's bindings while it loads, only when called.

import { finAudit } from './finance-audit.js';
import { finError } from './finance-errors.js';
import { finIdOf } from './finance-masters.js';
import { finGroupKinds, finIsPartyLedger, finPartySide } from './finance-vouchers.js';
import { finAutoAllocate, finItemOrder, finPickAllocate } from '../../client/src/lib/finance/allocation.js';
import { finFromPaise, finToPaise } from '../../client/src/lib/finance/money.js';

// The party locks' advisory-lock namespace: pg_advisory_xact_lock(7300, <party ledger id>).
export const FIN_ALLOC_LOCK_NS = 7300;
const FIN_ALLOC_MODES = Object.freeze(['auto', 'pick']);
// What a redo of a line works on (ruling R71): `line`, the whole line again, its allocations released first (a Redo, from the book: the
// default, as the route has always been); `open`, only what the line still holds on account, its allocations kept (an Adjust, from the
// Unadjusted money list).
const FIN_ADJUST_SCOPES = Object.freeze(['line', 'open']);
const FIN_PICKS_MAX = 5000;          // ticks in one redo, as many rows as the day book sends in one answer

const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});
const finNotPartyLine = message => finError(409, 'FIN_NOT_PARTY_LINE', message);

// Who is acting. An adjustment is in someone's name, as every Finance write is.
function finWho(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!Number.isSafeInteger(actor?.id) || !name) throw new Error('An adjustment needs to know who is acting: pass { id, name }');
  return { id: actor.id, name };
}

// ── The party lock (ruling R7) ───────────────────────────────────────────────────────────────

// One party ledger's lock, held until the transaction ends.
export async function finPartyLock(oc, ledgerId) {
  await oc('SELECT pg_advisory_xact_lock($1::int, $2::int)', [FIN_ALLOC_LOCK_NS, ledgerId]);
}

// The party ledgers among a voucher's own lines, by the one definition (finIsPartyLedger). Read without locks: the voucher is
// held FOR UPDATE by the caller, so its lines stand still, and the ledgers are locked later, in their place in the order.
async function finPartyLedgersOf(qc, voucherId) {
  const ledgers = await qc(
    `SELECT DISTINCT fl.id, fl.book_id, fl.group_id, fl.party_type
       FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id
      WHERE l.voucher_id = $1`, [voucherId]);
  if (!ledgers.length) return [];
  const kinds = await finGroupKinds(qc, ledgers[0].book_id);
  return ledgers.filter(ledger => finIsPartyLedger(ledger, kinds)).map(ledger => ledger.id).sort((a, b) => a - b);
}

// Rule 2: the locks of every party ledger among a voucher's own lines, in ascending id, in one statement (the Opening holds a
// line for every party). Returns their ids, which may be none.
export async function finLockPartiesOf(qc, oc, voucherId) {
  const ids = await finPartyLedgersOf(qc, voucherId);
  if (ids.length) {
    await qc('SELECT pg_advisory_xact_lock($1::int, p.id) FROM (SELECT DISTINCT unnest($2::int[]) AS id ORDER BY id) p',
      [FIN_ALLOC_LOCK_NS, ids]);
  }
  return ids;
}

// ── Items (spec §6.1) ────────────────────────────────────────────────────────────────────────

// A party ledger as the engine needs it, { id, book_id, name, side }, or null for a ledger that is no party's, or no ledger.
// Its side is the party group it is filed under (finGroupKinds: customers under Sundry Debtors, vendors under Sundry
// Creditors), or, for a ledger linked to an ERP customer or vendor but filed elsewhere, that link.
async function finPartyOf(qc, ledgerId) {
  const ledger = (await qc('SELECT id, book_id, name, group_id, party_type FROM fin_ledgers WHERE id = $1', [ledgerId]))[0];
  if (!ledger) return null;
  const kinds = await finGroupKinds(qc, ledger.book_id);
  if (!finIsPartyLedger(ledger, kinds)) return null;
  return { id: ledger.id, book_id: ledger.book_id, name: ledger.name, side: finPartySide(ledger, kinds) };
}

// A book's party groups, by the one walk (finGroupKinds), as the id lists the book-wide reads below hand to SQL: every group
// under Sundry Debtors or Sundry Creditors (`party`), and of those the customers' and the vendors' (party_side). In SQL a ledger
// is then a party's, and on a side, exactly as finIsPartyLedger and finPartySide say: by its group, else by its ERP link.
function finPartyGroups(kinds) {
  const ids = side => [...kinds].filter(([, k]) => k.party_side === side).map(([id]) => id);
  const customer = ids('customer');
  const vendor = ids('vendor');
  return { party: [...customer, ...vendor], customer, vendor };
}

// The live vouchers among those `start` names (ruling R9): posted, not reversed, and at an even depth in their reversal chain,
// walked up reversal_of_id to the entry that reverses nothing (the chain's end, where `up` is null). A chain that has not ended
// within 1000 steps has no end here, so its voucher is not live, as fin_allocation_guard refuses it too. A chain of posted
// reversals always ends: each voucher in it is marked reversed by the next, and a mark is made once (H3, H11).
const finLiveSql = start => `
  WITH RECURSIVE chain AS (
    SELECT v.id AS voucher_id, v.reversal_of_id AS up, 0 AS depth
      FROM fin_vouchers v
     WHERE v.status = 'posted' AND v.reversed_by_id IS NULL AND ${start}
    UNION ALL
    SELECT c.voucher_id, o.reversal_of_id, c.depth + 1
      FROM chain c JOIN fin_vouchers o ON o.id = c.up
     WHERE c.depth < 1000
  )
  SELECT c.voucher_id FROM chain c WHERE c.up IS NULL AND c.depth % 2 = 0`;
const FIN_LIVE_ON_LEDGER_SQL = finLiveSql('v.id IN (SELECT l.voucher_id FROM fin_voucher_lines l WHERE l.ledger_id = $1)');
const FIN_LIVE_VOUCHER_SQL = finLiveSql('v.id = $1');

// Whether a voucher is live (ruling R9), its party lines items.
const finIsLive = async (qc, voucherId) => (await qc(FIN_LIVE_VOUCHER_SQL, [voucherId])).length === 1;

// A ledger's items, each with what is still open of it: its amount less its allocations, on its own side. `releasing` is for a redo's
// preview (finRedoPreviewOf): every allocation that pairs an item with line $2 is left out of what settles it, as if the redo had
// deleted them already, so the bills that line settles are open again and the line itself is open in full.
const finItemsSql = (releasing = false) => {
  const kept = releasing ? ' AND $2::int NOT IN (a.debit_line_id, a.credit_line_id)' : '';
  return `
  SELECT l.id AS line_id, l.voucher_id, v.number, v.voucher_date, l.bill_ref, l.bill_date, l.due_date, l.debit > 0 AS is_debit,
         (v.voucher_type = 'opening' OR v.is_opening_correction) AS is_opening, l.debit + l.credit AS amount,
         l.debit + l.credit - CASE WHEN l.debit > 0
           THEN (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.debit_line_id = l.id${kept})
           ELSE (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.credit_line_id = l.id${kept}) END AS open
    FROM fin_voucher_lines l
    JOIN fin_vouchers v ON v.id = l.voucher_id
   WHERE l.ledger_id = $1 AND v.id IN (${FIN_LIVE_ON_LEDGER_SQL})`;
};
const FIN_ITEMS_SQL = finItemsSql();
const FIN_ITEMS_RELEASING_SQL = finItemsSql(true);

// An item as it goes out. is_opening_lump is a real boolean: the allocators compare it strictly.
function finItemOut(row) {
  const bill_ref = typeof row.bill_ref === 'string' && row.bill_ref.trim() ? row.bill_ref : null;
  return {
    line_id: row.line_id, date: row.bill_date ?? row.voucher_date, due_date: row.due_date ?? null, bill_ref,
    is_opening_lump: row.is_opening === true && bill_ref === null, open_paise: finToPaise(row.open),
    voucher_id: row.voucher_id, number: row.number, label: bill_ref ?? (row.is_opening ? 'Opening balance' : row.number),
    amount_paise: finToPaise(row.amount),
  };
}

// A ledger's open items, { debits, credits }, each list in Auto's order (finItemOrder).
async function finItemsOf(qc, ledgerId) {
  const debits = [];
  const credits = [];
  for (const row of await qc(`SELECT * FROM (${FIN_ITEMS_SQL}) i WHERE i.open > 0`, [ledgerId])) {
    (row.is_debit ? debits : credits).push(finItemOut(row));
  }
  return { debits: debits.sort(finItemOrder), credits: credits.sort(finItemOrder) };
}

// A ledger's open items and its balance, in ONE statement, so both come from one snapshot: read as two, a posting that commits
// between them would show its line in the balance and not among the items (or the other way round), and a party report read
// through the pool would say for a moment that the invariant fails. `items` is FIN_ITEMS_SQL's rows with something open, as
// JSON; `net` is every posted line of the ledger, debit less credit.
const FIN_OPEN_SQL = `
  SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]'::jsonb) FROM (${FIN_ITEMS_SQL}) i WHERE i.open > 0) AS items,
         (SELECT COALESCE(sum(l.debit - l.credit), 0)
            FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id
           WHERE l.ledger_id = $1 AND v.status = 'posted') AS net`;

// A party's open items: { ledger_id, side, balance_paise, debits, credits }. balance_paise is what a customer owes (its
// debits less its credits) or what is owed to a vendor (the mirror image), from every posted line of the ledger; the items and
// the balance are read in one statement (FIN_OPEN_SQL). A ledger that is no party's is refused, 409 FIN_NOT_PARTY_LINE.
export async function finOpenItems(qc, ledgerId) {
  const id = finIdOf(ledgerId);
  const party = id == null ? null : await finPartyOf(qc, id);
  if (!party) throw finNotPartyLine("That isn't a party's ledger: only a customer's or a vendor's has bills to adjust.");
  const row = (await qc(FIN_OPEN_SQL, [id]))[0];
  const debits = [];
  const credits = [];
  for (const item of row.items) (item.is_debit ? debits : credits).push(finItemOut(item));
  const net = finToPaise(row.net);
  return {
    ledger_id: id, side: party.side, balance_paise: party.side === 'vendor' ? 0 - net : net,
    debits: debits.sort(finItemOrder), credits: credits.sort(finItemOrder),
  };
}

// What a redo would work on (ruling R71), as a person asks for it with a redo or its preview: 'line' (the default) or 'open'. Anything
// else is refused, 400 FIN_BAD_INPUT, naming the scope.
export function finAdjustScope(raw) {
  if (raw == null) return 'line';
  if (!FIN_ADJUST_SCOPES.includes(raw)) {
    throw finBad("Say what to adjust: line, the whole entry again, or open, only its money still on account.", 'scope');
  }
  return raw;
}

// What a redo of one of a party's lines would work against (spec §6.5), read before anything is written, for the Cash & Bank
// screen's preview of a Redo or an Adjust: { side, money_paise, against }. `side` is the line's own ('debit' or 'credit'). With
// `scope` 'line' (a Redo), `money_paise` is all of the line, which is what a redo settles again once it has deleted the line's
// allocations, and `against` the other side's open items with those allocations released (FIN_ITEMS_RELEASING_SQL: the bills the
// line settles now are open again); with 'open' (an Adjust, ruling R71), `money_paise` is what the line still holds on account, its
// allocations kept, and `against` the other side's open items as they stand. Either in Auto's order. Anything that is not a posted
// line of a live voucher (ruling R9) on `ledgerId`, a party's ledger, is refused 409 FIN_NOT_PARTY_LINE, whether the line exists or
// not, so the answer never says whether a line of another ledger or book is there. No lock: a preview; the redo works it out again
// under the party lock (finRedoAllocations).
export async function finRedoPreviewOf(qc, ledgerId, lineId, { scope = 'line' } = {}) {
  const party = await finPartyOf(qc, ledgerId);
  const line = (await qc('SELECT id, ledger_id, voucher_id, debit, credit FROM fin_voucher_lines WHERE id = $1', [lineId]))[0];
  if (!party || !line || line.ledger_id !== party.id || !(await finIsLive(qc, line.voucher_id))) throw finNotPartyLine();
  const isDebit = finToPaise(line.debit) > 0;
  const side = isDebit ? 'debit' : 'credit';
  if (scope === 'open') {
    const { debits, credits } = await finItemsOf(qc, party.id);
    const own = (isDebit ? debits : credits).find(item => item.line_id === line.id);
    return { side, money_paise: own ? own.open_paise : 0, against: isDebit ? credits : debits };
  }
  const rows = await qc(`SELECT * FROM (${FIN_ITEMS_RELEASING_SQL}) i WHERE i.open > 0 AND i.is_debit = $3`, [party.id, line.id, !isDebit]);
  return {
    side, money_paise: finToPaise(line.debit) + finToPaise(line.credit),
    against: rows.map(finItemOut).sort(finItemOrder),
  };
}

// The invariant's figures for a party, from its open items as finOpenItems read them (spec §6.2, §6.7): for a customer,
// Σ outstanding (its open debits) − Σ on account (its open credits) is its balance, debit positive; for a vendor the mirror
// image, credit positive. It holds by construction, an allocation counting once on each side; ok is whether it does. PURE, so a
// report that lists the items says the figures of the very same read.
export function finPartyFigures({ side, balance_paise, debits, credits }) {
  const total = items => items.reduce((sum, item) => sum + item.open_paise, 0);
  const [owed, held] = side === 'vendor' ? [credits, debits] : [debits, credits];
  const outstanding_paise = total(owed);
  const on_account_paise = total(held);
  return { outstanding_paise, on_account_paise, balance_paise, ok: outstanding_paise - on_account_paise === balance_paise };
}

// The invariant (spec §6.2) for one party ledger, read now. An entry and its reversal net to nothing in the balance and neither
// is an item; a reversal of that reversal puts the entry back, in the balance and as an item alike (ruling R9).
export async function finPartyCheck(qc, ledgerId) {
  return finPartyFigures(await finOpenItems(qc, ledgerId));
}

// ── Settling (spec §6.3, §6.4) ───────────────────────────────────────────────────────────────

// The picks of a stored plan, as the allocator takes them: each { line_id, amount_paise }, the amount whole paise above
// nothing, or null for all that is open. Anything else in a plan is dropped and never refused: a plan is the screen's
// proposal, and the allocator caps each pick at what is open and at the money left.
function finPlanPicks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(p => {
    const line_id = finIdOf(p?.line_id);
    const amount = p?.amount_paise ?? null;
    return line_id != null && (amount === null || (Number.isSafeInteger(amount) && amount > 0)) ? [{ line_id, amount_paise: amount }] : [];
  });
}

// A voucher's stored plan as the engine reads it: { line_no, mode, picks }, line_no null when it names no line, mode null when it
// is neither Auto nor Pick (which settles nothing: the money stays on account), the picks cleaned (finPlanPicks); null for no plan
// at all. PURE. Posting reads it (finApplyPlan), and so does a Cash & Bank entry that waits, to say what its plan would settle now.
export function finPlanOf(plan) {
  if (plan == null || typeof plan !== 'object') return null;
  return {
    line_no: Number.isSafeInteger(plan.line_no) ? plan.line_no : null,
    mode: FIN_ALLOC_MODES.includes(plan.mode) ? plan.mode : null,
    picks: finPlanPicks(plan.picks),
  };
}

// What `money` settles of `items`, the open items of the other side: Auto, oldest first; Pick, the bills ticked, in order; or, for
// no mode, nothing, all of it on account. { allocations, on_account_paise }. The ONE decision a posting, a redo and a preview make
// (client/src/lib/finance/allocation.js does the work). PURE; the picks are clean (finCleanAdjust, finPlanOf).
export function finAllocate(items, { mode, picks = [] }, money) {
  if (mode === 'auto') return finAutoAllocate(items, money);
  if (mode === 'pick') return finPickAllocate(items, picks, money);
  return { allocations: [], on_account_paise: money };
}

// The picks a person sends, with a redo or with a Cash & Bank entry: the same, but a list that is not one is refused (400
// FIN_BAD_INPUT, naming the pick). A pick of a bill that is not open, or not this party's, is dropped by the allocator, as in a plan.
function finRedoPicks(raw) {
  if (!Array.isArray(raw)) throw finBad('A pick is the list of bills ticked: each a line, with an amount or none for all that is open.', 'picks');
  if (raw.length > FIN_PICKS_MAX) throw finBad(`A pick can tick ${FIN_PICKS_MAX} bills at most.`, 'picks');
  return raw.map((p, i) => {
    const line_id = p !== null && typeof p === 'object' && Number.isSafeInteger(p.line_id) ? finIdOf(p.line_id) : null;
    if (line_id == null) throw finBad(`Pick ${i + 1} needs the line of a bill.`, `picks[${i}].line_id`);
    const amount = p.amount_paise ?? null;
    if (amount !== null && !(Number.isSafeInteger(amount) && amount > 0)) {
      throw finBad(`Pick ${i + 1}: an amount is a whole number of paise above nothing, or none for all that is open.`, `picks[${i}].amount_paise`);
    }
    return { line_id, amount_paise: amount };
  });
}

// How a person asks for an adjustment (spec §6.3, §6.4), with a redo, a Cash & Bank entry or a preview: { mode, picks }, Auto,
// oldest first, which takes no picks, or Pick, the bills ticked in order. Anything else is refused, 400 FIN_BAD_INPUT, naming
// what is wrong: how, or the pick.
export function finCleanAdjust(how) {
  const { mode, picks } = how !== null && typeof how === 'object' ? how : {};
  if (!FIN_ALLOC_MODES.includes(mode)) throw finBad('Say how to adjust: auto, oldest first, or pick, the bills ticked.', 'mode');
  return { mode, picks: mode === 'pick' ? finRedoPicks(picks) : [] };
}

// A line's allocations, oldest first, as { line_id: the other line, amount_paise }. The Cash & Bank entry reads back with it
// what its posting settled (finPostLocked keeps finApplyPlan's answer to itself).
export async function finLineAllocations(qc, lineId) {
  return (await qc(
    `SELECT CASE WHEN a.credit_line_id = $1 THEN a.debit_line_id ELSE a.credit_line_id END AS line_id, a.amount
       FROM fin_allocations a WHERE a.debit_line_id = $1 OR a.credit_line_id = $1 ORDER BY a.id`, [lineId]))
    .map(a => ({ line_id: a.line_id, amount_paise: finToPaise(a.amount) }));
}

// Works out a line's adjustment against the open items of the other side and writes it: { allocations, on_account_paise },
// `allocations` being what this settled. The money is what is open of the line itself, all of it for a line just posted or one
// whose allocations were just deleted. Auto or the picks choose the items (`mode` null chooses none), and what is left stays on
// account. A line and an item are one pair (UNIQUE (debit_line_id, credit_line_id)), so an item the line is paired with already,
// as when an Adjust settles more of a bill its line part-settles (ruling R76), has that pair's allocation topped up; the pair
// keeps how and by whom it was first chosen, and the log says what the Adjust added. A posting or a Redo writes for a line that
// holds no allocation, so it never meets one. The allocators name an item once (Auto walks each once; Pick adds up repeated
// ticks), so the one statement never touches a pair twice, which ON CONFLICT DO UPDATE refuses. The caller holds the party
// lock (rule 1), so the items are read as they are now, after any posting or reversal it waited for.
async function finSettle(qc, { bookId, line, mode, picks, by }) {
  const isDebit = finToPaise(line.debit) > 0;
  const { debits, credits } = await finItemsOf(qc, line.ledger_id);
  const own = (isDebit ? debits : credits).find(item => item.line_id === line.id);
  const money = own ? own.open_paise : 0;
  const against = isDebit ? credits : debits;
  const result = finAllocate(against, { mode, picks }, money);
  if (result.allocations.length) {
    const others = result.allocations.map(a => a.line_id);
    const selves = result.allocations.map(() => line.id);
    await qc(
      `INSERT INTO fin_allocations (book_id, ledger_id, debit_line_id, credit_line_id, amount, mode, made_by_id, made_by)
       SELECT $1, $2, u.debit_line_id, u.credit_line_id, u.amount, $3, $4, $5
         FROM unnest($6::int[], $7::int[], $8::numeric[]) WITH ORDINALITY AS u(debit_line_id, credit_line_id, amount, n)
        ORDER BY u.n
       ON CONFLICT (debit_line_id, credit_line_id) DO UPDATE SET amount = fin_allocations.amount + EXCLUDED.amount`,
      [bookId, line.ledger_id, mode, by.id, by.name, isDebit ? selves : others, isDebit ? others : selves,
        result.allocations.map(a => finFromPaise(a.amount_paise))]);
  }
  return result;
}

// What the log keeps of a line whose adjustment changed.
const finLineSnapshot = (v, line) => ({ voucher_id: v.id, number: v.number, line_id: line.id, ledger_id: line.ledger_id });

// Settle bills by the plan a voucher carries (spec §6.3, §6.4), as it posts: { allocations, on_account_paise }, or null when
// it carries no plan. finPostLocked calls it once the voucher is posted, holding the party locks already. The plan,
// { line_no, mode: 'auto' | 'pick', picks: [{ line_id, amount_paise | null }] }, names the voucher's party line by line_no;
// its line's whole amount goes to the open items of the other side, worked out now, never refused (see the header). A mode
// that is neither puts it all on account, and so does a Pick with nothing ticked. A plan on a voucher that is not posted and
// live, or one that names no party line of it, settles nothing (null). Appends `apply`, with what was settled.
export async function finApplyPlan(qc, oc, voucherId, actor) {
  const by = finWho(actor);
  const id = finIdOf(voucherId);
  const v = id == null ? null : await oc('SELECT id, book_id, number, allocation_plan FROM fin_vouchers WHERE id = $1', [id]);
  const plan = finPlanOf(v?.allocation_plan);
  if (!plan) return null;
  if (!(await finIsLive(qc, v.id))) return null;
  const line = plan.line_no == null ? null
    : await oc('SELECT id, ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = $2', [v.id, plan.line_no]);
  if (!line || !(await finPartyOf(qc, line.ledger_id))) return null;
  await finPartyLock(oc, line.ledger_id);
  const { mode, picks } = plan;
  const result = await finSettle(qc, { bookId: v.book_id, line, mode, picks, by });
  await finAudit(qc, {
    bookId: v.book_id, entity: 'allocation', entityId: v.id, action: 'apply', userId: by.id, userName: by.name,
    after: { ...finLineSnapshot(v, line), mode, ...result },
  });
  return result;
}

// Redo the adjustment of one party line (spec §6.5), `how` { mode, picks, scope }: with scope 'line' (a Redo, the default) its
// allocations are deleted, worked out again, Auto or Pick, against the items open now, and written; with scope 'open' (an Adjust,
// ruling R71) its allocations are kept, and only what it still holds on account is worked out against the items open now (spec §6.3:
// older on-account money has its own Adjust), a bill it part-settles already taking more on that same allocation (ruling R76):
// { allocations: what this settled, on_account_paise: what stays on account }. It
// changes no balance, posts nothing, needs no approval, and works in a month of any status, a closing or a locked one too: a lock
// protects balances, and an adjustment changes none. It takes the party lock alone, after the input is checked and before anything
// that decides it is read.
// Refusals: how is not Auto or Pick, a Pick's list is not one, or the scope is neither (400 FIN_BAD_INPUT); no such line (404
// FIN_NOT_FOUND); a line that is not a posted line on a party ledger, of a live voucher (ruling R9: not reversed, at an even depth in
// its reversal chain), as read under the lock (409 FIN_NOT_PARTY_LINE).
// Appends `redo` (scope 'line') or `adjust` (scope 'open'), with the line's allocations before and what it settled after.
export async function finRedoAllocations(qc, oc, lineId, how, actor) {
  const by = finWho(actor);
  const { mode, picks: ticked } = finCleanAdjust(how);
  const scope = finAdjustScope(how?.scope);
  const id = finIdOf(lineId);
  const seen = id == null ? null : await oc('SELECT ledger_id FROM fin_voucher_lines WHERE id = $1', [id]);
  if (!seen) throw finError(404, 'FIN_NOT_FOUND');
  await finPartyLock(oc, seen.ledger_id);
  // Read again under the lock: a reversal that took it first is seen here. A posted line never changes ledger (H4).
  const line = await oc(
    `SELECT l.id, l.ledger_id, l.debit, l.credit, v.id AS voucher_id, v.book_id, v.number
       FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id WHERE l.id = $1`, [id]);
  if (!line) throw finError(404, 'FIN_NOT_FOUND');
  if (line.ledger_id !== seen.ledger_id || !(await finIsLive(qc, line.voucher_id)) || !(await finPartyOf(qc, line.ledger_id))) {
    throw finNotPartyLine();
  }
  const v = { id: line.voucher_id, number: line.number };
  const before = await finLineAllocations(qc, id);
  if (scope === 'open') {
    // An Adjust (ruling R71): what the line settles stays; finSettle spends what is still open of it, the money on account, and
    // tops up the allocation of a bill the line part-settles already (ruling R76).
    const result = await finSettle(qc, { bookId: line.book_id, line, mode, picks: ticked, by });
    await finAudit(qc, {
      bookId: line.book_id, entity: 'allocation', entityId: v.id, action: 'adjust', userId: by.id, userName: by.name,
      before: { ...finLineSnapshot(v, line), allocations: before }, after: { ...finLineSnapshot(v, line), scope, mode, ...result },
    });
    return result;
  }
  await qc('DELETE FROM fin_allocations WHERE debit_line_id = $1 OR credit_line_id = $1', [id]);
  const result = await finSettle(qc, { bookId: line.book_id, line, mode, picks: ticked, by });
  await finAudit(qc, {
    bookId: line.book_id, entity: 'allocation', entityId: v.id, action: 'redo', userId: by.id, userName: by.name,
    before: { ...finLineSnapshot(v, line), allocations: before }, after: { ...finLineSnapshot(v, line), mode, ...result },
  });
  return result;
}

// Release every allocation touching a line of a voucher, so the items they paired are open again (spec §6.5): how many went.
// finPostLocked calls it for the entry a reversal reverses, after marking it reversed (rule 3), holding the party locks of the
// reversal's own lines, which are the entry's; it takes them again here (rule 1), which costs that caller nothing. `actor` is
// whoever posted the reversal: the log keeps what was released, in their name.
export async function finReleaseAllocations(qc, oc, voucherId, actor) {
  const by = finWho(actor);
  const id = finIdOf(voucherId);
  if (id == null) return 0;
  await finLockPartiesOf(qc, oc, id);
  const released = (await qc(
    `DELETE FROM fin_allocations
      WHERE debit_line_id IN (SELECT l.id FROM fin_voucher_lines l WHERE l.voucher_id = $1)
         OR credit_line_id IN (SELECT l.id FROM fin_voucher_lines l WHERE l.voucher_id = $1)
     RETURNING id, debit_line_id, credit_line_id, amount, mode`, [id])).sort((a, b) => a.id - b.id);
  if (!released.length) return 0;
  const v = await oc('SELECT id, book_id, number FROM fin_vouchers WHERE id = $1', [id]);
  await finAudit(qc, {
    bookId: v.book_id, entity: 'allocation', entityId: v.id, action: 'release', userId: by.id, userName: by.name,
    before: {
      voucher_id: v.id, number: v.number,
      allocations: released.map(a => ({ debit_line_id: a.debit_line_id, credit_line_id: a.credit_line_id, amount_paise: finToPaise(a.amount), mode: a.mode })),
    },
  });
  return released.length;
}

// ── Across a book (Cash & Bank spec §5): the money on account, and what a book's entries settled ─────────────────────

// The book's party lines that hold money on account (spec §5's "Unadjusted money", §6.3): a customer's credit items and a vendor's
// debit items, of live vouchers (ruling R9), each with what is still open of it, which may be nothing. $1 the book; $2 and $3 the
// groups of its customers and of its vendors (finPartyGroups): a ledger filed under neither is a customer or a vendor by its ERP
// link, as finPartySide says, and one with neither is no party's. Its rows are what finItemOut turns into an item.
const FIN_HELD_SQL = `
  WITH party AS (
    SELECT l.id, l.name,
           CASE WHEN l.group_id = ANY($2::int[]) THEN 'customer' WHEN l.group_id = ANY($3::int[]) THEN 'vendor' ELSE l.party_type END AS side
      FROM fin_ledgers l
     WHERE l.book_id = $1
  ),
  held AS (
    SELECT ln.id AS line_id, ln.ledger_id, p.name AS party, ln.voucher_id, ln.bill_ref, ln.bill_date, ln.due_date,
           ln.debit > 0 AS is_debit, ln.debit + ln.credit AS amount
      FROM fin_voucher_lines ln JOIN party p ON p.id = ln.ledger_id
     WHERE (p.side = 'customer' AND ln.credit > 0) OR (p.side = 'vendor' AND ln.debit > 0)
  )
  SELECT h.line_id, h.ledger_id, h.party, h.voucher_id, v.number, v.voucher_date, h.bill_ref, h.bill_date, h.due_date, h.is_debit,
         (v.voucher_type = 'opening' OR v.is_opening_correction) AS is_opening, h.amount,
         h.amount - CASE WHEN h.is_debit
           THEN (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.debit_line_id = h.line_id)
           ELSE (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.credit_line_id = h.line_id) END AS open
    FROM held h JOIN fin_vouchers v ON v.id = h.voucher_id
   WHERE h.voucher_id IN (${finLiveSql('v.id IN (SELECT held.voucher_id FROM held)')})`;

// How much of a book's party money waits on account, as the Cash & Bank tiles show it: { count, amount_paise }, a count-only read
// (spec §3: a figure is counted in SQL, never by sending the rows). The qc may be the pool's q.
export async function finOnAccountSummary(qc, bookId) {
  const groups = finPartyGroups(await finGroupKinds(qc, bookId));
  const row = (await qc(`SELECT COUNT(*)::int AS count, COALESCE(sum(o.open), 0) AS amount FROM (${FIN_HELD_SQL}) o WHERE o.open > 0`,
    [bookId, groups.customer, groups.vendor]))[0];
  return { count: row.count, amount_paise: finToPaise(row.amount) };
}

// The same money, item by item, oldest first (each an item, as finOpenItems lists them, with its ledger and the party's name): at
// most `max` of them, and `truncated` when there are more. The qc may be the pool's q.
export async function finOnAccountItems(qc, bookId, { max }) {
  const groups = finPartyGroups(await finGroupKinds(qc, bookId));
  const rows = await qc(
    `SELECT o.* FROM (${FIN_HELD_SQL}) o WHERE o.open > 0 ORDER BY COALESCE(o.bill_date, o.voucher_date), o.line_id LIMIT $4`,
    [bookId, groups.customer, groups.vendor, max + 1]);
  return {
    items: rows.slice(0, max).map(row => ({ ...finItemOut(row), ledger_id: row.ledger_id, party: row.party })),
    truncated: rows.length > max,
  };
}

// What each party line of the given vouchers of a book has settled (spec §5: the Cash & Bank book's "Auto: 3 bills, ₹0 on
// account"), one row per party line, in voucher and line order: { voucher_id, line_id, amount_paise, settled_paise, bills, modes,
// live }. `bills` is how many items the line is paired with, `modes` how those pairs were chosen ('auto', 'pick'), and `live`
// whether its voucher is live (ruling R9): the lines of a reversed entry, and of a reversal, settle nothing. The qc may be the pool's q.
export async function finSettledOf(qc, bookId, voucherIds) {
  if (!voucherIds.length) return [];
  const groups = finPartyGroups(await finGroupKinds(qc, bookId));
  const rows = await qc(
    `SELECT ln.voucher_id, ln.id AS line_id, ln.debit + ln.credit AS amount, COALESCE(sum(a.amount), 0) AS settled,
            COUNT(a.id)::int AS bills, COALESCE(array_agg(DISTINCT a.mode) FILTER (WHERE a.id IS NOT NULL), '{}'::text[]) AS modes,
            ln.voucher_id IN (${finLiveSql('v.id = ANY($1::int[])')}) AS live
       FROM fin_voucher_lines ln
       JOIN fin_ledgers fl ON fl.id = ln.ledger_id
       LEFT JOIN fin_allocations a ON a.debit_line_id = ln.id OR a.credit_line_id = ln.id
      WHERE ln.voucher_id = ANY($1::int[]) AND (fl.party_type IS NOT NULL OR fl.group_id = ANY($2::int[]))
      GROUP BY ln.id
      ORDER BY ln.voucher_id, ln.line_no`, [voucherIds, groups.party]);
  return rows.map(row => ({
    voucher_id: row.voucher_id, line_id: row.line_id, amount_paise: finToPaise(row.amount), settled_paise: finToPaise(row.settled),
    bills: row.bills, modes: row.modes, live: row.live,
  }));
}
