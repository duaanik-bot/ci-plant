import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { AgeChip, Button, DataTable, Field, Input, Modal, useToast } from './ui.jsx';
import ProductIdentity, { productExport, productSearchText } from './ProductIdentity.jsx';

const AGE_BANDS = [['0-30d', 'bg-emerald-400'], ['31-60d', 'bg-amber-400'], ['61-90d', 'bg-orange-400'], ['90d+', 'bg-red-500']];
const bandIdx = d => d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;

function AgeBar({ items, unit = 'lines' }) {
  const counts = [0, 0, 0, 0];
  for (const d of items) { if (d != null) counts[bandIdx(d)]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/60 px-4 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Age in stock</span>
      <div className="flex h-2.5 min-w-[160px] flex-1 overflow-hidden rounded-full bg-slate-100">
        {AGE_BANDS.map(([label, cls], i) => counts[i] > 0 && (
          <div key={label} className={cls} style={{ width: `${counts[i] / total * 100}%` }} title={`${label} - ${counts[i]} ${unit}`} />
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-500">
        {AGE_BANDS.map(([label, cls], i) => (
          <span key={label} className="flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-full ${cls}`} />{label}: <span className="tabular-nums text-slate-700">{counts[i]}</span></span>
        ))}
      </div>
    </div>
  );
}

function SubTabs({ active, onChange, tabs }) {
  return (
    <div className="mb-3 inline-flex items-center gap-1 rounded-full bg-slate-100/80 p-1">
      {tabs.map(t => (
        <button key={t.key} type="button" onClick={() => onChange(t.key)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${active === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-slate-200/80 px-1.5 text-[10px] tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export default function FgStockPanel({ onCountsChange }) {
  const toast = useToast();
  const nav = useNavigate();
  const [fg, setFg] = useState([]);
  const [leftoverFg, setLeftoverFg] = useState([]);
  const [fgSub, setFgSub] = useState('in');
  const [fgSel, setFgSel] = useState(() => new Set());
  const [pickedBoxes, setPickedBoxes] = useState([]);
  const [move, setMove] = useState(null);
  const [saving, setSaving] = useState(false);

  const pickedRows = leftoverFg.filter(l => pickedBoxes.includes(l.id));

  const load = async () => {
    try {
      const [fgRows, leftoverRows] = await Promise.all([
        api.get('/inventory/fg'),
        api.get('/inventory/leftover-fg'),
      ]);
      setFg(fgRows);
      setLeftoverFg(leftoverRows);
      onCountsChange?.({ in: fgRows.length, leftover: leftoverRows.length });
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not load FG stock');
    }
  };
  useEffect(() => { load(); }, []);

  const boxNumbersLabel = boxes => {
    if (!boxes?.length) return '';
    const nums = boxes.map(b => b.box_number);
    return boxes.length === 1 ? nums[0] : `${boxes.length} boxes: ${nums[0]}...${nums[nums.length - 1]}`;
  };

  const openMove = async f => {
    try {
      const preview = await api.get(`/fg/movement-preview?product_id=${f.product_id}`);
      setMove({
        product: f,
        preview,
        alloc: Object.fromEntries((preview.allocations || []).map(a => [a.order_line_id, a.dispatch_qty])),
        boxLeftover: true,
        vehicle: '',
        driver: '',
      });
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not open FG move');
    }
  };

  const runMove = async mode => {
    const m = move;
    const allocations = (m.preview.allocations || [])
      .map(a => ({ order_line_id: a.order_line_id, qty: +m.alloc[a.order_line_id] || 0 }))
      .filter(a => a.qty > 0);
    const dispatched = allocations.reduce((s, a) => s + a.qty, 0);
    const leftover = Math.max(0, m.preview.available - dispatched);
    setSaving(true);
    try {
      if (mode === 'dispatch') {
        const res = await api.post('/fg/move', {
          product_id: m.product.product_id,
          mode: 'dispatch',
          allocations,
          leftover_qty: m.boxLeftover ? leftover : 0,
          vehicle: m.vehicle,
          driver: m.driver,
        });
        toast.success(`${res.challans.length} challan(s) created${res.boxes?.length ? ` - ${boxNumbersLabel(res.boxes)}` : ''}`);
        if (res.challans?.length === 1) nav(`/dispatch/challan/${res.challans[0].id}`);
      } else if (mode === 'leftover') {
        const res = await api.post('/fg/move', {
          product_id: m.product.product_id,
          mode: 'leftover',
          leftover_qty: m.preview.available,
        });
        toast.success(`Boxed as leftover${res.boxes?.length ? ` - ${boxNumbersLabel(res.boxes)}` : ''}`);
      }
      setMove(null);
      setFgSel(new Set());
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Movement failed');
    } finally {
      setSaving(false);
    }
  };

  const bulkLeftover = async () => {
    const picks = fg.filter(f => fgSel.has(f.product_id));
    if (!picks.length) return;
    setSaving(true);
    try {
      for (const f of picks) await api.post('/fg/move', { product_id: f.product_id, mode: 'leftover', leftover_qty: f.qty });
      toast.success(`${picks.length} product(s) boxed as leftover`);
      setFgSel(new Set());
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Bulk leftover failed');
    } finally {
      setSaving(false);
    }
  };

  const moveBoxToFg = async box => {
    if (!window.confirm(`Move box ${box.box_number || box.lot_number} (${fmt.num(box.remaining)}) back into FG stock?`)) return;
    setSaving(true);
    try {
      await api.post(`/fg-lots/${box.id}/to-fg`, {});
      toast.success(`Box ${box.box_number || box.lot_number} moved to FG`);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not move to FG');
    } finally {
      setSaving(false);
    }
  };

  const bulkMoveToFg = async () => {
    const ids = pickedRows.map(l => l.id);
    if (!ids.length) return;
    const total = pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0);
    if (!window.confirm(`Move ${ids.length} box${ids.length > 1 ? 'es' : ''} (${fmt.num(total)} cartons) back into FG stock?`)) return;
    setSaving(true);
    try {
      const res = await api.post('/fg-lots/bulk-to-fg', { ids });
      toast.success(`${res.count} boxes moved to FG`);
      setPickedBoxes([]);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Bulk move to FG failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SubTabs active={fgSub} onChange={setFgSub} tabs={[
        { key: 'in', label: 'In Stock', count: fg.length },
        { key: 'leftover', label: 'Leftover', count: leftoverFg.length || 0 },
      ]} />

      {fgSub === 'in' && (<>
        <AgeBar items={fg.map(f => f.age_days)} unit="SKUs" />
        {fgSel.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-2.5">
            <span className="text-sm font-semibold text-brand-700">{fgSel.size} selected</span>
            <Button size="sm" variant="secondary" onClick={bulkLeftover} disabled={saving}>Box selected as Leftover</Button>
            <button type="button" onClick={() => setFgSel(new Set())} className="text-xs font-semibold text-slate-500 hover:text-slate-700">Clear</button>
          </div>
        )}
        <DataTable
          searchable
          columns={[
            { key: 'sel', label: '', render: f => (
              <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={fgSel.has(f.product_id)}
                onChange={e => setFgSel(s => { const n = new Set(s); e.target.checked ? n.add(f.product_id) : n.delete(f.product_id); return n; })} />) },
            { key: 'product_name', label: 'Product',
              render: f => <ProductIdentity row={f} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Cartons in Stock', align: 'right', render: f => <span className="font-bold tabular-nums">{fmt.num(f.qty)}</span> },
            { key: 'age', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Age in Stock', render: f => f.age_days != null ? <AgeChip days={f.age_days} /> : <span className="text-xs text-slate-300">-</span> },
            { key: 'value', label: 'Value', align: 'right', render: f => fmt.inr(f.qty * f.rate) },
            { key: 'move', label: '', align: 'right', render: f => <Button size="sm" onClick={() => openMove(f)}>Move...</Button> },
          ]}
          rows={fg} empty="No finished goods in stock"
          exportName="FG Stock"
          exportSubtitle="Dispatch & Invoice - Finished goods"
          exportSummary={rows => [
            { label: 'SKUs in stock', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.qty || 0), 0)) },
            { label: 'Stock value', value: fmt.inr(rows.reduce((s, f) => s + (+f.qty || 0) * (+f.rate || 0), 0)) },
          ]} />
      </>)}

      {fgSub === 'leftover' && (<>
        <AgeBar items={leftoverFg.map(l => l.age_days)} unit="boxes" />
        {pickedBoxes.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} selected
              <span className="ml-2 text-xs font-semibold text-slate-500">- {fmt.num(pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0))} cartons</span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPickedBoxes([])}>Clear</Button>
              <Button size="sm" onClick={bulkMoveToFg} disabled={saving}>Move {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} to FG</Button>
            </div>
          </div>
        )}
        <DataTable
          searchable
          selectable
          selectedIds={pickedBoxes}
          onToggleRow={(row, checked) => setPickedBoxes(ids => checked ? [...new Set([...ids, row.id])] : ids.filter(id => id !== row.id))}
          onToggleAll={(rows, checked) => {
            const ids = rows.map(r => r.id);
            setPickedBoxes(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          columns={[
            { key: 'box_number', label: 'Box #', render: l => <span className="font-mono text-xs font-bold text-slate-800">{l.box_number || l.lot_number}</span> },
            { key: 'product_name', label: 'Product',
              render: l => <ProductIdentity row={l} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'customer_name', label: 'Customer' },
            { key: 'remaining', label: 'Cartons', align: 'right', render: l => <span className="font-bold tabular-nums">{fmt.num(l.remaining)}</span> },
            { key: 'source', label: 'Source', render: l => <span className="text-xs capitalize text-gray-500">{(l.source || '').replace(/_/g, ' ') || l.jc_number || '-'}</span> },
            { key: 'age', label: 'Age', render: l => <AgeChip days={l.age_days} /> },
            { key: 'move', label: '', align: 'right', render: l => <Button size="sm" variant="secondary" onClick={() => moveBoxToFg(l)}>Move to FG</Button> },
          ]}
          rows={leftoverFg} empty="No finished-goods leftover boxes - move some from FG stock (In Stock > Move...) or box a dispatch overrun."
          exportName="Leftover FG Boxes"
          exportSubtitle="Dispatch & Invoice - Finished-goods leftover boxes" />
      </>)}

      <Modal wide open={!!move} onClose={() => setMove(null)}
        title={move ? `Move FG - ${move.product.product_name}` : ''}
        footer={move && (() => {
          const dispatched = (move.preview.allocations || []).reduce((s, a) => s + (+move.alloc[a.order_line_id] || 0), 0);
          const leftover = Math.max(0, move.preview.available - dispatched);
          return (<>
            <Button variant="secondary" onClick={() => setMove(null)} disabled={saving}>Keep in FG</Button>
            <Button variant="secondary" onClick={() => runMove('leftover')} disabled={saving}>Box all {fmt.num(move.preview.available)} as Leftover</Button>
            <Button disabled={saving || dispatched === 0} onClick={() => runMove('dispatch')}>
              Dispatch {fmt.num(dispatched)}{move.boxLeftover && leftover > 0 ? ` - box ${fmt.num(leftover)}` : ''}
            </Button>
          </>);
        })()}>
        {move && (() => {
          const dispatched = (move.preview.allocations || []).reduce((s, a) => s + (+move.alloc[a.order_line_id] || 0), 0);
          const leftover = Math.max(0, move.preview.available - dispatched);
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-slate-400">FG on hand</div><div className="text-lg font-bold tabular-nums">{fmt.num(move.preview.fg_stock)}</div></div>
                <div className="rounded-xl bg-emerald-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-emerald-500">To dispatch</div><div className="text-lg font-bold tabular-nums text-emerald-700">{fmt.num(dispatched)}</div></div>
                <div className="rounded-xl bg-amber-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-amber-500">Leftover</div><div className="text-lg font-bold tabular-nums text-amber-700">{fmt.num(leftover)}</div></div>
              </div>

              {move.preview.allocations.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">No open sales orders want this product right now - box it all as leftover, or keep it in FG.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase text-slate-400">
                      <th className="px-3 py-1.5">Sales Order</th><th className="px-3 py-1.5">Customer</th>
                      <th className="px-3 py-1.5 text-right">Ordered</th><th className="px-3 py-1.5 text-right">Dispatched</th>
                      <th className="px-3 py-1.5 text-right">Tol %</th><th className="px-3 py-1.5 text-right">Max (incl. tol)</th>
                      <th className="px-3 py-1.5 text-right">Dispatch now</th>
                    </tr></thead>
                    <tbody>
                      {move.preview.allocations.map(a => (
                        <tr key={a.order_line_id} className="border-b border-slate-50 last:border-0">
                          <td className="px-3 py-1.5 font-semibold text-slate-800">{a.po_number}</td>
                          <td className="px-3 py-1.5 text-slate-500">{a.customer_name}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(a.ordered)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmt.num(a.dispatched)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{a.tolerance_pct}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(a.allowed_max)}</td>
                          <td className="px-3 py-1.5 text-right">
                            <input type="number" min="0" max={a.tolerance_room}
                              className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right tabular-nums"
                              value={move.alloc[a.order_line_id] ?? 0}
                              onChange={e => setMove(m => ({ ...m, alloc: { ...m.alloc, [a.order_line_id]: Math.min(a.tolerance_room, Math.max(0, Math.floor(+e.target.value || 0))) } }))} />
                            <div className="text-[9px] text-slate-400">room {fmt.num(a.tolerance_room)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {dispatched > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Vehicle"><Input value={move.vehicle} onChange={e => setMove({ ...move, vehicle: e.target.value })} placeholder="Optional" /></Field>
                  <Field label="Driver"><Input value={move.driver} onChange={e => setMove({ ...move, driver: e.target.value })} placeholder="Optional" /></Field>
                </div>
              )}
              {leftover > 0 && dispatched > 0 && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={move.boxLeftover} onChange={e => setMove({ ...move, boxLeftover: e.target.checked })} />
                  Box the remaining {fmt.num(leftover)} as a numbered Leftover box (auto CI-BOX-####)
                </label>
              )}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
