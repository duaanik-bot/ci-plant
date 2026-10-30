// Saved costings — every costing made here and every row of the old cost sheet, newest first.
// Search by product, customer, costing number or size (a size typed any way — 165x58x73,
// 165 X 58 X 73 — finds that size). Chips narrow to where it was made and to the rows to look at.
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, SearchInput } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { styleLabel } from '../../lib/costing.js';
import { perUnit, plain } from '../../lib/costingUi.js';

const PAGE = 300;

export default function CostingRegister({ onOpen, reloadSignal }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState('all');
  const [flag, setFlag] = useState('');
  const [hidden, setHidden] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const p = new URLSearchParams({ limit: String(limit) });
      if (q.trim()) p.set('search', q.trim());
      if (source !== 'all') p.set('source', source);
      if (flag) p.set('flag', flag);
      if (hidden) p.set('archived', '1');
      setLoading(true);
      api.get(`/costing/costings?${p}`).then(d => live && setData(d)).catch(() => {}).finally(() => live && setLoading(false));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, source, flag, hidden, limit, reloadSignal]);

  const chip = (label, on, onClick, title) => <FilterChip label={label} on={on} onClick={onClick} title={title} />;

  const columns = [
    { key: 'costing_no', label: 'No.', render: r => <span className="whitespace-nowrap font-bold text-brand-600">{r.costing_no}</span> },
    { key: 'costed_on', label: 'Date', render: r => <span className="whitespace-nowrap">{r.costed_on ? fmt.date(r.costed_on) : '—'}</span>, export: r => r.costed_on || '' },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product', width: 'min-w-[220px]',
      render: r => <div>{r.product_name}{r.batch_no && <div className="text-[11px] text-slate-400">{r.batch_no}</div>}</div> },
    { key: 'size_text', label: 'Size (mm)', render: r => <span className="whitespace-nowrap">{r.size_text || '—'}</span> },
    { key: 'style', label: 'Pasting', render: r => (r.style ? styleLabel(r.style) : '—'), export: r => r.style || '' },
    { key: 'qty', label: 'Qty', align: 'right', render: r => plain(r.qty, 0), export: r => r.qty ?? '' },
    { key: 'gsm', label: 'GSM', align: 'right', render: r => plain(r.gsm, 0), export: r => r.gsm ?? '' },
    { key: 'cost_per_unit', label: 'Cost / carton', align: 'right', render: r => <span className="tabular-nums">{perUnit(r.cost_per_unit)}</span>, export: r => r.cost_per_unit ?? '' },
    { key: 'quote_per_unit', label: 'Quote', align: 'right', render: r => <span className="tabular-nums">{perUnit(r.quote_per_unit)}</span>, export: r => r.quote_per_unit ?? '' },
    { key: '_source', label: 'Made', sortValue: r => r.source, export: r => (r.source === 'sheet' ? 'Old cost sheet' : `ERP · ${r.status === 'approved' ? 'Approved' : 'Draft'}`),
      render: r => (
        <span className="flex flex-wrap gap-1">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.source === 'sheet' ? 'bg-slate-100 text-slate-600' : 'bg-brand-50 text-brand-700'}`}>{r.source === 'sheet' ? 'Old sheet' : `ERP · rev ${r.version}`}</span>
          {!r.complete && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Incomplete</span>}
          {r.reproduced === false && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700" title="The sheet's figure differs from what its own inputs give">Sheet differs</span>}
          {r.archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">Hidden</span>}
          {r.source === 'erp' && r.complete && (r.status === 'approved'
            ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800" title={`Approved by ${r.approved_by_name} on ${r.approved_at}`}>Approved</span>
            : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">Draft</span>)}
        </span>
      ) },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchInput value={q} onChange={v => { setQ(v); setLimit(PAGE); }} placeholder="Product, customer, CI-CST- number or size (165x58x73)…" className="w-full sm:w-96" />
        <span className="text-sm text-slate-500">{loading ? 'Searching…' : `${fmt.num(data.total)} costing${data.total === 1 ? '' : 's'}`}</span>
      </div>
      <FilterRail className="mb-3">
        <FilterGroup label="Made" divider={false}>
          {chip('All', source === 'all', () => setSource('all'))}
          {chip('In the ERP', source === 'erp', () => setSource('erp'))}
          {chip('Old cost sheet', source === 'sheet', () => setSource('sheet'))}
        </FilterGroup>
        <FilterGroup label="Approval">
          {chip('Awaiting approval', flag === 'awaiting', () => setFlag(flag === 'awaiting' ? '' : 'awaiting'), 'Complete costings made here, not yet approved')}
          {chip('Approved', flag === 'approved', () => setFlag(flag === 'approved' ? '' : 'approved'))}
        </FilterGroup>
        <FilterGroup label="Look at">
          {chip('Incomplete', flag === 'incomplete', () => setFlag(flag === 'incomplete' ? '' : 'incomplete'))}
          {chip('Sheet figure differs', flag === 'not_reproduced', () => setFlag(flag === 'not_reproduced' ? '' : 'not_reproduced'), 'Old sheet rows whose own inputs do not give the figure the sheet showed')}
          {chip('Sheet notes', flag === 'sheet_notes', () => setFlag(flag === 'sheet_notes' ? '' : 'sheet_notes'), 'Old sheet rows with something written down about them')}
          {chip('No size in library', flag === 'no_size', () => setFlag(flag === 'no_size' ? '' : 'no_size'))}
          {chip('Hidden', hidden, () => setHidden(!hidden))}
        </FilterGroup>
      </FilterRail>
      <DataTable rows={data.rows} columns={columns} onRowClick={r => onOpen(r.id)} defaultSort={{ key: 'costed_on', dir: 'desc' }}
        exportName="costings" exportSubtitle="Saved costings" empty={loading ? 'Loading…' : 'No costings match.'} />
      {data.total > data.rows.length && (
        <div className="mt-3 flex items-center gap-3 text-sm text-slate-500">
          Showing the newest {fmt.num(data.rows.length)} of {fmt.num(data.total)}. Search to narrow it, or
          <Button size="sm" variant="secondary" onClick={() => setLimit(5000)}>Show all</Button>
        </div>
      )}
    </div>
  );
}
