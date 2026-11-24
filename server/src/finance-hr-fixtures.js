// Test-only: invented HR rows for the Finance tests of the HR feed (Cash & Bank plan, Tasks 10 and 11), written with SQL the way HR's own
// routes write them (routes/hr-ledgers.js: Pay staff, Give advance, New loan, Prepay, Waive, the advance sheets; routes/hr-payroll.js:
// Mark paid, a batch or one line, a line marked failed; hr/runs.js: a month's payroll approved, finalised and un-finalised). Imported
// only by tests and by the local walkthrough server's invented demo (server/finance-dev.mjs --cash-demo): no app code imports it, and it
// is not a *.test.js, so `npm test` never runs it. Every name, code and figure in it is invented ("Test Person A", HRF-001).
//
//   const fx = finHrFixtures(h.db);            // the harness's db.js (finance-pg-harness.js)
//   await fx.channels();                       // CASH, COLOUR, DARBI and SPARE
//   const a = await fx.person({ name: 'Test Person A' });
//   const adv = await fx.advance({ person: a, date: '2027-01-11', rupees: 5000, paidVia: 'cash', by: userId });
//
// Amounts are rupees, as HR's NUMERIC(12,2) columns hold them. `by` is a public.users id: who did it in HR (created_by, approved_by,
// decided_by). A row HR writes with its own audit row (an advance given, a loan made) gets one here too, the way HR writes it
// (hr/audit.js). The paid-from code on an advance row or a loan's disbursal (`paid_via`, the HR migration of Cash & Bank) is written
// as Task 12 will write it from Pay staff, Give advance and New loan; an advance sheet's rows carry none unless `viaOnRows` says so,
// as HR posts a sheet today (a loan keeps its own hr.loans.paid_via, which HR has always written).

