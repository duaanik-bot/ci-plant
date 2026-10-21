// Finance rules, the pure half: how a voucher is numbered, whether it needs an Approver, what it
// must look like before it posts, and who may do what. PURE, in the way merge-rules.js is: plain
// values in, a verdict out, no pg, no await, nothing to mock. That is what lets a test pin every
// sentence a refusal says, so the routes only have to carry it.
//
// The database re-checks some of this itself (the line CHECK of spec §6.7, the deferred triggers
// of §7.4) and has the last word at commit. This file is the first line: the plain sentence, said
// before anything is written.

import { finFormatINR } from '../../client/src/lib/finance/money.js';

// ── Voucher types (spec §6.5) ────────────────────────────────────────────────────────────────
// `code` is the pair of letters in the voucher number. `manual` marks the four types a person
// types on the voucher screen; the rest are made by the app.
export const FIN_VOUCHER_TYPES = Object.freeze({
  journal: Object.freeze({ code: 'JV', label: 'Journal', manual: true }),
  receipt: Object.freeze({ code: 'RV', label: 'Receipt', manual: true }),
  payment: Object.freeze({ code: 'PV', label: 'Payment', manual: true }),
  contra: Object.freeze({ code: 'CV', label: 'Contra', manual: true }),
  opening: Object.freeze({ code: 'OB', label: 'Opening', manual: false }),
  sales: Object.freeze({ code: 'SV', label: 'Sales', manual: false }),
  purchase: Object.freeze({ code: 'PU', label: 'Purchase', manual: false }),
  credit_note: Object.freeze({ code: 'CN', label: 'Credit Note', manual: false }),
  debit_note: Object.freeze({ code: 'DN', label: 'Debit Note', manual: false }),
});

// A type the table does not own is a bug in the caller, never a voucher to carry on with. The
// own-property check matters: 'constructor' and '__proto__' are on every object and are not types.
const finUnknownType = type => new Error(`Unknown voucher type "${type}"`);

// The number series a voucher is minted from, with the trailing dash: CI-JV-2627-. The minter
// appends the four-digit counter, giving CI-JV-2627-0001.
export function finPrefix(bookCode, type, fyShort) {
  if (!Object.hasOwn(FIN_VOUCHER_TYPES, type)) throw finUnknownType(type);
  return `${bookCode}-${FIN_VOUCHER_TYPES[type].code}-${fyShort}-`;
}

// ── Approval (spec §6.8, §7.3) ───────────────────────────────────────────────────────────────
const FIN_LAKH_PAISE = 10000000; // ₹1,00,000, the payment and contra limit
// limit_paise is set if and only if the mode is above_limit (spec §6.8), and null otherwise.
const finRule = (rule_key, mode, limit_paise = null) => Object.freeze({ rule_key, mode, limit_paise });

// What setup gives each book, which a Finance Admin can edit afterwards. A reversal has a rule of
// its own, and a reversal always takes it.
export const FIN_DEFAULT_RULES = Object.freeze([
  finRule('journal', 'always'),
  finRule('opening', 'always'),
  finRule('reversal', 'always'),
  finRule('credit_note', 'always'),
  finRule('debit_note', 'always'),
  finRule('payment', 'above_limit', FIN_LAKH_PAISE),
  finRule('contra', 'above_limit', FIN_LAKH_PAISE),
  finRule('receipt', 'never'),
  finRule('sales', 'never'),
  finRule('purchase', 'never'),
]);

// Does posting this voucher need an Approver? `mode` and `limit_paise` are the book's rule for the
// voucher (its own type's, or 'reversal' for a reversal; the caller picks the row), `total_paise`
// is the sum of its debits and `period_status` is the covering month's.
export function finNeedsApproval({ mode, limit_paise, total_paise, period_status }) {
  // A closing month takes nothing without an Approver, whatever the rule says (spec §7.3).
  if (period_status === 'closing') return true;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (mode !== 'above_limit') throw new Error(`Unknown approval mode "${mode}"`);
  // From here the answer is "total > limit", which is false for every amount if the limit is
  // missing. A rule that cannot be read has to stop the post, not wave it through: undefined is
  // exactly what a forgotten limit_amount -> limit_paise conversion looks like.
  if (!Number.isSafeInteger(limit_paise) || limit_paise < 0) {
    throw new Error(`An above_limit rule needs its limit in whole paise, got ${limit_paise}`);
  }
  if (!Number.isSafeInteger(total_paise)) {
    throw new Error(`The voucher total must be whole paise, got ${total_paise}`);
  }
  return total_paise > limit_paise;
}

