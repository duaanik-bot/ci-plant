// "Ordered For" — the column that answers, on the buying screens, the question
// the register never used to: which products is this board on order against?
//
// The cell states the answer in one line and opens the whole list on click. The
// list is a modal rather than a link out, because the buyer asking is mid-scan
// of a register and sending them to Planning to read four product names loses
// their place. From INSIDE the list each job does link out — `/planning?line=`
// is live and focuses the row (Planning.jsx reads it), so the drill-down ends
// somewhere real instead of at a page that ignores the id.
import { Link } from 'react-router-dom';
import { PackageSearch, ArrowUpRight } from 'lucide-react';
import { fmt } from '../api.js';
import { Modal, StatusBadge } from './ui.jsx';
import { commitmentSummary, commitmentCustomers, OPEN_ORDER } from '../lib/poCommitment.js';

// The cell. Committed reads blue and is clickable; an open order reads amber and
// is NOT — there is nothing behind it to open, and a button that opens nothing
// is the dead button this app has shipped before.
export function OrderedForCell({ commitments, onOpen, className = '' }) {
  const s = commitmentSummary(commitments);
  const customers = commitmentCustomers(commitments);

  if (s.kind === 'open') {
    return (
      <span className={`inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700 ${className}`}
        title="Bought to stock — no job's shortage put this on the order">
        {OPEN_ORDER}
      </span>
    );
  }

  // Every product is NAMED here, not counted. The codes wrap rather than
  // truncate: this cell exists to be read at a glance, and a tail hidden behind
  // "+2 more" puts the buyer back where they started — opening a panel to learn
  // what the order is for.
  return (
    <button type="button" onClick={onOpen}
      className={`group block w-full max-w-[260px] text-left touch:min-h-[38px] ${className}`}
      title={`${s.label} — click for customer, sales PO and job status`}>
      <span className="flex items-start gap-1">
        <PackageSearch size={12} className="mt-[3px] shrink-0 text-brand-600" />
        <span className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
          {s.names.map((n, i) => (
            <span key={n.key} className={n.on_board
              ? 'text-xs font-bold text-brand-600 underline-offset-2 group-hover:underline'
              : 'text-xs font-bold text-slate-400 line-through decoration-slate-300'}>
              {n.name}{i < s.names.length - 1 && <span className="font-normal text-slate-400"> ·</span>}
            </span>
          ))}
        </span>
      </span>
      {customers.length > 0 && (
        <span className="block truncate text-[10px] text-slate-400">
          {customers.slice(0, 2).join(' · ')}{customers.length > 2 ? ` +${customers.length - 2}` : ''}
        </span>
      )}
      {s.moved > 0 && (
        <span className="mt-0.5 inline-flex rounded-full bg-slate-100 px-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">
          {s.moved} moved off this board
        </span>
      )}
    </button>
  );
}

// The list behind the cell. `line` carries what the cell was standing on, so the
// heading can name the board and the order it sits on.
export function OrderedForModal({ line, onClose }) {
  const jobs = line?.commitments || [];
  return (
    <Modal open={!!line} onClose={onClose} size="wide"
      title={`Ordered for · ${line?.material_name || ''}`}>
      <div className="mb-3 text-[11px] text-slate-500">
        {line?.po_number}{line?.vendor_name ? ` · ${line.vendor_name}` : ''}
        {line?.qty != null && ` · ${fmt.num(line.qty)} ${line.unit || ''} ordered`}
      </div>

      {jobs.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          {OPEN_ORDER} — no job's shortage raised this. The board goes to the shelf.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#1D1D1F]/[0.06] text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Sales PO</th>
                <th className="px-3 py-2 text-right">Order Qty</th>
                <th className="px-3 py-2 text-right">Sheets</th>
                <th className="px-3 py-2">Raised on</th>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.order_line_id}
                  className={`border-b border-[#1D1D1F]/[0.04] last:border-0 ${j.on_board === false ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-2.5">
                    <div className="font-bold text-[#1D1D1F]">{j.product_code || '—'}</div>
                    <div className="max-w-[260px] truncate text-[11px] text-slate-500" title={j.product_name}>{j.product_name}</div>
                    {j.on_board === false && (
                      <div className="mt-0.5 text-[10px] font-bold text-amber-700">
                        re-anchored to another board since this was raised
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{j.customer_name || '—'}</td>
                  <td className="px-3 py-2.5 text-xs font-semibold text-slate-700">{j.sales_po || '—'}</td>
                  <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">{j.order_qty == null ? '—' : fmt.num(j.order_qty)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-semibold tabular-nums text-slate-700">{j.sheets == null ? '—' : fmt.num(j.sheets)}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className="font-semibold text-slate-600">{j.pr_number}</span>
                    {j.gang_number && <div className="text-[10px] text-violet-600">{j.gang_number}</div>}
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={j.status} /></td>
                  <td className="px-3 py-2.5 text-right">
                    <Link to={`/planning?line=${j.order_line_id}`} onClick={onClose}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-600 hover:underline">
                      Open job <ArrowUpRight size={12} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
