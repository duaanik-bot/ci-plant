// Gang printing — the ONE visual language for a gang everywhere in the app.
// A gang is several order lines sharing one physical press run: they travel as
// a single unified row (violet) from Planning through Cutting → Printing →
// Die Cutting, and only after die cutting do they separate into individual
// carton jobs. Every page renders gangs through these pieces so the cells and
// rows stay identical and aligned from plan to execution.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, Link2, Scissors } from 'lucide-react';
import { fmt } from '../api.js';
import { Button } from './ui.jsx';

// The little violet chip that marks a ganged job everywhere.
export function GangChip({ number, onClick, size = 10 }) {
  const cls = 'inline-flex items-center gap-1 rounded-full bg-violet-100/80 px-1.5 py-px text-[10px] font-bold text-violet-700 ring-1 ring-violet-200/70';
  if (!onClick) return <span className={cls}><Link2 size={size - 1} /> {number}</span>;
  return (
    <button type="button" onClick={onClick} className={`${cls} transition-colors hover:bg-violet-200/70`}>
      <Link2 size={size - 1} /> {number}
    </button>
  );
}

// One aligned grid for the gang's members — product | order | qty — used
// verbatim in station queues, job cards, modals and the planning group. The
// shared columns are what makes a gang read as ONE thing, not a pile of rows.
export function GangMemberList({ members = [], showOrder = true, className = '' }) {
  if (!members?.length) return null;
  return (
    <div className={`overflow-hidden rounded-xl border border-violet-200/70 bg-violet-50/50 ${className}`}>
      {members.map((m, i) => (
        <div key={m.line_id ?? i}
          className={`grid items-center gap-x-3 px-2.5 py-1.5 ${showOrder ? 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'} ${i ? 'border-t border-violet-100' : ''}`}>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-slate-800">{m.product_name}</div>
            <div className="truncate text-[10px] text-slate-400">{m.product_code}</div>
          </div>
          {showOrder && (
            <div className="min-w-0 text-[11px] text-slate-500">
              <div className="truncate">{m.customer_name}</div>
              <div className="truncate text-[10px] text-slate-400">PO {m.po_number}</div>
            </div>
          )}
          <div className="text-right text-xs font-bold tabular-nums text-slate-800">
            {fmt.num(m.qty)}
            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">pcs</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// A gang is ONE row in a queue. Columns that differ per member render as
// partitions inside the cell — every partitioned column uses this same segment
// geometry, so the divider boundaries line up straight across the row. Shared
// between Planning and the Artwork Queue so a gang reads identically in both.
export const GANG_SEG = 'flex min-h-[46px] flex-col justify-center py-1';
export function GangCellParts({ members, align = 'left', total, render }) {
  return (
    <div>
      <div className="divide-y divide-violet-300/70">
        {members.map((m, i) => (
          <div key={m.id ?? m.line_id ?? i} className={`${GANG_SEG} ${align === 'right' ? 'items-end text-right' : ''}`}>
            {render(m)}
          </div>
        ))}
      </div>
      {total !== undefined && (
        <div className={`border-t-2 border-violet-300 pt-1.5 text-[11px] font-bold text-violet-800 ${align === 'right' ? 'text-right tabular-nums' : ''}`}>
          {total}
        </div>
      )}
    </div>
  );
}

// Compact one-line summary — "3 products · Swiss Garnier +1 · until die cutting".
export function gangSummary(members = []) {
  const customers = [...new Set(members.map(m => m.customer_name).filter(Boolean))];
  return `${members.length} products · ${customers[0] || ''}${customers.length > 1 ? ` +${customers.length - 1}` : ''}`;
}

// UPI-style confirmation sheet shown the moment a gang is created — a green
// check that pops and draws itself, the gang number as the "transaction id",
// and a receipt of every job now bound to the run. Chromeless on purpose.
export function GangCreatedSheet({ gang, onClose, onPlan }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!gang) return null;
  const totalQty = gang.members.reduce((s, m) => s + (+m.qty || 0), 0);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-[#1D1D1F]/[0.38] backdrop-blur-[10px] backdrop-saturate-150" onClick={onClose} />
      <div className="relative w-full max-w-sm animate-liquidPop overflow-hidden rounded-[30px] border border-white/75 bg-white/90 shadow-modal backdrop-blur-2xl">
        {/* Check */}
        <div className="flex flex-col items-center px-6 pt-9">
          <div className="relative">
            <span className="gang-ring-once absolute inset-0 rounded-full bg-emerald-400/40" />
            <span className="gang-check-pop relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 shadow-[0_10px_24px_rgba(16,185,129,0.35),inset_0_1px_0_rgba(255,255,255,0.4)]">
              <svg viewBox="0 0 32 32" className="h-8 w-8">
                <path d="M8 17 l6 6 l10 -13" fill="none" stroke="white" strokeWidth="3.4"
                  strokeLinecap="round" strokeLinejoin="round" className="gang-check-draw" />
              </svg>
            </span>
          </div>
          <h3 className="mt-4 text-lg font-extrabold tracking-tight text-[#1D1D1F]">Gang Created</h3>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-violet-100/80 px-3 py-1 text-sm font-extrabold tabular-nums text-violet-700 ring-1 ring-violet-200/70">
            <Link2 size={14} /> {gang.gang_number}
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-slate-400">
            {new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>

        {/* Receipt */}
        <div className="px-6 pb-2 pt-5">
          <div className="rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-1">
            {gang.members.map((m, i) => (
              <div key={m.id} className={`flex items-center justify-between gap-3 py-2.5 ${i ? 'border-t border-dashed border-slate-200' : ''}`}>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-slate-800">{m.product_name}</div>
                  <div className="truncate text-[11px] text-slate-400">PO {m.po_number} · {m.customer_name}</div>
                </div>
                <div className="shrink-0 text-right text-[13px] font-bold tabular-nums text-slate-800">
                  {fmt.num(m.qty)}
                  <span className="ml-1 text-[10px] font-semibold uppercase text-slate-400">pcs</span>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-slate-200 py-2.5 text-[13px] font-extrabold text-violet-700">
              <span>One press run · {gang.members.length} jobs</span>
              <span className="tabular-nums">{fmt.num(totalQty)} pcs</span>
            </div>
          </div>
          <p className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-[11px] font-semibold text-slate-400">
            <Scissors size={12} className="text-violet-400" />
            Travels as one job on {gang.members[0]?.board_name} — separates after die cutting
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-6 pb-6 pt-3">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Done</Button>
          {onPlan && (
            <Button className="flex-1 justify-center whitespace-nowrap" onClick={onPlan}>
              <Link2 size={13} /> Plan Gang Now
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// The banner line reused wherever a gang parent needs explaining.
export function GangBanner({ number, members = [], className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-violet-700 ${className}`}>
      <GangChip number={number} />
      <span>{members.length} jobs travel together</span>
      <span className="inline-flex items-center gap-1 text-violet-400">
        <Scissors size={11} /> separate after die cutting
      </span>
    </div>
  );
}
