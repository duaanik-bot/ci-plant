// ─── HR payment status: paid / unpaid / on hold ─────────────────────────────
// Each person's line in a month's run carries hr.run_lines.payment_status:
//   pending   shown as "Unpaid": nothing recorded yet
//   paid      the money went (paid_amount = payable, paid_on, paid_ref)
//   on_hold   not to be paid until released (hold_reason, held_by, held_at)
//   failed    a payment that did not go through
//   reversed  a recorded payment taken back (approver)
// (migrations 20261016120000_hr_payroll.sql and 20261018120000_hr_payment_hold.sql)
//
// For totals and reports every line falls in exactly one of three buckets: paid, on_hold, or
// unpaid (pending, failed and reversed — the money has not gone, and nothing stops it going).
// So paid + unpaid + on_hold always covers the whole run, by count and by amount.
//
// Pure: no database, no request. Amounts are exact, through money.js, and come out as 2-dp strings.
import { fmtPaise, rat, toPaise } from './money.js';

export const PAYMENT_STATUSES = Object.freeze(['pending', 'paid', 'on_hold', 'failed', 'reversed']);
export const STATUS_WORD = Object.freeze({
  pending: 'unpaid', paid: 'paid', on_hold: 'on hold', failed: 'failed', reversed: 'reversed',
});
// The by_channel key of a line with no pay channel.
export const NO_CHANNEL = '_none';

export const bucketOf = (status) => (status === 'paid' ? 'paid' : status === 'on_hold' ? 'on_hold' : 'unpaid');

const paise = (v) => (v === null || v === undefined || v === '' ? 0n : toPaise(rat(v)));

// A line's amount in its bucket: what was paid for a paid line (paid_amount, else its payable),
// what is payable for the others.
export function lineAmount(line) {
  if (bucketOf(line?.payment_status) === 'paid') return paise(line?.paid_amount ?? line?.payable);
  return paise(line?.payable);
}

// { paid:{count, amount}, unpaid:{…}, on_hold:{…}, by_channel:{ <code>:{ paid, unpaid, on_hold } } }
// with every amount an exact 2-dp string. A line with no channel is under NO_CHANNEL.
export function paymentTotals(lines) {
  const blank = () => ({ paid: { count: 0, amount: 0n }, unpaid: { count: 0, amount: 0n }, on_hold: { count: 0, amount: 0n } });
  const all = blank();
  const channels = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const bucket = bucketOf(line?.payment_status);
    const amount = lineAmount(line);
    const key = typeof line?.pay_channel === 'string' && line.pay_channel !== '' ? line.pay_channel : NO_CHANNEL;
    if (!channels.has(key)) channels.set(key, blank());
    for (const into of [all, channels.get(key)]) {
      into[bucket].count += 1;
      into[bucket].amount += amount;
    }
  }
  const out = (t) => Object.fromEntries(['paid', 'unpaid', 'on_hold']
    .map((b) => [b, { count: t[b].count, amount: fmtPaise(t[b].amount) }]));
  const keys = [...channels.keys()].sort((a, b) => (a === NO_CHANNEL) - (b === NO_CHANNEL) || (a < b ? -1 : a > b ? 1 : 0));
  return { ...out(all), by_channel: Object.fromEntries(keys.map((k) => [k, out(channels.get(k))])) };
}
