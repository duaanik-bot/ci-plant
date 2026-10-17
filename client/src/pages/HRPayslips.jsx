// Payslips print page, /hr/payslips/:month — one A4 slip per person (spec §13 item 1).
//
//   /hr/payslips/2026-07                       everyone in the month's run
//   /hr/payslips/2026-07?person_ids=3,9        those people only
//   /hr/payslips/2026-07?channel=CASH          one pay channel
//
// The payload is GET /hr/runs/:month/payslips: { company:{name,gstin,address}, run, slips:[…] }.
// Every figure on a slip is printed as the server worked it out (exact 2-dp strings, formatted with
// inr2, never added up here). The only conversion is the payable into words, which is wording, not
// arithmetic. Each slip says its payment status (Paid with date and reference, Unpaid, On hold). Nothing is logged and no amount goes near document.title: the browser seeds the
// print-to-PDF file name from it, so it reads "Payslips July 2026 Cash".
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '../components/ui.jsx';
import { fmt } from '../api.js';
import { hrApi, inr2, monthLabel } from '../lib/hr.js';
import { rupeesInWords } from '../lib/amountWords.js';
import { MONTH_RE, list, paiseOf, qtyText } from './hr/RunLineDrawer.jsx';

const nonZero = v => (paiseOf(v) ?? 0n) !== 0n;

