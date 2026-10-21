// The trial balance as a tree the screen can open one level at a time (spec §9.2, §10).
//
// The API's answer (GET /finance/reports/trial-balance) lists every group and every ledger with figures, flat: groups carry
// parent_id and sort_order, and a group's figures are already the roll-up of everything under it. This turns that into the rows to
// draw: the root groups in template order, and, under a group that is open, its sub-groups (by sort_order, then id) and then its
// ledgers (by name). A group that is shut shows its own row and nothing below it.
//
// Nothing is lost, whatever the answer looks like (finance-reports.js finGroupTree does the same on the server): a group whose
// parent is not among the groups is a top group; a loop of groups, which the app never makes, is listed after the rest, at the
// top; and a ledger whose group is not among the groups is listed after the last group, at the top, always on view. A trial
// balance whose rows do not add up to its totals would be worse than an odd-looking one.
//
// Pure ESM, no React, no DOM: the server tests import this file by relative path and the browser bundles it as written. The one
// relative import is money.js, which imports nothing.
import { finFormatINR } from './money.js';

const byOrder = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);
// Names the way a person sorts them: capitals do not matter, and "Bank 2" comes before "Bank 10". Ties fall to the id.
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const byName = (a, b) => collator.compare(String(a.name ?? ''), String(b.name ?? '')) || (a.id - b.id);

// A group or a ledger with any figure at all. A figure the answer left out is nothing.
const hasFigures = x => Boolean(x.opening_paise || x.debit_paise || x.credit_paise || x.closing_paise);
const figures = x => ({ opening_paise: x.opening_paise, debit_paise: x.debit_paise, credit_paise: x.credit_paise, closing_paise: x.closing_paise });

// Where every group and ledger sits, whether or not it is on view: { tops, kids, own, strays }.
//   tops    the groups at the top, in order
//   kids    group id -> the sub-groups placed under it, in order
//   own     group id -> its ledgers, by name
//   strays  the ledgers whose group is not one of the groups, by name
function finTbTree(tb) {
  const groups = Array.isArray(tb?.groups) ? tb.groups : [];
  const ledgers = Array.isArray(tb?.ledgers) ? tb.ledgers : [];
  const known = new Set(groups.map(g => g.id));

  const below = new Map();                     // parent id (null for the top) -> its groups, in order
  for (const g of [...groups].sort(byOrder)) {
    const parent = known.has(g.parent_id) ? g.parent_id : null;
    if (!below.has(parent)) below.set(parent, []);
    below.get(parent).push(g);
  }

  const tops = [];
  const kids = new Map();
  const listed = new Set();
  const place = (group, into) => {
    listed.add(group.id);
    into.push(group);
    const mine = [];
    kids.set(group.id, mine);
    for (const sub of below.get(group.id) ?? []) if (!listed.has(sub.id)) place(sub, mine);
  };
  for (const root of below.get(null) ?? []) if (!listed.has(root.id)) place(root, tops);
  // What the walk from the top never reached can only be a loop.
  for (const g of [...groups].sort(byOrder)) if (!listed.has(g.id)) place(g, tops);

  const own = new Map();
  const strays = [];
  for (const l of [...ledgers].sort(byName)) {
    if (!known.has(l.group_id)) { strays.push(l); continue; }
    if (!own.has(l.group_id)) own.set(l.group_id, []);
    own.get(l.group_id).push(l);
  }
  return { tops, kids, own, strays };
}

// The rows of the tree, in the order they are drawn. `expanded` is a Set of group ids (any list of ids will do): a group's
// children are listed only while it is in the set.
//   { kind: 'group' | 'ledger', id, name, depth, opening_paise, debit_paise, credit_paise, closing_paise }
// `hideEmpty` leaves out every group with no figures of its own and no ledger with figures anywhere below it, and every ledger
// with no figures. A group whose ledgers net to nothing (a debtor owing and a debtor in credit) is not empty.
export function finTbRows(tb, expanded, { hideEmpty = false } = {}) {
  const open = expanded instanceof Set ? expanded : new Set(Array.isArray(expanded) ? expanded : []);
  const { tops, kids, own, strays } = finTbTree(tb);

  const busy = new Map();
  const isBusy = group => {
    if (!busy.has(group.id)) {
      busy.set(group.id, hasFigures(group) || (own.get(group.id) ?? []).some(hasFigures) || (kids.get(group.id) ?? []).some(isBusy));
    }
    return busy.get(group.id);
  };
  const showGroup = group => !hideEmpty || isBusy(group);
  const showLedger = ledger => !hideEmpty || hasFigures(ledger);

  const rows = [];
  const ledgerRow = (l, depth) => ({ kind: 'ledger', id: l.id, name: l.name, depth, ...figures(l) });
  const draw = (group, depth) => {
    rows.push({ kind: 'group', id: group.id, name: group.name, depth, ...figures(group) });
    if (!open.has(group.id)) return;
    for (const sub of kids.get(group.id)) if (showGroup(sub)) draw(sub, depth + 1);
    for (const l of own.get(group.id) ?? []) if (showLedger(l)) rows.push(ledgerRow(l, depth + 1));
  };
  for (const g of tops) if (showGroup(g)) draw(g, 0);
  for (const l of strays) if (showLedger(l)) rows.push(ledgerRow(l, 0));
  return rows;
}

