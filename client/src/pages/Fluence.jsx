// Fluence — the one module for Fluence Pharmaceuticals' kits.
//
// What used to be two modules (the Fluence Master and Kit Studio) is one page
// with one row of tabs:
//
//   Kits          Overview · Kits · New kit · Drafts — Kit Studio: every kit's
//                 carton size and arrangement, new kits designed and drafted
//   Masters       Inner products (sizes, codes, packaging) · Fluence products
//                 (the FP cartons: kit and prescription status) · Customer list
//                 (the customer's kit list, and which carton each kit is printed as)
//   Records       Change log (who changed what, signed) · Export & settings
//
// A kit's contents and its prescription are edited in one table, one save (the
// Fluence drawer). Masters keeps what is printed and billed — the FP code, billing
// code, carton MRP, size and spec — and each points at the other.
//
// Fluence Pharmaceuticals only. Nothing here touches any other customer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, CheckCircle2, History, Link2, Pill, Ruler, Unlink, AlertTriangle } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, DataTable, GroupedTabs, KpiCard, KpiRow, Modal, PageHeader, SearchableSelect, useToast } from '../components/ui.jsx';
import { canAccess, canPlan } from '../modules.js';
import FluenceDrawer from '../components/fluence/FluenceDrawer.jsx';
import KitStudioFrame from '../components/fluence/KitStudioFrame.jsx';
import { FLUENCE_CONTEXTS, kitListPrice, partLabel } from '../lib/fluence.js';

// Tab → where it lives: a view of the studio in the frame, or a table here.
const STUDIO_VIEW = { overview: 'overview', kits: 'kits', build: 'build', drafts: 'drafts', inner: 'products', settings: 'export' };
const TAB_OF_VIEW = Object.fromEntries(Object.entries(STUDIO_VIEW).map(([tab, view]) => [view, tab]));
const TABS = ['overview', 'kits', 'build', 'drafts', 'inner', 'products', 'customer', 'changes', 'settings'];

const KIT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'linked', label: 'Linked' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'unlinked', label: 'Not linked' },
];
const kitState = k => (k.superseded_by_kit_id ? 'superseded' : k.product_id ? 'linked' : k.suggested_product_id && !k.suggested_taken_by_kit_id ? 'suggested' : 'unlinked');

// What each kind of change is called in the log.
const CHANGE_LABEL = {
  prescription: 'Prescription', components: 'Kit list', kit_link: 'Kit link',
  kit_create: 'Kit added', kit_delete: 'Kit deleted', kit_studio_saved: 'Kit Studio',
  inner_product_create: 'Inner product added', inner_product_update: 'Inner product',
  studio_draft_created: 'Draft started', studio_draft_saved: 'Draft saved', studio_draft_deleted: 'Draft deleted',
  studio_settings: 'Clearances',
};

