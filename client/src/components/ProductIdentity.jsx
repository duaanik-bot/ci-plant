import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import MasterHistory from './MasterHistory.jsx';
import { api, fmt } from '../api.js';
import { canOpenProductHistory } from '../lib/productHistoryAccess.js';
import { declaresFontSize } from '../lib/fontSizeClass.js';

const CODE_META = [
  { key: 'internal', label: 'INT', tone: 'bg-slate-100 text-slate-600 ring-slate-200/70' },
  { key: 'artwork', label: 'AW', tone: 'bg-violet-50 text-violet-700 ring-violet-200/70' },
  { key: 'party', label: 'PARTY', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70' },
];

let productMasterCache = null;
let productMasterPromise = null;

function hasValue(v) {
  return v != null && String(v).trim() !== '';
}

function loadProductMasterCache() {
  if (productMasterCache) return Promise.resolve(productMasterCache);
  if (!productMasterPromise) {
    productMasterPromise = api.get('/products')
      .then(rows => {
        productMasterCache = new Map((Array.isArray(rows) ? rows : []).map(p => [Number(p.id), p]));
        return productMasterCache;
      })
      .catch(() => {
        productMasterPromise = null;
        return new Map();
      });
  }
  return productMasterPromise;
}

function needsMasterLookup(row) {
  return row?.id && (!hasValue(row.party_item_code) || !hasValue(row.party_artwork_code) || !hasValue(row.internal_carton_code));
}

export function productRecord(row = {}) {
  const id = row.product_id ?? row.id;
  return {
    ...row,
    id,
    name: row.product_name ?? row.name ?? '',
    code: row.product_code ?? row.code ?? row.internal_carton_code ?? '',
    // Rows reach this component under many shapes — an order line, a job card,
    // a press queue row, a dispatch row. Accept the aliases they use.
    line_remark: row.line_remark ?? row.order_line_remark ?? row.remark ?? null,
  };
}

export function productCodeParts(row = {}) {
  const r = productRecord(row);
  const values = {
    internal: r.product_code ?? r.code ?? r.internal_carton_code,
    artwork: r.party_artwork_code ?? r.product_artwork_code ?? r.artwork_no,
    party: r.party_item_code,
  };
  return CODE_META
    .map(meta => ({ ...meta, value: values[meta.key] }))
    .filter(x => hasValue(x.value));
}

export function productSearchText(row = {}) {
  const r = productRecord(row);
  return [
    r.product_name ?? r.name,
    r.product_code ?? r.code,
    r.internal_carton_code,
    r.party_artwork_code ?? r.product_artwork_code,
    r.party_item_code,
    r.output_number,
    r.size,
    r.customer_name,
    r.line_remark,
  ].filter(Boolean).join(' ');
}

export function ProductCodes({ row, className = '', compact = false, limit = 3 }) {
  const parts = productCodeParts(row).slice(0, limit);
  if (!parts.length) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {parts.map(part => (
        <span key={part.key}
          className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold ring-1 ${part.tone} ${compact ? 'text-[9px]' : 'text-[10px]'}`}
          title={`${part.label}: ${part.value}`}>
          <span className="shrink-0 opacity-70">{part.label}</span>
          <span className="min-w-0 truncate font-mono">{part.value}</span>
        </span>
      ))}
    </div>
  );
}

export default function ProductIdentity({
  row,
  product,
  name,
  productId,
  code,
  meta,
  // A node rendered at the head of the meta line — the customer's colour dot on
  // the Job Card register, and anything of that shape later.
  //
  // Deliberately NOT folded into `meta`: `title` below joins its parts with ' · '
  // and a React element stringifies to "[object Object]", so passing a node as
  // `meta` silently replaces the hover tooltip with that. `meta` stays text and
  // owns the title; this is display only, and is left out of the title because
  // a decorative dot has nothing to say to a screen reader or a tooltip.
  metaPrefix,
  className = '',
  // A font size here wins over `compact`'s own — see `compactSize` below. Any
  // other `text-*` utility (colour, alignment, wrapping) is left alone.
  nameClassName = '',
  codesClassName = '',
  compact = false,
  codes = true,
  stopPropagation = true,
}) {
  const location = useLocation();
  const r = useMemo(() => {
    const base = { ...(row || product || {}) };
    if (name != null) base.product_name = name;
    if (productId != null) base.product_id = productId;
    if (code != null) base.product_code = code;
    return productRecord(base);
  }, [row, product, name, productId, code]);
  const [master, setMaster] = useState(null);
  const detailKey = [r.id, r.party_item_code, r.party_artwork_code, r.internal_carton_code].join('|');

  useEffect(() => {
    let alive = true;
    if (!needsMasterLookup(r)) {
      setMaster(null);
      return () => { alive = false; };
    }
    loadProductMasterCache().then(map => {
      if (alive) setMaster(map.get(Number(r.id)) || null);
    });
    return () => { alive = false; };
  }, [detailKey]);

  const enriched = useMemo(() => {
    if (!master) return r;
    return productRecord({
      ...master,
      ...r,
      internal_carton_code: hasValue(r.internal_carton_code) ? r.internal_carton_code : master.internal_carton_code,
      party_artwork_code: hasValue(r.party_artwork_code) ? r.party_artwork_code : master.party_artwork_code,
      party_item_code: hasValue(r.party_item_code) ? r.party_item_code : master.party_item_code,
      product_code: hasValue(r.product_code) ? r.product_code : (master.code || master.internal_carton_code),
      product_name: hasValue(r.product_name) ? r.product_name : master.name,
    });
  }, [r, master]);
  const [open, setOpen] = useState(false);
  const canOpen = canOpenProductHistory(location.pathname) && enriched.id && enriched.name;
  const title = [
    enriched.name,
    ...productCodeParts(enriched).map(p => `${p.label} ${p.value}`),
    meta,
  ].filter(Boolean).join(' · ');

  // `compact` sets a DEFAULT size, and steps aside when the caller names its
  // own. It has to: both strings land in one class attribute, and a class
  // attribute has no say in which rule wins — Tailwind emits `text-xs` AFTER the
  // arbitrary sizes these call sites pass, so at equal specificity the later
  // rule won and a screen asking for 13px silently rendered 12px. One pixel is
  // small enough to survive years of review unnoticed. Marking the size
  // important at every call site fixes today's screens and leaves the next one
  // to fall in. Only the SIZE yields: `compact` still sizes the code chips.
  const compactSize = compact && !declaresFontSize(nameClassName) ? 'text-xs' : '';

  const onClick = e => {
    if (stopPropagation) e.stopPropagation();
    if (canOpen) setOpen(true);
  };

  return (
    <>
      <div className={`min-w-0 ${className}`} title={title}>
        {canOpen ? (
          <button type="button" onClick={onClick}
            className={`block max-w-full text-left font-semibold leading-snug text-slate-800 transition-colors hover:text-[#007AFF] focus:outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[#0A84FF]/35 ${compactSize} ${nameClassName}`}>
            <span className="line-clamp-2 break-words">{enriched.name}</span>
          </button>
        ) : (
          <div className={`font-semibold leading-snug text-slate-800 ${compactSize} ${nameClassName}`}>
            <span className="line-clamp-2 break-words">{enriched.name || '—'}</span>
          </div>
        )}
        {/* THE LINE'S OWN NOTE — typed once at order entry and carried the whole
            way: planning, job card, press, cutting, dispatch, and the FG shelf.
            It lives HERE rather than in each table because this component is
            what every one of those screens already uses to name a product, so
            the note travels with the product by construction instead of by
            twenty separate columns kept in step by hand. */}
        {hasValue(enriched.line_remark) && (
          <div className="mt-1">
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 ring-1 ring-amber-300/70"
              title={`Line remark: ${enriched.line_remark}`}>
              <span className="shrink-0 opacity-60">REM</span>
              <span className="min-w-0 truncate font-mono">{enriched.line_remark}</span>
            </span>
          </div>
        )}
        {codes && <ProductCodes row={enriched} compact={compact} className={`mt-1 ${codesClassName}`} />}
        {(meta || metaPrefix) && (
          <div className="mt-0.5 min-w-0 truncate text-[11px] text-slate-400">{metaPrefix}{meta}</div>
        )}
      </div>
      {open && <MasterHistory kind="products" record={enriched} onClose={() => setOpen(false)} />}
    </>
  );
}

export function productExport(row = {}) {
  const r = productRecord(row);
  const codes = productCodeParts(r).map(p => `${p.label}: ${p.value}`).join(' · ');
  const rem = hasValue(r.line_remark) ? `REM: ${r.line_remark}` : '';
  return [r.name, codes, rem].filter(Boolean).join(' — ') || '—';
}