function Row({ label, value, strong = false }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-0.5 ${strong ? 'font-extrabold text-gray-900' : 'text-gray-700'}`}>
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

// The slip's payment status, as recorded: Paid (date, reference), On hold, or Unpaid. The reason for a hold is
// not printed — the slip goes to the employee; it is on the screen and in the On hold report.
const PAY_WORDS = { pending: 'Unpaid', paid: 'Paid', on_hold: 'On hold', failed: 'Payment failed', reversed: 'Payment reversed' };
function PaymentLine({ payment }) {
  const st = payment?.status;
  if (!st) return null;
  const ref = payment.reference ?? payment.paid_ref;
  return (
    <p className="mt-1 text-xs text-gray-700">
      Payment: <b>{PAY_WORDS[st] || st}</b>
      {st === 'paid' && payment.paid_on && <> on <b>{fmt.date(payment.paid_on)}</b></>}
      {st === 'paid' && ref && <> · ref <span className="font-mono">{ref}</span></>}
    </p>
  );
}

function Slip({ slip, company, monthName }) {
  const p = slip.person || {};
  const t = slip.totals || {};
  const comps = list(slip.components).filter(c => c && typeof c === 'object');
  const earnings = comps.filter(c => c.kind === 'earning');
  const deductions = comps.filter(c => c.kind === 'deduction');
  const info = comps.filter(c => c.kind !== 'earning' && c.kind !== 'deduction');
  const loans = list(slip.loans);
  const adv = slip.advance || {};
  const short = slip.insufficient_pay;
  const d = slip.days || {};
  const rows = Math.max(earnings.length, deductions.length, 1);
  const channel = p.pay_channel_label || p.pay_channel || '';
  const money = c => inr2(c.amount);

  return (
    <section className="print-fit slip rounded-2xl border border-slate-200 bg-white p-8 text-[13px] shadow-card print:min-h-0 print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <div className="border-b-2 border-gray-900 pb-3">
        <h1 className="text-lg font-extrabold tracking-wide text-gray-900">{String(company?.name || 'Colour Impressions').toUpperCase()}</h1>
        {company?.address && <p className="text-xs text-gray-600">{company.address}</p>}
        {company?.gstin && <p className="text-xs text-gray-600">GSTIN: <b>{company.gstin}</b></p>}
        <p className="mt-1 text-sm font-bold text-gray-800">Payslip for {monthName}</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-700">
        <div>Employee code: <b>{p.code || '—'}</b></div>
        <div>Month: <b>{monthName}</b></div>
        <div>Name: <b>{p.name || '—'}</b></div>
        <div>Days in month: <b>{qtyText(d.days)}</b></div>
        <div>Department: <b>{p.department || '—'}</b></div>
        <div>Days present: <b>{qtyText(d.present_days)}</b></div>
        <div>Pay channel: <b>{channel || '—'}</b></div>
        {p.designation ? <div>Designation: <b>{p.designation}</b></div> : <div />}
      </div>

      <table className="mt-4 w-full border border-gray-300 text-xs">
        <thead>
          <tr className="bg-gray-100 text-left text-[10px] font-bold uppercase tracking-wide text-gray-600">
            <th className="border-r border-gray-300 px-2 py-1.5">Earnings</th>
            <th className="border-r border-gray-300 px-2 py-1.5 text-right">Amount</th>
            <th className="border-r border-gray-300 px-2 py-1.5">Deductions</th>
            <th className="px-2 py-1.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => {
            const e = earnings[i];
            const x = deductions[i];
            return (
              <tr key={i} className="align-top">
                <td className="border-r border-gray-200 px-2 py-1">{e?.label || e?.code || ''}{e?.formula && <span className="block text-[10px] text-gray-400">{e.formula}</span>}</td>
                <td className="border-r border-gray-300 px-2 py-1 text-right tabular-nums">{e ? money(e) : ''}</td>
                <td className="border-r border-gray-200 px-2 py-1">{x?.label || x?.code || ''}</td>
                <td className="px-2 py-1 text-right tabular-nums">{x ? money(x) : ''}</td>
              </tr>
            );
          })}
          <tr className="border-t border-gray-300 bg-gray-50 font-bold">
            <td className="border-r border-gray-200 px-2 py-1.5">Gross earnings</td>
            <td className="border-r border-gray-300 px-2 py-1.5 text-right tabular-nums">{inr2(t.gross)}</td>
            <td className="border-r border-gray-200 px-2 py-1.5">Total deductions</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{inr2(t.total_deductions)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-3 ml-auto w-72 text-xs">
        <Row label="Net pay" value={inr2(t.net)} />
        {nonZero(t.paid_separately) && <Row label="Less: paid separately" value={`-${inr2(t.paid_separately)}`} />}
        {nonZero(t.rounding) && <Row label="Rounding" value={inr2(t.rounding)} />}
        <div className="mt-1 border-t-2 border-gray-900 pt-1"><Row label="Net payable" value={inr2(t.payable)} strong /></div>
      </div>
      <p className="mt-1 text-xs italic text-gray-700">{rupeesInWords(Number(t.payable))}</p>
      <PaymentLine payment={slip.payment} />

      {(loans.length > 0 || adv.balance_after != null) && (
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
          <div className="rounded-lg border border-gray-200 p-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Loan details</div>
            {loans.length === 0 ? <p className="text-gray-500">No loan.</p> : loans.map(l => (
              <div key={l.loan_id ?? l.loan_no} className="mb-1.5">
                <div className="font-semibold text-gray-800">{l.loan_no}</div>
                <Row label="Instalment" value={inr2(l.instalment)} />
                <Row label="Recovered this month" value={inr2(l.recovered)} />
                <Row label="Outstanding after this month" value={inr2(l.outstanding_after)} />
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-gray-200 p-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Advance</div>
            {nonZero(adv.given) && <Row label="Given this month" value={inr2(adv.given)} />}
            {nonZero(adv.recovered) && <Row label="Recovered this month" value={inr2(adv.recovered)} />}
            <Row label="Balance after this month" value={inr2(adv.balance_after)} strong />
          </div>
        </div>
      )}

      {short && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Pay for this month was not enough to cover every recovery. The part not recovered stays owing and is carried to
          the next month{nonZero(short.total) ? ` (${inr2(short.total)})` : ''}.
        </p>
      )}
      {info.some(c => c.code === 'PAID_SEPARATELY') && (
        <p className="mt-2 text-[10px] text-gray-400">Paid separately: already paid outside this payroll and taken off the amount payable.</p>
      )}

      <div className="mt-14 flex items-end justify-between text-xs text-gray-700">
        <div className="w-52 border-t border-gray-500 pt-1">Prepared by</div>
        <div className="w-52 border-t border-gray-500 pt-1 text-right">Employee signature</div>
      </div>
    </section>
  );
}

export default function HRPayslips() {
  const { month } = useParams();
  const [params] = useSearchParams();
  const personIds = params.get('person_ids') || '';
  const channel = params.get('channel') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!MONTH_RE.test(month || '')) { setError('That is not a payroll month.'); return undefined; }
    let live = true;
    setData(null);
    setError('');
    hrApi.payslips(month, {
      person_ids: personIds ? personIds.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      channel: channel || undefined,
    }).then(
      d => { if (live) setData(d); },
      e => { if (live) setError(e?.data?.error || e?.message || 'The payslips could not be loaded.'); },
    );
    return () => { live = false; };
  }, [month, personIds, channel]);

  const slips = useMemo(() => list(data?.slips), [data]);
  const filterText = channel
    ? (slips[0]?.person?.pay_channel_label || channel)
    : personIds ? (slips.length === 1 ? slips[0]?.person?.name || 'one person' : `${slips.length || personIds.split(',').length} people`) : 'All';

  // The print-to-PDF file name; restored on leave so no other page prints under it. No amounts.
  const title = `Payslips ${monthLabel(month)} ${filterText}`.trim();
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);

  const finalised = data?.run?.status === 'finalised';
  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link to={`/hr?tab=payroll&month=${encodeURIComponent(month || '')}`}>
          <Button variant="secondary"><ArrowLeft size={14} /> Back</Button>
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#6E6E73]">{monthLabel(month)} · {filterText} · {slips.length} {slips.length === 1 ? 'slip' : 'slips'}</span>
          <Button onClick={() => window.print()} disabled={!slips.length}><Printer size={14} /> Print</Button>
        </div>
      </div>

      {error && <p role="alert" className="no-print rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>}
      {!data && !error && <div className="no-print p-8 text-sm text-slate-400">Loading payslips…</div>}
      {data && !data.run && <p className="no-print rounded-xl bg-white/70 px-4 py-3 text-sm text-[#515154]">There is no payroll for {monthLabel(month)} yet.</p>}
      {data?.run && !finalised && slips.length > 0 && (
        <p className="no-print mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800">
          Preview — this month is not finalised, so these figures can still change.
        </p>
      )}
      {data?.run && slips.length === 0 && !error && (
        <p className="no-print rounded-xl bg-white/70 px-4 py-3 text-sm text-[#515154]">No payslip matches this request.</p>
      )}

      <div className="space-y-6 print:space-y-0">
        {slips.map((s, i) => (
          <div key={s.person?.id ?? i} className={i > 0 ? 'print:break-before-page' : ''}>
            <Slip slip={s} company={data.company} monthName={monthLabel(month)} />
          </div>
        ))}
      </div>
    </div>
  );
}
