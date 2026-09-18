// A Fluence kit's inner products — what goes into the carton, how many of each,
// and each item's carton size where it is known.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, SearchableSelect } from '../ui.jsx';
import InnerProductForm from './InnerProductForm.jsx';
import { formatDims, qtyText, normaliseComponentsPayload } from '../../lib/fluence.js';

const box = 'h-8 w-full rounded-lg border border-[#1D1D1F]/[0.12] bg-white/85 px-2 text-xs font-medium text-[#1D1D1F] outline-none transition focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20';

export function DimsCell({ item }) {
  const dims = formatDims(item);
  if (dims) return <span className="tabular-nums">{dims}</span>;
  const some = [item?.carton_l, item?.carton_w, item?.carton_h].some(x => x != null);
  return <span className="text-[11px] font-medium text-amber-700">{some ? 'Incomplete' : 'Not known yet'}</span>;
}

export function KitComponentsTable({ components, canEdit, onEditItem }) {
  if (!components.length) return null;
  const th = 'px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#6E6E73]';
  const totalUnits = components.reduce((s, c) => s + (+c.qty_per_kit || 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs text-[#1D1D1F]">
        <thead>
          <tr className="border-b border-[#1D1D1F]/10 bg-[#1D1D1F]/[0.03]">
            <th className={`${th} w-6`}>#</th>
            <th className={th}>Inner product</th>
            <th className={`${th} text-right`}>Qty / kit</th>
            <th className={`${th} text-right`}>MRP in kit</th>
            <th className={th}>Carton (L × W × H)</th>
            <th className={th}>Codes</th>
            <th className={th}>Remarks</th>
            {canEdit && <th className={th} />}
          </tr>
        </thead>
        <tbody>
          {components.map((c, i) => (
            <tr key={c.id ?? c.inner_product_id} className="border-b border-[#1D1D1F]/[0.06]">
              <td className="px-2 py-1.5 tabular-nums text-[#86868B]">{i + 1}</td>
              <td className="px-2 py-1.5">
                <div className="font-semibold">{c.name}</div>
                <div className="text-[10px] text-[#6E6E73]">
                  {[c.kind === 'packaging' ? 'Packaging component' : null, c.dosage_form, c.packaging_info].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className="px-2 py-1.5 text-right font-bold tabular-nums">{qtyText(c.qty_per_kit)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{c.mrp_in_kit != null ? fmt.inr(c.mrp_in_kit) : '—'}</td>
              <td className="px-2 py-1.5"><DimsCell item={c} /></td>
              <td className="px-2 py-1.5 font-mono text-[10px] text-[#515154]">
                {[c.product_code && `Code ${c.product_code}`, c.artwork_code && `AW ${c.artwork_code}`, c.erp_product_code && `ERP ${c.erp_product_code}`].filter(Boolean).join(' · ') || '—'}
              </td>
              <td className="px-2 py-1.5 text-[#515154]">{[c.remarks, c.inner_remarks].filter(Boolean).join(' · ') || ''}</td>
              {canEdit && (
                <td className="px-2 py-1.5 text-right">
                  <button type="button" title="Edit this inner product — dimensions, codes, dosage form" onClick={() => onEditItem(c)}
                    className="rounded-lg p-1 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] hover:text-[#0064D2]"><Pencil size={12} /></button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td className="px-2 py-1.5 text-[11px] font-semibold text-[#6E6E73]">{components.length} item{components.length > 1 ? 's' : ''}</td>
            <td className="px-2 py-1.5 text-right text-[11px] font-bold tabular-nums">{qtyText(totalUnits)} units</td>
            <td colSpan={canEdit ? 5 : 4} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function KitComponentsEditor({ dossier, context, onCancel, onSaved, onDirty }) {
  const [inner, setInner] = useState(null);
  const [rows, setRows] = useState(() => (dossier.components || []).map(c => ({
    inner_product_id: c.inner_product_id, qty_per_kit: qtyText(c.qty_per_kit), mrp_in_kit: c.mrp_in_kit == null ? '' : String(c.mrp_in_kit), remarks: c.remarks || '',
  })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const loadInner = () => api.get('/fluence/inner-products').then(setInner).catch(e => setError(e.message));
  useEffect(() => { loadInner(); }, []);

  const byId = useMemo(() => new Map((inner || []).map(p => [p.id, p])), [inner]);
  const touch = next => { setRows(next); onDirty?.(true); };
  const setRow = (i, patch) => touch(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const move = (i, d) => {
    const next = [...rows];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    touch(next);
  };

  const save = async () => {
    const { errors } = normaliseComponentsPayload({ components: rows });
    if (errors.length) { setError(errors.join(' ')); return; }
    setSaving(true);
    setError(null);
    try {
      const out = await api.put(`/fluence/products/${dossier.product.id}/components`, { components: rows, from: context });
      onSaved?.(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const chosen = new Set(rows.map(r => Number(r.inner_product_id)).filter(Boolean));
  return (
    <div className="space-y-3">
      <p className="text-xs text-[#515154]">
        {dossier.part_of
          ? <>The items packed into the kit of <b>{dossier.part_of.outer_code} {dossier.part_of.outer_name}</b> — this part carton shows the same list. Saving updates the Fluence master for that kit.</>
          : <>The items packed into <b>{dossier.product.code} {dossier.product.name}</b>. Saving updates the Fluence master for this kit.</>}
      </p>
      {!inner && <p className="flex items-center gap-2 text-xs text-[#86868B]"><Loader2 size={13} className="animate-spin" /> Loading the inner product master…</p>}
      {inner && (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const item = byId.get(Number(r.inner_product_id));
            return (
              <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-2xl border border-white/80 bg-white/60 p-2.5">
                <label className="col-span-12 sm:col-span-5">
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">Inner product</span>
                  {/* Type any part of the name — "trich", "q10", "cal d3" — to narrow the
                      149 items; an item already in this kit is not offered twice. */}
                  <SearchableSelect
                    value={r.inner_product_id || ''}
                    placeholder="Type to search inner products…"
                    onChange={e => setRow(i, { inner_product_id: e.target.value ? Number(e.target.value) : '' })}
                    options={inner.map(p => ({
                      value: p.id,
                      label: `${p.name}${p.standard_mrp != null ? ` — ₹${p.standard_mrp}` : ''}`,
                      search: [p.product_code, p.artwork_code, p.dosage_form].filter(Boolean).join(' '),
                      disabled: chosen.has(p.id) && p.id !== Number(r.inner_product_id),
                    }))} />
                </label>
                <label className="col-span-4 sm:col-span-2">
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">Qty / kit</span>
                  <input className={`${box} text-right font-bold`} inputMode="decimal" value={r.qty_per_kit} onChange={e => setRow(i, { qty_per_kit: e.target.value })} />
                </label>
                <label className="col-span-4 sm:col-span-2">
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">MRP in kit</span>
                  <input className={`${box} text-right`} inputMode="decimal" value={r.mrp_in_kit}
                    placeholder={item?.standard_mrp != null ? String(item.standard_mrp) : ''} onChange={e => setRow(i, { mrp_in_kit: e.target.value })} />
                </label>
                <div className="col-span-4 flex justify-end gap-1 sm:col-span-3">
                  <button type="button" title="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="rounded-lg p-1.5 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] disabled:opacity-30"><ArrowUp size={13} /></button>
                  <button type="button" title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="rounded-lg p-1.5 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] disabled:opacity-30"><ArrowDown size={13} /></button>
                  <button type="button" title="Remove from this kit" onClick={() => touch(rows.filter((_, n) => n !== i))} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50"><Trash2 size={13} /></button>
                </div>
                <label className="col-span-12">
                  <input className={box} value={r.remarks} onChange={e => setRow(i, { remarks: e.target.value })} placeholder="Remarks for this item in this kit (optional)" />
                </label>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => touch([...rows, { inner_product_id: '', qty_per_kit: '1', mrp_in_kit: '', remarks: '' }])}>
              <Plus size={13} /> Add item
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
              <Plus size={13} /> New inner product…
            </Button>
          </div>
        </div>
      )}
      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving || !inner}>{saving && <Loader2 size={14} className="animate-spin" />} Save kit list</Button>
      </div>
      <InnerProductForm open={creating} item={null} onClose={() => setCreating(false)}
        onSaved={created => {
          loadInner();
          touch([...rows, { inner_product_id: created.id, qty_per_kit: '1', mrp_in_kit: '', remarks: '' }]);
        }} />
    </div>
  );
}
