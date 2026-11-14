// Correcting a loan's instalment in a FINALISED payroll month (owner's request 2026-11-14: "even if it's finalised I
// should be able to edit it for the month, but ask me for a confirmation pop-up if it's finalised").
//
// A finalised month has posted its money: the loan's payroll_recovery row, the advance 'recovered' row, and the line
// itself (often already paid). A correction works the month out again from what the line stored, the engine's way,
// with only that loan's deduction changed, then puts every record straight in one transaction:
//
//   wanted     each deduction's wanted amount is what the line kept plus what it could not recover (unrecovered):
//              the advance, each loan (oldest first, as stored), and the other deductions together. The edited loan
//              wants the new amount, never more than it owed going into the month.
//   short pay  as the engine: when the wanted total is more than the pay, the advance is cut first, then the loans
//              newest first, then the other deductions. What is not recovered stays owing (the advance carries on).
//   payable    net less paid separately, never below 0, rounded as the run's policy says (to the rupee by default).
//
// Then: each loan's payroll_recovery row for the run takes its new amount (a 0 removes it; a loan that is paid off
// closes, one that owes again reopens); the advance 'recovered' row likewise; the line's deductions, net, payable,
// carried advance, unrecovered, breakdown and flags follow; the run's totals are worked out again. When the line was
// already PAID and its payable moves, the difference goes to the first open month as an approved adjustment (arrears
// earning when less was deducted, a deduction when more was), and the line's note says so. Everything is audited.
//
// With dry: true nothing is written; the answer is the preview the confirmation pop-up shows.
import { fmtPaise, rat, roundRupee, toPaise } from './money.js';
import { loanOutstanding } from './loans.js';
import { hrAudit } from './audit.js';

const P = (v) => (v === null || v === undefined || v === '' ? 0n : toPaise(rat(String(v))));
const T = (p) => fmtPaise(p);
const fail = (status, code, message, more = {}) => Object.assign(new Error(message), { status, body: { code, ...more } });

