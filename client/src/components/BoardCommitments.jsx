// The one place that explains a board: what the warehouse has, how much of it is
// held for named jobs, and which jobs are waiting. Opened from a Procurement PR
// row today; the Planning Engine and Masters 360 will share it next.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, fmt } from '../api.js';
import { Modal, useToast } from './ui.jsx';

function Tile({ label, value, accent = 'text-slate-900' }) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

export default function BoardCommitments({ open, onClose, materialId, prContext = null }) {
  const [data, setData] = useState(null);
  const toast = useToast();

  useEffect(() => {
    if (!open || !materialId) return;
    let cancelled = false;
    setData(null);
    api.get(`/board/${materialId}/panel`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) toast.error('Could not load the board position'); });
    return () => { cancelled = true; };
  }, [open, materialId]);

  const targetLineId = prContext?.order_line_id || null;
  const target = data?.lines.find(l => l.id === targetLineId) || null;

  return (
    <Modal open={open} onClose={onClose} wide title={data?.board?.name || 'Board position'}>
      {!data ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2.5">
            <Tile label="In warehouse" value={fmt.num(data.available)} />
            <Tile label="Committed" value={fmt.num(data.held)}
              accent={data.held > 0 ? 'text-amber-600' : 'text-slate-900'} />
            <Tile label="Free" value={fmt.num(data.free)}
              accent={data.free > 0 ? 'text-emerald-600' : 'text-red-600'} />
          </div>

          {prContext && (
            <div className="rounded-xl border border-brand-200 bg-brand-50/70 px-3.5 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-500">
                {prContext.pr_number} is buying for
              </div>
              {target ? (
                <>
                  <div className="mt-1 text-sm font-semibold text-brand-800">{target.product_name}</div>
                  <div className="text-xs text-brand-600">
                    PO {target.po_number} · needs {fmt.num(target.need)} · from stock {fmt.num(target.held)} · buying {fmt.num(target.incoming)}
                  </div>
                </>
              ) : (
                <p className="mt-1 flex items-start gap-2 text-xs font-semibold text-amber-700">
                  <AlertTriangle size={14} className="mt-px shrink-0" />
                  This requisition was raised before jobs were linked to PRs, so it does not name a job yet.
                </p>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              The board in the warehouse is committed to
            </div>
            {data.lines.length === 0 ? (
              <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
                Nothing is planned on this board — all {fmt.num(data.available)} sheets are free.
              </p>
            ) : data.lines.map(l => (
              <div key={l.id} className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">
                    {l.product_name}
                    {l.gang_run_id && (
                      <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                        {l.gang_number || `gang #${l.gang_run_id}`}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">
                    PO {l.po_number} · {l.customer_name}
                    {l.planned_date ? ` · planned ${fmt.date(l.planned_date)}` : ''}
                  </div>
                </div>
                <div className="text-right text-sm font-semibold tabular-nums text-slate-700">
                  {fmt.num(l.need)}
                  {l.held > 0 && <div className="text-[11px] font-normal text-amber-600">{fmt.num(l.held)} held</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
