// Advances paid in a payroll month, person by person (owner, 2026-11-26): what the Payroll page's "Advances paid" card
// and list and the Overview tile show. It is the same figure payroll recovers for the month (hr/runs.js newAdvance):
//   entry sheet   run_inputs.advance_given of each included row (the advance list entered for the month)
//   Pay staff     the month's in-app advances — kind 'given', source 'manual', in the payroll month they are
//                 deducted in (coalesce(for_month, month of txn_date)), exactly as hr/ledger.js inAppAdvancesInMonth
// and a person's month total is sheet + Pay staff for an 'extra' row, the larger of the two for a 'total' row (the
// sheet then already counts what Pay staff gave), and the Pay staff figure for someone with no sheet advance. So an
// advance paid by Pay staff shows in the totals as soon as it is paid, before the month's sheet is imported.
//
// `exclude`: person ids hidden from this login (hr/privacy.js). Money comes back as exact strings (2 decimals).

const paise = (v) => {
  const s = String(v ?? '0').trim();
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^[-+]/, '').split('.');
  const n = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0');
  return neg ? -n : n;
};
const rupees = (p) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

export async function monthAdvances(q, runId, month, exclude = []) {
  const rows = await q(
    `WITH sheet AS (
       SELECT person_id, advance_given AS amount, advance_mode, remarks
         FROM hr.run_inputs
        WHERE run_id = $1 AND include AND coalesce(advance_given, 0) <> 0
     ), app AS (
       SELECT person_id, sum(amount) AS amount, count(*)::int AS payments
         FROM hr.advance_txns
        WHERE kind = 'given' AND source = 'manual'
          AND coalesce(for_month, to_char(txn_date, 'YYYY-MM')) = $2
        GROUP BY person_id
     )
     SELECT p.id AS person_id, p.code, coalesce(p.display_name, p.name) AS name, p.department, p.pay_channel,
            coalesce(s.amount, 0)::numeric(14,2)::text AS sheet,
            coalesce(a.amount, 0)::numeric(14,2)::text AS pay_staff,
            coalesce(a.payments, 0) AS pay_staff_payments,
            (CASE WHEN s.advance_mode = 'total' THEN greatest(coalesce(s.amount, 0), coalesce(a.amount, 0))
                  ELSE coalesce(s.amount, 0) + coalesce(a.amount, 0) END)::numeric(14,2)::text AS amount,
            s.advance_mode, s.remarks
       FROM sheet s FULL JOIN app a USING (person_id)
       JOIN hr.people p ON p.id = coalesce(s.person_id, a.person_id)
      WHERE p.id <> ALL($3::int[])
      ORDER BY p.pay_channel NULLS LAST, p.code`,
    [runId ?? null, month, exclude]);
  const people = rows.filter((r) => paise(r.amount) !== 0n);
  const byChannel = new Map();
  let total = 0n;
  let sheet = 0n;
  let payStaff = 0n;
  for (const r of people) {
    total += paise(r.amount);
    sheet += paise(r.sheet);
    payStaff += paise(r.pay_staff);
    const key = r.pay_channel ?? null;
    const c = byChannel.get(key) || { pay_channel: key, people: 0, amount: 0n };
    c.people += 1;
    c.amount += paise(r.amount);
    byChannel.set(key, c);
  }
  return {
    total: rupees(total),
    people: people.length,
    sheet_total: rupees(sheet),
    pay_staff_total: rupees(payStaff),
    by_channel: [...byChannel.values()].map((c) => ({ ...c, amount: rupees(c.amount) })),
    rows: people,
  };
}
