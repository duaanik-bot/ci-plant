import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finPrefix, finNeedsApproval, FIN_DEFAULT_RULES, finBalanceProblem, finShapeProblem, finCan, FIN_VOUCHER_TYPES, FIN_ROLES } from './finance-rules.js';

test('voucher number prefix', () => {
  assert.equal(finPrefix('CI', 'journal', '2627'), 'CI-JV-2627-');
  assert.equal(finPrefix('DP', 'receipt', '2627'), 'DP-RV-2627-');
  assert.equal(finPrefix('CI', 'opening', '2627'), 'CI-OB-2627-');
  assert.throws(() => finPrefix('CI', 'nonsense', '2627'));
});

test('approval decision', () => {
  const L = 10000000;
  assert.equal(finNeedsApproval({ mode: 'always', total_paise: 1, period_status: 'open' }), true);
  assert.equal(finNeedsApproval({ mode: 'never', total_paise: 9e12, period_status: 'open' }), false);
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: L, total_paise: L, period_status: 'open' }), false);
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: L, total_paise: L + 1, period_status: 'open' }), true);
  assert.equal(finNeedsApproval({ mode: 'never', total_paise: 1, period_status: 'closing' }), true);
});

test('default rules are spec §6.8', () => {
  const by = Object.fromEntries(FIN_DEFAULT_RULES.map(r => [r.rule_key, r]));
  assert.equal(FIN_DEFAULT_RULES.length, 10);
  for (const k of ['journal', 'opening', 'reversal', 'credit_note', 'debit_note']) assert.equal(by[k].mode, 'always');
  for (const k of ['payment', 'contra']) assert.deepEqual([by[k].mode, by[k].limit_paise], ['above_limit', 10000000]);
  for (const k of ['receipt', 'sales', 'purchase']) assert.equal(by[k].mode, 'never');
});

test('balance problems carry the spec sentence', () => {
  const l = (d, c) => ({ debit_paise: d, credit_paise: c });
  assert.equal(finBalanceProblem([l(500, 0), l(0, 500)]), null);
  assert.equal(finBalanceProblem([l(500, 0)]).code, 'FIN_TOO_FEW_LINES');
  assert.equal(finBalanceProblem([l(0, 0), l(0, 0)]).code, 'FIN_BAD_LINE');
  assert.equal(finBalanceProblem([l(5, 5), l(0, 10)]).code, 'FIN_BAD_LINE');
  const u = finBalanceProblem([l(12000000, 0), l(0, 11800000)]);
  assert.equal(u.code, 'FIN_UNBALANCED');
  assert.equal(u.message, "Debits ₹1,20,000.00 and credits ₹1,18,000.00 don't match — difference ₹2,000.00.");
});

test('voucher shapes (spec §6.5)', () => {
  const b = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: true });
  const o = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: false });
  assert.equal(finShapeProblem('journal', [o(1, 0), o(0, 1)]), null);
  assert.equal(finShapeProblem('journal', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('journal', [b(1, 0), o(0, 1)], { isReversal: true }), null);
  assert.equal(finShapeProblem('receipt', [b(1, 0), o(0, 1)]), null);
  assert.equal(finShapeProblem('receipt', [o(1, 0), b(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('payment', [o(1, 0), b(0, 1)]), null);
  assert.equal(finShapeProblem('payment', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('contra', [b(1, 0), b(0, 1)]), null);
  assert.equal(finShapeProblem('contra', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('opening', [b(1, 0), o(0, 1)]), null);
});

test('capability matrix is spec §8.1', () => {
  assert.ok(finCan(['viewer'], 'view') && !finCan(['viewer'], 'enter'));
  assert.ok(finCan(['accountant'], 'enter') && finCan(['accountant'], 'ledger') && finCan(['accountant'], 'import'));
  assert.ok(!finCan(['accountant'], 'approve') && !finCan(['accountant'], 'admin'));
  assert.ok(finCan(['approver'], 'approve') && finCan(['approver'], 'enter') && !finCan(['approver'], 'ledger'));
  assert.ok(finCan(['admin'], 'admin') && finCan(['admin'], 'ledger') && finCan(['admin'], 'import') && !finCan(['admin'], 'enter'));
  assert.ok(finCan(['approver', 'admin'], 'ledger'));
  assert.ok(!finCan([], 'view'));
});

// ── Beyond the brief's pins: the whole tables, and the edges that must never fail open ────────

const bankLine = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: true });
const plainLine = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: false });

