// Fluence Master — the home of the Fluence prescription & kit master.
//
//   Products        every Fluence carton: its customer kit, kit items and
//                   prescription status — open any one in the Fluence drawer
//   Customer kits   the customer's own kit list, and which ERP product each kit
//                   is printed as. Exact names were linked by the import; the
//                   rest wait here for a person — with a suggestion where one
//                   exists — because a wrong link would print the wrong
//                   prescription on a carton
//   Inner products  every item that goes inside a kit, with carton dimensions
//                   (blank until supplied — never estimated)
//
// Fluence Pharmaceuticals only. Nothing here touches any other customer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, CheckCircle2, Link2, Pill, Plus, Ruler, Unlink, AlertTriangle } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, DataTable, KpiCard, KpiRow, Modal, PageHeader, SearchableSelect, Tabs, useToast } from '../components/ui.jsx';
import { canPlan } from '../modules.js';
import FluenceDrawer from '../components/fluence/FluenceDrawer.jsx';
import InnerProductForm from '../components/fluence/InnerProductForm.jsx';
import { DimsCell } from '../components/fluence/KitComponents.jsx';
import { FLUENCE_CONTEXTS, kitListPrice, partLabel } from '../lib/fluence.js';

const KIT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'linked', label: 'Linked' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'unlinked', label: 'Not linked' },
];

const kitState = k => (k.superseded_by_kit_id ? 'superseded' : k.product_id ? 'linked' : k.suggested_product_id && !k.suggested_taken_by_kit_id ? 'suggested' : 'unlinked');

