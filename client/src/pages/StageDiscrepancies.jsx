// Sort & Paste Discrepancies — the register that pays for the station having no
// hard quantity gate.
//
// That station accepts a count above what the paperwork expects, without a
// reason prompt and without blocking, because a bench that really did handle
// 14,200 cartons should not be taught to type 13,900. The price of that softness
// is that nobody is interrupted when it happens — so every absorbed difference
// lands here with the percentage the operator was shown, and this screen is
// where a one-off shift is told apart from a habit.
//
// Read-only, like Cutting Variances: the record is captured inline at the
// station, and this is where it is reviewed, grouped and exported.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, KpiCard, KpiFilterNotice, PageHeader, rowMatches, useKpiFilter } from '../components/ui.jsx';
import { repeatSources } from '../lib/discrepancyGroups.js';
import { AlertTriangle, Combine, Scale, TrendingUp, User } from 'lucide-react';

const KIND_LABEL = {
  over_receipt: 'Counted over',
  step_correction: 'Machine step raised',
};
// The two kinds answer different questions, so the KPI cards filter by them.
const KPI_ROWS = {
  over_receipt: r => r.kind === 'over_receipt',
  step_correction: r => r.kind === 'step_correction',
};
const KPI_LABEL = {
  over_receipt: 'entries where the bench counted more than the pool it was given',
  step_correction: 'entries where a hand step out-counted its machine step',
};

function KindChip({ kind }) {
  const cls = kind === 'over_receipt' ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700';
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>
      {KIND_LABEL[kind] || kind}
    </span>
  );
}

