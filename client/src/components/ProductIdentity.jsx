import { useEffect, useMemo, useState } from 'react';
import MasterHistory from './MasterHistory.jsx';
import { api, fmt } from '../api.js';

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
  className = '',
  nameClassName = '',
  codesClassName = '',
  compact = false,
  codes = true,
  stopPropagation = true,
}) {
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
  const canOpen = enriched.id && enriched.name;
  const title = [
    enriched.name,
    ...productCodeParts(enriched).map(p => `${p.label} ${p.value}`),
    meta,
  ].filter(Boolean).join(' · ');

  const onClick = e => {
    if (stopPropagation) e.stopPropagation();
    if (canOpen) setOpen(true);
  };

  return (
    <>
      <div className={`min-w-0 ${className}`} title={title}>
        {canOpen ? (
          <button type="button" onClick={onClick}
            className={`block max-w-full text-left font-semibold leading-snug text-slate-800 transition-colors hover:text-[#007AFF] focus:outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[#0A84FF]/35 ${compact ? 'text-xs' : ''} ${nameClassName}`}>
            <span className="line-clamp-2 break-words">{enriched.name}</span>
          </button>
        ) : (
          <div className={`font-semibold leading-snug text-slate-800 ${compact ? 'text-xs' : ''} ${nameClassName}`}>
            <span className="line-clamp-2 break-words">{enriched.name || '—'}</span>
          </div>
        )}
        {codes && <ProductCodes row={enriched} compact={compact} className={`mt-1 ${codesClassName}`} />}
        {meta && <div className="mt-0.5 min-w-0 truncate text-[11px] text-slate-400">{meta}</div>}
      </div>
      {open && <MasterHistory kind="products" record={enriched} onClose={() => setOpen(false)} />}
    </>
  );
}

export function productExport(row = {}) {
  const r = productRecord(row);
  const codes = productCodeParts(r).map(p => `${p.label}: ${p.value}`).join(' · ');
  return [r.name, codes].filter(Boolean).join(' — ') || '—';
}
