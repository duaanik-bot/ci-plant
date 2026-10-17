// HR → Overview (spec §14): the month at a glance. Every figure comes from GET /hr/dashboard?month=
// (exact strings for money, formatted here and never added up) and each tile or exception links to the
// rows behind it: the Payroll tab for the month, People, or Loans & Advances. Like every HR tab it
// takes { level }; the overview is read-only for everyone, so the level changes nothing here.
//
// The month is the page's ?month= (shared with Payroll and Reports), default the plant's current month.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Banknote, ChevronLeft, ChevronRight, HandCoins, RefreshCw, UserCheck, Users, Wallet } from 'lucide-react';
import { Button, Input, KpiCard, KpiRow } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { LEVEL_META, MONTH_RE, flagLabel, list, plantMonth, plural, shiftMonth } from './RunLineDrawer.jsx';
import { refusalText } from './PersonDrawer.jsx';

const RUN_LABEL = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', finalised: 'Finalised' };

// The link a tile or exception opens: /hr?tab=…&month=…
const to = (tab, month, extra = {}) => `/hr?${new URLSearchParams({ tab, month, ...extra })}`;

function Tile({ href, ...props }) {
  return <Link to={href} className="block rounded-[22px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]/50"><KpiCard compact {...props} /></Link>;
}