export async function correctFinalisedInstalment(qc, req, { run, loanId, personId, amount, note = null, firstOpen, dry = false }) {
  const line = await qc(
    `SELECT id, gross::text AS gross, paid_separately::text AS paid_separately, misc_deduction::text AS misc_deduction,
            adj_deductions::text AS adj_deductions, loan_recovery::text AS loan_recovery, advance_recovery::text AS advance_recovery,
            total_deductions::text AS total_deductions, net_before_cap::text AS net_before_cap, net::text AS net,
            payable::text AS payable, rounding::text AS rounding, carried_advance::text AS carried_advance,
            loan_recoveries, unrecovered, breakdown, flags, payment_status, paid_amount::text AS paid_amount, status_note
       FROM hr.run_lines WHERE run_id = $1 AND person_id = $2 FOR UPDATE`, [run.id, personId]);
  const L = line[0];
  if (!L) throw fail(409, 'NOT_IN_MONTH', `This person was not on the ${run.month} payroll, so nothing was deducted there to correct`);

  const u = L.unrecovered && typeof L.unrecovered === 'object' ? L.unrecovered : {};
  const uLoans = new Map((Array.isArray(u.loans) ? u.loans : []).map((x) => [Number(x.loan_id), P(x.amount)]));
  const recs = (Array.isArray(L.loan_recoveries) ? L.loan_recoveries : []).map((x) => ({ loan_id: Number(x.loan_id), kept: P(x.amount) }));
  const loanRows = recs.map((x) => ({ loan_id: x.loan_id, old: x.kept, wanted: x.kept + (uLoans.get(x.loan_id) ?? 0n) }));
  for (const [id, left] of uLoans) if (!loanRows.some((x) => x.loan_id === id)) loanRows.push({ loan_id: id, old: 0n, wanted: left });

  // What the loan owed going into the month: now, plus what this run and any later run took.
  const txns = await qc(
    `SELECT t.kind, t.principal_amount::text AS principal_amount, r.month AS run_month
       FROM hr.loan_txns t LEFT JOIN hr.runs r ON r.id = t.run_id WHERE t.loan_id = $1 ORDER BY t.id`, [loanId]);
  const owedNow = P(loanOutstanding({ id: loanId }, txns));
  const takenSince = txns.filter((t) => t.kind === 'payroll_recovery' && t.run_month && t.run_month >= run.month)
    .reduce((s, t) => s + P(t.principal_amount), 0n);
  const owedBefore = owedNow + takenSince;
  const want = P(amount) < owedBefore ? P(amount) : owedBefore;
  let edited = loanRows.find((x) => x.loan_id === loanId);
  if (!edited) { edited = { loan_id: loanId, old: 0n, wanted: 0n }; loanRows.push(edited); }
  edited.wanted = want < 0n ? 0n : want;

  // The month again, the engine's way.
  const gross = P(L.gross);
  const paidSep = P(L.paid_separately);
  const advKeptOld = P(L.advance_recovery);
  const advWanted = advKeptOld + P(u.advance);
  const otherKeptOld = P(L.misc_deduction) + P(L.adj_deductions);
  const otherWanted = otherKeptOld + P(u.other);
  const wantedTotal = advWanted + loanRows.reduce((s, x) => s + x.wanted, 0n) + otherWanted;
  const nbc = gross - wantedTotal - paidSep;
  let shortBy = nbc < 0n ? -nbc : 0n;
  const cut = (w) => { const c = shortBy > 0n ? (shortBy < w ? shortBy : w) : 0n; shortBy -= c; return w - c; };
  const advKept = cut(advWanted);
  for (const x of [...loanRows].reverse()) x.kept = cut(x.wanted);
  const otherKept = cut(otherWanted);
  const loanKept = loanRows.reduce((s, x) => s + x.kept, 0n);
  const totalDed = advKept + loanKept + otherKept;
  const net = gross - totalDed;
  let payable = net - paidSep;
  if (payable < 0n) payable = 0n;
  const before = payable;
  if ((run.policy?.rounding ?? 'rupee') === 'rupee') payable = roundRupee(payable);
  const rounding = payable - before;
  const carried = P(L.carried_advance) + (advKeptOld - advKept);
  const payDelta = payable - P(L.payable);
  const paid = L.payment_status === 'paid';

  const preview = {
    month: run.month,
    loan: { loan_id: loanId, from: T(edited.old), to: T(edited.kept), asked: T(P(amount)) },
    other_loans: loanRows.filter((x) => x.loan_id !== loanId && x.kept !== x.old).map((x) => ({ loan_id: x.loan_id, from: T(x.old), to: T(x.kept) })),
    advance_recovered: { from: T(advKeptOld), to: T(advKept) },
    advance_carried: { from: T(P(L.carried_advance)), to: T(carried) },
    payable: { from: T(P(L.payable)), to: T(payable) },
    paid,
    arrears: paid && payDelta !== 0n
      ? { month: firstOpen, kind: payDelta > 0n ? 'earning' : 'deduction', amount: T(payDelta < 0n ? -payDelta : payDelta) } : null,
  };
  if (dry) return preview;
  if (paid && payDelta !== 0n && !firstOpen) {
    throw fail(409, 'NO_OPEN_MONTH', 'The line was already paid and its amount moves, but there is no open payroll month to settle the difference in');
  }

  // ── The loan ledger ──
  for (const x of loanRows) {
    if (x.kept === x.old) continue;
    const [row] = await qc(`SELECT id FROM hr.loan_txns WHERE loan_id = $1 AND run_id = $2 AND kind = 'payroll_recovery' FOR UPDATE`, [x.loan_id, run.id]);
    if (x.kept === 0n) {
      if (row) await qc(`DELETE FROM hr.loan_txns WHERE id = $1`, [row.id]);
    } else if (row) {
      await qc(`UPDATE hr.loan_txns SET principal_amount = $2, note = $3 WHERE id = $1`,
        [row.id, T(x.kept), `Payroll ${run.month}: recovered from pay (corrected from ${T(x.old)})`]);
    } else {
      await qc(
        `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, interest_amount, run_id, note, created_by)
         VALUES ($1, (date_trunc('month', ($2 || '-01')::date) + interval '1 month - 1 day')::date, 'payroll_recovery', $3, 0, $4, $5, $6)`,
        [x.loan_id, run.month, T(x.kept), run.id, `Payroll ${run.month}: recovered from pay (added by correction)`, req.user.id]);
    }
    const all = await qc(`SELECT kind, principal_amount::text AS principal_amount FROM hr.loan_txns WHERE loan_id = $1`, [x.loan_id]);
    const owes = P(loanOutstanding({ id: x.loan_id }, all)) > 0n;
    await qc(`UPDATE hr.loans SET status = CASE WHEN $2 THEN 'active' ELSE 'closed' END WHERE id = $1 AND status IN ('active', 'closed')`,
      [x.loan_id, owes]);
  }

  // ── The advance ledger ──
  if (advKept !== advKeptOld) {
    const [row] = await qc(`SELECT id FROM hr.advance_txns WHERE run_id = $1 AND person_id = $2 AND kind = 'recovered' FOR UPDATE`, [run.id, personId]);
    if (advKept === 0n) {
      if (row) await qc(`DELETE FROM hr.advance_txns WHERE id = $1`, [row.id]);
    } else if (row) {
      await qc(`UPDATE hr.advance_txns SET amount = $2, note = $3 WHERE id = $1`,
        [row.id, T(advKept), `Payroll ${run.month}: recovered from pay (corrected from ${T(advKeptOld)})`]);
    } else {
      await qc(
        `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, run_id, source, note, created_by)
         VALUES ($1, (date_trunc('month', ($2 || '-01')::date) + interval '1 month - 1 day')::date, 'recovered', $3, $4, 'payroll', $5, $6)`,
        [personId, run.month, T(advKept), run.id, `Payroll ${run.month}: recovered from pay (added by correction)`, req.user.id]);
    }
  }

  // ── The line ──
  const keptOf = new Map(loanRows.map((x) => [x.loan_id, x.kept]));
  const breakdown = (Array.isArray(L.breakdown) ? L.breakdown : []).map((b) => {
    if (b?.code === 'ADVANCE') return { ...b, amount: T(advKept), rate: T(advKept) };
    const m = /^LOAN:(\d+)$/.exec(String(b?.code ?? ''));
    if (m && keptOf.has(Number(m[1]))) {
      const k = keptOf.get(Number(m[1]));
      return { ...b, amount: T(k), rate: T(k), formula: `${b.formula ?? ''}${Number(m[1]) === loanId ? ` · corrected to ${T(k)}` : ''}`.trim() };
    }
    return b;
  });
  if (!breakdown.some((b) => b?.code === `LOAN:${loanId}`) && edited.kept > 0n) {
    breakdown.push({ qty: '1', code: `LOAN:${loanId}`, kind: 'deduction', rate: T(edited.kept), label: 'Loan', amount: T(edited.kept), formula: 'Added by correction' });
  }
  const unrecovered = {
    loans: loanRows.filter((x) => x.wanted > x.kept).map((x) => ({ loan_id: x.loan_id, amount: T(x.wanted - x.kept) })),
    other: T(otherWanted - otherKept),
    advance: T(advWanted - advKept),
  };
  const short = nbc < 0n;
  const flags = (Array.isArray(L.flags) ? L.flags : []).filter((f) => f?.code !== 'INSUFFICIENT_PAY');
  if (short) {
    const left = [advWanted - advKept > 0n && `advance ₹${T(advWanted - advKept)}`,
      ...loanRows.filter((x) => x.wanted > x.kept).map((x) => `loan ₹${T(x.wanted - x.kept)}`)].filter(Boolean);
    flags.push({ code: 'INSUFFICIENT_PAY', level: 'warn', message: `Pay does not cover every recovery; left owing: ${left.join(', ')}` });
  }
  let noteAdd = null;
  if (paid && payDelta !== 0n) {
    noteAdd = `Payable corrected from ${T(P(L.payable))} to ${T(payable)} after it was paid: ₹${preview.arrears.amount} `
      + `${payDelta > 0n ? 'paid as arrears' : 'recovered'} in ${firstOpen}`;
  }
  await qc(
    `UPDATE hr.run_lines SET loan_recovery = $2, advance_recovery = $3, loan_recoveries = $4::jsonb, total_deductions = $5,
            net_before_cap = $6, net = $7, payable = $8, rounding = $9, carried_advance = $10, unrecovered = $11::jsonb,
            breakdown = $12::jsonb, flags = $13::jsonb, status_note = coalesce($14, status_note)
      WHERE id = $1`,
    [L.id, T(loanKept), T(advKept),
      JSON.stringify(loanRows.filter((x) => x.kept > 0n).map((x) => ({ loan_id: x.loan_id, amount: T(x.kept) }))),
      T(totalDed), T(nbc), T(net), T(payable), T(rounding), T(carried), JSON.stringify(unrecovered),
      JSON.stringify(breakdown), JSON.stringify(flags), noteAdd]);

  // ── A paid line whose amount moved: settled in the first open month ──
  let adjustmentId = null;
  if (paid && payDelta !== 0n) {
    const [adj] = await qc(
      `INSERT INTO hr.adjustments (person_id, kind, category, amount, description, reference, recurrence, start_month, status,
                                   approved_by, approved_at, created_by)
       VALUES ($1, $2, 'arrears', $3, $4, $5, 'one_time', $6, 'approved', $7, now(), $7) RETURNING id`,
      [personId, preview.arrears.kind, preview.arrears.amount,
        `${run.month} loan instalment corrected after payment${note ? `: ${note}` : ''}`.slice(0, 500), `run ${run.month}`, firstOpen, req.user.id]);
    adjustmentId = adj.id;
  }

  // The run's totals, worked out again from its lines.
  const { totalsOf } = await import('./runs.js');
  await qc(`UPDATE hr.runs SET totals = $2::jsonb WHERE id = $1`, [run.id, JSON.stringify(await totalsOf(qc, run.id))]);
  await hrAudit(qc, req, 'run_line', L.id, 'finalised_correction', { ...preview, person_id: personId, note, adjustment_id: adjustmentId });
  return { ...preview, adjustment_id: adjustmentId };
}
