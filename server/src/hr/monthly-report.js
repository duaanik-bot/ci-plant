// HR · the month-wise payment schedule (owner's request 2026-11-03: "month-wise, the complete payment schedule —
// the month, the payment done, advances in cash and bank, contractor payments — updated by itself every month once
// payroll is approved and paid").
//
// Nothing is stored: every call reads the runs, lines, advance and loan ledgers as they stand, so a month appears
// as soon as it has a run and its figures follow every approval, payment and finalise. One row per month that has a
// run, a Pay-staff advance or a loan issued, newest first. Money comes back as exact 2-dp strings (SQL NUMERIC sums,
// never floats); counts as integers.
//
// Per month:
//   run       status, people, gross, deductions (advance / loan / other), payable, short (pay below zero: count and
//             total shortfall, carried as advance)
//   approval  approved people and their payable
//   payment   paid (count, amount), unpaid (pending / failed / reversed with something to pay), on hold
//   channels  payable and paid split by the pay channel's kind: cash, bank, and lines with no channel
//   contractors  worker_type 'contractor': people, gross, payable, paid
//   advances  given on the salary sheet (run_lines.advance_given) and through Pay staff (advance_txns 'given',
//             source 'manual'), the latter split cash / bank by the "Paid via <code>" its note carries
//   loans     issued that month (not opening balances): count, principal, split cash / bank by paid_via; recovered
//             through payroll (the run's loan_recovery)
const CASH = 'cash';

const RUN_SQL = `
  SELECT r.month, r.status,
         count(*)::int AS people,
         coalesce(sum(l.gross), 0)::text AS gross,
         coalesce(sum(l.advance_recovery), 0)::text AS advance_recovered,
         coalesce(sum(l.loan_recovery), 0)::text AS loan_recovered,
         coalesce(sum(l.misc_deduction + l.adj_deductions), 0)::text AS other_deductions,
         coalesce(sum(l.total_deductions), 0)::text AS deductions,
         coalesce(sum(l.payable), 0)::text AS payable,
         coalesce(sum(l.advance_given), 0)::text AS advance_given_sheet,
         count(*) FILTER (WHERE l.net_before_cap < 0)::int AS short_people,
         coalesce(-sum(l.net_before_cap) FILTER (WHERE l.net_before_cap < 0), 0)::text AS short_amount,
         count(*) FILTER (WHERE l.approval_status = 'approved')::int AS approved_people,
         coalesce(sum(l.payable) FILTER (WHERE l.approval_status = 'approved'), 0)::text AS approved_payable,
         count(*) FILTER (WHERE l.payment_status = 'paid')::int AS paid_people,
         coalesce(sum(coalesce(l.paid_amount, l.payable)) FILTER (WHERE l.payment_status = 'paid'), 0)::text AS paid_amount,
         count(*) FILTER (WHERE l.payment_status IN ('pending', 'failed', 'reversed') AND l.payable > 0)::int AS unpaid_people,
         coalesce(sum(l.payable) FILTER (WHERE l.payment_status IN ('pending', 'failed', 'reversed') AND l.payable > 0), 0)::text AS unpaid_amount,
         count(*) FILTER (WHERE l.payment_status = 'on_hold')::int AS held_people,
         coalesce(sum(l.payable) FILTER (WHERE l.payment_status = 'on_hold'), 0)::text AS held_amount,
         coalesce(sum(l.payable) FILTER (WHERE c.kind = 'cash'), 0)::text AS cash_payable,
         coalesce(sum(l.payable) FILTER (WHERE c.kind = 'bank'), 0)::text AS bank_payable,
         coalesce(sum(l.payable) FILTER (WHERE c.kind IS NULL), 0)::text AS none_payable,
         coalesce(sum(coalesce(l.paid_amount, l.payable)) FILTER (WHERE l.payment_status = 'paid' AND c.kind = 'cash'), 0)::text AS cash_paid,
         coalesce(sum(coalesce(l.paid_amount, l.payable)) FILTER (WHERE l.payment_status = 'paid' AND c.kind = 'bank'), 0)::text AS bank_paid,
         count(*) FILTER (WHERE p.worker_type = 'contractor')::int AS contractor_people,
         coalesce(sum(l.gross) FILTER (WHERE p.worker_type = 'contractor'), 0)::text AS contractor_gross,
         coalesce(sum(l.payable) FILTER (WHERE p.worker_type = 'contractor'), 0)::text AS contractor_payable,
         coalesce(sum(coalesce(l.paid_amount, l.payable)) FILTER (WHERE p.worker_type = 'contractor' AND l.payment_status = 'paid'), 0)::text AS contractor_paid
    FROM hr.runs r
    JOIN hr.run_lines l ON l.run_id = r.id
    JOIN hr.people p ON p.id = l.person_id
    LEFT JOIN hr.pay_channels c ON c.code = l.pay_channel
   WHERE l.person_id <> ALL($1::int[])
   GROUP BY r.id, r.month, r.status`;