const money = rupees => Number(rupees).toFixed(2);
const monthOf = date => date.slice(0, 7);
const daysIn = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export function finHrFixtures(db) {
  let made = 0;
  const nextCode = () => `HRF-${String(++made).padStart(3, '0')}`;
  const sheetLoanNos = new Map();   // a sheet's loan line id -> the loan number its posting mints (HR mints one per loan line)
  // HR's own trail, as hrAudit writes it: entity_id is text, detail is JSON.
  const audit = (by, entity, entityId, action, detail) => db.q(
    `INSERT INTO hr.audit_log (user_id, user_name, entity, entity_id, action, detail) VALUES ($1, NULL, $2, $3, $4, $5::jsonb)`,
    [by ?? null, entity, String(entityId), action, JSON.stringify(detail)]);

  // HR's door, as its own audit rows name it: Pay staff writes via 'staff_payment', an advance sheet via 'advance_sheet', and Give
  // advance or New loan on Loans & Advances no via at all.
  const DOOR_VIA = Object.freeze({ pay_staff: { via: 'staff_payment' }, sheet: { via: 'advance_sheet' }, loans: {} });

  // An advance given, kind 'given' and source 'manual', as postAdvance writes it, with HR's 'give' audit row. `door`: 'pay_staff',
  // 'loans' or 'sheet' (DOOR_VIA). `storeVia` false leaves the row's paid_via empty, as HR posts a sheet's advances today.
  async function given({ person, date, rupees, paidVia = null, door = 'pay_staff', note = null, by = null, storeVia = true }) {
    const row = await db.one(
      `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note, created_by, for_month, paid_via)
       VALUES ($1, $2::date, 'given', $3, 'manual', $4, $5, $6, $7) RETURNING id`,
      [person, date, money(rupees), note ?? (door === 'pay_staff' ? `Paid via ${paidVia ?? 'cash'}` : null), by, monthOf(date),
        storeVia ? paidVia : null]);
    await audit(by, 'advance', person, 'give', { ...DOOR_VIA[door], txn_id: row.id, amount: money(rupees), date, paid_via: paidVia });
    return row.id;
  }

  // A loan and its first ledger row: the disbursal (or, for an opening loan, the opening balance), as insertLoan writes them, with HR's
  // 'create' audit row naming its door (DOOR_VIA; New loan, 'loans', by default). hr.loans.paid_via is always written, as HR writes it;
  // the disbursal's own paid_via only when `storeVia`.
  async function lend({ person, loanNo, date, rupees, paidVia = null, opening = false, status = 'active', door = 'loans', by = null, storeVia = true }) {
    const loan = await db.one(
      `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, interest_rate, instalment, first_due_month, paid_via, status,
                             is_opening, created_by)
       VALUES ($1, $2, $3, $4::date, 0, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [loanNo, person, money(rupees), date, money(Math.ceil(rupees / 10)), monthOf(date), paidVia, status, opening, by]);
    const txn = await db.one(
      `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by, paid_via)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7) RETURNING id`,
      [loan.id, date, opening ? 'opening' : 'disbursed', money(rupees), opening ? 'Opening balance' : 'Loan issued', by,
        storeVia ? paidVia : null]);
    await audit(by, 'loan', loan.id, 'create', { ...DOOR_VIA[door], loan_no: loanNo, person_id: person, principal: money(rupees), is_opening: opening });
    return { id: loan.id, txnId: txn.id };
  }

  return {
    // HR's pay channels: the cash channel and three banks.
    async channels() {
      await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES
        ('CASH', 'Cash', 'cash'), ('COLOUR', 'Colour bank', 'bank'), ('DARBI', 'Darbi bank', 'bank'), ('SPARE', 'Spare bank', 'bank')`);
    },

    // A person, of a firm (COLOUR, DARBI or none) and paid through a channel; an employee or a contractor (hr.people.worker_type), of a
    // department or none.
    async person({ name, firm = 'COLOUR', channel = 'CASH', type = 'employee', dept = null }) {
      return (await db.one(`INSERT INTO hr.people (code, name, firm, pay_channel, worker_type, department) VALUES ($1, $2, $3, $4, $5, $6)
                            RETURNING id`, [nextCode(), name, firm, channel, type, dept])).id;
    },

    // A person hidden from a login (hr.access_hidden): mode 'pay' (no amounts) or 'all' (not there at all).
    async hide(person, { user, mode = 'pay' }) {
      await db.q(`INSERT INTO hr.access_hidden (user_id, person_id, mode, set_by) VALUES ($1, $2, $3, $1)`, [user, person, mode]);
    },
    // …and shown again, to every login (Settings takes the person off each hide list).
    async unhide(person) {
      await db.q('DELETE FROM hr.access_hidden WHERE person_id = $1', [person]);
    },

    // A login's HR level (hr.access): viewer, accounts, operator, approver or admin.
    async access(user, level) {
      await db.q(`INSERT INTO hr.access (user_id, level, granted_by) VALUES ($1, $2, $1)
                  ON CONFLICT (user_id) DO UPDATE SET level = EXCLUDED.level`, [user, level]);
    },

    advance: given,

    // An advance waived by an approver: kind 'waived', source 'waiver'.
    async waiver({ person, date, rupees, by = null }) {
      return (await db.one(
        `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note, created_by)
         VALUES ($1, $2::date, 'waived', $3, 'waiver', 'Waived', $4) RETURNING id`, [person, date, money(rupees), by])).id;
    },

    loan: lend,

    // Money taken back on a loan before payroll does: kind 'prepayment', received into `paidVia`.
    async prepay({ loan, date, rupees, paidVia = null, by = null }) {
      return (await db.one(
        `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by, paid_via)
         VALUES ($1, $2::date, 'prepayment', $3, 'Prepayment', $4, $5) RETURNING id`, [loan, date, money(rupees), by, paidVia])).id;
    },

    // The month's run, made once (hr.runs.month is unique).
    async run(month, status = 'finalised') {
      const made = await db.one(
        `INSERT INTO hr.runs (month, status, days_in_month, finalised_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (month) DO NOTHING RETURNING id`, [month, status, daysIn(month)]);
      return made ? made.id : (await db.one('SELECT id FROM hr.runs WHERE month = $1', [month])).id;
    },

    // A confirmed payment batch (Mark paid for a channel) and its lines, each approved for payment by `approvedBy` (null: a line paid
    // before per-person approval existed, which the migration recorded as approved with no approver) and paid in the batch. A line
    // `paid: false` was marked failed since (HR leaves its batch on it). `reference` is the bank reference HR keeps on the batch.
    async batch({ run, channel, batchNo, paidOn, paidFrom = null, reference = null, lines, by = null }) {
      const total = lines.filter(l => l.paid !== false).reduce((sum, l) => sum + Math.round(l.rupees * 100), 0) / 100;
      const batch = await db.one(
        `INSERT INTO hr.payment_batches (run_id, pay_channel, count, total, status, reference, paid_on, confirmed_by, confirmed_at,
                                         created_by, batch_no, paid_from)
         VALUES ($1, $2, $3, $4, 'confirmed', $5, $6::date, $7, now(), $7, $8, $9) RETURNING id`,
        [run, channel, lines.length, money(total), reference, paidOn, by, batchNo, paidFrom]);
      const ids = [];
      for (const l of lines) {
        const paid = l.paid !== false;
        ids.push((await db.one(
          `INSERT INTO hr.run_lines (run_id, person_id, gross, payable, pay_channel, payment_status, payment_batch_id, paid_amount, paid_on,
                                     paid_at, paid_ref, approval_status, approved_by, approved_at)
           VALUES ($1, $2, $3, $3, $4, $5, $6, CASE WHEN $7 THEN $3::numeric END, CASE WHEN $7 THEN $8::date END,
                   CASE WHEN $7 THEN now() END, $9, 'approved', $10, now()) RETURNING id`,
          [run, l.person, money(l.rupees), channel, paid ? 'paid' : 'failed', batch.id, paid, paidOn, reference, l.approvedBy ?? null])).id);
      }
      return { id: batch.id, lineIds: ids };
    },

    // One line of a run marked paid on its own, with no batch (the line drawer's Mark paid), or left unpaid (`status` 'pending').
    async line({ run, person, rupees, paidOn, paidFrom = null, channel = 'CASH', approvedBy = null, status = 'paid', reference = null }) {
      const paid = status === 'paid';
      return (await db.one(
        `INSERT INTO hr.run_lines (run_id, person_id, gross, payable, pay_channel, payment_status, paid_amount, paid_on, paid_at, paid_ref,
                                   paid_from, approval_status, approved_by, approved_at)
         VALUES ($1, $2, $3, $3, $4, $5, CASE WHEN $6 THEN $3::numeric END, CASE WHEN $6 THEN $7::date END, CASE WHEN $6 THEN now() END,
                 $8, $9, 'approved', $10, now()) RETURNING id`,
        [run, person, money(rupees), channel, status, paid, paidOn, reference, paidFrom, approvedBy])).id;
    },

    // Lines a payroll() made, paid now in a confirmed batch of a channel (Mark paid), paid_amount = payable, as HR's route pays them.
    async payBatch({ lineIds, channel, batchNo, paidOn, paidFrom = null, by = null }) {
      const run = (await db.one('SELECT run_id FROM hr.run_lines WHERE id = $1', [lineIds[0]])).run_id;
      const batch = await db.one(
        `INSERT INTO hr.payment_batches (run_id, pay_channel, count, total, status, paid_on, confirmed_by, confirmed_at, created_by, batch_no, paid_from)
         SELECT $1, $2, count(*), coalesce(sum(payable), 0), 'confirmed', $3::date, $4::int, now(), $4::int, $5, $6 FROM hr.run_lines WHERE id = ANY($7::int[])
         RETURNING id`, [run, channel, paidOn, by, batchNo, paidFrom, lineIds]);
      await db.q(`UPDATE hr.run_lines SET payment_status = 'paid', payment_batch_id = $2, paid_amount = payable, paid_on = $3::date, paid_at = now()
                   WHERE id = ANY($1::int[])`, [lineIds, batch.id, paidOn]);
      return batch.id;
    },

    // A line paid since, marked failed (the line drawer) or reversed (an approver): HR clears what was paid and keeps the batch link.
    async markLine(lineId, status) {
      await db.q(`UPDATE hr.run_lines SET payment_status = $2, paid_amount = NULL, paid_on = NULL, paid_at = NULL WHERE id = $1`,
        [lineId, status]);
    },

    // A month's payroll, approved in HR by `approvedBy` and not finalised yet: the run and one line per person, worked out the engine's
    // way (hr/engine.js): gross, then the deductions (advance and loan recovery, a misc deduction, approved adjustments, `breakdown`
    // components such as a sub-account's ADJ:SUB…), what was paid separately, and the payable rounded to the rupee, half away from
    // zero, with that rounding kept. Rupees in, as HR's columns hold them. An `advanceGiven` is an advance written on the month's
    // payroll sheet, which finalise posts. Answers { id, lineIds }.
    async payroll({ month, approvedBy = null, lines }) {
      const run = await db.one(
        `INSERT INTO hr.runs (month, status, days_in_month, approved_by, approved_at) VALUES ($1, 'approved', $2, $3, now()) RETURNING id`,
        [month, daysIn(month), approvedBy]);
      const paise = rupees => Math.round(Number(rupees ?? 0) * 100);
      const lineIds = [];
      for (const l of lines) {
        const gross = paise(l.gross);
        const taken = paise(l.advanceRecovery) + paise(l.loanRecovery) + paise(l.misc) + paise(l.adj);
        const before = gross - taken - paise(l.paidSeparately);
        const payable = Math.sign(before) * Math.round(Math.abs(before) / 100) * 100;
        const channel = (await db.one('SELECT pay_channel FROM hr.people WHERE id = $1', [l.person])).pay_channel;
        lineIds.push((await db.one(
          `INSERT INTO hr.run_lines (run_id, person_id, gross, advance_recovery, loan_recovery, misc_deduction, adj_deductions,
                                     total_deductions, paid_separately, net, payable, rounding, advance_given, breakdown, pay_channel,
                                     approval_status, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 'approved', $16, now()) RETURNING id`,
          [run.id, l.person, money(gross / 100), money(paise(l.advanceRecovery) / 100), money(paise(l.loanRecovery) / 100),
            money(paise(l.misc) / 100), money(paise(l.adj) / 100), money(taken / 100), money(paise(l.paidSeparately) / 100),
            money((gross - taken) / 100), money(payable / 100), money((payable - before) / 100), money(paise(l.advanceGiven) / 100),
            JSON.stringify(l.breakdown ?? []), channel, approvedBy])).id);
      }
      return { id: run.id, lineIds };
    },

    // Approved → finalised, as hr/runs.js finaliseRun posts it: for each line, an advance 'given' (the month's sheet advance, dated the
    // month end or the finalise day, whichever is earlier) and 'recovered' (the finalise day), source 'payroll', and the run stamped
    // finalised by `by` at `at` (an ISO moment, so its plant day can be any day of the books).
    async finalise(runId, { at, by = null }) {
      const run = await db.one('SELECT month FROM hr.runs WHERE id = $1', [runId]);
      const monthEnd = `${run.month}-${String(daysIn(run.month)).padStart(2, '0')}`;
      const day = (await db.one(`SELECT (($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date::text AS day`, [at])).day;
      await db.q(
        `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, run_id, source, note, created_by)
         SELECT person_id, LEAST($2::date, $3::date), 'given', advance_given, run_id, 'payroll', 'Payroll: advance from the month''s sheet', $4::int
           FROM hr.run_lines WHERE run_id = $1 AND advance_given > 0
         UNION ALL
         SELECT person_id, $3::date, 'recovered', advance_recovery, run_id, 'payroll', 'Payroll: recovered from pay', $4::int
           FROM hr.run_lines WHERE run_id = $1 AND advance_recovery > 0`, [runId, monthEnd, day, by]);
      await db.q(`UPDATE hr.runs SET status = 'finalised', finalised_by = $2, finalised_at = $3::timestamptz WHERE id = $1`, [runId, by, at]);
    },

    // Finalised → approved again, as hr/runs.js unfinaliseRun takes it back: the run's payroll advance rows deleted, the stamp cleared.
    async unfinalise(runId) {
      await db.q(`DELETE FROM hr.advance_txns WHERE run_id = $1 AND source = 'payroll'`, [runId]);
      await db.q(`UPDATE hr.runs SET status = 'approved', finalised_by = NULL, finalised_at = NULL WHERE id = $1`, [runId]);
    },

    // An advance sheet, CI-ADV-…, submitted, with its lines, each an advance or a loan (`loanNo`, minted when it posts), approved by
    // `decidedBy`, or still pending without one. Nothing on it is posted yet: postRound posts. Answers { id, lineIds }, the line ids in
    // the order the lines were given.
    async sheet({ sheetNo, month, paidOn, paidVia = 'cash', lines, by = null }) {
      const sheet = await db.one(
        `INSERT INTO hr.advance_sheets (sheet_no, month, paid_on, paid_via, status, created_by, submitted_by, submitted_at)
         VALUES ($1, $2, $3::date, $4, 'submitted', $5, $5, now()) RETURNING id`, [sheetNo, month, paidOn, paidVia, by]);
      const lineIds = [];
      for (const l of lines) {
        const kind = l.loanNo ? 'loan' : 'advance';
        const line = await db.one(
          `INSERT INTO hr.advance_sheet_lines (sheet_id, person_id, kind, amount, instalments, decision, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::int IS NULL THEN NULL ELSE now() END) RETURNING id`,
          [sheet.id, l.person, kind, money(l.rupees), kind === 'loan' ? 10 : null, l.decidedBy ? 'approved' : 'pending', l.decidedBy ?? null]);
        if (kind === 'loan') sheetLoanNos.set(line.id, l.loanNo);
        lineIds.push(line.id);
      }
      return { id: sheet.id, lineIds };
    },

    // Management approves lines of a submitted sheet (POST /hr/advance-sheets/:id/decide).
    async decide(lineIds, { by }) {
      await db.q(`UPDATE hr.advance_sheet_lines SET decision = 'approved', decided_by = $2, decided_at = now() WHERE id = ANY($1::int[])`,
        [lineIds, by]);
    },

    // One posting round of a sheet (POST /hr/advance-sheets/:id/post), the way HR posts it through Pay staff's path: each line an
    // advance (a 'given' row) or a loan with its disbursal, dated the sheet's paid_on, and linked to what it became; and every line of the
    // round stamped with ONE posted_at, as HR's one transaction stamps them (here one statement, so one now()). The sheet is posted once no
    // line of it is pending. A loan keeps the sheet's paid_via on hr.loans, as HR writes it; the rows' own paid_via only `viaOnRows`.
    // Answers { advances, loans }: the rows the round made.
    async postRound(sheetId, lineIds, { by = null, viaOnRows = false } = {}) {
      const sheet = await db.one('SELECT sheet_no, month, paid_on::text AS paid_on, paid_via FROM hr.advance_sheets WHERE id = $1', [sheetId]);
      const lines = await db.q('SELECT id, person_id, kind, amount FROM hr.advance_sheet_lines WHERE id = ANY($1::int[]) ORDER BY person_id', [lineIds]);
      const links = { ids: [], advances: [], loans: [] };
      for (const l of lines) {
        const advance = l.kind === 'advance'
          ? await given({ person: l.person_id, date: sheet.paid_on, rupees: l.amount, paidVia: sheet.paid_via, door: 'sheet',
            note: `${sheet.sheet_no} for ${sheet.month}`, by, storeVia: viaOnRows })
          : null;
        const loan = l.kind === 'loan'
          ? (await lend({ person: l.person_id, loanNo: sheetLoanNos.get(l.id), date: sheet.paid_on, rupees: l.amount, paidVia: sheet.paid_via,
            door: 'sheet', by, storeVia: viaOnRows })).id
          : null;
        links.ids.push(l.id);
        links.advances.push(advance);
        links.loans.push(loan);
      }
      await db.q(
        `UPDATE hr.advance_sheet_lines sl SET advance_txn_id = v.advance, loan_id = v.loan, posted_at = now()
           FROM unnest($1::int[], $2::int[], $3::int[]) AS v(id, advance, loan) WHERE sl.id = v.id`,
        [links.ids, links.advances, links.loans]);
      await db.q(
        `UPDATE hr.advance_sheets SET status = 'posted', posted_by = $2, posted_at = now()
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM hr.advance_sheet_lines WHERE sheet_id = $1 AND decision = 'pending')`, [sheetId, by]);
      return { advances: links.advances.filter(id => id != null), loans: links.loans.filter(id => id != null) };
    },

    // What HR lets a sheet go through after a round has posted (routes/hr-ledgers.js), the reason a round is booked from the rows it
    // made and not from the sheet (ruling R25): sent back to draft (POST …/send-back); its paid_on and paid_via changed (PUT …/:id); a line
    // rewritten with a new amount, decided again from pending, its posted_at and links kept (PUT …/lines); a line dropped (PUT …/lines).
    async sendBack(sheetId) {
      await db.q(`UPDATE hr.advance_sheets SET status = 'draft', sent_back_at = now(), sent_back_reason = 'Test send-back' WHERE id = $1`, [sheetId]);
    },
    async editSheet(sheetId, { paidOn, paidVia }) {
      await db.q('UPDATE hr.advance_sheets SET paid_on = $2::date, paid_via = $3 WHERE id = $1', [sheetId, paidOn, paidVia]);
    },
    async rewriteLine(lineId, { rupees }) {
      await db.q(`UPDATE hr.advance_sheet_lines SET amount = $2, decision = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1`,
        [lineId, money(rupees)]);
    },
    async dropLine(lineId) {
      await db.q('DELETE FROM hr.advance_sheet_lines WHERE id = $1', [lineId]);
    },

    // HR's Cancel of a loan before anything was taken back (POST /hr/loans/:id/cancel): what was lent reversed by an adjustment row
    // dated `date`, and the loan cancelled.
    async cancelLoan(loanId, { date }) {
      await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note)
                  SELECT id, $2::date, 'adjustment', -principal, 'Loan cancelled' FROM hr.loans WHERE id = $1`, [loanId, date]);
      await db.q(`UPDATE hr.loans SET status = 'cancelled' WHERE id = $1`, [loanId]);
    },
  };
}
