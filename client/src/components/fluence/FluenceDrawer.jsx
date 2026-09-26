// The Fluence drawer — one panel, opened from a Fluence button in any module,
// showing the Fluence master for one product, for every Fluence carton on a
// gang / invoice / challan, or for one kit by its own id (a kit designed in Kit
// Studio has no product until its carton goes into the product master):
//
//   Kit & prescription   what is in the box and how each item is taken — one
//                        table, edited in one place and saved together
//   Product (Masters)    the product master row the carton is printed and
//                        billed as: FP code, billing code, MRP, size, spec.
//                        Read-only here; it is edited in Masters.
//   History              every change: who, when, from which module
//
// It is FLUENCE-ONLY by construction: it is only ever opened with Fluence product
// ids or Fluence kits, and the server refuses anything else. Review-first modules
// (Invoice, Dispatch, Accounts, Warehouse) open it read-only with a verification
// summary; editing stays one deliberate click away for an authorised user.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, BadgeCheck, CheckCircle2, ClipboardList, ExternalLink, History, Layers, Loader2, Pencil, Pill, X,
} from 'lucide-react';
import { api, fmt, auth } from '../../api.js';
import { Button, Modal } from '../ui.jsx';
import { canAccess, canPlan } from '../../modules.js';
import { FLUENCE_CONTEXTS, REVIEW_CONTEXTS, rxState, qtyText, kitListPrice, partLabel, kitCartons } from '../../lib/fluence.js';
import { RxLinesTable, RxGeneral, ProductRxTable, rxStampText } from './PrescriptionView.jsx';
import KitRxEditor from './KitRxEditor.jsx';
import InnerProductForm from './InnerProductForm.jsx';

const TABS = [
  { key: 'kit', label: 'Kit & prescription', icon: Pill },
  { key: 'product', label: 'Product (Masters)', icon: ClipboardList },
  { key: 'history', label: 'History', icon: History },
];

const AREA_LABEL = { prescription: 'Prescription', components: 'Kit list', kit_link: 'Kit link' };

// A dossier's identity in this drawer: its product, or — for a kit with no
// product yet — the kit itself.
const keyOf = d => (d?.product ? d.product.id : d?.kit ? `kit:${d.kit.id}` : null);
const fromStudio = kit => String(kit?.source_ref || '').startsWith('kit-studio:');