export default function Overview() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('month');
  const month = MONTH_RE.test(asked || '') ? asked : plantMonth();
  const setMonth = useCallback(m => {
    if (!MONTH_RE.test(m || '')) return;
    setParams(p => { const n = new URLSearchParams(p); n.set('month', m); return n; }, { replace: true });
  }, [setParams]);

  const [dash, setDash] = useState(null);
  const [channels, setChannels] = useState([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [d, c] = await Promise.all([hrApi.dashboard(month), hrApi.payChannels().catch(() => [])]);
      setDash({ month, ...d });
      if (Array.isArray(c)) setChannels(c);
    } catch (e) {
      setError(refusalText(e));
    }
  }, [month]);
  useEffect(() => { setDash(null); load(); }, [load]);

  const label = useMemo(() => {
    const by = new Map(channels.map(c => [c.code, c.label || c.code]));
    return code => (code ? by.get(code) || code : 'No pay channel');
  }, [channels]);

  const here = dash?.month === month ? dash : null;
  const run = here?.run || null;
  const status = run?.status || null;
  const totals = run?.totals && typeof run.totals === 'object' ? run.totals : {};
  const ex = here?.exceptions || {};
  const byCode = list(ex.by_code);
  const head = here?.headcount || {};
  const pay = here?.payments || null;

  return (
    <div>
      <section className="glass mb-3 flex flex-wrap items-center gap-2 rounded-[22px] border border-white/70 p-4 shadow-card">
        <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05]"><ChevronLeft size={17} /></button>
        <Input type="month" aria-label="Month" value={month} className="!w-[168px]" onChange={e => setMonth(e.target.value)} />
        <button type="button" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05]"><ChevronRight size={17} /></button>
        <h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#1D1D1F]">{monthLabel(month)}</h2>
        <button type="button" aria-label="Reload" title="Reload" onClick={load}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-[#86868B] hover:bg-[#1D1D1F]/[0.05]"><RefreshCw size={14} /></button>
      </section>

      {error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">The overview could not be loaded — {error}</span>
          <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
        </div>
      )}
      {!here && !error && <div className="p-8 text-sm text-slate-400">Loading {monthLabel(month)}…</div>}

      {here && (
        <>
          <KpiRow cols={5}>
            <Tile href={to('people', month)} label="Active people" value={String(head.active ?? 0)} icon={Users} tone="info"
              sub={`${head.on_leave ?? 0} on leave · ${head.exited ?? 0} exited`} />
            <Tile href={to('people', month)} label="Joined this month" value={String(head.joined_this_month ?? 0)} icon={UserCheck} tone="good"
              sub={`${plural(head.exited_this_month ?? 0, 'person', 'people')} left`} />
            <Tile href={to('payroll', month)} label="This month's run" icon={Wallet} tone={status === 'finalised' ? 'good' : status ? 'warn' : 'neutral'}
              value={status ? RUN_LABEL[status] || status : 'Not started'}
              sub={run ? `${totals.lines ?? 0} lines · payable ${inr2(totals.payable)}` : 'no payroll prepared yet'} />
            <Tile href={to('loans', month)} label="Loans outstanding" value={inr2(here.loans?.outstanding)} icon={HandCoins} tone="violet"
              sub={plural(here.loans?.count ?? 0, 'active loan')} />
            <Tile href={to('loans', month, { sub: 'advances' })} label="Advances outstanding" value={inr2(here.advances?.outstanding)} icon={Banknote} tone="warn"
              sub={plural(here.advances?.count ?? 0, 'person', 'people')} />
          </KpiRow>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="glass rounded-[22px] border border-white/70 p-4 shadow-card">
              <h3 className="mb-2 text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Payable by channel</h3>
              {!run ? <p className="text-xs text-[#86868B]">No run for this month yet.</p> : (
                <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
                  <table className="w-full text-xs">
                    <thead><tr className="ci-table-head">
                      <th className="px-2.5 py-2 text-left">Channel</th><th className="px-2.5 py-2 text-right">People</th>
                      <th className="px-2.5 py-2 text-right">Payable</th><th className="px-2.5 py-2 text-right">Advance carried</th>
                    </tr></thead>
                    <tbody>
                      {list(totals.by_channel).map(c => (
                        <tr key={c.pay_channel ?? 'none'} className="ci-table-row">
                          <td className="px-2.5 py-2 font-semibold text-[#1D1D1F]">{label(c.pay_channel)}</td>
                          <td className="px-2.5 py-2 text-right tabular-nums">{c.lines}</td>
                          <td className="px-2.5 py-2 text-right tabular-nums">{inr2(c.payable)}</td>
                          <td className="px-2.5 py-2 text-right tabular-nums">{inr2(c.carried_advance)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-[#1D1D1F]/[0.08] bg-white/60 font-bold">
                        <td className="px-2.5 py-2">Total</td><td className="px-2.5 py-2 text-right tabular-nums">{totals.lines ?? 0}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{inr2(totals.payable)}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{inr2(totals.carried_advance)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3">
                <h4 className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">Paid · unpaid · on hold</h4>
                {pay ? (
                  <>
                    <Link to={to('payroll', month)} className="grid grid-cols-3 gap-2 text-xs">
                      <span className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-800"><b className="block tabular-nums">{inr2(pay.paid_amount)}</b>paid · {plural(pay.paid_lines ?? 0, 'person', 'people')}</span>
                      <span className="rounded-xl bg-gray-100 px-3 py-2 text-gray-700"><b className="block tabular-nums">{inr2(pay.pending_amount)}</b>unpaid · {plural(pay.pending_lines ?? 0, 'person', 'people')}</span>
                      <span className="rounded-xl bg-amber-50 px-3 py-2 text-amber-800"><b className="block tabular-nums">{inr2(pay.on_hold_amount ?? '0')}</b>on hold · {plural(pay.on_hold_lines ?? 0, 'person', 'people')}</span>
                    </Link>
                    {pay.final === false && <p className="mt-1 text-[11px] text-[#86868B]">Lines are marked paid once the month is finalised.</p>}
                  </>
                ) : <p className="text-xs text-[#86868B]">No run for this month yet.</p>}
              </div>
            </section>

            <section className="glass rounded-[22px] border border-white/70 p-4 shadow-card">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]"><AlertTriangle size={15} className="text-[#6E6E73]" /> Exceptions</h3>
              <ul className="divide-y divide-[#1D1D1F]/[0.06] text-xs">
                {Number(ex.unresolved_import_rows) > 0 && (
                  <li><Link to={to('payroll', month)} className="flex items-center gap-2 py-2 hover:text-[#007AFF]">
                    <span className="h-2 w-2 rounded-full bg-red-500" /><span className="flex-1 font-semibold">Unmatched import rows</span><b className="tabular-nums">{ex.unresolved_import_rows}</b></Link></li>
                )}
                {Number(ex.people_without_setup) > 0 && (
                  <li><Link to={to('people', month)} className="flex items-center gap-2 py-2 hover:text-[#007AFF]">
                    <span className="h-2 w-2 rounded-full bg-red-500" /><span className="flex-1 font-semibold">People without a pay setup</span><b className="tabular-nums">{ex.people_without_setup}</b></Link></li>
                )}
                {byCode.map(c => (
                  <li key={`${c.level}-${c.code}`}><Link to={to('payroll', month)} className="flex items-center gap-2 py-2 hover:text-[#007AFF]">
                    <span className={`h-2 w-2 rounded-full ${(LEVEL_META[c.level] || LEVEL_META.warn).dot}`} />
                    <span className="flex-1 font-semibold">{flagLabel(c.code)}</span><b className="tabular-nums">{c.people}</b></Link></li>
                ))}
              </ul>
              {!Number(ex.unresolved_import_rows) && !Number(ex.people_without_setup) && byCode.length === 0 && (
                <p className="text-xs font-semibold text-emerald-700">No exceptions for {monthLabel(month)}.</p>
              )}
              {run && <p className="mt-2 text-[11px] text-[#86868B]">{ex.blocked ?? 0} blocked · {ex.warned ?? 0} with warnings · {ex.lines ?? 0} lines</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