// ── Balance (spec §6.7, §7.4) ────────────────────────────────────────────────────────────────
// One side of a line: whole paise and not negative. A string, a fraction or NaN is not an amount.
const finIsAmount = p => Number.isSafeInteger(p) && p >= 0;

// The checks every voucher passes on its lines, in this order: enough lines, each line sound, the
// two sides equal. null means all three hold; otherwise the first failure, as { code, message }.
// A line is { debit_paise, credit_paise }: exactly one side positive and the other a zero that is
// actually there. That is the database CHECK on fin_voucher_lines (spec §6.7) with whole paise
// added. A missing side is refused here rather than at the insert, where finFromPaise would throw.
//
// Plain sums of whole paise are exact below 2^53 (about ₹90 lakh crore). money.js refuses any typed
// or imported amount at or above FIN_MAX_PAISE, far under that, so no real voucher can reach it.
export function finBalanceProblem(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return { code: 'FIN_TOO_FEW_LINES', message: 'A voucher needs at least two lines.' };
  }
  let debits = 0;
  let credits = 0;
  for (const [i, line] of lines.entries()) {
    const debit = line?.debit_paise;
    const credit = line?.credit_paise;
    if (!finIsAmount(debit) || !finIsAmount(credit) || (debit > 0) === (credit > 0)) {
      return {
        code: 'FIN_BAD_LINE',
        message: `Line ${i + 1} needs a debit or a credit amount, not both and not neither.`,
      };
    }
    debits += debit;
    credits += credit;
  }
  if (debits !== credits) {
    const difference = finFormatINR(Math.abs(debits - credits));
    return {
      code: 'FIN_UNBALANCED',
      message: `Debits ${finFormatINR(debits)} and credits ${finFormatINR(credits)} don't match — difference ${difference}.`,
    };
  }
  return null;
}

// ── Shape (spec §6.5) ────────────────────────────────────────────────────────────────────────
// What each hand-typed type must look like, and the sentence a refusal says. A line carries
// `is_bank_cash`, which the caller works out from its ledger's group (see FIN_BANK_CASH_GROUPS).
// The other types (opening, sales, purchase, credit_note, debit_note) have no shape rule here.
const FIN_SHAPES = {
  journal: {
    says: "A journal can't use bank or cash ledgers — use a Payment, Receipt or Contra voucher.",
    // A reversal is a journal that mirrors the voucher it undoes, bank and cash lines included.
    holds: (lines, isReversal) => isReversal || !lines.some(l => l.is_bank_cash),
  },
  receipt: {
    says: 'A receipt needs money coming into a bank or cash ledger.',
    holds: lines => lines.some(l => l.is_bank_cash && l.debit_paise > 0),
  },
  payment: {
    says: 'A payment needs money going out of a bank or cash ledger.',
    holds: lines => lines.some(l => l.is_bank_cash && l.credit_paise > 0),
  },
  contra: {
    says: 'A contra moves money between bank and cash ledgers only.',
    holds: lines => lines.every(l => l.is_bank_cash),
  },
};

// null when the lines have the shape the type needs, otherwise { code: 'FIN_SHAPE', message }.
// `isReversal` waives the journal rule and nothing else: a reversal IS a journal, so no other
// type is loosened by it. Run finBalanceProblem first; this reads lines that are already sound.
export function finShapeProblem(type, lines, { isReversal = false } = {}) {
  if (!Object.hasOwn(FIN_VOUCHER_TYPES, type)) throw finUnknownType(type);
  const shape = Object.hasOwn(FIN_SHAPES, type) ? FIN_SHAPES[type] : null;
  return shape && !shape.holds(lines, isReversal) ? { code: 'FIN_SHAPE', message: shape.says } : null;
}

// ── Who may do what (spec §8.1) ──────────────────────────────────────────────────────────────
// The roles, the capability table and finCan live in the client's lib, so the screens hide exactly what this server
// refuses: one table, read by both. They are re-exported here so every server import of them keeps working.
export { FIN_ROLES, finCan } from '../../client/src/lib/finance/caps.js';
