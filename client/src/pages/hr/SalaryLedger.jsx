// HR · a person's salary ledger (owner's request 2026-11-05): every month's payroll since they joined, oldest first,
// with the days, earnings, each deduction, net, payable (short pay in red), the advance carried and the payment —
// a total under it, Excel / PDF export, and any month opened to its full worked-out breakdown.
// GET /hr/people/:id/salary-ledger. A login whose view of this person's pay is hidden gets 404 (server hr/privacy.js).
import { useEffect, useMemo, useState } from 'react';
import { DataTable } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';

const P = v => { const t = String(v ?? '0'); const neg = t.startsWith('-'); const [i, f = ''] = (neg ? t.slice(1) : t).split('.'); const p = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -p : p; };
const T = p => { const a = p < 0n ? -p : p; return `${p < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const sum = (rows, k) => T(rows.reduce((t, r) => t + P(r[k]), 0n));
const RUN = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', finalised: 'Finalised' };
const PAY = { paid: 'Paid', pending: 'Unpaid', on_hold: 'On hold', failed: 'Failed', reversed: 'Reversed' };

export default function SalaryLedger({ pid }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [Breakdown, setBreakdown] = useState(null);
  useEffect(() => {
    let live = true;
    hrApi.salaryLedger(pid).then(d => { if (live) setData(d); }, e => { if (live) setError(e?.data?.error || e?.message || 'The ledger could not be loaded'); });
    // Loaded on demand: RunLineDrawer imports PersonDrawer, which imports this file.
    import('./RunLineDrawer.jsx').then(m => { if (live) setBreakdown(() => m.Breakdown); });
    return () => { live = false; };
  }, [pid]);
  const months = useMemo(() => (Array.isArray(data?.months) ? data.months : []).slice().reverse(), [data]);
  const totals = useMemo(() => ({
    _total: true, month: 'Total',
    ...Object.fromEntries(['gross', 'advance_recovery', 'loan_recovery', 'other', 'total_deductions', 'net', 'payable', 'paid_amount', 'advance_given']
      .map(k => [k, k === 'other' ? T(months.reduce((t, r) => t + P(r.misc_deduction) + P(r.adj_deductions), 0n)) : sum(months, k)])),
  }), [months]);
  if (error) return <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>;
  if (!data) return <div className="p-6 text-sm text-slate-400">Reading the ledger…</div>;
  const p = data.person;
  const m = (key, label, pick = r => r[key], extra = {}) => ({
    key, label, align: 'right', sortable: false, export: r => inr2(pick(r)),
    render: r => <span className={`whitespace-nowrap tabular-nums ${r._total ? 'font-bold text-[#1D1D1F]' : ''}`}>{inr2(pick(r))}</span>, ...extra,
  });
  const short = r => !r._total && P(r.net_before_cap) < 0n;
  const columns = [
    { key: 'month', label: 'Month', sortable: false, export: r => (r._total ? 'Total' : monthLabel(r.month)),
      render: r => (r._total ? <b>Total · {months.length} months</b> : (
        <span className="whitespace-nowrap font-semibold text-[#1D1D1F]">{monthLabel(r.month)}
          <span className="ml-1.5 rounded-full bg-[#1D1D1F]/[0.07] px-1.5 py-px text-[10px] font-bold text-[#515154]">{RUN[r.run_status] || r.run_status}</span>
        </span>)) },
    { key: 'days', label: 'Present / days', align: 'right', sortable: false,
      export: r => (r._total ? '' : `${Number(r.present_days)} / ${Number(r.days)}`),
      render: r => (r._total ? '' : <span className="whitespace-nowrap tabular-nums">{Number(r.present_days)} / {Number(r.days)}</span>) },
    { key: 'ot', label: 'OT h', align: 'right', sortable: false, export: r => (r._total ? '' : Number(r.ot_hours || 0)),
      render: r => (r._total ? '' : <span className="tabular-nums">{Number(r.ot_hours || 0) || '—'}</span>) },
    m('gross', 'Gross'),
    m('advance_given', 'Advance given'),
    m('advance_recovery', 'Advance recovered'),
    m('loan_recovery', 'Loan recovered'),
    m('other', 'Other deductions', r => (r._total ? r.other : T(P(r.misc_deduction) + P(r.adj_deductions)))),
    m('net', 'Net'),
    { ...m('payable', 'Payable'),
      export: r => (short(r) ? `${inr2(r.net_before_cap)} (short)` : inr2(r.payable)),
      render: r => (short(r)
        ? <span className="whitespace-nowrap font-bold tabular-nums text-red-700" title="Short pay: carried forward to the next month">{inr2(r.net_before_cap)}</span>
        : <span className={`whitespace-nowrap tabular-nums ${r._total ? 'font-bold text-[#1D1D1F]' : 'font-semibold'}`}>{inr2(r.payable)}</span>) },
    m('carried_advance', 'Advance after', r => (r._total ? null : r.carried_advance)),
    { key: 'paid', label: 'Payment', sortable: false,
      export: r => (r._total ? inr2(r.paid_amount) : `${PAY[r.payment_status] || r.payment_status}${r.paid_on ? ` ${r.paid_on}` : ''}`),
      render: r => (r._total ? <span className="whitespace-nowrap font-bold">{inr2(r.paid_amount)} paid</span>
        : <span className="whitespace-nowrap text-xs">{PAY[r.payment_status] || r.payment_status}{r.paid_on ? ` · ${r.paid_on}` : ''}</span>) },
  ];
  const openRow = months.find(r => r.month === open);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-2xl border border-white/70 bg-white/60 px-3 py-2 text-xs text-[#515154]">
        <span>Joined <b className="text-[#1D1D1F]">{p.joined_on || '—'}</b></span>
        {p.exited_on && <span>Left <b className="text-[#1D1D1F]">{p.exited_on}</b></span>}
        <span><b className="text-[#1D1D1F]">{months.length}</b> payroll month{months.length === 1 ? '' : 's'}</span>
        <span>Gross <b className="tabular-nums text-[#1D1D1F]">{inr2(totals.gross)}</b></span>
        <span>Paid <b className="tabular-nums text-[#1D1D1F]">{inr2(totals.paid_amount)}</b></span>
      </div>
      {months.length === 0 ? <p className="text-xs text-[#86868B]">No payroll month yet.</p> : (
        <DataTable columns={columns} rows={[totals, ...months]} getRowId={r => (r._total ? '__total' : r.month)} pinTop={r => r._total === true}
          serialNumber={false} dense onRowClick={r => { if (!r._total) setOpen(o => (o === r.month ? null : r.month)); }}
          exportName={`Salary ledger ${p.code} ${p.name}`} exportSubtitle={`HR & Payroll · every payroll month of ${p.name} (${p.code})`} />
      )}
      <p className="text-[11px] text-[#86868B]">Click a month to see how its pay was worked out.</p>
      {openRow && (
        <div className="space-y-2 rounded-2xl border border-[#0A84FF]/20 bg-[#E1EFFF]/40 p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 text-sm font-bold text-[#1D1D1F]">
            {monthLabel(openRow.month)}
            <span className="text-xs font-medium text-[#515154]">{RUN[openRow.run_status] || openRow.run_status} · absent {Number(openRow.absent_days || 0)} · OT {Number(openRow.ot_hours || 0)} h{openRow.remarks ? ` · ${openRow.remarks}` : ''}</span>
          </div>
          {Breakdown ? <Breakdown line={openRow} /> : <p className="text-xs text-[#86868B]">Loading…</p>}
        </div>
      )}
    </div>
  );
}
