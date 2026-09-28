// Planning → From Stock. Every order completed from our own FG boxes and
// pushed straight to Dispatch & Invoice, with the undo back to planning.
//
// Undo lists each box booked to the line with its own tick: ticked goes back
// on the shelf, unticked stays reserved to the order. That is how a planner
// AMENDS the quantities — send it back keeping some boxes, then take more (or
// fewer) through Use FG Stock — rather than starting from nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Input, Modal, useToast } from './ui.jsx';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { PackageCheck, Undo2 } from 'lucide-react';

const UNDO_REASONS = ['Customer changed the quantity', 'Wrong box ticked', 'Stock found damaged', 'Order to be produced fresh'];

const boxLabel = b => b.box_number || b.lot_number;

export default function StockFulfilled({ canUndo, onChanged }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [undo, setUndo] = useState(null); // { line, release: Set<consumption id>, reason }
  const [busy, setBusy] = useState(false);

  // The toast context is a fresh object whenever a toast shows, so it rides a
  // ref — as a dependency, a failed load's own toast would re-fire the load.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const load = useCallback(async () => {
    try { setRows(await api.get('/planning/from-stock')); }
    catch (e) { toastRef.current.error(e.message || 'Could not load orders completed from stock'); setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

  const openUndo = line => setUndo({ line, release: new Set(line.boxes.map(b => b.id)), reason: '' });
  const toggle = id => setUndo(u => {
    const release = new Set(u.release);
    if (release.has(id)) release.delete(id); else release.add(id);
    return { ...u, release };
  });

  const doUndo = async () => {
    const reason = undo.reason.trim();
    if (!reason) return toast.error('Give a reason for sending it back');
    setBusy(true);
    try {
      const r = await api.post(`/order-lines/${undo.line.id}/return-to-planning`, { release: [...undo.release], reason });
      toast.success(`Back in To Plan — ${fmt.num(r.released)} pcs released to stock${r.kept ? `, ${fmt.num(r.kept)} pcs still reserved` : ''} · ${fmt.num(r.balance_to_produce)} to make`);
      setUndo(null);
      await load();
      onChanged?.();
    } catch (e) { if (!e.data) toast.error(e.message || 'Could not send it back'); }
    finally { setBusy(false); }
  };

  const releasing = undo ? undo.line.boxes.filter(b => undo.release.has(b.id)) : [];
  const keeping = undo ? undo.line.boxes.filter(b => !undo.release.has(b.id)) : [];
  const relQty = releasing.reduce((s, b) => s + b.qty, 0);
  const keepQty = keeping.reduce((s, b) => s + b.qty, 0);

  return (
    <>
      <p className="mb-3 text-xs text-slate-500">
        Orders filled from FG stock and sent straight to Dispatch & Invoice — no job card, no production.
        Until something is despatched, <b>Undo</b> brings the order back to To Plan.
      </p>
      <DataTable cardClass="ci-card-edge" searchable
        rows={rows || []}
        empty={rows === null ? 'Loading…' : 'No order has been completed from stock yet'}
        defaultSort={{ key: 'fulfilled_at', dir: 'desc' }}
        exportName="Completed from Stock"
        columns={[
          { key: 'po_number', label: 'SO / Customer', card: 'title',
            render: l => <div><span className="font-extrabold">{l.po_number}</span><span className="ml-2 text-xs text-gray-500">{l.customer_name}</span></div>,
            export: l => `${l.po_number} · ${l.customer_name}` },
          { key: 'product_name', label: 'Product', card: 'subtitle',
            render: l => <div className="leading-tight"><div className="font-semibold">{l.product_name}</div><div className="text-[11px] text-slate-400">{l.product_code}</div></div>,
            export: l => `${l.product_code} · ${l.product_name}` },
          { key: 'qty', label: 'Ordered', align: 'right', card: 'metric',
            render: l => <span className="tabular-nums">{fmt.num(l.qty)}</span>, export: l => fmt.num(l.qty) },
          { key: 'fg_consumed_qty', label: 'From Stock', align: 'right', card: 'metric',
            render: l => <span className="font-bold tabular-nums text-emerald-600">{fmt.num(l.fg_consumed_qty)}</span>,
            export: l => fmt.num(l.fg_consumed_qty) },
          { key: 'boxes', label: 'Boxes', sortValue: l => l.boxes.length,
            render: l => (
              <div className="flex flex-wrap gap-1">
                {l.boxes.map(b => (
                  <span key={b.id} className="rounded bg-slate-100 px-1.5 py-px font-mono text-[10px] font-semibold text-slate-600">
                    {boxLabel(b)} · {fmt.num(b.qty)}
                  </span>
                ))}
              </div>),
            export: l => l.boxes.map(b => `${boxLabel(b)} × ${b.qty}`).join(', ') },
          { key: 'dispatched_qty', label: 'Despatched', align: 'right', card: 'metric',
            render: l => <span className="tabular-nums">{fmt.num(l.dispatched_qty)}</span>, export: l => fmt.num(l.dispatched_qty) },
          { key: 'fulfilled_at', label: 'Sent to Dispatch', sortValue: l => l.fulfilled_at,
            render: l => <span className="whitespace-nowrap text-xs text-slate-500">{fmt.date(l.fulfilled_at)}{l.fulfilled_by ? ` · ${l.fulfilled_by}` : ''}</span>,
            export: l => `${fmt.date(l.fulfilled_at)}${l.fulfilled_by ? ` · ${l.fulfilled_by}` : ''}` },
          { key: '_act', label: '', sortable: false,
            render: l => (l.status === 'produced' && !(+l.dispatched_qty > 0)
              ? (canUndo && (
                <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); openUndo(l); }}>
                  <Undo2 size={13} /> Undo
                </Button>))
              : <span className="text-[11px] font-semibold text-slate-400">Despatched — final</span>) },
        ]} />

      <Modal open={!!undo} onClose={() => { if (!busy) setUndo(null); }} title="Send back to planning"
        footer={<>
          <Button variant="secondary" onClick={() => setUndo(null)} disabled={busy}>Cancel</Button>
          <Button onClick={doUndo} disabled={busy || !undo?.reason.trim()}>
            <Undo2 size={14} /> {busy ? 'Sending back…' : 'Send back to To Plan'}
          </Button>
        </>}>
        {undo && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <b>{undo.line.po_number}</b> · {undo.line.product_name} leaves Ready to Dispatch and returns to <b>To Plan</b>.
              Tick the boxes to put back on the shelf; any box left unticked stays reserved to this order.
            </p>
            <div className="space-y-1.5">
              {undo.line.boxes.map(b => (
                <label key={b.id} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-xs transition
                  ${undo.release.has(b.id) ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-slate-50'}`}>
                  <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={undo.release.has(b.id)} onChange={() => toggle(b.id)} />
                  <PackageCheck size={14} className="text-slate-400" />
                  <span className="font-bold text-slate-800">{boxLabel(b)}</span>
                  {b.box_number && <span className="text-[10px] text-slate-400">{b.lot_number}</span>}
                  <span className="tabular-nums text-slate-500">{fmt.num(b.qty)} pcs</span>
                  <span className={`ml-auto text-[10px] font-bold uppercase tracking-wide ${undo.release.has(b.id) ? 'text-amber-700' : 'text-violet-600'}`}>
                    {undo.release.has(b.id) ? 'back to stock' : 'keep reserved'}
                  </span>
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-amber-50 px-2 py-2"><div className="text-[10px] font-bold uppercase text-amber-700">Back to stock</div><div className="text-lg font-extrabold tabular-nums">{fmt.num(relQty)}</div></div>
              <div className="rounded-xl bg-violet-50 px-2 py-2"><div className="text-[10px] font-bold uppercase text-violet-700">Stays reserved</div><div className="text-lg font-extrabold tabular-nums">{fmt.num(keepQty)}</div></div>
              <div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-[10px] font-bold uppercase text-slate-500">To make</div><div className="text-lg font-extrabold tabular-nums">{fmt.num(Math.max(0, undo.line.qty - keepQty))}</div></div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-600">Reason <span className="text-brand-500">*</span></div>
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {UNDO_REASONS.map(r0 => (
                  <button key={r0} type="button" onClick={() => setUndo(u => ({ ...u, reason: r0 }))}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${undo.reason === r0
                      ? 'border-brand-500 bg-brand-500/10 text-brand-700' : 'border-[#1D1D1F]/10 bg-white/70 text-slate-600 hover:border-slate-300'}`}>
                    {r0}
                  </button>
                ))}
              </div>
              <Input value={undo.reason} onChange={e => setUndo(u => ({ ...u, reason: e.target.value }))}
                placeholder="Why this order is going back to planning" />
            </div>
            <p className="text-[11px] text-slate-400">Recorded in the order's audit trail and the FG ledger.</p>
          </div>
        )}
      </Modal>
    </>
  );
}
