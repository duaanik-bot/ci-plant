// The board picker, in two forms that share one option renderer.
//
//   • MaterialPicker    — the inline type-ahead that sits on every PR/PO line
//   • BoardPickerModal  — a warehouse-style browse table behind the magnifier
//
// Both answer the same question — "which of the 303 boards do I mean?" — and the
// buyer who knows the board should never have to open a modal to say so. The
// type-ahead is the primary path; the modal is for browsing by stock or rate.
//
// Search behaviour is not implemented here. `searchText(record)` flattens the
// whole board onto the option and `SearchableSelect` squash-normalizes it, so
// typing '2228' resolves a board stored as 'Chromo Paper · 205 GSM · 22 x 28'.
// What this file adds is the ability to SEE that: the spec code that matched is
// printed on the row, next to the stock and rate that decide whether the board
// is worth ordering at all.
import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Modal, Select, SearchInput, searchText, rowMatches } from './ui.jsx';
import { fmt } from '../api.js';
import { Plus, Search, PackageSearch } from 'lucide-react';
import { packets, ratePerSheet } from '../lib/boardMath.js';

// Spec code · HSN, the two identifiers that do not fit in the board name. The
// name already carries grade, GSM and size.
function specLine(mat) {
  return [mat?.spec, mat?.hsn_code ? `HSN ${mat.hsn_code}` : null].filter(Boolean).join(' · ');
}

// A board's ₹/sheet for the vendor on this PO, resolved through the same
// injected resolver the line fill uses — so the number in the dropdown is the
// number that lands in the rate field, not a second opinion.
function sheetRate(mat, rateFor) {
  const r = rateFor?.(mat);
  if (r?.rate != null && r.rate !== '') return +r.rate;
  return ratePerSheet(mat, r?.rate_per_kg);
}

// Available stock in the unit the floor counts in. Packets lead — a buyer thinks
// in packets — with sheets underneath. Zero and negative both read amber: a
// negative balance is a real state in this system (an over-cut refunds against
// stock) and it must not look like a healthy number.
function StockCell({ stock, mat }) {
  const avail = +stock?.available || 0;
  const pkt = packets(mat, avail);
  const tone = avail > 0 ? 'text-slate-500' : 'text-amber-600 font-semibold';
  return (
    <div className={`text-right text-[11px] leading-4 ${tone}`}>
      <div>{avail > 0 && pkt != null
        ? `${pkt.toLocaleString('en-IN', { maximumFractionDigits: 1 })} pkt`
        : `${fmt.num(avail)} sheets`}</div>
      {avail > 0 && pkt != null && <div className="text-slate-400">{fmt.num(avail)} sheets</div>}
    </div>
  );
}

// The dropdown row. Left identifies the board, right prices it — the two halves
// a buyer reads in that order.
function OptionRow({ item, rateFor }) {
  const mat = item.record;
  const rate = sheetRate(mat, rateFor);
  const spec = specLine(mat);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="break-words font-medium">{item.label}</div>
        {spec && <div className="mt-0.5 font-mono text-[10px] text-slate-400">{spec}</div>}
      </div>
      <div className="shrink-0 text-right">
        <StockCell stock={item.stock} mat={mat} />
        {rate != null && <div className="text-[11px] font-semibold tabular-nums text-slate-600">₹{rate.toFixed(2)}/sheet</div>}
      </div>
    </div>
  );
}

// Options carry the whole record, not just a label: `renderOption` reads it for
// the spec/stock/rate row, and `searchText` flattens it into the haystack so any
// character of anything stored on the board finds it.
function boardOptions(materials, value, stockFor) {
  return materials
    .filter(m => (m.active ?? 1) || String(m.id) === String(value))
    .map(m => ({
      value: String(m.id),
      label: m.name,
      search: searchText(m),
      record: m,
      stock: stockFor?.(m.id) ?? null,
    }));
}

