// The Fluence door — a small green "Fluence" pill that opens the prescription &
// kit drawer. It renders NOTHING unless the row carries a Fluence product (or is
// a document of a Fluence customer), so every other customer's row is exactly
// what it was before this feature existed.
//
//   <FluenceButton productIds={[...]} context="planning" />           a row, a gang
//   <FluenceButton productId={row.product_id} context="dispatch" />    one product
//   <FluenceButton customerId={inv.customer_id} resolve={{ invoice_id: inv.id }} context="invoice" />
//   <FluenceButton productId={card.product_id} jobCardId={card.id} context="print_planning" />
//     — a card that names only its LEAD product: the job card's own lines decide
//       whether it is Fluence and which cartons the drawer opens, product-wise.
//
// Green is Fluence's own customer hue (customerColour.js, id 43 → green-700),
// deliberately not teal (combined run) or violet (gang), which already mean
// something on these same rows.
import { lazy, Suspense, useState } from 'react';
import { Pill } from 'lucide-react';
import { useFluenceScope } from '../../lib/useFluenceScope.js';
import { useJobCardFluenceProducts } from '../../lib/fluenceJobCards.js';

const FluenceDrawer = lazy(() => import('./FluenceDrawer.jsx'));

// `bar` wraps the pill in its own right-aligned row — for placing it at the top
// of an engine or form. The row exists only when the pill does, so a
// non-Fluence screen gains no empty row and no extra spacing.
export default function FluenceButton({
  productIds, productId, customerId, resolve, jobCardId, context, label = 'Fluence', compact = false, className = '', title, bar = false,
}) {
  const scope = useFluenceScope();
  const [open, setOpen] = useState(false);
  const direct = scope.fluenceIds(productIds ?? (productId != null ? [productId] : []));
  // A job card's own lines win once known; until then the lead product decides.
  const ofJobCard = useJobCardFluenceProducts(jobCardId, scope.enabled && jobCardId != null);
  const ids = ofJobCard ?? direct;
  const byDocument = Boolean(resolve) && scope.isCustomer(customerId);
  if (!scope.enabled || (!ids.length && !byDocument)) return null;
  // Opened from a job card, the drawer resolves the card's members FRESH — the
  // cached list only decides whether the door is shown.
  const drawerResolve = jobCardId != null ? { job_card_id: jobCardId } : (ids.length ? null : resolve);
  const drawerIds = jobCardId != null ? [] : ids;

  const stop = e => e.stopPropagation();
  const Wrap = bar ? 'div' : 'span';
  return (
    <Wrap className={bar ? 'flex justify-end' : 'contents'}>
      <button type="button"
        onClick={e => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
        onMouseDown={stop} onPointerDown={stop} onTouchStart={stop}
        draggable={false}
        title={title || (ids.length > 1 ? `Fluence — prescription & kit for ${ids.length} products` : 'Fluence — prescription & kit')}
        aria-label="Open Fluence prescription and kit"
        data-fluence-button={context}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-green-700/25 bg-green-50 font-bold text-green-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:bg-green-100 hover:text-green-900 active:scale-[0.97] no-print print:hidden ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'} ${className}`}>
        <Pill size={compact ? 10 : 11} className="shrink-0" />
        {!compact || label ? <span>{label}</span> : null}
        {ids.length > 1 && <span className="rounded-full bg-green-700 px-1 text-[9px] leading-[14px] text-white">{ids.length}</span>}
      </button>
      {open && (
        // React bubbles events out of a portal through the COMPONENT tree, so a
        // click inside the drawer would otherwise reach the row this button sits
        // in and open that row's own form. The wrapper stops them here.
        <span className="contents" onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop}
          onTouchStart={stop} onContextMenu={stop} onDragStart={stop}>
          <Suspense fallback={null}>
            <FluenceDrawer productIds={drawerIds} resolve={drawerResolve} context={context} onClose={() => setOpen(false)} />
          </Suspense>
        </span>
      )}
    </Wrap>
  );
}