test('voucher types: the whole §6.5 table, frozen, and finPrefix reads it', () => {
  assert.deepEqual(FIN_VOUCHER_TYPES, {
    journal: { code: 'JV', label: 'Journal', manual: true },
    receipt: { code: 'RV', label: 'Receipt', manual: true },
    payment: { code: 'PV', label: 'Payment', manual: true },
    contra: { code: 'CV', label: 'Contra', manual: true },
    opening: { code: 'OB', label: 'Opening', manual: false },
    sales: { code: 'SV', label: 'Sales', manual: false },
    purchase: { code: 'PU', label: 'Purchase', manual: false },
    credit_note: { code: 'CN', label: 'Credit Note', manual: false },
    debit_note: { code: 'DN', label: 'Debit Note', manual: false },
  });
  assert.ok(Object.isFrozen(FIN_VOUCHER_TYPES));
  for (const [type, t] of Object.entries(FIN_VOUCHER_TYPES)) {
    assert.ok(Object.isFrozen(t), type);
    assert.equal(finPrefix('DP', type, '2728'), `DP-${t.code}-2728-`, type);
  }
});

test('finPrefix: only a type the table itself owns has a number series', () => {
  // constructor, toString and __proto__ are on every object, and none of them is a voucher type
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Journal', '', undefined, null])
    assert.throws(() => finPrefix('CI', bad, '2627'), /voucher type/i, `should refuse ${JSON.stringify(bad)}`);
});

test('approval: a closing month always asks, and a rule that cannot be read stops the post', () => {
  const L = 10000000;
  for (const rule of [{ mode: 'always' }, { mode: 'never' }, { mode: 'above_limit', limit_paise: L }])
    assert.equal(finNeedsApproval({ ...rule, total_paise: 1, period_status: 'closing' }), true, rule.mode);
  // A missing limit would make "above the limit" false for every amount, and the rule would quietly
  // stop asking. undefined is what a forgotten limit_amount -> limit_paise conversion looks like.
  for (const limit_paise of [undefined, null, NaN, -1, 0.5, '10000000'])
    assert.throws(() => finNeedsApproval({ mode: 'above_limit', limit_paise, total_paise: 5, period_status: 'open' }), /limit/i, `limit ${String(limit_paise)}`);
  assert.throws(() => finNeedsApproval({ mode: 'above_limit', limit_paise: L, total_paise: undefined, period_status: 'open' }), /total/i);
  for (const mode of ['', 'ALWAYS', 'sometimes', undefined, null])
    assert.throws(() => finNeedsApproval({ mode, limit_paise: L, total_paise: 5, period_status: 'open' }), /mode/i, `mode ${String(mode)}`);
  // a limit of nothing is still a rule: everything above nothing asks
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: 0, total_paise: 1, period_status: 'open' }), true);
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: 0, total_paise: 0, period_status: 'open' }), false);
});

test('default rules carry a limit only where the mode is above_limit, and cover every type', () => {
  for (const r of FIN_DEFAULT_RULES) assert.equal(r.limit_paise, r.mode === 'above_limit' ? 10000000 : null, r.rule_key);
  assert.deepEqual(FIN_DEFAULT_RULES.map(r => r.rule_key).sort(), [...Object.keys(FIN_VOUCHER_TYPES), 'reversal'].sort());
  assert.ok(Object.isFrozen(FIN_DEFAULT_RULES));
  for (const r of FIN_DEFAULT_RULES) assert.ok(Object.isFrozen(r), r.rule_key);
});

test('balance problems: what counts as a line, and the order the checks run in', () => {
  const l = (d, c) => ({ debit_paise: d, credit_paise: c });
  for (const none of [[], null, undefined]) assert.equal(finBalanceProblem(none).code, 'FIN_TOO_FEW_LINES');
  assert.equal(finBalanceProblem([l(0, 0)]).code, 'FIN_TOO_FEW_LINES'); // the count comes before the line
  // A line is one positive whole-paise side with a zero other side, as the database CHECK has it.
  // A missing side is refused too: finFromPaise would throw on it at the insert.
  // (-5, 3) and (3, -5) are the negatives that "exactly one side is positive" lets through on its own.
  for (const bad of [l(-5, 0), l(0, -5), l(-5, 3), l(3, -5), l(1.5, 0), l(0, 0.5), l('500', 0), l(0, '500'), l(NaN, 0), l(Infinity, 0), l(500), { credit_paise: 500 }, {}, null])
    assert.equal(finBalanceProblem([l(500, 0), bad, l(0, 500)])?.code, 'FIN_BAD_LINE', `should refuse ${JSON.stringify(bad)}`);
  assert.match(finBalanceProblem([l(500, 0), l(0, 0), l(0, 500)]).message, /^Line 2 /);
  assert.equal(finBalanceProblem([l(5, 5), l(0, 10)]).code, 'FIN_BAD_LINE'); // a wrong line is said before the sides differ
  // any number of lines, in any order; and credits can be the larger side as well as debits
  assert.equal(finBalanceProblem([l(300, 0), l(200, 0), l(0, 500)]), null);
  assert.equal(finBalanceProblem([l(0, 500), l(300, 0), l(200, 0)]), null);
  assert.equal(finBalanceProblem([l(1, 0), l(0, 2)]).message, "Debits ₹0.01 and credits ₹0.02 don't match — difference ₹0.01.");
});