export function MaterialPicker({ value, materials, disabled, onPick, onQuickCreate, rateFor, stockFor }) {
  const [browse, setBrowse] = useState(false);
  const options = useMemo(() => boardOptions(materials, value, stockFor), [materials, value, stockFor]);
  const pick = id => onPick(materials.find(m => String(m.id) === String(id)));
  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <Select value={value || ''} disabled={disabled} options={options} placeholder="Select board…"
          renderOption={item => <OptionRow item={item} rateFor={rateFor} />}
          onChange={e => pick(e.target.value)} />
      </div>
      <button type="button" title="Browse all boards" disabled={disabled}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white/70 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
        onClick={() => setBrowse(true)}><Search size={15} /></button>
      {onQuickCreate && (
        <button type="button" title="Create a new board" disabled={disabled}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
          onClick={onQuickCreate}><Plus size={15} /></button>
      )}
      <BoardPickerModal open={browse} onClose={() => setBrowse(false)} materials={materials}
        currentId={value} rateFor={rateFor} stockFor={stockFor}
        onSelect={m => { onPick(m); setBrowse(false); }} />
    </div>
  );
}

// ── Browse table ──────────────────────────────────────────────────────────────
// Filters CLIENT-SIDE, unlike WarehousePicker. Procurement already holds all 303
// boards from /materials, so server search and pagination would be plumbing for
// no gain at this row count — and rowMatches is the same normalizer the tables
// use, so this list agrees with every other search in the app by construction.
export function BoardPickerModal({ open, onClose, materials, currentId, rateFor, stockFor, onSelect }) {
  const [q, setQ] = useState('');
  const [inStock, setInStock] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);

  useEffect(() => { if (open) { setQ(''); setInStock(false); setActiveOnly(true); } }, [open]);

  const rows = useMemo(() => materials.filter(m => {
    if (activeOnly && !(m.active ?? 1) && String(m.id) !== String(currentId)) return false;
    if (inStock && !(+stockFor?.(m.id)?.available > 0)) return false;
    return rowMatches(m, q);
  }), [materials, q, inStock, activeOnly, currentId, stockFor]);

  const head = 'px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500';
  return (
    <Modal wide open={open} onClose={onClose} title="Boards — select one"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={q} onChange={setQ} placeholder="Board, grade, GSM, size, code…" />
          <Checkbox label="In stock only" checked={inStock} onChange={e => setInStock(e.target.checked)} />
          <Checkbox label="Active only" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} />
          <span className="ml-auto text-xs text-slate-400">{fmt.num(rows.length)} boards</span>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-[#1D1D1F]/[0.06]">
          <table className="w-full text-sm">
            <thead><tr className="ci-table-head">
              <th className={`${head} text-left`}>Board</th>
              <th className={`${head} text-left`}>Code</th>
              <th className={`${head} text-left`}>Sheet</th>
              <th className={`${head} text-right`}>Available</th>
              <th className={`${head} text-right`}>₹/Sheet</th>
              <th className={head}></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  <PackageSearch className="mx-auto mb-2 text-slate-300" size={20} />
                  No board matches — widen the search or untick a filter.
                </td></tr>
              )}
              {rows.map(m => {
                const rate = sheetRate(m, rateFor);
                const current = String(m.id) === String(currentId);
                return (
                  <tr key={m.id} className={`border-t border-slate-50 ${current ? 'bg-brand-50/60' : 'hover:bg-slate-50/70'}`}>
                    {/* No grade/GSM subtitle: the board name already reads
                        'Saffire · 280 GSM · 31.5x41.5', so repeating it under
                        itself is noise, and Code / Sheet have their own columns. */}
                    <td className="px-3 py-2 font-medium text-slate-700">{m.name}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{m.spec || '—'}</td>
                    <td className="px-3 py-2 text-[11px] tabular-nums text-slate-500">
                      {m.sheet_l > 0 && m.sheet_w > 0 ? `${m.sheet_l}×${m.sheet_w}"` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right"><StockCell stock={stockFor?.(m.id)} mat={m} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {rate != null ? `₹${rate.toFixed(2)}` : <span className="text-amber-600">no rate</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant={current ? 'secondary' : 'primary'} onClick={() => onSelect(m)}>
                        {current ? 'Current' : 'Select'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
