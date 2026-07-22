// Finished Goods — QC-accepted production, batch by batch (job card).
// Ordered vs produced (excess / short), available for dispatch, location,
// and full stage-by-stage production history + dispatch traceability.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { AgeChip, Button, ExportMenu, Field, Input, KpiCard, Modal, PageHeader, rowMatches, SearchInput, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Boxes, PackageCheck, TruckIcon, AlertTriangle, ArrowUpRight, History, MapPin, PackagePlus, ShieldCheck, ClipboardCheck, Pencil } from 'lucide-react';

export default function FinishedGoods() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [lots, setLots] = useState([]);
  const [moves, setMoves] = useState([]);
  const [pending, setPending] = useState([]);      // QC awaiting inspection
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('inspect');
  const [detail, setDetail] = useState(null);
  const [pushing, setPushing] = useState(null);   // batch row → push-excess modal
  const [verifying, setVerifying] = useState(null); // lot → verification modal
  const [inspect, setInspect] = useState(null);   // QC stage → inspection modal
  const [editBox, setEditBox] = useState(null);   // lot → edit-box modal

  const load = () => {
    api.get('/finished-goods').then(setRows); api.get('/fg-lots').then(setLots);
    api.get('/fg-movements').then(setMoves); api.get('/qc/pending').then(setPending);
  };
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  // Pass QC: start the stage if it hasn't been, then complete it with the
  // inspector's counts. The server enforces inspector + remark (Phase 2 gate).
  const submitInspection = async () => {
    const i = inspect;
    const accepted = +i.qty_accepted, rejected = +(i.qty_rejected || 0), rework = +(i.qty_rework || 0);
    if (!i.inspector?.trim()) return toast.error('Inspector name is required');
    if (!i.remarks?.trim()) return toast.error('An inspection remark is required');
    if (accepted + rejected + rework > i.qty_in) return toast.error(`Accepted + rejected + rework exceeds ${i.qty_in} received`);
    try {
      if (i.stage_status === 'pending') await api.post(`/job-stages/${i.stage_id}/start`, {});
      await api.post(`/job-stages/${i.stage_id}/complete`, {
        qty_accepted: accepted, qty_rejected: rejected, qty_rework: rework,
        inspector: i.inspector.trim(), remarks: i.remarks.trim(),
        scrap_reason: rejected > 0 ? (i.scrap_reason || 'QC reject') : undefined,
      });
      toast.success(`QC passed — ${accepted} accepted to Finished Goods`);
      setInspect(null); load();
    } catch (e) { toast.error(e.message || 'Could not complete QC'); }
  };

  const kpis = useMemo(() => ({
    batches: rows.length,
    available: rows.reduce((s, r) => s + Math.max(0, r.available), 0),
    value: rows.reduce((s, r) => s + Math.max(0, r.available) * (r.rate || 0), 0),
    excess: rows.reduce((s, r) => s + r.excess, 0),
    shortfall: rows.reduce((s, r) => s + r.shortfall, 0),
  }), [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (tab === 'ready') out = out.filter(r => r.available > 0);
    else if (tab === 'dispatched') out = out.filter(r => r.available <= 0);
    if (q) out = out.filter(r => rowMatches(r, q));
    return out;
  }, [rows, tab, q]);

  const openDetail = async r => setDetail(await api.get(`/finished-goods/${r.job_card_id}`));

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  return (
    <div>
      <PageHeader title="Finished Goods & QC" subtitle="Inspect production, hold finished stock, and box leftover — one quality-to-warehouse module" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="FG Batches" value={fmt.num(kpis.batches)} icon={Boxes} />
        <KpiCard label="Available Cartons" value={fmt.num(kpis.available)} icon={PackageCheck} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
        <KpiCard label="FG Value" value={fmt.inr(kpis.value)} icon={ArrowUpRight} />
        <KpiCard label="Excess" value={fmt.num(kpis.excess)} icon={AlertTriangle} chip="bg-amber-50 text-amber-600" accent={kpis.excess ? 'text-amber-600' : 'text-slate-900'} />
        <KpiCard label="Short vs Order" value={fmt.num(kpis.shortfall)} icon={AlertTriangle} chip="bg-red-50 text-red-500" accent={kpis.shortfall ? 'text-red-600' : 'text-slate-900'} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'inspect', label: 'Pending Inspection', count: pending.length },
          { key: 'ready', label: 'Dispatch-Ready', count: rows.filter(r => r.available > 0).length },
          { key: 'dispatched', label: 'Fully Dispatched', count: rows.filter(r => r.available <= 0).length },
          { key: 'all', label: 'All Batches', count: rows.length },
          { key: 'lots', label: 'Leftover Boxes', count: lots.filter(l => l.status === 'pending_verification').length },
          { key: 'ledger', label: 'Movement Ledger', count: moves.length },
        ]} />
        <div className="mb-4 flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="Batch, product, PO, customer…" />
          <ExportMenu build={() => {
            const kpiSummary = [
              { label: 'FG batches', value: fmt.num(kpis.batches) },
              { label: 'Available cartons', value: fmt.num(kpis.available) },
              { label: 'FG value', value: fmt.inr(kpis.value) },
              { label: 'Excess', value: fmt.num(kpis.excess) },
              { label: 'Short vs order', value: fmt.num(kpis.shortfall) },
            ];
            if (tab === 'lots') return {
              name: 'FG Lots',
              title: 'FG Lots',
              subtitle: 'Finished Goods · Labelled excess stock and verification',
              meta: [q ? `Search: "${q}"` : null],
              columns: [
                { key: 'lot_number', label: 'Lot' },
                { key: 'created_at', label: 'Created', export: l => `${fmt.date(l.created_at)}${l.created_by ? ` · ${l.created_by}` : ''}` },
                { key: 'product_name', label: 'Product', export: l => `${l.product_name} (${l.product_code})` },
                { key: 'source', label: 'Source', export: l => `${fmt.title(l.source)}${l.source_batch ? ` · batch ${l.source_batch}` : ''}${l.source_po ? ` · PO ${l.source_po}` : ''}` },
                { key: 'qty', label: 'Qty', align: 'right', export: l => fmt.num(l.qty) },
                { key: 'box_count', label: 'Boxes', export: l => (l.box_count ? `${l.box_count}${l.qty_per_box ? ` × ${l.qty_per_box}` : ''}${l.loose_qty ? ` + ${l.loose_qty} loose` : ''}` : '—') },
                { key: 'consumed_qty', label: 'Consumed', align: 'right', export: l => fmt.num(l.consumed_qty) },
                { key: 'remaining', label: 'Remaining', align: 'right', export: l => fmt.num(l.remaining) },
                { key: 'status', label: 'Status', export: l => fmt.title(l.status) },
                { key: 'verified_by', label: 'Verification', export: l => (l.verified_by ? `${l.verified_by} · ${fmt.dt(l.verified_at)}` : '—') },
              ],
              rows: lots.filter(l => rowMatches(l, q)),
            };
            return {
              name: `FG Batches ${fmt.title(tab)}`,
              title: 'Finished Goods Batches',
              subtitle: 'QC-accepted production · batch traceability',
              meta: [`Tab: ${{ ready: 'Dispatch-Ready', dispatched: 'Fully Dispatched', all: 'All Batches' }[tab]}`, q ? `Search: "${q}"` : null],
              summary: kpiSummary,
              columns: [
                { key: 'batch', label: 'Batch (JC)', export: r => `${r.batch} · ${fmt.date(r.closed_at)}` },
                { key: 'product_name', label: 'Product', export: r => `${r.product_name} (${r.product_code})` },
                { key: 'customer_name', label: 'Customer / PO', export: r => `${r.customer_name} · PO ${r.po_number}` },
                { key: 'ordered_qty', label: 'Ordered', align: 'right', export: r => fmt.num(r.ordered_qty) },
                { key: 'qty_produced', label: 'Produced', align: 'right', export: r => fmt.num(r.qty_produced) },
                { key: 'excess', label: 'Excess / Short', align: 'right', export: r => (r.excess > 0 ? `+${fmt.num(r.excess)}` : r.shortfall > 0 ? `-${fmt.num(r.shortfall)}` : 'even') },
                { key: 'available', label: 'Available', align: 'right', export: r => fmt.num(Math.max(0, r.available)) },
                { key: 'fg_location', label: 'Location', export: r => r.fg_location || 'FG-STORE' },
                { key: 'readiness', label: 'Readiness', export: r => (r.available > 0 ? 'Ready' : 'Dispatched') },
              ],
              rows: filtered,
            };
          }} />
        </div>
      </div>

      {/* Pending QC inspection — the unified module's quality gate */}
      {tab === 'inspect' && (
        <div className="overflow-hidden rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                <th className={`${th} text-right`}>S.No.</th>
                <th className={th}>Batch (JC)</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
                <th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>To Inspect</th>
                <th className={th}>Stage</th><th className={th} />
              </tr></thead>
              <tbody>
                {pending.filter(r => rowMatches(r, q)).length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">Nothing awaiting inspection — batches arrive here once every stage before QC is complete.</td></tr>
                )}
                {pending.filter(r => rowMatches(r, q)).map((r, i) => {
                  const toInspect = r.qty_in ?? r.prev_out ?? 0;
                  return (
                    <tr key={r.stage_id} className="border-b border-slate-50 last:border-0">
                      <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                      <td className={`${td} font-bold text-slate-900`}>{r.batch}</td>
                      <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></td>
                      <td className={td}><div className="text-slate-700">{r.customer_name || '—'}</div><div className="text-xs text-slate-400">PO {r.po_number || '—'}</div></td>
                      <td className={`${td} text-right tabular-nums`}>{fmt.num(r.ordered_qty)}</td>
                      <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(toInspect)}</td>
                      <td className={td}><StatusBadge status={r.stage_status === 'in_progress' ? 'in_production' : r.stage_status} /></td>
                      <td className={`${td} text-right`}>
                        <Button size="sm" onClick={() => setInspect({
                          stage_id: r.stage_id, stage_status: r.stage_status, batch: r.batch, product_name: r.product_name,
                          qty_in: toInspect, qty_accepted: String(toInspect), qty_rejected: '', qty_rework: '',
                          inspector: auth.user?.name || '', remarks: '', scrap_reason: '',
                        })}><ClipboardCheck size={13} /> Inspect</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* FG lots — labelled excess stock: verify physically, then planning can consume */}
      {tab === 'lots' && (
        <div className="overflow-hidden rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                <th className={`${th} text-right`}>S.No.</th>
                <th className={th}>Box #</th><th className={th}>Lot</th><th className={th}>Product</th><th className={th}>Source</th>
                <th className={`${th} text-right`}>Qty</th><th className={th}>Boxes</th>
                <th className={`${th} text-right`}>Consumed</th><th className={`${th} text-right`}>Remaining</th>
                <th className={th}>Status</th><th className={th}>Verification</th><th className={th} />
              </tr></thead>
              <tbody>
                {lots.length === 0 && (
                  <tr><td colSpan={12} className="px-4 py-12 text-center text-sm text-slate-400">No leftover boxes yet — push excess from a batch (or, in Phase 3, box it straight off the FG list).</td></tr>
                )}
                {lots.filter(l => rowMatches(l, q)).map((l, i) => (
                  <tr key={l.id} className="border-b border-slate-50 last:border-0">
                    <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                    <td className={td}>
                      <button type="button" onClick={() => setEditBox({ ...l, box_number: l.box_number || '' })}
                        className="group flex items-center gap-1 font-mono text-xs font-bold text-slate-800 hover:text-brand-600">
                        {l.box_number || <span className="text-slate-300">— assign —</span>}
                        <Pencil size={11} className="opacity-0 transition group-hover:opacity-100" />
                      </button>
                      {l.kind === 'leftover'
                        ? <div className="mt-0.5 inline-block rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">Leftover</div>
                        : <div className="mt-0.5 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">FG Excess</div>}
                    </td>
                    <td className={`${td} font-bold text-slate-900`}>
                      <span className="flex items-center gap-1.5">{l.lot_number}{l.remaining > 0 && ['pending_verification', 'verified'].includes(l.status) && <AgeChip date={l.created_at} />}</span>
                      <div className="text-[11px] font-normal text-slate-400">{fmt.date(l.created_at)}{l.created_by ? ` · ${l.created_by}` : ''}</div>
                    </td>
                    <td className={td}><div className="font-semibold text-slate-800">{l.product_name}</div><div className="text-xs text-slate-400">{l.product_code}</div></td>
                    <td className={`${td} text-xs text-slate-500`}>
                      {fmt.title(l.source)}{l.source_batch ? <div className="text-[11px] text-slate-400">batch {l.source_batch}{l.source_po ? ` · PO ${l.source_po}` : ''}</div> : null}
                    </td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(l.qty)}</td>
                    <td className={`${td} text-xs text-slate-500`}>
                      {l.box_count ? `${l.box_count} boxes${l.qty_per_box ? ` × ${l.qty_per_box}` : ''}${l.loose_qty ? ` + ${l.loose_qty} loose` : ''}` : '—'}
                    </td>
                    <td className={`${td} text-right tabular-nums text-slate-500`}>{fmt.num(l.consumed_qty)}</td>
                    <td className={`${td} text-right font-bold tabular-nums`}>{fmt.num(l.remaining)}</td>
                    <td className={td}><StatusBadge status={l.status} /></td>
                    <td className={`${td} text-xs text-slate-500`}>
                      {l.verified_by ? <>{l.verified_by}<div className="text-[11px] text-slate-400">{fmt.dt(l.verified_at)}{l.verification_note ? ` · ${l.verification_note}` : ''}</div></> : '—'}
                    </td>
                    <td className={`${td} text-right`}>
                      {l.status === 'pending_verification' && ['admin', 'qc', 'planner'].includes(auth.user?.role) && (
                        <Button size="sm" variant="secondary" onClick={() => setVerifying({ lot: l, note: '' })}>
                          <ShieldCheck size={13} /> Verify
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* FG Warehouse Movement Ledger — every stock movement against a reference */}
      {tab === 'ledger' && (() => {
        const MOVE = { opening_stock: 'Opening Stock', production_receipt: 'Production Receipt', stock_consumption: 'Stock Consumption', excess_stock: 'Excess Stock', manual_adjustment: 'Manual Adjustment' };
        const filteredMoves = moves.filter(m => rowMatches(m, q));
        return (
          <div className="overflow-hidden rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                  <th className={th}>Reference</th><th className={th}>Type</th><th className={th}>Product</th>
                  <th className={th}>Sales Order / Customer</th>
                  <th className={`${th} text-right`}>In</th><th className={`${th} text-right`}>Out</th>
                  <th className={`${th} text-right`}>Balance</th><th className={th}>Source</th><th className={th}>Date / By</th>
                </tr></thead>
                <tbody>
                  {filteredMoves.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">No FG movements yet — consuming or pushing stock records a row here.</td></tr>
                  )}
                  {filteredMoves.map(m => (
                    <tr key={m.id} className="border-b border-slate-50 last:border-0">
                      <td className={`${td} font-bold text-slate-900`}>
                        {m.ref_number}
                        {m.parent_ref && <div className="text-[10px] font-normal text-violet-500">← {m.parent_ref}</div>}
                      </td>
                      <td className={td}><span className="whitespace-nowrap text-xs font-semibold text-slate-600">{MOVE[m.movement_type]}</span></td>
                      <td className={td}><div className="font-semibold text-slate-800">{m.product_name}</div><div className="text-xs text-slate-400">{m.internal_carton_code || m.party_artwork_code || m.product_code}</div></td>
                      <td className={td}>{m.po_number ? <><div className="text-slate-700">PO {m.po_number}</div><div className="text-xs text-slate-400">{m.customer_name}</div></> : <span className="text-slate-300">—</span>}</td>
                      <td className={`${td} text-right tabular-nums text-emerald-600`}>{m.qty_in ? fmt.num(m.qty_in) : ''}</td>
                      <td className={`${td} text-right tabular-nums text-red-500`}>{m.qty_out ? fmt.num(m.qty_out) : ''}</td>
                      <td className={`${td} text-right font-bold tabular-nums`}>{fmt.num(m.balance)}</td>
                      <td className={`${td} text-xs capitalize text-slate-500`}>{m.source_module}</td>
                      <td className={`${td} text-xs text-slate-500`}>{fmt.date(m.created_at)}{m.created_by ? <div className="text-[11px] text-slate-400">{m.created_by}</div> : null}{m.remarks ? <div className="text-[10px] italic text-slate-400">{m.remarks}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {!['lots', 'ledger', 'inspect'].includes(tab) && (
      <div className="overflow-hidden rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 bg-slate-50/80">
              <th className={`${th} text-right`}>S.No.</th>
              <th className={th}>Batch (JC)</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
              <th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Produced</th>
              <th className={`${th} text-right`}>Excess / Short</th><th className={`${th} text-right`}>Available</th>
              <th className={th}>Location</th><th className={th}>Readiness</th><th className={th} />
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-sm text-slate-400">No finished-goods batches in this view. Close a job through QC to see it here.</td></tr>
              )}
              {filtered.map((r, i) => (
                <tr key={r.job_card_id} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60" onClick={() => openDetail(r)}>
                  <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                  <td className={`${td} font-bold text-slate-900`}>{r.batch}<div className="text-[11px] font-normal text-slate-400">{fmt.date(r.closed_at)}</div></td>
                  <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></td>
                  <td className={td}><div className="text-slate-700">{r.customer_name}</div><div className="text-xs text-slate-400">PO {r.po_number}</div></td>
                  <td className={`${td} text-right tabular-nums`}>{fmt.num(r.ordered_qty)}</td>
                  <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_produced)}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {r.excess > 0 ? <span className="text-amber-600">+{fmt.num(r.excess)}</span>
                      : r.shortfall > 0 ? <span className="text-red-600">−{fmt.num(r.shortfall)}</span>
                      : <span className="text-slate-300">even</span>}
                  </td>
                  <td className={`${td} text-right font-bold tabular-nums ${r.available > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{fmt.num(Math.max(0, r.available))}</td>
                  <td className={`${td} text-xs`}><span className="inline-flex items-center gap-1 text-slate-500"><MapPin size={11} />{r.fg_location || 'FG-STORE'}</span></td>
                  <td className={td}>
                    {r.available > 0
                      ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"><TruckIcon size={11} /> Ready</span>
                      : <StatusBadge status="dispatched" />}
                  </td>
                  <td className={`${td} text-right`} onClick={e => e.stopPropagation()}>
                    <div className="flex justify-end gap-1.5">
                      {(r.excess - (r.lotted_qty || 0)) > 0 && (
                        <Button size="sm" variant="secondary" title="Push excess to FG warehouse"
                          onClick={() => setPushing({
                            batch: r, qty: String(r.excess - (r.lotted_qty || 0)),
                            box_count: '', qty_per_box: '', loose_qty: '', location: r.fg_location || 'FG-STORE', note: '',
                          })}>
                          <PackagePlus size={13} /> Push to FG
                        </Button>
                      )}
                      {r.available > 0 && <Link to="/dispatch"><Button size="sm" variant="secondary">Dispatch</Button></Link>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Batch traceability */}
      <Modal wide open={!!detail} onClose={() => setDetail(null)}
        title={detail ? `Batch ${detail.jc_number} — ${detail.product_name}` : ''}>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['Customer', detail.customer_name], ['PO', detail.po_number], ['Ordered', fmt.num(detail.line_qty)],
                ['Produced (accepted)', fmt.num(detail.qty_produced)], ['Total wastage', fmt.num(detail.qty_scrap)],
                ['Location', detail.fg_location || 'FG-STORE'], ['Closed', fmt.dt(detail.closed_at)], ['Board', detail.board_name]]
                .map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className="text-sm font-bold text-slate-800">{v}</div>
                  </div>))}
            </div>

            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><History size={13} /> Production history</h4>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase text-slate-400">
                    <th className="px-3 py-1.5">Stage</th><th className="px-3 py-1.5">Machine</th><th className="px-3 py-1.5">Operator</th>
                    <th className="px-3 py-1.5 text-right">In</th><th className="px-3 py-1.5 text-right">Out</th>
                    <th className="px-3 py-1.5 text-right">Wastage</th><th className="px-3 py-1.5">Completed</th>
                  </tr></thead>
                  <tbody>
                    {detail.stages.map(s => (
                      <tr key={s.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-1.5 font-semibold">{fmt.stage(s.stage)}</td>
                        <td className="px-3 py-1.5 text-slate-500">{s.stage_machine_name || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-500">{s.operator || '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{s.qty_in != null ? fmt.num(s.qty_in) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{s.qty_out != null ? fmt.num(s.qty_out) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red-500">{s.qty_scrap ? fmt.num(s.qty_scrap) : ''}{s.scrap_reason ? ` (${s.scrap_reason})` : ''}</td>
                        <td className="px-3 py-1.5 text-slate-400">{fmt.dt(s.completed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {detail.packing?.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><Boxes size={13} /> Packing manifest</h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.packing.map(pl => (
                    <span key={pl.id} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                      {pl.boxes > 0 ? `${pl.boxes} × ${pl.qty_per_box}` : ''}{pl.boxes > 0 && pl.loose_qty > 0 ? ' + ' : ''}{pl.loose_qty > 0 ? `${pl.loose_qty} loose` : ''} = {fmt.num(pl.total)}
                    </span>
                  ))}
                  <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700">
                    Total {fmt.num(detail.packing.reduce((s, pl) => s + pl.total, 0))} pcs
                  </span>
                </div>
              </div>
            )}

            {detail.lots?.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><PackagePlus size={13} /> FG lots from this batch</h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.lots.map(l => (
                    <span key={l.id} className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
                      {l.lot_number} · {fmt.num(l.qty)} pcs · {fmt.title(l.status)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detail.dispatches.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><TruckIcon size={13} /> Dispatches</h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.dispatches.map((d, i) => (
                    <span key={i} className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                      {d.challan_number} · {fmt.num(d.qty)} · {fmt.date(d.dispatched_at)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Push excess to FG — creates a verifiable lot with a unique reference */}
      <Modal open={!!pushing} onClose={() => setPushing(null)}
        title={pushing ? `Push excess to FG Warehouse — ${pushing.batch.batch}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setPushing(null)}>Cancel</Button>
          <Button disabled={!(+pushing?.qty > 0)} onClick={async () => {
            const lot = await api.post('/fg-lots', {
              job_card_id: pushing.batch.job_card_id, qty: +pushing.qty,
              box_count: pushing.box_count ? +pushing.box_count : undefined,
              qty_per_box: pushing.qty_per_box ? +pushing.qty_per_box : undefined,
              loose_qty: pushing.loose_qty ? +pushing.loose_qty : undefined,
              location: pushing.location || undefined, note: pushing.note || undefined,
              source: 'packing_excess',
            });
            toast.success(`${lot.lot_number} created — pending physical verification`);
            setPushing(null); load();
          }}><PackagePlus size={13} /> Push to FG Warehouse</Button>
        </>}>
        {pushing && (
          <div className="space-y-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Do you want to push excess material to the FG Warehouse?
              Batch <b>{pushing.batch.batch}</b> produced <b>{fmt.num(pushing.batch.qty_produced)}</b> against an order of{' '}
              <b>{fmt.num(pushing.batch.ordered_qty)}</b> — excess available to push:{' '}
              <b className="text-amber-600">{fmt.num(pushing.batch.excess - (pushing.batch.lotted_qty || 0))}</b>.
              The lot gets a unique reference and must pass physical verification before planning can consume it.
            </p>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Lot contents</span><span>{pushing.batch.product_name}</span></div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Quantity (pcs)" required>
                  <Input type="number" min="1" max={pushing.batch.excess - (pushing.batch.lotted_qty || 0)}
                    value={pushing.qty} onChange={e => setPushing({ ...pushing, qty: e.target.value })} autoFocus />
                </Field>
                <Field label="Boxes">
                  <Input type="number" min="0" value={pushing.box_count} onChange={e => setPushing({ ...pushing, box_count: e.target.value })} />
                </Field>
                <Field label="Qty / box">
                  <Input type="number" min="0" value={pushing.qty_per_box} onChange={e => setPushing({ ...pushing, qty_per_box: e.target.value })} />
                </Field>
                <Field label="Loose pcs">
                  <Input type="number" min="0" value={pushing.loose_qty} onChange={e => setPushing({ ...pushing, loose_qty: e.target.value })} />
                </Field>
              </div>
              {pushing.box_count && pushing.qty_per_box && (+pushing.box_count * +pushing.qty_per_box + (+pushing.loose_qty || 0)) !== +pushing.qty && (
                <p className="mt-2 text-xs font-semibold text-amber-600">
                  Box breakdown ({fmt.num(+pushing.box_count * +pushing.qty_per_box + (+pushing.loose_qty || 0))}) differs from the lot quantity ({fmt.num(+pushing.qty || 0)}).
                </p>
              )}
            </section>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Location"><Input value={pushing.location} onChange={e => setPushing({ ...pushing, location: e.target.value })} /></Field>
              <Field label="Note"><Input value={pushing.note} onChange={e => setPushing({ ...pushing, note: e.target.value })} placeholder="Optional" /></Field>
            </div>
          </div>
        )}
      </Modal>

      {/* Physical verification — approve or reject a pending lot */}
      <Modal open={!!verifying} onClose={() => setVerifying(null)}
        title={verifying ? `Physical verification — ${verifying.lot.lot_number}` : ''}
        footer={<>
          <Button variant="danger" onClick={async () => {
            await api.post(`/fg-lots/${verifying.lot.id}/verify`, { approve: false, note: verifying.note });
            toast.info(`${verifying.lot.lot_number} rejected — not suitable for consumption`);
            setVerifying(null); load();
          }}>Reject — Not Suitable</Button>
          <Button variant="success" onClick={async () => {
            await api.post(`/fg-lots/${verifying.lot.id}/verify`, { approve: true, note: verifying.note });
            toast.success(`${verifying.lot.lot_number} verified — approved for consumption`);
            setVerifying(null); load();
          }}><ShieldCheck size={13} /> Verified &amp; Approve</Button>
        </>}>
        {verifying && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              <b>{verifying.lot.product_name}</b> · {fmt.num(verifying.lot.qty)} pcs
              {verifying.lot.box_count ? ` · ${verifying.lot.box_count} boxes` : ''} · from batch {verifying.lot.source_batch || '—'}
              <div className="mt-1 text-xs text-slate-400">Only verified lots can be consumed against future orders in Planning.</div>
            </div>
            <Field label="Verification note"><Textarea value={verifying.note} onChange={e => setVerifying({ ...verifying, note: e.target.value })} placeholder="Condition, count check, packing state…" /></Field>
          </div>
        )}
      </Modal>

      {/* QC inspection — the inspector checkpoint. Accepted → Finished Goods. */}
      <Modal open={!!inspect} onClose={() => setInspect(null)}
        title={inspect ? `QC Inspection — ${inspect.batch}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setInspect(null)}>Cancel</Button>
          <Button variant="success" onClick={submitInspection}><ShieldCheck size={13} /> Pass QC → Finished Goods</Button>
        </>}>
        {inspect && (() => {
          const acc = +inspect.qty_accepted || 0, rej = +(inspect.qty_rejected || 0), rew = +(inspect.qty_rework || 0);
          const tally = acc + rej + rew, over = tally > inspect.qty_in;
          return (
            <div className="space-y-3">
              <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                <b>{inspect.product_name}</b> · <b>{fmt.num(inspect.qty_in)}</b> received for inspection.
                <div className="mt-1 text-xs text-slate-400">Only the accepted quantity is credited to Finished Goods. Inspector and remark are required.</div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Accepted" required><Input type="number" min="0" value={inspect.qty_accepted} onChange={e => setInspect({ ...inspect, qty_accepted: e.target.value })} autoFocus /></Field>
                <Field label="Rejected"><Input type="number" min="0" value={inspect.qty_rejected} onChange={e => setInspect({ ...inspect, qty_rejected: e.target.value })} /></Field>
                <Field label="Rework"><Input type="number" min="0" value={inspect.qty_rework} onChange={e => setInspect({ ...inspect, qty_rework: e.target.value })} /></Field>
              </div>
              {over && <p className="text-xs font-semibold text-red-600">Accepted + rejected + rework ({fmt.num(tally)}) exceeds the {fmt.num(inspect.qty_in)} received.</p>}
              {rej > 0 && (
                <Field label="Rejection reason" required><Input value={inspect.scrap_reason} onChange={e => setInspect({ ...inspect, scrap_reason: e.target.value })} placeholder="Why were pieces rejected?" /></Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Inspector" required><Input value={inspect.inspector} onChange={e => setInspect({ ...inspect, inspector: e.target.value })} /></Field>
                <Field label="Remark" required><Input value={inspect.remarks} onChange={e => setInspect({ ...inspect, remarks: e.target.value })} placeholder="Condition / inspection note" /></Field>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Edit a box's number / location — the CI-BOX-#### is editable */}
      <Modal open={!!editBox} onClose={() => setEditBox(null)}
        title={editBox ? `Edit box — ${editBox.lot_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setEditBox(null)}>Cancel</Button>
          <Button onClick={async () => {
            try {
              await api.put(`/fg-lots/${editBox.id}`, { box_number: editBox.box_number, location: editBox.location, note: editBox.note });
              toast.success('Box updated'); setEditBox(null); load();
            } catch (e) { toast.error(e.message || 'Could not update box'); }
          }}>Save</Button>
        </>}>
        {editBox && (
          <div className="space-y-3">
            <Field label="Box number" hint="Auto-assigned CI-BOX-####; override with the physical label"><Input value={editBox.box_number} onChange={e => setEditBox({ ...editBox, box_number: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Location"><Input value={editBox.location || ''} onChange={e => setEditBox({ ...editBox, location: e.target.value })} /></Field>
              <Field label="Note"><Input value={editBox.note || ''} onChange={e => setEditBox({ ...editBox, note: e.target.value })} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
