// Drafts keyed in by the AVS order intake (owner's request, 6 Oct 2026).
//
// The intake reads every new customer PO from the company mailbox and keys it
// into the ERP as a DRAFT sales order — and, for an item we have never made, a
// DRAFT product master mapped to its artwork. A draft is shown wherever orders
// are read, always in orange, and never reaches Planning until a person checks
// it against the PO and presses Confirm order (server: routes/drafts.js).
//
//   DraftsChip     the orange chip on Sales Orders / Status Sheet / Masters
//   DraftsPanel    every draft order (lines, new masters, artwork mapping,
//                  intake flags) and every draft master, with Open / Confirm
//   DraftBadge     "Draft · to confirm" beside a status
//   DRAFT_ROW      the orange row highlight, for DataTable's rowClass
//   useDraftSummary  the counts, refreshed when orders or products change
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, PackagePlus } from 'lucide-react';
import { api, fmt } from '../api.js';
import { Button, Modal, Textarea, useToast } from './ui.jsx';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import PhoneAlertsPrompt from './PhoneAlerts.jsx';

// `!` so the orange beats the table's zebra stripe, and a solid orange rail on
// the left edge so a draft reads by shape as well as colour.
export const DRAFT_ROW = '!bg-orange-50 hover:!bg-orange-100/70 shadow-[inset_4px_0_0_#F97316]';
export const isDraftOrder = o => o?.status === 'draft' || o?.order_status === 'draft';

const EMPTY = { orders: 0, lines: 0, products: 0, artworks: 0, total: 0 };
// Who may confirm: the people who key orders (server: requireRole('planner'), admin implied).
export const canConfirmDrafts = user => ['admin', 'planner'].includes(user?.role);

export function useDraftSummary(enabled = true) {
  const [s, setS] = useState(EMPTY);
  const load = () => api.get('/drafts/summary').then(setS).catch(() => {});
  // The intake writes through Supabase, which the realtime ping on orders and
  // products still announces; the poll is the backstop.
  useRealtimeRefresh(load, ['orders', 'order_lines', 'products'], { debounceMs: 1500, enabled });
  useFallbackRefresh(load, { enabled, intervalMs: 120000 });
  return [s, load];
}

export function DraftBadge({ title, compact = false }) {
  return (
    <span title={title || 'Keyed in by the AVS intake from the customer\'s PO. Not with Planning until someone checks it and presses Confirm order.'}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-orange-500 font-bold text-white ring-1 ring-inset ring-orange-600/30 ${compact ? 'px-2 py-px text-[10px]' : 'px-2.5 py-0.5 text-xs'}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/80" />
      Draft{compact ? '' : ' · to confirm'}
    </span>
  );
}

