// Who is holding a board — ONE vocabulary, everywhere board stock is quoted.
//
// The rule this module exists to enforce: never quote a free figure on its own
// when something is holding the rest back. "4,850 free — covers plan" was true
// arithmetic and a false sentence — 3,650 of those sheets were owed to two
// OMEZYME jobs, and the planner reading it was being told the board was
// unspoken for. A board that is spoken for must say so, and must name the job,
// because whether to take board off that job is a planner's decision and
// nobody else's. The engine's part is to put the name on screen.
//
// Three words, always in the same order and the same tones, so the reader
// learns them once: IN WAREHOUSE (what exists) → COMMITTED (what is owed to
// named jobs, amber) → FREE (what is actually takeable, green or red). When
// nothing is committed the first two are dropped: a board with no claim on it
// should read as plainly as it always did.
import { useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { fmt } from '../api.js';

// The stock split for one board, as one line of running text.
// `sufficient` / `short` are the caller's verdict about ITS OWN plan.
export function StockSplit({ available, committed = 0, free, short = 0, sufficient }) {
  const locked = committed > 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums">
      {locked && (
        <>
          <span className="text-slate-500">{fmt.num(available)} in warehouse</span>
          <span className="font-semibold text-amber-600">{fmt.num(committed)} committed</span>
        </>
      )}
      <span className={sufficient ? 'font-semibold text-emerald-600' : 'font-semibold text-red-500'}>
        {fmt.num(free)} free{sufficient ? ' — covers plan' : ` · short ${fmt.num(short)}`}
      </span>
    </span>
  );
}

// The named jobs behind `committed`, collapsed to the biggest claim and opened
// on a click. Collapsed shows a PRODUCT NAME rather than a count, because "2
// jobs" answers a question nobody asked — the planner wants to know whether the
// job in the way is one they are willing to take board from.
export function Claimants({ claimants = [], className = '' }) {
  const [open, setOpen] = useState(false);
  if (!claimants.length) return null;
  const [lead] = claimants;
  const rest = claimants.length - 1;

  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(o => !o)}
        title="Which jobs this board is already committed to"
        className="inline-flex w-full max-w-full items-center gap-1 rounded-lg bg-amber-50 px-1.5 py-0.5 text-left text-[10.5px] font-semibold text-amber-700 transition-colors hover:bg-amber-100">
        <Lock size={10} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Committed to {lead.product_name}{rest > 0 ? ` +${rest} more` : ''}
        </span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-lg bg-amber-50/70 px-2 py-1.5">
          {claimants.map(c => (
            <div key={c.order_line_id} className="flex items-start gap-2 text-[10.5px] leading-snug">
              <span className="min-w-0 flex-1">
                <span className="break-words font-semibold text-slate-700">{c.product_name}</span>
                <span className="block text-slate-400">
                  {c.customer_name}{c.po_number ? ` · PO ${c.po_number}` : ''}
                  {c.gang_number ? ` · ${c.gang_number}` : ''}
                  {/* Why this claim cannot simply be reassigned, said once. */}
                  {c.status === 'in_production' && ' · on the floor'}
                  {c.incoming > 0 && ` · ${fmt.num(c.incoming)} on order`}
                </span>
              </span>
              <span className="shrink-0 font-bold tabular-nums text-amber-700">{fmt.num(c.open_need)}</span>
            </div>
          ))}
          <p className="pt-0.5 text-[10px] leading-snug text-slate-400">
            Parent sheets each job is still waiting on. Using this board is your call — it does not release theirs.
          </p>
        </div>
      )}
    </div>
  );
}
