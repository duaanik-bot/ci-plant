// HR · Payroll — this month against the month before, as KPI cards (owner's request 2026-11-17: "whenever we take
// the next month's payroll there should be a comparison at the top: this much percentage impact against the previous
// month, salary less by this much, overtime this much percentage"). Reads GET /hr/runs/:month/compare and is
// re-read whenever the month's lines change (`stamp`).
import { useEffect, useState } from 'react';
import { KpiCard, KpiRow } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';

const P = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const pctChange = (now, before) => (P(before) === 0 ? null : ((P(now) - P(before)) / Math.abs(P(before))) * 100);
const arrow = d => (d === null ? '' : d > 0 ? '▲' : d < 0 ? '▼' : '■');
const pctText = d => (d === null ? 'new' : `${arrow(d)} ${Math.abs(d).toFixed(1)}%`);
// Money going up is neither good nor bad by itself; the tone says only how far it moved.
const toneOf = (d, warnAt) => (d === null ? 'neutral' : Math.abs(d) >= warnAt ? 'warn' : 'neutral');
const names = (list, more = 8) => list.slice(0, more).map(x => `${x.name}${x.change_pct != null ? ` ${x.change_pct > 0 ? '+' : ''}${x.change_pct.toFixed(1)}%` : ''}`).join(', ')
  + (list.length > more ? ` and ${list.length - more} more` : '');

export default function MonthCompare({ month, stamp, onPeople }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    hrApi.runCompare(month).then(d => { if (live) setData(d); }, () => { if (live) setData(null); });
    return () => { live = false; };
  }, [month, stamp]);
  if (!data?.now) return null;
  const { now, before, people } = data;
  const prevLabel = monthLabel(data.previous_month);
  if (!before) {
    return (
      <p className="mb-2 text-xs text-[#86868B]">No {prevLabel} payroll to compare {monthLabel(month)} with.</p>
    );
  }
  const warnAt = people?.threshold_pct ?? 25;
  const card = (label, key, extra) => {
    const d = pctChange(now[key], before[key]);
    return (
      <KpiCard compact label={label} value={pctText(d)} tone={toneOf(d, warnAt)}
        sub={`${inr2(now[key])} · ${prevLabel} ${inr2(before[key])}${extra ? ` · ${extra}` : ''}`}
        title={`${label}: ${inr2(now[key])} in ${monthLabel(month)} against ${inr2(before[key])} in ${prevLabel}`} />
    );
  };
  const otPts = now.ot_share_pct - before.ot_share_pct;
  const headDelta = now.people - before.people;
  const down = people?.down ?? [];
  const up = people?.up ?? [];
  return (
    <section className="mb-1">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">
        {monthLabel(month)} against {prevLabel}{before.status !== 'finalised' ? ` (${prevLabel} is ${before.status})` : ''}
      </p>
      <KpiRow cols={7}>
        {card('Salary (gross)', 'gross')}
        {card('Payable', 'payable')}
        <KpiCard compact label="Overtime" value={`${now.ot_share_pct.toFixed(1)}% of salary`}
          tone={Math.abs(otPts) >= 5 ? 'warn' : 'neutral'}
          sub={`${inr2(now.ot_amount)} · ${prevLabel} ${before.ot_share_pct.toFixed(1)}% (${otPts >= 0 ? '+' : ''}${otPts.toFixed(1)} pts) · ${pctText(pctChange(now.ot_amount, before.ot_amount))}`}
          title={`Overtime ${inr2(now.ot_amount)} against ${inr2(before.ot_amount)} in ${prevLabel}`} />
        {card('Deductions', 'total_deductions', `advance ${inr2(now.advance_recovery)} · loans ${inr2(now.loan_recovery)}`)}
        <KpiCard compact label="Loans outstanding" value={inr2(now.loans_outstanding)}
          tone="neutral"
          sub={`${pctText(pctChange(now.loans_outstanding, before.loans_outstanding))} · ${prevLabel} ${inr2(before.loans_outstanding)} · ${now.loans_open} loan${now.loans_open === 1 ? '' : 's'}, ${now.loan_people} ${now.loan_people === 1 ? 'person' : 'people'} · recovered ${inr2(now.loan_recovery)}`}
          title={`Still owed on loans after ${monthLabel(month)}: ${inr2(now.loans_outstanding)} (after ${prevLabel}: ${inr2(before.loans_outstanding)}). Recovered from pay this month: ${inr2(now.loan_recovery)}.`} />
        <KpiCard compact label="People" value={`${now.people} (${headDelta >= 0 ? '+' : ''}${headDelta})`}
          sub={`${prevLabel} ${before.people} · ${people?.joined?.length ?? 0} new · ${people?.left?.length ?? 0} not paid this month`}
          title={[people?.joined?.length ? `New: ${names(people.joined)}` : '', people?.left?.length ? `Not this month: ${names(people.left)}` : ''].filter(Boolean).join('\n') || undefined} />
        <KpiCard compact label={`Pay changed > ${warnAt}%`} value={`${down.length} down · ${up.length} up`}
          tone={down.length ? 'bad' : up.length ? 'warn' : 'good'}
          sub={down.length ? `Biggest fall: ${down[0].name} ${down[0].change_pct.toFixed(1)}%` : up.length ? `Biggest rise: ${up[0].name} +${up[0].change_pct.toFixed(1)}%` : `everyone within ${warnAt}% of ${prevLabel}`}
          title={[down.length ? `Down: ${names(down)}` : '', up.length ? `Up: ${names(up)}` : ''].filter(Boolean).join('\n') || undefined}
          onClick={onPeople && (down.length || up.length) ? () => onPeople([...down, ...up].map(x => x.person_id)) : undefined} />
      </KpiRow>
    </section>
  );
}