export function DraftsChip({ summary, onOpen }) {
  const s = summary || EMPTY;
  const parts = [
    s.orders && fmt.count(s.orders, 'order'),
    s.products && fmt.count(s.products, 'new master'),
    s.artworks && fmt.count(s.artworks, 'artwork'),
  ].filter(Boolean);
  const tip = s.total
    ? `Drafts from the AVS intake, waiting for a check: ${parts.join(' · ')}. Planning sees none of them until they are confirmed.`
    : 'No drafts waiting — every order the AVS intake keyed in has been confirmed.';
  return (
    <button type="button" onClick={onOpen} title={tip}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${s.total
        ? 'bg-orange-500 text-white shadow-sm hover:bg-orange-600'
        : 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200 hover:bg-orange-100'}`}>
      <FileText size={13} />
      <span>Drafts</span>
      <span className={`rounded-full px-1.5 tabular-nums ${s.total ? 'bg-white/25' : 'bg-orange-100'}`}>{s.total || 0}</span>
      {s.total > 0 && <span className="hidden font-semibold opacity-90 sm:inline">{parts.join(' · ')}</span>}
    </button>
  );
}

function ArtworkCell({ a }) {
  if (!a) return <span className="text-xs text-slate-400">No artwork mapped yet</span>;
  const tone = a.status === 'current' ? 'bg-emerald-50 text-emerald-700'
    : a.status === 'to_confirm' ? 'bg-orange-100 text-orange-800'
      : a.status === 'missing' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600';
  const code = [a.artwork_code, a.rev, a.output_number && `Out ${a.output_number}`].filter(Boolean).join(' · ');
  const link = id => id && `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
  return (
    <span className="block leading-tight">
      <span className={`inline-block rounded-full px-2 py-px text-[10px] font-bold ${tone}`}>{String(a.status || 'unknown').replace(/_/g, ' ')}</span>
      {code && <span className="ml-1.5 font-mono text-[11px] text-slate-600">{code}</span>}
      <span className="mt-0.5 flex gap-2 text-[11px]">
        {a.master_pdf_id && <a href={link(a.master_pdf_id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-brand-600 hover:underline">Master <ExternalLink size={10} /></a>}
        {a.approved_file_id && <a href={link(a.approved_file_id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-brand-600 hover:underline">Approval <ExternalLink size={10} /></a>}
      </span>
      {a.note && <span className="mt-0.5 block text-[11px] text-slate-500" title={a.note}>{a.note.length > 110 ? `${a.note.slice(0, 110)}…` : a.note}</span>}
    </span>
  );
}

// Confirm a draft order: lines to Planning, its new masters confirmed with it.
export function ConfirmDraftDialog({ order, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(''); }, [order?.id]);
  if (!order) return null;
  const newMasters = (order.lines || []).filter(l => l.product_is_draft && !l.part_of_line_id);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/orders/${order.id}/confirm`, { note });
      toast.success(`PO ${r.po_number} confirmed — ${fmt.count(r.lines, 'line')} sent to Planning${r.products?.length ? ` · ${fmt.count(r.products.length, 'new master')} confirmed` : ''}`);
      onDone?.(r);
    } catch (e) { toast.error(e.message || 'Could not confirm the order'); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? () => {} : onClose} layer="nested" title={`Confirm PO ${order.po_number}?`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Not yet</Button>
        <Button onClick={confirm} disabled={busy}><CheckCircle2 size={14} /> {busy ? 'Confirming…' : 'Confirm order'}</Button>
      </>}>
      <div className="space-y-3 text-sm text-slate-700">
        <p>Check every line against the customer's PO first — product, quantity, rate and delivery date. Once confirmed, the order is a normal pending order and its lines go to <b>Planning</b>.</p>
        {newMasters.length > 0 && (
          <div className="rounded-xl bg-orange-50 p-3 ring-1 ring-inset ring-orange-200">
            <p className="flex items-center gap-1.5 font-semibold text-orange-800"><PackagePlus size={14} /> {fmt.count(newMasters.length, 'new product master')} will be confirmed with it:</p>
            <ul className="mt-1 list-disc pl-5 text-[13px] text-orange-900">
              {newMasters.map(l => <li key={l.id}><span className="font-mono">{l.product_code}</span> — {l.product_name}</li>)}
            </ul>
            <p className="mt-1 text-xs text-orange-800">Check their specs (board, size, die, artwork) in Masters if you have not.</p>
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Note (optional)</span>
          <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Checked against the PO mail of 6 Oct" />
        </label>
      </div>
    </Modal>
  );
}

