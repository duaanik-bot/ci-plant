// The Fluence page of a job card — printed on its own page after the traveler,
// and shown under it on screen. Only a card carrying a Fluence product renders
// it; every other card is exactly the sheet it was, with no extra request.
//
// PRODUCT-WISE, ALWAYS. A gang card lists each Fluence carton with its own
// artwork code and its own prescription — first as the brief's one-glance table
// (Product | Artwork Code | Prescription), then product by product in full.
// Prescriptions are never merged into one for the run.
//
// The data is the Fluence master read live, like everything else on the card. If
// the prescription was revised after the card was finalised, the page says so.
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { useFluenceScope } from '../../lib/useFluenceScope.js';
import { rxHasContent, rxState, qtyText, partLabel } from '../../lib/fluence.js';
import { RxLinesTable, RxGeneral, ProductRxTable, rxStampText } from './PrescriptionView.jsx';

export function jobCardProductIds(jc) {
  if (!jc) return [];
  if (jc.gang_parent && jc.gang_members?.length) return jc.gang_members.map(m => m.product_id);
  return [jc.product_id];
}

export default function JobCardFluenceRx({ jc }) {
  const scope = useFluenceScope();
  const fluenceIds = scope.fluenceIds(jobCardProductIds(jc));
  const [card, setCard] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!jc?.id || !fluenceIds.length) return undefined;
    let live = true;
    setFailed(false);
    api.get(`/fluence/job-cards/prescriptions?ids=${jc.id}`)
      .then(r => { if (live) setCard(r.cards?.[jc.id] || { items: [] }); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [jc?.id, fluenceIds.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!fluenceIds.length) return null;
  const items = card?.items || [];
  const multi = items.length > 1;

  return (
    <section className="jc-fluence mt-8 border-t-2 border-dashed border-green-700/40 pt-5 print:mt-0 print:break-before-page print:border-0 print:pt-0" data-fluence-jobcard-page="1">
      <div className="flex items-start justify-between gap-4 border-b-2 border-ink-900 pb-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-green-800">Fluence Pharmaceuticals — Prescription</div>
          <h2 className="mt-1 text-lg font-bold tracking-tight text-ink-900">
            {jc.jc_number}{card?.gang_number ? <span className="font-normal text-gray-600"> · {card.gang_number}</span> : null}
          </h2>
          <div className="text-xs text-gray-600">
            {multi ? `${items.length} Fluence products on this card — each with its own prescription`
              : items[0] ? `${items[0].product_code} · ${items[0].product_name}` : ''}
          </div>
        </div>
        <div className="shrink-0 text-right text-[10px] text-gray-500">
          <div className="text-sm font-extrabold text-ink-900">COLOUR IMPRESSIONS</div>
          <div>From the Fluence master</div>
          <div className="print:hidden">Prints as its own page after the job card</div>
        </div>
      </div>

      {!card && !failed && <p className="mt-4 text-xs text-gray-500">Loading the prescription from the Fluence master…</p>}
      {failed && <p className="mt-4 text-xs font-semibold text-red-700">The prescription could not be loaded — reload before printing.</p>}

      {multi && (
        <div className="mt-4">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-green-800">Prescription — product-wise</div>
          <ProductRxTable items={items} print />
        </div>
      )}

      {items.map(it => (
        <div key={it.product_id} className="mt-5 break-inside-avoid">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-gray-300 pb-1">
            <div className="text-sm font-bold text-ink-900">{it.product_code} · {it.product_name}</div>
            <div className="text-[10px] text-gray-600">
              Artwork <b className="font-mono text-gray-900">{it.party_artwork_code || '—'}</b>
              {it.party_item_code ? <> · Item <b className="font-mono text-gray-900">{it.party_item_code}</b></> : null}
              {it.kit_name ? <> · Kit <b className="text-gray-900">{it.kit_name}</b></> : null}
              {it.qty ? <> · {fmt.num(it.qty)} pcs{it.po_numbers?.length ? ` (PO ${[...new Set(it.po_numbers)].join(', ')})` : ''}</> : null}
            </div>
          </div>
          {it.part_of && (
            <div className="mt-1 text-[11px] font-semibold text-green-900">
              {partLabel(it.part_of)} — a part carton of {it.part_of.outer_name}. The prescription below is that kit’s.
            </div>
          )}
          {it.rx_changed_after_finalise && (
            <div className="mt-1.5 rounded border border-amber-500 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-800">
              The prescription was {it.prescription?.revision > 1 ? 'revised' : 'entered'} after this job card was finalised (now revision {it.prescription?.revision}) — check the artwork against it before printing.
            </div>
          )}
          {rxHasContent(it.prescription) ? (
            <div className="mt-1.5">
              <RxLinesTable rx={it.prescription} print dense />
              <RxGeneral rx={it.prescription} print />
              <div className="mt-1 text-[10px] text-gray-500">{rxStampText(it.prescription)}</div>
            </div>
          ) : rxState(it.prescription) === 'items' ? (
            <div className="mt-1.5">
              <RxLinesTable rx={it.prescription} print dense />
              <div className="mt-1 text-[10px] text-gray-500">From the customer master — it has no day-wise schedule · {rxStampText(it.prescription)}</div>
            </div>
          ) : (
            <div className="mt-2 rounded border border-dashed border-amber-500 px-2 py-2 text-xs font-semibold text-amber-800">
              No prescription is entered in the Fluence master for this product.
            </div>
          )}
          {it.components?.length > 0 && rxState(it.prescription) !== 'items' && (
            <div className="mt-1 text-[10px] leading-snug text-gray-600">
              <b className="text-gray-800">Kit contents:</b> {it.components.map(c => `${c.name}${+c.qty_per_kit > 1 ? ` ×${qtyText(c.qty_per_kit)}` : ''}`).join(' · ')}
            </div>
          )}
        </div>
      ))}

      {items.length > 0 && (
        <div className="jc-sign mt-8 grid grid-cols-2 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Prescription checked against artwork</div>
          <div className="border-t border-gray-300 pt-2">Checked at press</div>
        </div>
      )}
    </section>
  );
}