// The ids of the groups that have something to open: a sub-group or a ledger. "Expand all" opens exactly these.
export function finTbExpandable(tb) {
  const { kids, own } = finTbTree(tb);
  return new Set([...kids.keys()].filter(id => kids.get(id).length > 0 || (own.get(id) ?? []).length > 0));
}

// The ids of the groups that hold a ledger with figures somewhere below them, in the group's own ledgers or in a sub-group's. A group can
// net to nothing and still hold such ledgers (a debtor owing and a debtor in credit); it is then a group with something in it.
export function finTbHolding(tb) {
  const { tops, kids, own } = finTbTree(tb);
  const holding = new Set();
  const walk = group => {
    let holds = (own.get(group.id) ?? []).some(hasFigures);
    for (const sub of kids.get(group.id) ?? []) if (walk(sub)) holds = true;   // every sub-group is walked, whatever the others say
    if (holds) holding.add(group.id);
    return holds;
  };
  for (const group of tops) walk(group);
  return holding;
}

// The four cells of a row, as text. Opening and closing are balances, so they carry Dr or Cr; the period's debit and credit are plain
// amounts. Nothing where there is nothing, as Tally leaves it, so a book of mostly untouched ledgers is not a wall of ₹0.00, with two
// exceptions, because a row that stands for figures must not read as an empty one:
//   - a closing of nil on a row that had figures says ₹0.00: a debtor who paid in full is settled, which is not the same as blank;
//   - a group that `holds` ledgers with figures (finTbHolding) yet nets to nothing in every column says ₹0.00 in both balances, and its
//     debit and credit stay blank, since nothing moved: it nets to nil, it is not empty.
// A row with figures of its own reads the same whether or not it holds.
export function finTbCells(row, holds = false) {
  const amount = value => (value ? finFormatINR(value) : '');
  const own = Boolean(row.opening_paise || row.debit_paise || row.credit_paise || row.closing_paise);
  const netsToNil = holds && !own;
  return {
    opening: row.opening_paise ? finFormatINR(row.opening_paise, { drcr: true }) : netsToNil ? finFormatINR(0) : '',
    debit: amount(row.debit_paise),
    credit: amount(row.credit_paise),
    closing: own || holds ? finFormatINR(row.closing_paise ?? 0, { drcr: true }) : '',
  };
}

// What the foot of the trial balance adds up, in words, for the three cards on screen and for the summary above an export: the SAME
// words in both. Opening and closing are each LEDGER's balance counted on its own side (a ledger in debit on the Dr side, one in credit on
// the Cr side), the way Tally's trial balance totals its ledgers; a group row beside them shows the group's NET. So a Closing card of
// Dr 13,00,000 can sit beside a group row of Dr 12,00,000 and both be right, and the card has to say what it is.
export const FIN_TB_FOOT = Object.freeze({
  opening: 'Opening · ledger balances by side',
  period: 'This period · debits and credits',
  closing: 'Closing · ledger balances by side',
});
export const FIN_TB_FOOT_NOTE = "Opening and closing add up each ledger's balance on its own side (Dr or Cr), so they can be larger than the net a group row shows.";

// The foot of the trial balance: its debit side against its credit side in the opening, the period's movement and the closing,
// from the answer's `totals`. Each is the amount by which the two sides differ in paise; all three are 0 in books that tally,
// which the database's own checks make certain, so a trial balance that says otherwise is a fault to report and not to hide.
export function finTbBalance(totals) {
  const t = totals ?? {};
  const gap = (dr, cr) => (Number(dr) || 0) - (Number(cr) || 0);
  const out = { opening: gap(t.opening_dr, t.opening_cr), movement: gap(t.debit, t.credit), closing: gap(t.closing_dr, t.closing_cr) };
  return { ...out, tallies: out.opening === 0 && out.movement === 0 && out.closing === 0 };
}