export function DraftsPanel({ open, onClose, onOpenOrder, canConfirm, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const load = () => api.get('/drafts').then(setData).catch(e => { toast.error(e.message || 'Could not load drafts'); setData({ orders: [], products: [] }); });
  useEffect(() => { if (open) { setData(null); load(); } }, [open]);
  const openOrder = o => {
    if (onOpenOrder) { onClose(); onOpenOrder(o); } else navigate(`/orders?order=${o.id}`);
  };
  const confirmProduct = async p => {
    try {
      await api.post(`/products/${p.id}/confirm-draft`, {});
      toast.success(`${p.code || p.name} confirmed`);
      load(); onChanged?.();
    } catch (e) { toast.error(e.message || 'Could not confirm the master'); }
  };
  const orders = data?.orders || [];
  const products = data?.products || [];
  return (
    <>
      <Modal open={open} onClose={onClose} wide title="Drafts from the AVS intake"
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <p className="mb-3 rounded-xl bg-orange-50 px-3 py-2 text-xs text-orange-900 ring-1 ring-inset ring-orange-200">
          Keyed in automatically from customer POs in the company mailbox. <b>Planning sees none of these</b> until someone checks each one against its PO and confirms it.
        </p>
        <PhoneAlertsPrompt compact />
        {!data ? <p className="py-10 text-center text-sm text-slate-400">Loading drafts…</p> : (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Draft sales orders ({orders.length})</h3>
              {orders.length === 0 ? <p className="rounded-xl border border-dashed py-6 text-center text-sm text-slate-400">No draft orders.</p> : (
                <div className="space-y-3">
                  {orders.map(o => (
                    <div key={o.id} className="rounded-2xl border border-orange-200 bg-orange-50/60 p-3 shadow-[inset_4px_0_0_#F97316]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <DraftBadge compact />
                          <span className="font-semibold text-slate-900">PO {o.po_number}</span>
                          <span className="text-sm text-slate-600">{o.customer_name}</span>
                          <span className="text-xs text-slate-500">PO date {fmt.date(o.po_date)}{o.delivery_date ? ` · Delivery ${fmt.date(o.delivery_date)}` : ''}</span>
                          <span className="text-xs font-semibold text-slate-700">{fmt.inr(o.value)}</span>
                          {o.new_products > 0 && <span className="rounded-full bg-orange-200 px-2 py-px text-[10px] font-bold text-orange-900">{fmt.count(o.new_products, 'new master')}</span>}
                        </div>
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="secondary" onClick={() => openOrder(o)}>Open / edit</Button>
                          {canConfirm && <Button size="sm" onClick={() => setConfirming(o)}><CheckCircle2 size={13} /> Confirm</Button>}
                        </div>
                      </div>
                      {o.draft_note && <p className="mt-1.5 text-xs text-orange-900">{o.draft_note}</p>}
                      {o.flags?.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {o.flags.map(f => (
                            <li key={f.id} className={`flex items-start gap-1.5 text-xs ${f.result === 'HOLD' || f.result === 'REJECT' ? 'text-red-700' : 'text-slate-600'}`}>
                              <AlertTriangle size={12} className="mt-px shrink-0" /><span><b>{f.result}</b> {f.text || f.kind}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="text-left text-[10px] font-bold uppercase text-slate-400">
                            <th className="py-1 pr-3">Product</th><th className="py-1 pr-3 text-right">Qty</th><th className="py-1 pr-3 text-right">Rate</th><th className="py-1">Artwork mapping</th>
                          </tr></thead>
                          <tbody>
                            {o.lines.map(l => (
                              <tr key={l.id} className="border-t border-orange-100 align-top">
                                <td className="py-1.5 pr-3">
                                  <span className="block font-semibold text-slate-800">{l.product_name}</span>
                                  <span className="font-mono text-[11px] text-slate-500">{[l.product_code, l.party_item_code, l.size].filter(Boolean).join(' · ')}</span>
                                  {l.product_is_draft ? <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 py-px text-[9px] font-bold text-white">NEW MASTER</span> : null}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt.num(l.qty)}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt.inr(l.rate)}</td>
                                <td className="py-1.5"><ArtworkCell a={l.artwork} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Draft product masters ({products.length})</h3>
              {products.length === 0 ? <p className="rounded-xl border border-dashed py-6 text-center text-sm text-slate-400">No draft masters.</p> : (
                <div className="overflow-x-auto rounded-2xl border border-orange-200">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-orange-50 text-left text-[10px] font-bold uppercase text-slate-500">
                      <th className="px-3 py-2">Product</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Board</th><th className="px-3 py-2">Artwork mapping</th><th className="px-3 py-2">On draft PO</th><th className="px-3 py-2" />
                    </tr></thead>
                    <tbody>
                      {products.map(p => (
                        <tr key={p.id} className="border-t border-orange-100 align-top">
                          <td className="px-3 py-2">
                            <span className="block font-semibold text-slate-800">{p.name}</span>
                            <span className="font-mono text-[11px] text-slate-500">{[p.code, p.party_item_code, p.size].filter(Boolean).join(' · ')}</span>
                            {p.draft_note && <span className="mt-0.5 block text-[11px] text-orange-800">{p.draft_note}</span>}
                          </td>
                          <td className="px-3 py-2">{p.customer_name || <span className="text-red-600">No customer</span>}</td>
                          <td className="px-3 py-2">{p.board_material_name || <span className="font-semibold text-red-600">No board set</span>}{p.spec_incomplete ? <span className="mt-0.5 block text-[10px] font-bold text-amber-700">Spec incomplete</span> : null}</td>
                          <td className="px-3 py-2"><ArtworkCell a={p.artwork} /></td>
                          <td className="px-3 py-2">{p.draft_pos || <span className="text-slate-400">—</span>}</td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="secondary" disabled={!p.board_material_id} title={p.board_material_id ? 'Open this master to check its spec' : 'Set a board on this master first — the Product Master lists only products with a board'} onClick={() => { onClose(); navigate(`/masters?edit=${p.id}`); }}>Master</Button>
                              {canConfirm && <Button size="sm" onClick={() => confirmProduct(p)}>Confirm</Button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </Modal>
      {confirming && (
        <ConfirmDraftDialog order={confirming} onClose={() => setConfirming(null)}
          onDone={() => { setConfirming(null); load(); onChanged?.(); }} />
      )}
    </>
  );
}
