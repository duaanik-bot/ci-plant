// Paper Warehouse picker — the Planning Engine's "select existing stock" modal.
// Server-side search + pagination (never loads the whole warehouse), debounced
// typing, and a live cut-fit column for the child sheet being planned.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Checkbox, Modal, SearchInput } from './ui.jsx';
import { PackageSearch, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react';
import { clientFit } from '../lib/cutFit.js';

// The cut-fit twin moved to lib/cutFit.js so the server test can import it
// without pulling React in — same precedent as lib/boardMath.js. Re-exported
// here because Planning.jsx has always taken it off this module.
export { clientFit };

const PAGE_SIZE = 10;

export default function WarehousePicker({ open, onClose, childL, childW, currentBoardId, parentNeededFor, onSelect }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [fitOnly, setFitOnly] = useState(true);
  const [inStock, setInStock] = useState(true);
  // "In Leftover" is an include-toggle and starts CHECKED — leftover offcut
  // stock is part of the default view; unticking hides it.
  const [loInc, setLoInc] = useState(true);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { if (open) { setSearch(''); setDebounced(''); setPage(1); setFitOnly(true); setInStock(true); setLoInc(true); } }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = ++seq.current;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), in_stock: inStock ? '1' : '0' });
    if (debounced) params.set('search', debounced);
    if (fitOnly && childL > 0 && childW > 0) { params.set('child_l', childL); params.set('child_w', childW); }
    if (!loInc) params.set('exclude_leftover', '1');
    api.get(`/warehouse/paper?${params}`)
      .then(d => { if (seq.current === id) setData(d); })
      .finally(() => { if (seq.current === id) setLoading(false); });
  }, [open, debounced, page, fitOnly, inStock, loInc, childL, childW]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const rows = data?.rows || [];
  const sized = childL > 0 && childW > 0;

  return (
    <Modal wide open={open} onClose={onClose} title="Paper Warehouse — select stock"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search board, GSM, size, code…" />
          {sized && <Checkbox label={`Fits child ${childL}×${childW}"`} checked={fitOnly} onChange={e => { setFitOnly(e.target.checked); setPage(1); }} />}
          <Checkbox label="In Stock" checked={inStock} onChange={e => { setInStock(e.target.checked); setPage(1); }} />
          <Checkbox label="In Leftover" checked={loInc} onChange={e => { setLoInc(e.target.checked); setPage(1); }} />
          <span className="ml-auto text-xs text-slate-400">{loading ? 'Searching…' : data ? `${fmt.num(data.total)} boards` : ''}</span>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-[#1D1D1F]/[0.06]">
          <table className="w-full text-sm">
            <thead>
              <tr className="ci-table-head">
                {['Board', 'Parent Sheet', 'Cut Fit', 'Available', 'Committed', 'Free', ''].map((h, i) => (
                  <th key={h || i} className={`px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i >= 3 && i <= 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">
                  <PackageSearch className="mx-auto mb-2 text-slate-300" size={20} />
                  {loading ? 'Loading warehouse…' : 'No matching stock — widen the search or untick the fit filter.'}
                </td></tr>
              )}
              {rows.map((r, i) => {
                const fit = sized ? clientFit(r.sheet_l, r.sheet_w, childL, childW) : null;
                const need = fit?.cpp > 0 && parentNeededFor ? parentNeededFor(fit.cpp) : null;
                const enough = need != null && r.free >= need;
                const isCurrent = r.id === currentBoardId;
                return (
                  <tr key={r.id} className={`ci-table-row ${isCurrent ? 'bg-[#0A84FF]/[0.06]' : i % 2 ? 'bg-slate-50/35' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                        <span className="min-w-0 truncate">{r.name}</span>
                        {r.leftover === 1 && <span className="shrink-0 rounded-full bg-violet-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-violet-600">Leftover</span>}
                      </div>
                      <div className="text-[11px] text-slate-400">{r.spec}{r.incoming > 0 ? ` · ${fmt.num(r.incoming)} incoming` : ''}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600">{r.sheet_l && r.sheet_w ? `${r.sheet_l}×${r.sheet_w}"` : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {fit ? fit.cpp > 0 ? (
                        <span className="text-xs">
                          <b className="text-slate-800">{fit.cpp}/parent</b>
                          <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${fit.waste <= 10 ? 'bg-emerald-50 text-emerald-700' : fit.waste <= 20 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600'}`}>{fit.util}% util</span>
                        </span>
                      ) : <span className="text-xs text-red-500">no fit</span> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(r.available)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${r.committed > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{fmt.num(r.committed)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${need != null ? (enough ? 'text-emerald-600' : 'text-red-600') : 'text-slate-800'}`}>{fmt.num(r.free)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {isCurrent
                        ? <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-bold text-[#0064D2]"><CheckCircle2 size={12} /> Selected</span>
                        : <Button size="sm" variant="secondary" disabled={sized && fit?.cpp === 0} onClick={() => onSelect(r)}>Use</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Page {data.page} of {pages}</span>
            <span className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={13} /> Prev</Button>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next <ChevronRight size={13} /></Button>
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