// One source and how often it turns up. Percentage is the headline rather than
// the piece count: 300 cartons over on a run of 14,000 is rounding, the same 300
// on a run of 900 is somebody counting a different thing.
function SourceList({ title, icon: Icon, groups, unit }) {
  if (!groups.length) return null;
  return (
    <div className="ci-data-panel p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">
        <Icon size={12} /> {title}
      </div>
      <div className="space-y-1.5">
        {groups.map(g => (
          <div key={g.name} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-semibold text-slate-700" title={g.name}>{g.name}</span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-bold text-slate-600">{g.count}×</span>
              <span className="font-semibold text-slate-500">+{fmt.num(g.net)} {unit}</span>
              {g.worstPct != null && (
                <span className={`font-bold ${g.worstPct >= 5 ? 'text-red-600' : 'text-slate-400'}`}>
                  worst {g.worstPct}%
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StageDiscrepancies() {
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');

  // A dead backend must not read as "no discrepancies" — an empty register is
  // the good news here, so it is exactly the state an outage must never fake.
  useEffect(() => {
    const load = () => api.get('/stage-discrepancies')
      .then(d => { setRows(d); setLoadError(false); })
      .catch(() => setLoadError(true));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const kpis = useMemo(() => ({
    count: rows.length,
    over: rows.filter(r => r.kind === 'over_receipt').length,
    steps: rows.filter(r => r.kind === 'step_correction').length,
    net: rows.reduce((s, r) => s + (+r.delta_qty || 0), 0),
  }), [rows]);

  const searched = useMemo(() => (q ? rows.filter(r => rowMatches(r, q)) : rows), [rows, q]);
  const kpi = useKpiFilter('discrepancies');
  const filtered = kpi.apply(searched, KPI_ROWS);

  // Grouped on the FILTERED rows, so narrowing to one kind re-answers "who" for
  // that kind rather than leaving a summary that contradicts the table below it.
  const byOperator = useMemo(() => repeatSources(filtered, 'operator'), [filtered]);
  const byProduct = useMemo(() => repeatSources(filtered, 'product_name'), [filtered]);

  return (
    <div>
      <PageHeader title="Sort & Paste Discrepancies"
        subtitle="Every count the station accepted above what was expected — nothing here was blocked, and this is where a one-off is told apart from a habit" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={Scale} label="Entries" value={fmt.num(kpis.count)} />
        <KpiCard icon={TrendingUp} label="Counted over" value={fmt.num(kpis.over)}
          onClick={() => kpi.toggle('over_receipt')} active={kpi.is('over_receipt')} />
        <KpiCard icon={Combine} label="Machine step raised" value={fmt.num(kpis.steps)}
          onClick={() => kpi.toggle('step_correction')} active={kpi.is('step_correction')} />
        <KpiCard label="Net extra cartons" value={`${kpis.net > 0 ? '+' : ''}${fmt.num(kpis.net)}`} />
      </div>
      <KpiFilterNotice filter={kpi} label={KPI_LABEL[kpi.key]}
        shown={filtered.length} total={searched.length} />
      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the register can’t load'}. Retrying every 20 seconds…
        </div>
      )}
      {/* The point of the screen. A flat log cannot say whether this is the
          plant or the counting; the same name twice running can. */}
      {(byOperator.length > 0 || byProduct.length > 0) && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <SourceList title="Where it repeats — operator" icon={User} groups={byOperator} unit="cartons" />
          <SourceList title="Where it repeats — carton" icon={Combine} groups={byProduct} unit="cartons" />
        </div>
      )}
      <div className="mt-3">
        <DataTable
          exportName="sort-paste-discrepancies"
          searchValue={q} onSearchChange={setQ}
          searchPlaceholder="Search JC, product, operator…"
          rows={filtered}
          empty={loadError
            ? 'Server unreachable — nothing to show until it reconnects.'
            : 'No discrepancies recorded — every count has matched what was expected.'}
          columns={[
            { key: 'created_at', label: 'When', export: r => fmt.date(r.created_at), render: r => fmt.date(r.created_at) },
            { key: 'jc_number', label: 'Job Card' },
            { key: 'product_name', label: 'Product', card: 'title',
              render: r => <span>{r.product_name} <span className="text-slate-400">{r.product_code}</span></span> },
            { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
            { key: 'kind', label: 'What', export: r => KIND_LABEL[r.kind] || r.kind, render: r => <KindChip kind={r.kind} /> },
            { key: 'stage', label: 'Stage', export: r => fmt.title(r.stage), render: r => fmt.title(r.stage) },
            { key: 'expected_qty', label: 'Expected', align: 'right', export: r => fmt.num(r.expected_qty), render: r => fmt.num(r.expected_qty) },
            { key: 'actual_qty', label: 'Counted', align: 'right', export: r => fmt.num(r.actual_qty), render: r => fmt.num(r.actual_qty) },
            { key: 'delta_qty', label: 'Δ', align: 'right',
              export: r => `+${r.delta_qty}`,
              render: r => <span className="font-semibold text-sky-700">+{fmt.num(r.delta_qty)}</span> },
            // Percentage carries the judgement, so it is the one cell that
            // colours: 5% and up is worth someone walking to the bench.
            { key: 'delta_pct', label: '%', align: 'right',
              export: r => (r.delta_pct == null ? '—' : `${r.delta_pct}%`),
              render: r => r.delta_pct == null
                ? <span className="text-slate-300">—</span>
                : <span className={`font-bold tabular-nums ${r.delta_pct >= 5 ? 'text-red-600' : 'text-slate-500'}`}>{r.delta_pct}%</span> },
            { key: 'operator', label: 'Operator', render: r => r.operator || '—' },
            { key: 'machine_name', label: 'Machine', render: r => r.machine_name || '—' },
            // The note restates the two figures already in their own columns, so
            // it earns one line, not four. Full text on hover, full text in the
            // export — this is a register to scan, and a wrapping cell here
            // triples the height of every row in it.
            { key: 'note', label: 'Note',
              render: r => r.note
                ? <span className="block max-w-[230px] truncate" title={r.note}>{r.note}</span>
                : <span className="text-slate-300">—</span> },
            { key: 'created_by', label: 'By' },
          ]}
        />
      </div>
    </div>
  );
}