export default function Fluence() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
  const setTab = useCallback(t => setParams(p => {
    const n = new URLSearchParams(p);
    n.set('tab', t);
    n.delete('open'); n.delete('kit'); n.delete('view');
    return n;
  }, { replace: true }), [setParams]);
  const [products, setProducts] = useState(null);
  const [kits, setKits] = useState(null);
  const [changes, setChanges] = useState(null);
  const [drafts, setDrafts] = useState(null);
  // The drawer: { productId } or, for a kit with no product, { kitId }; `view` opens a tab in it.
  const [drawer, setDrawer] = useState(null);
  const [kitFilter, setKitFilter] = useState('all');
  const [linking, setLinking] = useState(null);     // kit row
  const [linkProduct, setLinkProduct] = useState('');
  const [unlinking, setUnlinking] = useState(null);
  const [busy, setBusy] = useState(false);
  const user = auth.user;
  const canEdit = canPlan(user);
  // Which carton a customer kit is printed as is a product-master decision.
  const keepsProducts = canEdit && canAccess(user, 'masters');

  const load = useCallback(() => Promise.all([
    api.get('/fluence/products').then(setProducts),
    api.get('/fluence/kits').then(setKits),
  ]).catch(() => {}), []);
  const loadChanges = useCallback(() => api.get('/fluence/changes?limit=400').then(setChanges).catch(() => setChanges([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'changes') loadChanges(); }, [tab, loadChanges]);

  // Links into the module: ?open=<product id> or ?kit=<kit id>[&view=history]
  // open the drawer — a notification about a change lands on the change itself.
  useEffect(() => {
    const open = Number(params.get('open'));
    const kit = Number(params.get('kit'));
    const view = params.get('view') === 'history' ? 'history' : null;
    if (Number.isInteger(open) && open > 0) setDrawer({ productId: open, view });
    else if (Number.isInteger(kit) && kit > 0) setDrawer({ kitId: kit, view });
  }, [params]);
  const closeDrawer = () => {
    setDrawer(null);
    if (params.get('open') || params.get('kit')) setParams(p => { const n = new URLSearchParams(p); n.delete('open'); n.delete('kit'); n.delete('view'); return n; }, { replace: true });
    load();
    if (tab === 'changes') loadChanges();
  };

  const kpi = useMemo(() => {
    const p = products || [];
    const k = (kits || []).filter(x => !x.superseded_by_kit_id);
    return {
      products: p.length,
      withKit: p.filter(x => x.kit_id).length,
      asPart: p.filter(x => x.kit_id && x.part).length,
      withRx: p.filter(x => x.rx_state === 'full').length,
      itemsOnly: p.filter(x => x.rx_state === 'items').length,
      openNoRx: p.filter(x => x.open_lines > 0 && x.rx_state === 'none').length,
      kitsUnlinked: k.filter(x => !x.product_id).length,
      kitsSuggested: k.filter(x => kitState(x) === 'suggested').length,
    };
  }, [products, kits]);

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
  const studioView = STUDIO_VIEW[tab] ?? null;
  const groups = [
    { label: 'Kits', items: [
      { key: 'overview', label: 'Overview' }, { key: 'kits', label: 'Kits' }, { key: 'build', label: 'New kit' },
      { key: 'drafts', label: drafts ? `Drafts · ${drafts}` : 'Drafts' },
    ] },
    { label: 'Masters', items: [
      { key: 'inner', label: 'Inner products' }, { key: 'products', label: 'Fluence products' },
      { key: 'customer', label: kpi.kitsUnlinked ? `Customer list · ${kpi.kitsUnlinked} to link` : 'Customer list' },
    ] },
    { label: 'Records', items: [{ key: 'changes', label: 'Change log' }, { key: 'settings', label: 'Export & settings' }] },
  ];

  return (
    <div>
      <PageHeader
        title={<span className="inline-flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-green-700 text-white"><Pill size={16} /></span> Fluence</span>}
        subtitle="Kits, their prescriptions and cartons — Fluence Pharmaceuticals only. Sized and designed here, edited in one place, read live by every module." />

      <GroupedTabs groups={groups} active={tab} onChange={setTab} />

      {/* Kit Studio: always mounted once the page is open, shown on its tabs. */}
      <KitStudioFrame view={studioView ?? undefined} hidden={!studioView}
        onView={v => { const t = TAB_OF_VIEW[v]; if (t && t !== tab && STUDIO_VIEW[tab]) setTab(t); }}
        onDrafts={setDrafts} />

      {!studioView && tab !== 'changes' && (
        <KpiRow cols={5}>
          <KpiCard compact label="Fluence products" value={fmt.num(kpi.products)} sub={`${fmt.num(kpi.withKit)} with a kit${kpi.asPart ? ` · ${fmt.num(kpi.asPart)} parts` : ''}`} icon={Boxes} />
          <KpiCard compact label="Prescriptions" value={fmt.num(kpi.withRx + kpi.itemsOnly)} sub={`${fmt.num(kpi.products - kpi.withRx - kpi.itemsOnly)} blank · ${fmt.num(kpi.withRx)} with days`} icon={Pill} tone={kpi.withRx + kpi.itemsOnly ? 'good' : undefined} />
          <KpiCard compact label="Open orders, no Rx" value={fmt.num(kpi.openNoRx)} sub="products on live orders" icon={AlertTriangle} tone={kpi.openNoRx ? 'warn' : undefined} />
          <KpiCard compact label="Customer kits not linked" value={fmt.num(kpi.kitsUnlinked)} sub={`${fmt.num(kpi.kitsSuggested)} with a suggestion`} icon={Link2} onClick={() => { setTab('customer'); setKitFilter('unlinked'); }} />
          <KpiCard compact label="Carton sizes" value="Inner products" sub="sizes, codes and packaging" icon={Ruler} onClick={() => setTab('inner')} />
        </KpiRow>
      )}

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

      {tab === 'customer' && (
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
                if (!keepsProducts) return <div className="flex justify-end" onClick={e => e.stopPropagation()}>{open}</div>;
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

      {tab === 'changes' && (
        <>
          <p className="mb-3 text-xs text-gray-500">
            Every change to the Fluence kits, prescriptions, inner products and Kit Studio — newest first, with who made it and from where.
            A change made from a customer’s own login carries its login ID as its signature, and Colour Impressions management is told at once.
          </p>
          <DataTable searchable rows={changes || []} empty={changes ? 'No changes recorded yet' : 'Loading…'}
            defaultSort={{ key: 'at', dir: 'desc' }}
            onRowClick={c => (c.kit_id ? setDrawer({ kitId: c.kit_id, view: 'history' }) : null)}
            exportName="Fluence Change Log" exportSubtitle="Kits, prescriptions, inner products and Kit Studio"
            columns={[
              { key: 'at', label: 'When', sortValue: c => new Date(c.at).getTime(), export: c => fmt.dt(c.at),
                render: c => <span className="whitespace-nowrap text-xs tabular-nums">{fmt.dt(c.at)}</span> },
              { key: 'who', label: 'Signed', render: c => <span className="text-xs font-semibold">{c.who || '—'}</span> },
              { key: 'area', label: 'Change', export: c => `${CHANGE_LABEL[c.area] || c.area}${c.revision ? ` rev ${c.revision}` : ''}`,
                render: c => (
                  <span className="whitespace-nowrap rounded-full bg-green-700/10 px-2 py-0.5 text-[10px] font-bold text-green-800">
                    {CHANGE_LABEL[c.area] || c.area}{c.revision ? ` · rev ${c.revision}` : ''}
                  </span>) },
              { key: 'kit_name', label: 'Kit or item', render: c => (
                <div className="text-xs">
                  <div className="font-semibold">{c.kit_name || '—'}</div>
                  {c.product_code && <div className="font-mono text-[10px] text-gray-400">{c.product_code}</div>}
                </div>) },
              { key: 'detail', label: 'What', render: c => <span className="text-xs text-gray-600">{c.detail || ''}</span> },
              { key: 'from_ctx', label: 'From', render: c => <span className="text-xs text-gray-500">{c.from_ctx ? FLUENCE_CONTEXTS[c.from_ctx] || c.from_ctx : ''}</span> },
              { key: 'go', label: '', sortable: false, render: c => (c.kit_id ? (
                <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setDrawer({ kitId: c.kit_id, view: 'history' }); }}><History size={12} /> History</Button>) : null) },
            ]} />
        </>
      )}

      {drawer && (
        <FluenceDrawer key={`${drawer.productId ?? ''}:${drawer.kitId ?? ''}`} productIds={drawer.productId ? [drawer.productId] : []} kitId={drawer.kitId ?? null}
          initialTab={drawer.view ?? undefined} context="fluence_master" onClose={closeDrawer} />
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
    </div>
  );
}