function Section({ title, children, right }) {
  return (
    <section className="rounded-[20px] border border-white/75 bg-white/55 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      {(title || right) && (
        <div className="mb-2 flex items-center gap-2">
          {title && <h4 className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">{title}</h4>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Fact({ label, value, mono }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">{label}</div>
      <div className={`truncate text-xs font-semibold text-[#1D1D1F] ${mono ? 'font-mono' : ''}`} title={value == null ? '' : String(value)}>{value == null || value === '' ? '—' : value}</div>
    </div>
  );
}

// Every carton the kit is printed as — shown only for kits printed as several
// (Topico): the outer carton and its parts, this carton highlighted.
function KitCartonsFact({ dossier }) {
  const { kit, product, part_of: partOf } = dossier;
  if (!product) return null;
  const outer = partOf ? { product_id: partOf.outer_product_id, code: partOf.outer_code } : { product_id: product.id, code: product.code };
  const cartons = kitCartons(outer, kit?.parts);
  if (!cartons.length) return null;
  return (
    <div className="col-span-2 min-w-0 sm:col-span-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">Cartons printed for this kit — all show its prescription</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {cartons.map(c => (
          <span key={c.code} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${c.product_id === product.id ? 'bg-green-700 font-bold text-white' : 'bg-[#1D1D1F]/[0.06] font-semibold text-[#515154]'}`}>
            <span className="font-mono">{c.code}</span> · {c.part}
          </span>
        ))}
      </div>
    </div>
  );
}

function VerifyRow({ ok, warn, label, value }) {
  return (
    <div className="flex items-start gap-2 py-1">
      {ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-700" />
        : <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${warn ? 'text-amber-600' : 'text-[#AEAEB2]'}`} />}
      <span className="w-28 shrink-0 text-[11px] font-semibold text-[#6E6E73]">{label}</span>
      <span className="min-w-0 flex-1 text-xs font-semibold text-[#1D1D1F]">{value}</span>
    </div>
  );
}

// What a save did, in the words the floor reads it in.
function savedText(out) {
  if (out.unchanged) return 'Nothing changed — the Fluence master is as it was.';
  const d = out.dossier;
  const what = [out.componentsChanged && 'kit list', out.rxChanged && `prescription (revision ${out.revision})`].filter(Boolean).join(' and ') || 'kit';
  const plural = out.componentsChanged && out.rxChanged;
  if (!d?.product) {
    return `Fluence master updated — ${what} for ${d?.kit?.kit_name || 'this kit'}. Every module reads ${plural ? 'them' : 'it'} once the kit’s carton is in the product master.`;
  }
  const outer = d.part_of?.outer_code;
  return outer
    ? `Fluence master updated — ${what} for the kit of ${outer}. ${outer}, its part cartons, Planning, Job Cards and every other module now read ${plural ? 'them' : 'it'}.`
    : `Fluence master updated — ${what} for ${d.product.code}. Planning, Job Cards and every other module now read ${plural ? 'them' : 'it'}.`;
}

export default function FluenceDrawer({
  productIds = [], resolve = null, kitId = null, startEditing = false, context = 'fluence_master', title, onClose, onSaved,
}) {
  const [ids, setIds] = useState(productIds);
  const [dossiers, setDossiers] = useState(null);
  const [canEditServer, setCanEditServer] = useState(false);
  const [active, setActive] = useState(null);         // a dossier key (keyOf), or 'all'
  const [tab, setTab] = useState('kit');
  const [editing, setEditing] = useState(false);
  const [editorKey, setEditorKey] = useState(0);      // remounts the editor on "load the latest"
  const [dirty, setDirty] = useState(false);
  const [askDiscard, setAskDiscard] = useState(null); // the action to run once discarded
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);           // { key, tone, text }
  const [innerEditing, setInnerEditing] = useState(null);
  const [revisions, setRevisions] = useState(null);
  const autoEdit = useRef(Boolean(startEditing));

  const review = REVIEW_CONTEXTS.has(context);
  const user = auth.user;
  const canEdit = canEditServer && canPlan(user);

  const load = useCallback(async (list) => {
    setError(null);
    if (kitId) {
      const out = await api.get(`/fluence/kits/${kitId}/dossier`);
      setCanEditServer(Boolean(out.can_edit));
      setDossiers(out.dossier ? [out.dossier] : []);
      setActive(cur => cur ?? keyOf(out.dossier));
      return;
    }
    let want = list;
    if ((!want || !want.length) && resolve) {
      const qs = new URLSearchParams(Object.entries(resolve).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
      want = (await api.get(`/fluence/resolve?${qs}`)).product_ids;
      setIds(want);
    }
    if (!want?.length) { setDossiers([]); return; }
    const out = await api.get(`/fluence/dossiers?product_ids=${want.join(',')}`);
    setCanEditServer(Boolean(out.can_edit));
    setDossiers(out.dossiers);
    setActive(cur => cur ?? (out.dossiers.length > 1 ? 'all' : keyOf(out.dossiers[0])));
  }, [resolve, kitId]);

  useEffect(() => { load(productIds).catch(e => { setError(e.message); setDossiers([]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dossier = useMemo(() => (dossiers || []).find(d => keyOf(d) === active) || null, [dossiers, active]);

  // Opened to edit (Kit Studio's "Edit contents & prescription"): straight into
  // the editor, once, for someone who may edit.
  useEffect(() => {
    if (!autoEdit.current || !dossier || !canEdit) return;
    autoEdit.current = false;
    setTab('kit');
    setEditing(true);
  }, [dossier, canEdit]);

  // Guard every way out of an unsaved edit.
  const guard = action => { if (editing && dirty) setAskDiscard(() => action); else action(); };
  const close = () => guard(onClose);
  const stopEditing = () => { setEditing(false); setDirty(false); };

  // Escape closes the drawer only — never the engine or form it was opened over.
  useEffect(() => {
    const h = e => {
      if (e.key !== 'Escape') return;
      // A dialog opened ON the drawer (nested layer), or an open search
      // dropdown, takes its own Escape.
      if (document.querySelector('.z-\\[90\\], .z-\\[200\\]')) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  });

  useEffect(() => {
    if (tab !== 'history' || !dossier?.kit) { setRevisions(null); return; }
    let live = true;
    api.get(`/fluence/kits/${dossier.kit.id}/revisions`).then(r => live && setRevisions(r)).catch(() => live && setRevisions([]));
    return () => { live = false; };
  }, [tab, dossier?.kit?.id, dossier?.revisions?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const afterSave = out => {
    const next = out.dossier;
    if (next) {
      const was = active;
      setDossiers(list => (list || []).map(d => (keyOf(d) === was ? next : d)));
      setActive(keyOf(next));
    }
    stopEditing();
    setSaved({ key: keyOf(next), tone: out.unchanged ? 'info' : 'ok', text: savedText(out) });
    onSaved?.(out);
  };

  // A colleague saved first: fetch the latest and reopen the editor on it.
  const reloadLatest = async () => {
    setDirty(false);
    try { await load(ids); setEditorKey(k => k + 1); } catch (e) { setError(e.message); }
  };

  const summaryItems = (dossiers || []).filter(d => d.product).map(d => ({
    product_id: d.product.id, product_code: d.product.code, product_name: d.product.name,
    party_artwork_code: d.product.party_artwork_code, prescription: d.prescription,
  }));

  const header = dossier?.product
    ? { name: dossier.product.name, sub: `${dossier.product.code}${dossier.product.party_item_code ? ` · Item ${dossier.product.party_item_code}` : ''}` }
    : dossier?.kit
      ? { name: dossier.kit.kit_name, sub: fromStudio(dossier.kit) ? 'Kit Studio kit · not in the product master yet' : `Customer kit${dossier.kit.party_sl_no ? ` · party Sl.No ${dossier.kit.party_sl_no}` : ''} · not linked to a product yet` }
      : { name: title || (dossiers?.length > 1 ? `${dossiers.length} Fluence products` : 'Fluence'), sub: dossiers?.length > 1 ? 'Each product keeps its own prescription' : '' };

  const rx = dossier?.prescription;
  const components = dossier?.components || [];
  const hasAnything = components.length > 0 || (rx?.lines || []).length > 0 || Boolean(rx?.general_instructions);
  const whereLabel = dossier?.part_of ? `kit of ${dossier.part_of.outer_code} (from ${dossier.product.code})` : dossier?.product ? dossier.product.code : dossier?.kit?.kit_name;
  // Opened from Masters, the product is already a click away there (and its
  // form may be open under this drawer) — no link back into it.
  const mastersLink = dossier?.product && context !== 'masters' && canAccess(user, 'masters') ? `/masters?tab=products&edit=${dossier.product.id}` : null;

  return createPortal(
    <div data-ci-overlay className="no-print fixed inset-0 z-[58]" data-fluence-drawer="1">
      <div className="absolute inset-0 bg-[#1D1D1F]/25 backdrop-blur-[3px] animate-fadeIn" onClick={close} />
      <aside className={`absolute inset-y-0 right-0 flex w-full p-0 transition-[max-width] duration-200 sm:p-3 ${editing ? 'max-w-[1240px]' : 'max-w-[920px]'}`} role="dialog" aria-label="Fluence kit and prescription">
        <div className="glass flex h-full w-full flex-col overflow-hidden rounded-none sm:rounded-[26px] animate-scaleIn">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-700 text-white shadow-[0_6px_16px_rgba(21,128,61,0.35)]"><Pill size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="shrink-0 whitespace-nowrap rounded-full bg-green-700/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-green-800">Fluence only</span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">
                  {review ? 'Review & verify' : 'Kit & prescription master'} · from {FLUENCE_CONTEXTS[context] || 'ERP'}
                </span>
              </div>
              <p className="truncate text-[15px] font-bold tracking-[-0.01em] text-[#1D1D1F]">{header.name}</p>
              {header.sub && <p className="truncate text-[11px] text-[#6E6E73]">{header.sub}</p>}
            </div>
            {context !== 'fluence_master' && (
              <Link to="/fluence" onClick={e => { if (editing && dirty) { e.preventDefault(); return; } onClose(); }}
                className="hidden items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#0064D2] hover:bg-white/70 sm:inline-flex" title="Open the Fluence Master">
                Fluence Master <ExternalLink size={11} />
              </Link>
            )}
            <button type="button" onClick={close} aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
              <X size={16} />
            </button>
          </div>

          {/* Product switcher — a gang, invoice or challan carries several */}
          {dossiers?.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto border-b border-[#1D1D1F]/[0.06] bg-white/30 px-4 py-2 scrollbar-none">
              <button type="button" onClick={() => guard(() => { setActive('all'); stopEditing(); })}
                className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold ${active === 'all' ? 'bg-green-700 text-white' : 'bg-white/70 text-[#515154] hover:bg-white'}`}>
                All {dossiers.length} products
              </button>
              {dossiers.map(d => {
                const has = rxState(d.prescription) !== 'none';
                const key = keyOf(d);
                return (
                  <button key={key} type="button" onClick={() => guard(() => { setActive(key); stopEditing(); })}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold ${active === key ? 'bg-green-700 text-white' : 'bg-white/70 text-[#515154] hover:bg-white'}`}
                    title={has ? 'Prescription entered' : 'No prescription entered yet'}>
                    <span className={`h-1.5 w-1.5 rounded-full ${has ? 'bg-green-400' : 'bg-amber-400'}`} />
                    {d.product ? `${d.product.code} · ${d.product.name}` : d.kit?.kit_name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Tabs (one kit) */}
          {dossier && (
            <div className="flex gap-1 overflow-x-auto border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2 scrollbar-none">
              {TABS.map(t => (
                <button key={t.key} type="button" data-fluence-tab={t.key} onClick={() => guard(() => { setTab(t.key); stopEditing(); })}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${tab === t.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
                  <t.icon size={13} /> {t.label}
                  {t.key === 'kit' && components.length > 0 && <span className="rounded-full bg-[#1D1D1F]/[0.07] px-1.5 text-[10px]">{components.length} items</span>}
                  {t.key === 'kit' && rxState(rx) === 'full' && <span className="rounded-full bg-green-700/10 px-1.5 text-[10px] text-green-800">rev {rx.revision}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Body */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {!dossiers && !error && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#86868B]"><Loader2 size={16} className="animate-spin" /> Loading the Fluence master…</div>
            )}
            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
            {dossiers && dossiers.length === 0 && !error && (
              <p className="py-12 text-center text-sm text-[#6E6E73]">{kitId ? 'This kit is no longer in the Fluence master.' : 'No Fluence products on this record.'}</p>
            )}

            {saved && (!dossier || saved.key === keyOf(dossier) || active === 'all') && (
              <div className={`flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs font-semibold ${saved.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`} data-fluence-saved="1">
                <BadgeCheck size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">{saved.text}</span>
                <button type="button" className="shrink-0 text-[11px] underline" onClick={() => setSaved(null)}>Dismiss</button>
              </div>
            )}

            {/* All products — the product-wise table */}
            {active === 'all' && dossiers?.length > 1 && (
              <Section title="Prescription — product-wise" right={<span className="text-[10px] text-[#86868B]">Every product keeps its own prescription</span>}>
                <ProductRxTable items={summaryItems} onOpen={id => { setActive(id); setTab('kit'); }} />
              </Section>
            )}

            {dossier?.product && review && (
              <Section title="Verification">
                <VerifyRow ok label="Product" value={`${dossier.product.code} · ${dossier.product.name}`} />
                <VerifyRow ok={Boolean(dossier.product.party_artwork_code)} warn label="Artwork code" value={dossier.product.party_artwork_code || 'Not on the product master'} />
                <VerifyRow ok={Boolean(dossier.kit)} warn label="Kit" value={dossier.kit ? `${dossier.kit.kit_name}${dossier.kit.party_sl_no ? ` · party Sl.No ${dossier.kit.party_sl_no}` : ''}${dossier.part_of ? ` · via its outer carton (${partLabel(dossier.part_of).toLowerCase()})` : ''}` : dossier.part_of ? `${partLabel(dossier.part_of)} — the outer carton has no kit linked` : 'No customer kit linked'} />
                <VerifyRow ok={components.length > 0} warn label="Inner products" value={components.length ? `${components.length} items · ${qtyText(components.reduce((s, c) => s + (+c.qty_per_kit || 0), 0))} units` : 'None recorded'} />
                <VerifyRow ok={rxState(rx) !== 'none'} warn label="Prescription" value={{ full: rxStampText(rx), items: `${rx?.lines?.length || 0} products, from the customer master (it has no day-wise schedule)`, none: 'Not entered in the Fluence master' }[rxState(rx)]} />
              </Section>
            )}

            {dossier?.part_of && tab === 'kit' && (
              <div className="flex items-start gap-2 rounded-2xl border border-green-200 bg-green-50/80 px-3 py-2 text-xs text-green-900" data-fluence-part="1">
                <Layers size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <b>{partLabel(dossier.part_of)}</b> — a part carton of {dossier.part_of.outer_name}.{' '}
                  {dossier.kit
                    ? 'It shows that kit’s contents and prescription; an edit made here changes them for the outer carton and all its parts.'
                    : 'The outer carton has no kit linked yet, so there is nothing to show.'}
                </span>
              </div>
            )}

            {dossier && tab === 'kit' && !editing && (
              <>
                {dossier.kit ? (
                  <Section title="Customer kit">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Fact label="Kit (customer list)" value={dossier.kit.kit_name} />
                      <Fact label="Party Sl.No" value={dossier.kit.party_sl_no} />
                      <Fact label="Type" value={dossier.kit.kit_type} />
                      <Fact label="Valid" value={dossier.kit.valid_from ? `${fmt.date(dossier.kit.valid_from)} – ${dossier.kit.valid_to ? fmt.date(dossier.kit.valid_to) : '…'}` : null} />
                      {(() => {
                        const price = kitListPrice(dossier.kit, components.map(c => c.mrp_in_kit));
                        return price?.kind === 'per_line'
                          ? <Fact label="Line price (customer list)" value={`${fmt.inr(price.amount)} on every line`} />
                          : <Fact label="Kit total (customer list)" value={price ? fmt.inr(price.amount) : null} />;
                      })()}
                      {dossier.part_of
                        ? <Fact label={`Outer carton MRP (${dossier.part_of.outer_code})`} value={dossier.part_of.outer_mrp != null ? fmt.inr(dossier.part_of.outer_mrp) : null} />
                        : <Fact label="Carton MRP (Masters)" value={dossier.product?.mrp != null ? fmt.inr(dossier.product.mrp) : null} />}
                      <Fact label="Linked" value={!dossier.product && !dossier.part_of ? 'Not in the product master yet'
                        : dossier.kit.from_customer_list ? `${(dossier.kit.link_method || '').replace(/_/g, ' ')}${dossier.kit.linked_by ? ` · ${dossier.kit.linked_by}` : ''}`
                        : fromStudio(dossier.kit) ? `Kit Studio${dossier.kit.linked_by ? ` · ${dossier.kit.linked_by}` : ''}`
                        : 'Started from the ERP product'} />
                      <Fact label="Carton size (Masters)" value={dossier.product?.size} />
                      <KitCartonsFact dossier={dossier} />
                    </div>
                  </Section>
                ) : dossier.part_of ? (
                  <Section title="Customer kit">
                    <p className="text-xs text-[#6E6E73]">
                      {dossier.product.code} is a part carton — it shows the kit of its outer carton {dossier.part_of.outer_code}, which has no kit linked.
                      {' '}Link the customer kit to {dossier.part_of.outer_code} in the{' '}
                      <Link to="/fluence?tab=kits" className="font-semibold text-[#0064D2] hover:underline" onClick={onClose}>Fluence Master</Link>.
                    </p>
                  </Section>
                ) : null}

                <Section title="Kit & prescription"
                  right={canEdit && (
                    <Button size="sm" variant={review ? 'secondary' : 'primary'} onClick={() => { setEditing(true); setSaved(null); }} data-fluence-edit="1">
                      <Pencil size={12} /> {hasAnything ? 'Edit kit & prescription' : 'Add items & prescription'}
                    </Button>
                  )}>
                  {hasAnything ? (
                    <>
                      {rx && <p className="mb-2 text-[11px] font-semibold text-green-800">{rxStampText(rx)}</p>}
                      <RxLinesTable rx={rx} components={components} onEditItem={canEdit ? setInnerEditing : null} />
                      <RxGeneral rx={rx} />
                      {rxState(rx) !== 'full' && components.length > 0 && (
                        <p className="mt-2 text-[11px] text-[#6E6E73]">
                          No day-wise schedule yet — the customer master lists the kit’s products only
                          {canEdit ? '. Doses and times go in with Edit kit & prescription, beside each item.' : '.'}
                        </p>
                      )}
                      {components.some(c => c.carton_l == null || c.carton_w == null || c.carton_h == null) && (
                        <p className="mt-1 text-[11px] text-amber-700">Carton sizes marked “not known yet” are blank on purpose — they are filled in when the sizes are supplied, never estimated.</p>
                      )}
                    </>
                  ) : dossier.part_of && !dossier.kit ? (
                    <p className="text-xs text-[#6E6E73]">
                      Nothing to show until the outer carton {dossier.part_of.outer_code} has a kit.
                      {canEdit ? ` Items added here start that kit on ${dossier.part_of.outer_code}.` : ''}
                    </p>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50/70 px-4 py-5 text-center">
                      <p className="text-sm font-bold text-amber-800">Nothing in the Fluence master for this kit yet</p>
                      <p className="mt-1 text-xs text-amber-800/80">
                        {canEdit ? 'Add its items and how each is taken — one table, one save. Planning, the Job Card and every station read it from the master.'
                          : 'Ask Planning or Artwork to enter it in the Fluence master.'}
                      </p>
                    </div>
                  )}
                  {review && canEdit && <p className="mt-2 text-[11px] text-[#86868B]">Opened for review from {FLUENCE_CONTEXTS[context]} — editing changes the master for every module.</p>}
                </Section>
              </>
            )}

            {dossier && tab === 'kit' && editing && (
              <Section title={`Edit kit & prescription — ${whereLabel}`}>
                <KitRxEditor key={`${keyOf(dossier)}:${editorKey}`} dossier={dossier} context={context} onDirty={setDirty}
                  onCancel={() => guard(stopEditing)}
                  onReload={reloadLatest}
                  onSaved={afterSave} />
              </Section>
            )}

            {dossier && tab === 'product' && (
              dossier.product ? (
                <Section title="Product master (Masters)"
                  right={mastersLink && (
                    <Link to={mastersLink} data-fluence-open-masters="1"
                      onClick={e => { if (editing && dirty) { e.preventDefault(); return; } onClose(); }}
                      className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#0064D2] shadow-[0_1px_4px_rgba(29,29,31,0.08)] hover:bg-white">
                      Open in Masters <ExternalLink size={11} />
                    </Link>
                  )}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Fact label="Product" value={dossier.product.name} />
                    <Fact label="FP code" value={dossier.product.code} mono />
                    <Fact label="Billing code (item code)" value={dossier.product.party_item_code} mono />
                    <Fact label="Artwork code" value={dossier.product.party_artwork_code} mono />
                    <Fact label="Carton MRP" value={dossier.product.mrp != null ? fmt.inr(dossier.product.mrp) : null} />
                    <Fact label="Carton size" value={dossier.product.size} />
                    <Fact label="Output number" value={dossier.product.output_number} mono />
                    <Fact label="Shade card" value={[dossier.product.shade_card_number, dossier.product.shade_card_date].filter(Boolean).join(' · ')} />
                    <Fact label="Colours" value={[dossier.product.colors, dossier.product.colour_type].filter(Boolean).join(' · ')} />
                    <Fact label="Board" value={dossier.product.board_name} />
                    <Fact label="Coating" value={dossier.product.coating} />
                    <Fact label="Pasting" value={dossier.product.pasting_type} />
                    <Fact label="Child sheet" value={dossier.product.child_l && dossier.product.child_w ? `${dossier.product.child_l} × ${dossier.product.child_w}` : null} />
                    <Fact label="Ups" value={dossier.product.ups} />
                    <Fact label="Die" value={dossier.product.die_number} />
                    <Fact label="Customer" value={dossier.product.customer_name} />
                  </div>
                  <p className="mt-3 text-[11px] text-[#86868B]">
                    Masters owns what is printed and billed — the FP code, billing code, carton MRP, size and spec. The Fluence master owns what is in the kit and its prescription.
                    {mastersLink ? ' Change these in Masters.' : ''}
                  </p>
                </Section>
              ) : (
                <Section title="Product master (Masters)">
                  <p className="text-xs text-[#515154]">
                    <b>{dossier.kit?.kit_name}</b> has no carton in the product master yet, so it has no FP code or billing code and no module shows it.
                  </p>
                  <p className="mt-1.5 text-xs text-[#6E6E73]">
                    {fromStudio(dossier.kit)
                      ? 'Create or link its product master from the kit in Kit Studio (“Create product master”) — the FP code and the next billing code are given there.'
                      : 'Link it to its product under Customer kits in the Fluence Master.'}
                  </p>
                </Section>
              )
            )}

            {dossier && tab === 'history' && (
              <Section title="Change history">
                {!dossier.kit && <p className="text-xs text-[#6E6E73]">Nothing has been recorded for this product yet.</p>}
                {dossier.kit && !revisions && <p className="flex items-center gap-2 text-xs text-[#86868B]"><Loader2 size={13} className="animate-spin" /> Loading…</p>}
                {revisions && revisions.length === 0 && <p className="text-xs text-[#6E6E73]">No changes recorded yet.</p>}
                {revisions && revisions.length > 0 && (
                  <ol className="space-y-2">
                    {revisions.map(r => (
                      <li key={r.id} className="rounded-xl border border-white/80 bg-white/60 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <span className="rounded-full bg-green-700/10 px-2 py-0.5 text-[10px] font-bold text-green-800">{AREA_LABEL[r.area] || r.area}{r.revision ? ` · rev ${r.revision}` : ''}</span>
                          <span className="font-semibold text-[#1D1D1F]">{r.changed_by || '—'}</span>
                          <span className="text-[#6E6E73]">{fmt.dt(r.changed_at)}</span>
                          {r.changed_from && <span className="text-[#86868B]">from {FLUENCE_CONTEXTS[r.changed_from] || r.changed_from}</span>}
                        </div>
                        {r.note && <p className="mt-1 text-[11px] text-[#515154]">{r.note}</p>}
                        {r.area === 'prescription' && r.after && (
                          <details className="mt-1 text-[11px]">
                            <summary className="cursor-pointer font-semibold text-[#0064D2]">Show this revision</summary>
                            <div className="mt-1"><RxLinesTable rx={r.after} dense /><RxGeneral rx={r.after} /></div>
                          </details>
                        )}
                        {r.area === 'components' && (
                          <p className="mt-1 text-[11px] text-[#515154]">
                            {(r.before || []).length} → {(r.after || []).length} items
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
            )}
          </div>

          <div className="border-t border-[#1D1D1F]/[0.06] bg-white/40 px-4 py-2 text-[10px] text-[#86868B]">
            Fluence Pharmaceuticals only · one master, read live by Planning, Artwork, Job Cards, Print Planning, Printing, Sorting, Pasting, Dispatch, Invoice, Accounts and Warehouse.
          </div>
        </div>
      </aside>

      <Modal open={Boolean(askDiscard)} onClose={() => setAskDiscard(null)} layer="nested" title="Discard your changes?"
        footer={<>
          <Button variant="secondary" onClick={() => setAskDiscard(null)}>Keep editing</Button>
          <Button variant="danger" onClick={() => { const a = askDiscard; setAskDiscard(null); stopEditing(); a?.(); }}>Discard</Button>
        </>}>
        <p className="text-sm text-gray-600">You have unsaved edits to the Fluence master. Leave without saving?</p>
      </Modal>
      <InnerProductForm open={Boolean(innerEditing)} item={innerEditing} onClose={() => setInnerEditing(null)}
        onSaved={() => load(ids).catch(e => setError(e.message))} />
    </div>,
    document.body,
  );
}
