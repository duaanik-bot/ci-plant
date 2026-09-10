// <Family> → Purchase Orders → Closed lines: every line closed short, off its
// order's row, with the way back through the reopen form. One view for the
// plate and die/block registers — the board page keeps its own, with the
// Ordered For column tooling lines do not have.
//
// The page owns only what its register's "N closed" chip sets — the order it
// focused. The order filter, the ticked pile and the reopen form live here.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api, fmt } from '../api.js';
import { Button, DataTable, SelectionDock } from './ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from './FilterChip.jsx';
import ReopenPoLinesModal from './ReopenPoLines.jsx';
import { closedLineRows, reopenSummary, unitLabel } from '../lib/closedPoLines.js';

const FINISHED = ['received', 'closed'];

export default function ClosedPoLinesView({
  family, pos = [], unitWord = 'nos',
  // (line) → { title, sub } in the register's own words — a plate set is a
  // product and a size, a die is its master.
  describe, poHref, canReopen = false,
  focusPo = null, onFocusPo, reopenNote = null, onDone, exportName, searchPlaceholder,
}) {
  // A reversed order is void — its lines are history, not a decision to revisit.
  const rows = useMemo(() => closedLineRows(pos.filter(po => po.status !== 'reversed')), [pos]);
  const [order, setOrder] = useState(null); // null | 'live' | 'finished'
  const [picked, setPicked] = useState([]);
  const [reopening, setReopening] = useState(null);
  const orderOf = row => (FINISHED.includes(row.po_status) ? 'finished' : 'live');
  const list = rows
    .filter(row => !order || orderOf(row) === order)
    .filter(row => !focusPo || row.po_id === focusPo.id);
  // The pile as ticked — a selection outlives a filter, as it does on the board.
  const pile = rows.filter(row => picked.includes(row.id));
  const summary = reopenSummary(pile);
  const countOf = kind => rows.filter(row => orderOf(row) === kind).length;
  const itemText = row => { const d = describe(row); return [d.title, d.sub].filter(Boolean).join(' · '); };

  const columns = [
    { key: 'po_number', label: 'PO', card: 'title',
      render: row => (
        <div>
          <Link to={poHref(row)} onClick={event => event.stopPropagation()}
            className="font-extrabold text-brand-600 hover:underline">{row.po_number}</Link>
          <div className="text-[11px] text-slate-400">{row.vendor_name}</div>
        </div>
      ) },
    { key: 'item', label: 'Item', card: 'subtitle', sortValue: row => describe(row).title, searchValue: itemText,
      render: row => {
        const d = describe(row);
        return (
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-700">{d.title}</div>
            {d.sub && <div className="text-[10px] text-slate-400">{d.sub}</div>}
          </div>
        );
      } },
    { key: 'qty', label: 'Ordered', align: 'right', render: row => `${fmt.num(row.qty)} ${unitLabel(row.qty, unitWord)}` },
    { key: 'received_qty', label: 'Received', align: 'right', render: row => fmt.num(row.received_qty) },
    // The balance that stopped being owed — said as "waived", never a bare 0,
    // which would read as fully received.
    { key: 'waived', label: 'Waived', align: 'right',
      render: row => (
        <span className="inline-flex whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
          {fmt.num(row.waived)} waived
        </span>
      ) },
    { key: 'closed_reason', label: 'Why closed', card: 'detail',
      render: row => (row.closed_reason
        ? <span className="text-xs italic text-slate-500">“{row.closed_reason}”</span>
        : <span className="text-slate-300">—</span>) },
    { key: 'closed_at', label: 'Closed', sortValue: row => (row.closed_at ? Date.parse(row.closed_at) : -Infinity),
      render: row => (
        <div className="whitespace-nowrap text-xs">
          <div className="font-semibold text-slate-600">{fmt.date(row.closed_at)}</div>
          {row.closed_by && <div className="text-[11px] text-slate-400">{row.closed_by}</div>}
        </div>
      ) },
    ...(canReopen ? [{ key: '_reopen', label: '', sortable: false, card: 'actions',
      render: row => (
        <Button size="sm" variant="secondary" onClick={event => { event.stopPropagation(); setReopening([row]); }}>
          <RotateCcw size={12} /> Reopen…
        </Button>
      ) }] : []),
  ];
  // The export spells every fact in its own column — the screen folds the
  // vendor under the PO and the closer under the date.
  const exportColumns = [
    { key: 'po_number', label: 'PO' },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'item', label: 'Item', export: itemText },
    { key: 'qty', label: 'Ordered', align: 'right', export: row => `${fmt.num(row.qty)} ${unitLabel(row.qty, unitWord)}` },
    { key: 'received_qty', label: 'Received', align: 'right', export: row => fmt.num(row.received_qty) },
    { key: 'waived', label: 'Waived', align: 'right', export: row => fmt.num(row.waived) },
    { key: 'closed_reason', label: 'Why closed', export: row => row.closed_reason || '—' },
    { key: 'closed_by', label: 'Closed by', export: row => row.closed_by || '—' },
    { key: 'closed_at', label: 'Closed on', export: row => fmt.date(row.closed_at) },
  ];

  return (
    <div className="space-y-3">
      {/* Whether the order is still receiving decides what a reopen means: on a
          live order the line simply takes receipts again; on a finished one it
          puts the order back on. */}
      <FilterRail>
        <FilterGroup label="Order" divider={false}>
          <FilterChip label="Still receiving" count={countOf('live')} on={order === 'live'}
            title="The order is live — its other lines are still being received"
            onClick={() => setOrder(order === 'live' ? null : 'live')} />
          <FilterChip label="Order finished" count={countOf('finished')} on={order === 'finished'}
            title="Nothing else is coming on the order — reopening a line puts it back on"
            onClick={() => setOrder(order === 'finished' ? null : 'finished')} />
        </FilterGroup>
        {focusPo && (
          <FilterGroup label="PO">
            <FilterChip label={focusPo.po_number} on count={rows.filter(row => row.po_id === focusPo.id).length}
              title="Opened from the order's row — tap to see every order's closed lines"
              onClick={() => onFocusPo?.(null)} />
          </FilterGroup>
        )}
      </FilterRail>
      <DataTable searchable selectable={canReopen} rows={list} columns={columns}
        selectedIds={picked}
        onToggleRow={(row, checked) => setPicked(ids => (checked ? [...new Set([...ids, row.id])] : ids.filter(id => id !== row.id)))}
        onToggleAll={(shown, checked) => {
          const ids = shown.map(row => row.id);
          setPicked(current => (checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id))));
        }}
        defaultSort={{ key: 'closed_at', dir: 'desc' }}
        searchPlaceholder={searchPlaceholder}
        empty={rows.length
          ? 'Nothing matches — clear the chips to see every closed line'
          : 'No closed lines. A line closed short from its order or from Pendency lands here — and can be reopened.'}
        exportName={exportName} exportColumns={exportColumns} />
      <SelectionDock open={canReopen && pile.length > 0} count={pile.length}
        summary={`${summary.orders} order${summary.orders === 1 ? '' : 's'} · ${fmt.num(summary.waived)} ${unitLabel(summary.waived, unitWord)} back to pending`}
        onClear={() => setPicked([])}>
        <Button size="sm" onClick={() => setReopening(pile)}>
          <RotateCcw size={13} /> Reopen {pile.length} line{pile.length === 1 ? '' : 's'}…
        </Button>
      </SelectionDock>
      {reopening && <ReopenPoLinesModal unitWord={unitWord} note={reopenNote}
        lines={reopening.map(row => {
          const d = describe(row);
          return {
            id: row.id, po_number: row.po_number, title: d.title,
            sub: [row.po_number, row.vendor_name, d.sub].filter(Boolean).join(' · '),
            qty: Number(row.qty), received_qty: Number(row.received_qty), unit: unitWord, waived: row.waived,
            closed_reason: row.closed_reason, closed_by: row.closed_by, closed_at: row.closed_at,
          };
        })}
        onReopen={(line_ids, reason) => api.post(`/tooling/procurement/${family}/po-lines/reopen`, { line_ids, reason })}
        onDone={async () => { setPicked([]); await onDone?.(); }}
        onClose={() => setReopening(null)} />}
    </div>
  );
}