// Pay-staff advances: the channel code is in the note ("Paid via <code>" or "Paid via <code> · <note>").
const ADVANCE_SQL = `
  SELECT to_char(a.txn_date, 'YYYY-MM') AS month,
         coalesce(k.kind, CASE WHEN m.code IS NULL OR m.code = '${CASH}' THEN 'cash' ELSE 'bank' END) AS kind,
         count(*)::int AS n, sum(a.amount)::text AS amount
    FROM hr.advance_txns a
    LEFT JOIN LATERAL (SELECT substring(a.note FROM '^Paid via ([^ ]+)') AS code) m ON true
    LEFT JOIN hr.pay_channels k ON k.code = m.code
   WHERE a.kind = 'given' AND a.source = 'manual' AND a.reverses_id IS NULL AND a.person_id <> ALL($1::int[])
   GROUP BY 1, 2`;

const LOAN_SQL = `
  SELECT to_char(l.issued_on, 'YYYY-MM') AS month,
         coalesce(k.kind, CASE WHEN l.paid_via IS NULL OR l.paid_via = '${CASH}' THEN 'cash' ELSE 'bank' END) AS kind,
         count(*)::int AS n, sum(l.principal)::text AS amount
    FROM hr.loans l
    LEFT JOIN hr.pay_channels k ON k.code = l.paid_via
   WHERE NOT l.is_opening AND l.status <> 'cancelled' AND l.person_id <> ALL($1::int[])
   GROUP BY 1, 2`;

// Adds 2-dp decimal strings exactly (paise as BigInt).
const paise = (s) => {
  const t = String(s ?? '0');
  const neg = t.startsWith('-');
  const [i, f = ''] = (neg ? t.slice(1) : t).split('.');
  const v = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -v : v;
};
const text = (p) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const plus = (...xs) => text(xs.reduce((t, x) => t + paise(x), 0n));

const ZERO = '0.00';
const emptySplit = () => ({ count: 0, amount: ZERO, cash: ZERO, bank: ZERO });

// exclude: people left out of every figure (a restricted login's hidden people, hr/privacy.js).
export async function monthlySchedule(qx, { exclude = [] } = {}) {
  const [runs, advances, loans] = await Promise.all([qx(RUN_SQL, [exclude]), qx(ADVANCE_SQL, [exclude]), qx(LOAN_SQL, [exclude])]);
  const months = new Map();
  const row = (month) => {
    if (!months.has(month)) {
      months.set(month, { month, run: null, advances_pay_staff: emptySplit(), loans_issued: emptySplit() });
    }
    return months.get(month);
  };
  for (const r of runs) {
    const m = row(r.month);
    m.run = {
      status: r.status, people: r.people, gross: r.gross, deductions: r.deductions,
      advance_recovered: r.advance_recovered, loan_recovered: r.loan_recovered, other_deductions: r.other_deductions,
      payable: r.payable, short: { count: r.short_people, amount: r.short_amount },
      approved: { count: r.approved_people, amount: r.approved_payable },
      paid: { count: r.paid_people, amount: r.paid_amount },
      unpaid: { count: r.unpaid_people, amount: r.unpaid_amount },
      on_hold: { count: r.held_people, amount: r.held_amount },
      channels: {
        cash: { payable: r.cash_payable, paid: r.cash_paid },
        bank: { payable: r.bank_payable, paid: r.bank_paid },
        none: { payable: r.none_payable },
      },
      contractors: { count: r.contractor_people, gross: r.contractor_gross, payable: r.contractor_payable, paid: r.contractor_paid },
      advance_given_sheet: r.advance_given_sheet,
    };
  }
  for (const [list, key] of [[advances, 'advances_pay_staff'], [loans, 'loans_issued']]) {
    for (const a of list) {
      const s = row(a.month)[key];
      s.count += a.n;
      s.amount = plus(s.amount, a.amount);
      s[a.kind === 'bank' ? 'bank' : 'cash'] = plus(s[a.kind === 'bank' ? 'bank' : 'cash'], a.amount);
    }
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}
