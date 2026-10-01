// What a carton-in-parts card IS, printed where the operator looks first — under
// the job-card number. A part card runs only to die cutting and its pieces are
// pasted into the carton on another card; a pasting card joins the pieces of the
// part cards it names. Without this line either one reads like any other job.
// Payload: GET /job-cards/:id → jc.carton_parts (production.js attachCartonParts,
// read from the ORDER's own part lines). Every other card has none and prints
// exactly as it did.
//
// Sky on screen — the part colour of Planning's PartChip. Black on paper, like the
// sheet's Board & cutting plan box: a black-and-white printer reads the band by
// its border and its weight, never by its colour.
//
// It fills the header's left column — ~400px on A4 beside the customer/PO column
// (JobCardSheet caps that column on a carton card) — where the part sentence takes
// two lines at 12px bold, set tight; at 13px it ran to a third. What never breaks
// is a code or a card number at its hyphen ("CI-" at the end of one line and
// "JC-0002" on the next is not a card number), so each part's "(card: pcs)" is
// kept whole. A pasting card places each part as one piece — "Part 2" never ends
// a line without its card — and only a part longer than the band itself wraps,
// inside its own box, its last word still with its card. A free-text label of
// any length therefore wraps rather than pushing the band off the page;
// overflow-wrap:anywhere is the floor under even a label with no spaces.
import { Fragment } from 'react';

export default function JobCardPartsBand({ jc }) {
  const cp = jc?.carton_parts;
  if (!cp) return null;
  const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
  return (
    <div data-carton-parts-band={cp.role}
      className="mt-1 rounded border-2 border-sky-600 px-2 py-1 text-xs font-bold leading-snug tracking-tight text-sky-800 [overflow-wrap:anywhere] print:border-ink-900 print:text-ink-900">
      {cp.role === 'part'
        ? <>{cp.label} of {cp.of_parts} · for <span className="whitespace-nowrap">{cp.outer_code}</span> {cp.outer_name} — runs to die cutting; the pieces are pasted into the carton on its pasting card</>
        : <>Pasting card — joins {cp.parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && ' + '}
              <span className="inline-block max-w-full">{p.label}&nbsp;<span className="whitespace-nowrap">{`(${p.jc_number || 'not yet'}: ${fmt(p.qty_produced)} pcs)`}</span></span>
            </Fragment>
          ))}</>}
    </div>
  );
}
