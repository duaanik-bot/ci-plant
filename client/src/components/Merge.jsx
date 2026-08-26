// Combined Runs — the ONE visual language for a merged multi-order run.
// A COMBINED RUN (CI-MRG-) is the SAME carton on several sales orders, printed
// as one pile: it travels as a single TEAL row through the ENTIRE route —
// cutting → printing → die cutting → sorting → pasting → QC — and never
// splits. The sales orders get their identity back at dispatch, one challan
// per PO, earliest delivery first.
//
// Teal, deliberately NOT violet: violet means "separates after die cutting"
// everywhere in this app, and a combined run is the exact opposite promise.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Truck } from 'lucide-react';
import { fmt } from '../api.js';
import { Button } from './ui.jsx';
import ProductIdentity from './ProductIdentity.jsx';

// The little teal chip that marks a combined run everywhere.
export function MergeChip({ number, onClick, size = 10 }) {
  const cls = 'inline-flex items-center gap-1 rounded-full bg-teal-100/80 px-1.5 py-px text-[10px] font-bold text-teal-700 ring-1 ring-teal-200/70';
  if (!onClick) return <span className={cls}><Layers size={size - 1} /> {number}</span>;
  return (
    <button type="button" onClick={onClick} className={`${cls} transition-colors hover:bg-teal-200/70`}>
      <Layers size={size - 1} /> {number}
    </button>
  );
}

// The run's sales orders in one aligned grid — PO | delivery | qty. The
// PRODUCT is deliberately absent from the rows: a combined run is one carton
// by definition, so repeating its name N times would say nothing. What differs
// per member — and what the floor and the planner actually read — is whose
// order, due when, for how many.
export function MergeMemberList({ members = [], className = '' }) {
  if (!members?.length) return null;
  return (
    <div className={`overflow-hidden rounded-xl border border-teal-200/70 bg-teal-50/50 ${className}`}>
      {members.map((m, i) => (
        <div key={m.line_id ?? m.id ?? i}
          className={`grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] items-center gap-x-3 px-2.5 py-1.5 ${i ? 'border-t border-teal-100' : ''}`}>
          <div className="min-w-0 text-[11px] text-slate-600">
            <div className="truncate font-semibold text-slate-800">PO {m.po_number}</div>
            <div className="truncate text-[10px] text-slate-400">{m.customer_name}</div>
          </div>
          <div className="min-w-0 text-[11px] tabular-nums text-slate-500">
            {m.delivery_date ? fmt.date(m.delivery_date) : '—'}
          </div>
          <div className="text-right text-xs font-bold tabular-nums text-slate-800">
            {fmt.num(m.qty)}
            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">pcs</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Compact one-line summary — "3 sales orders · 74,100 pcs · one pile".
export function mergeSummary(members = []) {
  const total = members.reduce((s, m) => s + (+m.qty || 0), 0);
  return `${members.length} sales orders · ${fmt.num(total)} pcs`;
}

// UPI-style confirmation sheet the moment a run is combined — same skeleton as
// GangCreatedSheet so the two ceremonies feel like siblings, but the promise
// printed at the bottom is the opposite one.
export function MergeCreatedSheet({ run, onClose, onPlan }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!run) return null;
  const totalQty = run.members.reduce((s, m) => s + (+m.qty || 0), 0);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-[#1D1D1F]/[0.38] backdrop-blur-[10px] backdrop-saturate-150" onClick={onClose} />
      <div className="relative w-full max-w-sm animate-liquidPop overflow-hidden rounded-[30px] border border-white/75 bg-white/90 shadow-modal backdrop-blur-2xl">
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
          <h3 className="mt-4 text-lg font-extrabold tracking-tight text-[#1D1D1F]">Orders Combined</h3>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-teal-100/80 px-3 py-1 text-sm font-extrabold tabular-nums text-teal-700 ring-1 ring-teal-200/70">
            <Layers size={14} /> {run.gang_number}
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-slate-400">
            {new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>

        {/* Receipt — the one carton on top, then each PO's share of the pile. */}
        <div className="px-6 pb-2 pt-5">
          <div className="rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-1">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <ProductIdentity row={run.members[0]} compact nameClassName="!text-[13px] text-slate-800" />
              </div>
              <div className="shrink-0 text-right text-[13px] font-extrabold tabular-nums text-teal-700">
                {fmt.num(totalQty)}
                <span className="ml-1 text-[10px] font-semibold uppercase text-slate-400">pcs</span>
              </div>
            </div>
            {run.members.map(m => (
              <div key={m.id} className="flex items-center justify-between gap-3 border-t border-dashed border-slate-200 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-slate-700">PO {m.po_number}</div>
                  <div className="truncate text-[11px] text-slate-400">{m.customer_name}{m.delivery_date ? ` · due ${fmt.date(m.delivery_date)}` : ''}</div>
                </div>
                <div className="shrink-0 text-right text-[13px] font-bold tabular-nums text-slate-800">
                  {fmt.num(m.qty)}
                  <span className="ml-1 text-[10px] font-semibold uppercase text-slate-400">pcs</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-[11px] font-semibold text-slate-400">
            <Truck size={12} className="text-teal-500" />
            Runs as ONE job through every stage — allocated back per sales order at dispatch
          </p>
        </div>

        <div className="flex gap-2 px-6 pb-6 pt-3">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Done</Button>
          {onPlan && (
            <Button className="flex-1 justify-center whitespace-nowrap" onClick={onPlan}>
              <Layers size={13} /> Plan the Run Now
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// The banner line reused wherever a combined-run card needs explaining.
export function MergeBanner({ number, members = [], className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-teal-700 ${className}`}>
      <MergeChip number={number} />
      <span>{members.length} sales orders · one pile, no split</span>
      <span className="inline-flex items-center gap-1 text-teal-500">
        <Truck size={11} /> separates at dispatch
      </span>
    </div>
  );
}