export default function FluenceMaster() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = ['products', 'kits', 'inner'].includes(params.get('tab')) ? params.get('tab') : 'products';
  const setTab = t => setParams(p => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, { replace: true });
  const [products, setProducts] = useState(null);
  const [kits, setKits] = useState(null);
  const [inner, setInner] = useState(null);
  const [drawer, setDrawer] = useState(null);       // { productId } or, for a kit with no product, { kitId }
  const [kitFilter, setKitFilter] = useState('all');
  const [linking, setLinking] = useState(null);     // kit row
  const [linkProduct, setLinkProduct] = useState('');
  const [unlinking, setUnlinking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [innerEditing, setInnerEditing] = useState(null); // row, or {} for new
  const canEdit = canPlan(auth.user);

  const load = useCallback(() => Promise.all([
    api.get('/fluence/products').then(setProducts),
    api.get('/fluence/kits').then(setKits),
    api.get('/fluence/inner-products').then(setInner),
  ]).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const kpi = useMemo(() => {
    const p = products || [];
    const k = (kits || []).filter(x => !x.superseded_by_kit_id);
    const i = inner || [];
    return {
      products: p.length,
      withKit: p.filter(x => x.kit_id).length,
      asPart: p.filter(x => x.kit_id && x.part).length,
      withRx: p.filter(x => x.rx_state === 'full').length,
      itemsOnly: p.filter(x => x.rx_state === 'items').length,
      openNoRx: p.filter(x => x.open_lines > 0 && x.rx_state === 'none').length,
      kitsUnlinked: k.filter(x => !x.product_id).length,
      kitsSuggested: k.filter(x => kitState(x) === 'suggested').length,
      inner: i.length,
      dimsMissing: i.filter(x => x.carton_l == null || x.carton_w == null || x.carton_h == null).length,
    };
  }, [products, kits, inner]);

  // A part carton shows its outer carton's kit — a customer kit links to the outer carton, never to a part.
  const freeProducts = useMemo(() => (products || []).filter(p => !p.part && (!p.kit_id || !String(p.source_ref || '').startsWith('customer-master:'))), [products]);

  const link = async (kit, productId) => {
    setBusy(true);
    try {
      await api.post(`/fluence/kits/${kit.id}/link`, { product_id: productId, from: 'fluence_master' });
      const p = (products || []).find(x => x.id === Number(productId));
      toast.success(`Linked ${kit.kit_name} → ${p ? `${p.code} ${p.name}` : 'product'}`);
      setLinking(null);
      setLinkProduct('');
      await load();
    } catch { /* the central toast names the refusal */ } finally { setBusy(false); }
  };

  const unlink = async kit => {
    setBusy(true);
    try {
      await api.post(`/fluence/kits/${kit.id}/unlink`, { from: 'fluence_master' });
      toast.success(`Unlinked ${kit.kit_name}`);
      setUnlinking(null);
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  };

  const kitRows = useMemo(() => (kits || []).filter(k => kitFilter === 'all' || kitState(k) === kitFilter), [kits, kitFilter]);

  return (
    <div>
      <PageHeader
        title={<span className="inline-flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-green-700 text-white"><Pill size={16} /></span> Fluence Master</span>}
        subtitle="Prescriptions, kits and inner products — Fluence Pharmaceuticals only. Entered once here (or from any Fluence button) and read live by every module."
        actions={tab === 'inner' && canEdit ? <Button onClick={() => setInnerEditing({})}><Plus size={14} /> New inner product</Button> : null} />

      <KpiRow cols={6}>
        <KpiCard compact label="Fluence products" value={fmt.num(kpi.products)} sub={`${fmt.num(kpi.withKit)} with a kit${kpi.asPart ? ` · ${fmt.num(kpi.asPart)} parts` : ''}`} icon={Boxes} />
        <KpiCard compact label="Prescriptions" value={fmt.num(kpi.withRx + kpi.itemsOnly)} sub={`${fmt.num(kpi.products - kpi.withRx - kpi.itemsOnly)} blank · ${fmt.num(kpi.withRx)} with days`} icon={Pill} tone={kpi.withRx + kpi.itemsOnly ? 'good' : undefined} />
        <KpiCard compact label="Open orders, no Rx" value={fmt.num(kpi.openNoRx)} sub="products on live orders" icon={AlertTriangle} tone={kpi.openNoRx ? 'warn' : undefined} />
        <KpiCard compact label="Customer kits not linked" value={fmt.num(kpi.kitsUnlinked)} sub={`${fmt.num(kpi.kitsSuggested)} with a suggestion`} icon={Link2} onClick={() => { setTab('kits'); setKitFilter('unlinked'); }} />
        <KpiCard compact label="Inner products" value={fmt.num(kpi.inner)} icon={CheckCircle2} />
        <KpiCard compact label="Carton size not known" value={fmt.num(kpi.dimsMissing)} sub="left blank, never estimated" icon={Ruler} onClick={() => setTab('inner')} />
      </KpiRow>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'products', label: 'Products', count: products?.length },
        { key: 'kits', label: 'Customer kits', count: kits?.filter(k => !k.superseded_by_kit_id).length, tone: kpi.kitsUnlinked ? 'danger' : undefined },
        { key: 'inner', label: 'Inner products', count: inner?.length },
      ]} />

      {tab === 'products' && (
        <DataTable searchable rows={products || []} empty={products ? 'No Fluence products' : 'Loading…'}
          onRowClick={p => setDrawer({ productId: p.id })}
          defaultSort={{ key: 'code', dir: 'asc' }}
          exportName="Fluence Products" exportSubtitle="Kit and prescription status"
          columns={[
            // The shared sort reads "FP-100" as a DATE (Date.parse is lenient), which
            // scrambles the series — sort on the number instead.
            { key: 'code', label: 'Code', sortValue: p => Number(String(p.code || '').replace(/\D/g, '')) || 0,
              render: p => <span className="font-mono text-xs font-bold">{p.code}</span> },
            { key: 'name', label: 'Product', render: p => (
              <div className="min-w-0">
                <div className="font-semibold">{p.name}</div>
                <div className="font-mono text-[11px] text-gray-400">Item {p.party_item_code || '—'} · AW {p.party_artwork_code || '—'}</div>
              </div>) },
            { key: 'kit_name', label: 'Customer kit', render: p => (
              <div className="text-xs">
                {p.kit_id
                  ? <span>{p.kit_name}{String(p.source_ref || '').startsWith('erp-product:') ? <span className="ml-1 text-[10px] text-gray-400">(plant-entered)</span>
                    : String(p.source_ref || '').startsWith('kit-studio:') ? <span className="ml-1 text-[10px] text-gray-400">(Kit Studio)</span> : null}</span>
                  : <span className="text-amber-700">{p.part ? 'Outer carton has no kit' : 'Not linked'}</span>}
                {p.part && <div className="text-[10px] font-semibold text-green-800">{partLabel({ part: p.part, outer_code: p.outer_code })} — reads its kit</div>}
              </div>) },
            { key: 'components_count', label: 'Items', align: 'right', render: p => <span className="tabular-nums">{p.components_count || '—'}</span> },
            { key: 'rx_revision', label: 'Prescription', sortValue: p => ({ full: p.rx_revision, items: 0 }[p.rx_state] ?? -1), render: p => p.rx_state === 'items'
              ? <span className="text-xs"><span className="rounded-full bg-green-700/10 px-2 py-0.5 font-bold text-green-800">Customer master</span><span className="ml-1.5 text-gray-500">{p.rx_lines} products · no day-wise schedule</span></span>
              : p.rx_state === 'full'
              ? <span className="text-xs"><span className="rounded-full bg-green-700/10 px-2 py-0.5 font-bold text-green-800">rev {p.rx_revision}</span>
                  <span className="ml-1.5 text-gray-500">{fmt.dt(p.rx_updated_at)} · {p.rx_updated_by}{p.rx_updated_from ? ` · ${FLUENCE_CONTEXTS[p.rx_updated_from] || p.rx_updated_from}` : ''}</span></span>
              : <span className="text-xs font-semibold text-amber-700">Not entered</span> },
            { key: 'open_lines', label: 'Open order lines', align: 'right', render: p => <span className="tabular-nums">{p.open_lines || '—'}</span> },
            { key: 'mrp', label: 'MRP', align: 'right', render: p => (p.mrp != null ? fmt.inr(p.mrp) : '—') },
            { key: 'open', label: '', sortable: false, render: p => (
              <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); setDrawer({ productId: p.id }); }}><Pill size={12} /> Open</Button>) },
          ]} />
      )}

      {tab === 'kits' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {KIT_FILTERS.map(f => (
              <button key={f.key} type="button" onClick={() => setKitFilter(f.key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${kitFilter === f.key ? 'bg-green-700 text-white' : 'bg-white/70 text-[#515154] hover:bg-white'}`}>
                {f.label}
              </button>
            ))}
            <span className="text-xs text-gray-500">Only an exact name was linked automatically. Confirm a suggestion or link a kit by hand — a wrong link would print the wrong prescription.</span>
          </div>
          <DataTable searchable rows={kitRows} empty={kits ? 'No kits in this view' : 'Loading…'}
            defaultSort={{ key: 'party_sl_no', dir: 'asc' }}
            exportName="Fluence Customer Kits" exportSubtitle="Customer kit list and ERP product links"
            columns={[
              { key: 'party_sl_no', label: 'Party Sl.No', align: 'right', render: k => <span className="tabular-nums">{k.party_sl_no}</span> },
              { key: 'kit_name', label: 'Kit (customer list)', render: k => (
                <div>
                  <div className="font-semibold">{k.kit_name}</div>
                  <div className="text-[11px] text-gray-400">{k.kit_type || '—'} · valid {k.valid_from ? fmt.date(k.valid_from) : '—'} – {k.valid_to ? fmt.date(k.valid_to) : '—'}</div>
                </div>) },
              { key: 'components_count', label: 'Items', align: 'right', render: k => <span className="tabular-nums">{k.components_count}</span> },
              { key: 'kit_total_mrp', label: 'Kit price', align: 'right',
                sortValue: k => kitListPrice(k, k.line_mrp != null ? [k.line_mrp] : [])?.amount ?? -1,
                export: k => {
                  const price = kitListPrice(k, k.line_mrp != null ? [k.line_mrp] : []);
                  return !price ? '' : price.kind === 'per_line' ? `${price.amount} each line` : price.amount;
                },
                render: k => {
                  const price = kitListPrice(k, k.line_mrp != null ? [k.line_mrp] : []);
                  if (!price) return '—';
                  return price.kind === 'per_line'
                    ? <span className="whitespace-nowrap" title="Flat-priced: the customer list carries this price on every line">{fmt.inr(price.amount)} <span className="text-[10px] text-gray-400">each line</span></span>
                    : fmt.inr(price.amount);
                } },
              { key: 'product_code', label: 'ERP product', sortValue: k => k.product_code || k.suggested_code || '', render: k => {
                const st = kitState(k);
                if (st === 'superseded') return <span className="text-xs text-gray-400">Re-listed as {k.superseded_by_name}</span>;
                if (st === 'linked') return (
                  <div className="text-xs">
                    <span className="font-mono font-bold">{k.product_code}</span> {k.product_name}
                    <div className="text-[10px] text-gray-400">{(k.link_method || '').replace(/_/g, ' ')}{k.linked_by ? ` · ${k.linked_by}` : ''}</div>
                    {k.parts_count > 0 && <div className="text-[10px] font-semibold text-green-800">+ {k.parts_count} part cartons show this kit</div>}
                  </div>);
                if (st === 'suggested') return (
                  <div className="text-xs">
                    <span className="font-semibold text-amber-700">Suggested:</span> <span className="font-mono font-bold">{k.suggested_code}</span> {k.suggested_name}
                    <div className="text-[10px] text-gray-400">{k.suggestion_reason}</div>
                  </div>);
                return <span className="text-xs font-semibold text-amber-700">Not linked</span>;
              } },
              { key: 'actions', label: '', sortable: false, render: k => {
                const st = kitState(k);
                if (st === 'superseded') return null;
                // A kit with no product yet opens by itself: its items and
                // prescription can be kept before its carton is linked.
                const open = <Button size="sm" variant="secondary" onClick={() => setDrawer(st === 'linked' ? { productId: k.product_id } : { kitId: k.id })}><Pill size={12} /> Open</Button>;
                if (!canEdit) return <div className="flex justify-end" onClick={e => e.stopPropagation()}>{open}</div>;
                return (
                  <div className="flex justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                    {st !== 'linked' && open}
                    {st === 'suggested' && (
                      <Button size="sm" variant="success" className="whitespace-nowrap" disabled={busy} onClick={() => link(k, k.suggested_product_id)}>
                        <CheckCircle2 size={12} /> Link {k.suggested_code}
                      </Button>
                    )}
                    {st !== 'linked' && <Button size="sm" variant="secondary" className="whitespace-nowrap" disabled={busy} onClick={() => { setLinking(k); setLinkProduct(''); }}><Link2 size={12} /> Link…</Button>}
                    {st === 'linked' && (
                      <>
                        {open}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setUnlinking(k)}><Unlink size={12} /> Unlink</Button>
                      </>
                    )}
                  </div>);
              } },
            ]} />
        </>
      )}

      {tab === 'inner' && (
        <DataTable searchable rows={inner || []} empty={inner ? 'No inner products' : 'Loading…'}
          defaultSort={{ key: 'name', dir: 'asc' }}
          onRowClick={canEdit ? r => setInnerEditing(r) : undefined}
          exportName="Fluence Inner Products" exportSubtitle="Kit items and carton dimensions"
          columns={[
            { key: 'name', label: 'Inner product', render: r => (
              <div>
                <div className="font-semibold">{r.name}</div>
                <div className="text-[11px] text-gray-400">{r.kind === 'packaging' ? 'Packaging component' : 'Item'}{r.dosage_form ? ` · ${r.dosage_form}` : ''}{r.packaging_info ? ` · ${r.packaging_info}` : ''}</div>
              </div>) },
            { key: 'standard_mrp', label: 'Std MRP', align: 'right', render: r => (r.standard_mrp != null ? fmt.inr(r.standard_mrp) : '—') },
            { key: 'dims', label: 'Carton (L × W × H)', sortValue: r => (r.carton_l == null ? 0 : 1), render: r => <DimsCell item={r} /> },
            { key: 'codes', label: 'Codes', render: r => <span className="font-mono text-[11px] text-gray-500">{[r.product_code && `Code ${r.product_code}`, r.artwork_code && `AW ${r.artwork_code}`, r.erp_product_code && `ERP ${r.erp_product_code}`].filter(Boolean).join(' · ') || '—'}</span> },
            { key: 'kits_count', label: 'In kits', align: 'right', render: r => <span className="tabular-nums">{r.kits_count}</span> },
            { key: 'remarks', label: 'Remarks', render: r => <span className="text-xs text-gray-500">{r.remarks || ''}</span> },
          ]} />
      )}

      {drawer && (
        <FluenceDrawer productIds={drawer.productId ? [drawer.productId] : []} kitId={drawer.kitId ?? null} context="fluence_master"
          onClose={() => { setDrawer(null); load(); }} />
      )}

      <Modal open={Boolean(linking)} onClose={() => setLinking(null)} title={linking ? `Link customer kit — ${linking.kit_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setLinking(null)}>Cancel</Button>
          <Button disabled={!linkProduct || busy} onClick={() => link(linking, Number(linkProduct))}><Link2 size={14} /> Link</Button>
        </>}>
        {linking && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">Choose the Fluence product this kit is printed as. Its kit list and any prescription then appear on that product in every module.</p>
            {linking.suggested_code && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">Suggested: <b>{linking.suggested_code} {linking.suggested_name}</b> — {linking.suggestion_reason}</p>}
            <SearchableSelect value={linkProduct} onChange={e => setLinkProduct(e.target.value)} placeholder="Search Fluence products…"
              options={freeProducts.map(p => ({ value: String(p.id), label: `${p.code} · ${p.name}`, search: `${p.party_item_code || ''} ${p.party_artwork_code || ''}` }))} />
          </div>
        )}
      </Modal>

      <Modal open={Boolean(unlinking)} onClose={() => setUnlinking(null)} title="Unlink this kit?"
        footer={<>
          <Button variant="secondary" onClick={() => setUnlinking(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => unlink(unlinking)}><Unlink size={14} /> Unlink</Button>
        </>}>
        {unlinking && (
          <p className="text-sm text-gray-600">
            <b>{unlinking.kit_name}</b> will no longer be linked to <b>{unlinking.product_code} {unlinking.product_name}</b>. The kit keeps its items and
            any prescription, but that product's job cards will stop showing them until a kit is linked again.
          </p>
        )}
      </Modal>

      <InnerProductForm open={Boolean(innerEditing)} item={innerEditing && innerEditing.id ? innerEditing : null}
        onClose={() => setInnerEditing(null)} onSaved={() => load()} />
    </div>
  );
}