test('shape messages are the spec sentences, word for word', () => {
  assert.deepEqual(finShapeProblem('journal', [bankLine(1, 0), plainLine(0, 1)]),
    { code: 'FIN_SHAPE', message: "A journal can't use bank or cash ledgers — use a Payment, Receipt or Contra voucher." });
  assert.deepEqual(finShapeProblem('receipt', [plainLine(1, 0), bankLine(0, 1)]),
    { code: 'FIN_SHAPE', message: 'A receipt needs money coming into a bank or cash ledger.' });
  assert.deepEqual(finShapeProblem('payment', [bankLine(1, 0), plainLine(0, 1)]),
    { code: 'FIN_SHAPE', message: 'A payment needs money going out of a bank or cash ledger.' });
  assert.deepEqual(finShapeProblem('contra', [bankLine(1, 0), plainLine(0, 1)]),
    { code: 'FIN_SHAPE', message: 'A contra moves money between bank and cash ledgers only.' });
});

test('shape edges: a reversal waives only the journal rule, other types carry none, an unknown type is a bug', () => {
  // a reversal IS a journal, so waiving the journal rule must not loosen any other type
  assert.equal(finShapeProblem('receipt', [plainLine(1, 0), bankLine(0, 1)], { isReversal: true }).code, 'FIN_SHAPE');
  for (const t of ['opening', 'sales', 'purchase', 'credit_note', 'debit_note'])
    assert.equal(finShapeProblem(t, [bankLine(1, 0), plainLine(0, 1)]), null, t);
  // one bank line on the right side is enough, whatever else the voucher holds
  assert.equal(finShapeProblem('receipt', [bankLine(5, 0), plainLine(0, 3), plainLine(0, 2)]), null);
  assert.equal(finShapeProblem('payment', [plainLine(3, 0), plainLine(2, 0), bankLine(0, 5)]), null);
  // never a silent pass for a type the ledger does not know
  for (const t of ['nonsense', 'constructor', '__proto__', undefined])
    assert.throws(() => finShapeProblem(t, [plainLine(1, 0), plainLine(0, 1)]), /voucher type/i, String(t));
});

test('capability matrix: every role against every capability', () => {
  const allowed = {
    view: ['viewer', 'accountant', 'approver', 'admin'],
    enter: ['accountant', 'approver'],
    ledger: ['accountant', 'admin'],
    import: ['accountant', 'admin'],
    approve: ['approver'],
    admin: ['admin'],
  };
  assert.deepEqual(FIN_ROLES, ['viewer', 'accountant', 'approver', 'admin']);
  for (const [cap, roles] of Object.entries(allowed))
    for (const role of FIN_ROLES) assert.equal(finCan([role], cap), roles.includes(role), `${role} / ${cap}`);
});

test('finCan: an unknown capability, an unknown role or a non-list is always no', () => {
  const everyone = ['viewer', 'accountant', 'approver', 'admin'];
  // 'constructor' and '__proto__' exist on every object, and are not capabilities
  for (const cap of ['export', 'delete', 'constructor', 'toString', '__proto__', '', undefined, null])
    assert.equal(finCan(everyone, cap), false, `capability ${String(cap)}`);
  for (const roles of [['superuser'], ['Admin'], ['constructor'], [''], [null]])
    assert.equal(finCan(roles, 'view'), false, `roles ${JSON.stringify(roles)}`);
  // a string is not a list: 'admin'.includes('admin') would be true
  for (const roles of [undefined, null, 'admin', {}]) assert.equal(finCan(roles, 'view'), false, `roles ${String(roles)}`);
});
