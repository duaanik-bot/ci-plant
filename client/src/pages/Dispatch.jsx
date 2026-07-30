// Dispatch — produced lines appear here automatically. From the Ready list you
// open "Move FG" for a product: the on-hand FG cascades across that product's
// open sales orders within customer tolerance, boxes are auto-calculated from
// the dispatch quantity, and any leftover is boxed into individually-numbered
// CI-BOX lots (one per physical carton + one for the loose remainder).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Tabs, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { boxBreakdown, boxLabel } from '../lib/boxes.js';
import { Truck, Printer, Boxes, Pencil, Undo2, PackageCheck, Warehouse } from 'lucide-react';

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

export default function Dispatch({ embedded = false, view }) {
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState('ready');
  const [ready, setReady] = useState([]);
  const [register, setRegister] = useState([]);
  const [moving, setMoving] = useState(null);   // product-centric Move FG state
  const [loadingMove, setLoadingMove] = useState(false);
  const [saving, setSaving] = useState(false);

  const [threads, setThreads] = useState({});

  const load = () => {
    api.get('/dispatch/ready').then(setReady);
    api.get('/dispatches').then(ds => {
      setRegister(ds);
      threadSummary('dispatch', ds.map(d => d.id)).then(setThreads).catch(() => {});
    });
  };
  useEffect(() => { load(); }, []);

  // group ready lines by order (the card), each line is a product to move
  const byOrder = {};
  for (const l of ready) (byOrder[l.order_id] ||= { order_id: l.order_id, po_number: l.po_number, customer_name: l.customer_name, delivery_date: l.delivery_date, lines: [] }).lines.push(l);

  // Open the Move FG modal for a product — pull the cascade plan + FG on hand.
  const openMove = async (product_id, product_name) => {
    setMoving({ product_id, product_name, loading: true, allocations: [], fg_stock: 0, qty_per_box: 0, vehicle: '', driver: '' });
    setLoadingMove(true);
    try {
      const p = await api.get(`/fg/movement-preview?product_id=${product_id}`);
      setMoving({
        product_id, product_name: p.product_name || product_name,
        fg_stock: p.fg_stock, qty_per_box: p.qty_per_box || 0,
        vehicle: '', driver: '',
        allocations: (p.allocations || []).map(a => ({ ...a, dispatch_now: a.dispatch_qty })),
      });
    } catch { setMoving(null); } finally { setLoadingMove(false); }
  };

  const setAllocQty = (order_line_id, v) =>
    setMoving(m => ({ ...m, allocations: m.allocations.map(a => (a.order_line_id === order_line_id ? { ...a, dispatch_now: v } : a)) }));

  const toDispatch = moving ? moving.allocations.reduce((s, a) => s + (Math.floor(+a.dispatch_now) || 0), 0) : 0;
  const leftover = moving ? Math.max(0, moving.fg_stock - toDispatch) : 0;

  const boxNumbersLabel = boxes => {
    if (!boxes?.length) return '';
    const nums = boxes.map(b => b.box_number);
    return boxes.length === 1 ? nums[0] : `${boxes.length} boxes: ${nums[0]}…${nums[nums.length - 1]}`;
  };

  // Box the whole on-hand FG for this product into numbered leftover cartons.
  const boxAllAsLeftover = async () => {
    if (!moving.fg_stock) return toast.error('No FG on hand to box');
    setSaving(true);
    try {
      const res = await api.post('/fg/move', { product_id: moving.product_id, mode: 'leftover', leftover_qty: moving.fg_stock });
      toast.success(`Boxed ${fmt.num(moving.fg_stock)} as leftover — ${boxNumbersLabel(res.boxes)}`);
      setMoving(null); load();
    } catch { /* server explains via central toast */ } finally { setSaving(false); }
  };

  // Dispatch the entered per-order quantities — one challan per sales order.
  const dispatchNow = async () => {
    const allocations = moving.allocations
      .filter(a => (Math.floor(+a.dispatch_now) || 0) > 0)
      .map(a => ({ order_line_id: a.order_line_id, qty: Math.floor(+a.dispatch_now) }));
    if (!allocations.length) return toast.error('Enter at least one dispatch quantity');
    setSaving(true);
    try {
      const res = await api.post('/fg/move', {
        product_id: moving.product_id, mode: 'dispatch', allocations,
        vehicle: moving.vehicle, driver: moving.driver,
      });
      const nums = (res.challans || []).map(c => c.challan_number).join(', ');
      toast.success(`Dispatched ${fmt.num(toDispatch)} — challan ${nums}`);
      setMoving(null); load();
      if (res.challans?.length === 1) nav(`/dispatch/challan/${res.challans[0].id}`);
    } catch { /* tolerance / stock 409 surfaces via central toast */ } finally { setSaving(false); }
  };

  // Cancel an entire challan — reverse every line back to FG stock, one click.
  const cancelDispatch = async d => {
    if (!window.confirm(`Cancel challan ${d.challan_number}? All its goods go back to FG stock and the challan is removed.`)) return;
    try {
      await api.post(`/dispatches/${d.id}/cancel`, {});
      toast.success(`${d.challan_number} cancelled — goods returned to FG`);
      load();
    } catch (e) { toast.error(e.message || 'Could not cancel the challan'); }
  };

  const activeView = embedded ? view : tab;

  return (
    <div>
      {!embedded && <PageHeader title="Dispatch" subtitle="Finished goods flow here automatically when a job closes" />}
      {!embedded && (
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'ready', label: 'Ready to Dispatch', count: Object.keys(byOrder).length },
          { key: 'register', label: 'Dispatch Register', count: register.length },
        ]} />
      )}

      {activeView === 'ready' && (
        <div className="space-y-3">
          {Object.keys(byOrder).length === 0 &&
            <p className="rounded-xl border border-dashed bg-white py-14 text-center text-sm text-gray-400">Nothing waiting for dispatch.</p>}
          {Object.values(byOrder).map(grp => (
            <div key={grp.order_id} className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <span className="text-sm font-extrabold">{grp.po_number}</span>
                  <span className="ml-2 text-xs text-gray-500">{grp.customer_name} · delivery {fmt.date(grp.delivery_date)}</span>
                  {grp.lines[0]?.tolerance_pct > 0 && (
                    <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">±{grp.lines[0].tolerance_pct}% tolerance</span>
                  )}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                  <th className="px-3 py-1.5">Product</th><th className="px-3 py-1.5">Packing</th>
                  <th className="px-3 py-1.5 text-right">Ordered</th>
                  <th className="px-3 py-1.5 text-right">Dispatched</th><th className="px-3 py-1.5 text-right">FG in Stock</th>
                  <th className="px-3 py-1.5 text-right"></th>
                </tr></thead>
                <tbody>
                  {grp.lines.map(l => (
                    <tr key={l.order_line_id} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2">{l.product_name} <span className="text-xs text-gray-400">{l.code}</span></td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {l.packed_total > 0
                          ? <span className="inline-flex items-center gap-1"><Boxes size={12} className="text-slate-400" /> {fmt.num(l.packed_total)} pcs in {l.pack_boxes} boxes</span>
                          : l.pack_boxes
                            ? <span className="inline-flex items-center gap-1"><Boxes size={12} className="text-slate-400" /> {l.pack_boxes} boxes{l.pack_qty_per_box ? ` × ${l.pack_qty_per_box}` : ''}</span>
                            : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.dispatched_qty)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums text-emerald-600">{fmt.num(l.fg_qty)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" onClick={() => openMove(l.product_id, l.product_name)}><Truck size={14} /> Move FG</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {activeView === 'register' && (
        <DataTable searchable
          columns={[
            { key: 'challan_number', label: 'Challan', render: d => <span className="font-semibold">{d.challan_number}</span> },
            { key: 'dispatched_at', label: 'Date', render: d => fmt.dt(d.dispatched_at) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'po_number', label: 'Against PO' },
            { key: 'vehicle', label: 'Vehicle' },
            { key: 'lines', label: 'Items', render: d => <span className="text-xs text-gray-500">{d.lines.map(l => `${l.product_name} ×${fmt.num(l.qty)}`).join(', ')}</span> },
            threadColumn({ entity: 'dispatch', threads, idOf: d => d.id }),
            { key: 'actions', label: '', render: d => (
              <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="secondary" title="Edit vehicle, driver or line quantities" onClick={() => nav(`/dispatch/challan/${d.id}`)}><Pencil size={13} /> Edit</Button>
                <Button size="sm" variant="ghost" title="Print delivery challan" onClick={() => nav(`/dispatch/challan/${d.id}`)}><Printer size={14} /> Print</Button>
                <Button size="sm" variant="ghost" title="Cancel challan — return goods to FG" onClick={() => cancelDispatch(d)}><Undo2 size={13} /> Cancel</Button>
              </div>) },
          ]}
          rows={register} empty="No dispatches yet"
          rowClass={unreadRowClass(threads, d => d.id)}
          getRowId={d => d.id}
          exportName="Dispatch Register"
          exportSubtitle="Challans with vehicle and item detail" />
      )}

      {/* Move FG — product-centric dispatch / leftover with live box math */}
      <Modal open={!!moving} onClose={() => setMoving(null)} wide
        title={moving ? `Move FG — ${moving.product_name}` : ''}
        footer={moving && !moving.loading && (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setMoving(null)} disabled={saving}>Keep in FG</Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={boxAllAsLeftover} disabled={saving || !moving.fg_stock}>
                <Warehouse size={14} /> Box all {fmt.num(moving.fg_stock)} as Leftover
              </Button>
              <Button onClick={dispatchNow} disabled={saving || toDispatch <= 0}>
                <PackageCheck size={14} /> Dispatch {fmt.num(toDispatch)}
              </Button>
            </div>
          </div>
        )}>
        {moving && (moving.loading || loadingMove ? (
          <p className="py-10 text-center text-sm text-gray-400">Loading FG movement plan…</p>
        ) : (
          <div className="space-y-4">
            {/* Three summary tiles */}
            <div className="grid grid-cols-3 gap-3">
              {[
                ['FG on hand', moving.fg_stock, 'from-slate-50 to-slate-100 text-slate-800'],
                ['To dispatch', toDispatch, 'from-emerald-50 to-emerald-100 text-emerald-700'],
                ['Leftover', leftover, 'from-amber-50 to-amber-100 text-amber-700'],
              ].map(([k, v, cls]) => (
                <div key={k} className={`rounded-2xl bg-gradient-to-br ${cls} px-4 py-3 shadow-sm`}>
                  <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{k}</div>
                  <div className="text-2xl font-black tabular-nums">{fmt.num(v)}</div>
                  <div className="text-[11px] font-semibold opacity-70">{boxLabel(v, moving.qty_per_box, fmt.num)}</div>
                </div>
              ))}
            </div>

            <div className="text-[11px] font-semibold text-slate-500">
              Box size on record: {moving.qty_per_box > 0 ? `${fmt.num(moving.qty_per_box)} / box` : 'none — leftover will box as one lot'}
            </div>

            {/* One row per allocated sales order */}
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-1.5">Sales Order</th><th className="px-3 py-1.5">Customer</th>
                <th className="px-3 py-1.5 text-right">Ordered</th><th className="px-3 py-1.5 text-right">Dispatched</th>
                <th className="px-3 py-1.5 text-right">Tol %</th><th className="px-3 py-1.5 text-right">Max incl. tol</th>
                <th className="px-3 py-1.5 text-right">Dispatch Now</th>
              </tr></thead>
              <tbody>
                {moving.allocations.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No open sales order needs this product — box the FG as leftover.</td></tr>
                )}
                {moving.allocations.map(a => {
                  const room = Math.max(0, a.allowed_max - a.dispatched);
                  const val = Math.floor(+a.dispatch_now) || 0;
                  const over = val > room;
                  const b = boxBreakdown(val, moving.qty_per_box);
                  return (
                    <tr key={a.order_line_id} className="border-b border-gray-50 align-top">
                      <td className="px-3 py-2 font-semibold">{a.po_number}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{a.customer_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(a.ordered)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(a.dispatched)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">±{a.tolerance_pct}%</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmt.num(a.allowed_max)}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0"
                          value={a.dispatch_now}
                          onChange={e => setAllocQty(a.order_line_id, e.target.value)}
                          className={`w-32 rounded-lg border px-2 py-1 text-right text-sm focus:outline-none ${over ? 'border-amber-400 bg-amber-50 focus:border-amber-500' : 'border-gray-300 focus:border-brand-500'}`} />
                        <div className={`mt-0.5 text-[10px] font-semibold ${over ? 'text-amber-600' : 'text-slate-400'}`}>
                          {over ? `beyond tolerance — room ${fmt.num(room)}` : `room ${fmt.num(room)}`}
                        </div>
                        {val > 0 && (
                          <div className="mt-0.5 text-[11px] font-semibold text-emerald-600">
                            = {b.per > 0 ? `${fmt.num(b.boxes)} box${b.boxes === 1 ? '' : 'es'} × ${fmt.num(b.per)}${b.loose > 0 ? ` + ${fmt.num(b.loose)} loose` : ''}` : `${fmt.num(b.loose)} loose`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Vehicle / Driver */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vehicle No"><Input value={moving.vehicle} onChange={e => setMoving({ ...moving, vehicle: e.target.value })} placeholder="PB-10-XX-0000" /></Field>
              <Field label="Driver"><Input value={moving.driver} onChange={e => setMoving({ ...moving, driver: e.target.value })} /></Field>
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
}
