// Printing colour + process — ONE look for the whole ERP.
//
// This is the BoardStatus.jsx contract applied to ink: client/src/lib/printColour.js
// decides the FACTS (and is asserted identical to the server twin), this file
// decides how they LOOK — so Planning, Artwork, the Job Card, Print Planning and
// the press queue cannot describe one job five different ways. A page that
// re-declares its own colour labels or tones is the bug this module prevents.
//
// TWO AXES, never merged:
//   colour_type   — what the colour build IS   (CMYK / Pantone / CMYK + Pantone)
//   print_process — how it is LAID DOWN        (Offset / Metallic / Offset + Metallic)
// A Pantone spot colour is not a metallic ink. Pantone 871 C looks gold and
// prints on a conventional offset unit; folding the two axes into one field is
// exactly what put Pantone and metallic jobs into the same bucket on the floor.
import { FilterChip, FilterGroup, FilterRail } from './FilterChip.jsx';
import {
  COLOUR_TYPES, PRINT_PROCESSES, COLOUR_BANDS,
  colourTypeOf, processOf, totalColoursOf, cmykCountOf, pantoneCountOf, metallicCountOf,
  metallicNameOf, colourSummary, toggleInSet,
} from '../lib/printColour.js';

// Re-exported so a screen needs ONE import to badge, filter and sort by ink.
export {
  COLOUR_TYPES, PRINT_PROCESSES, COLOUR_BANDS,
  colourTypeOf, processOf, totalColoursOf, cmykCountOf, pantoneCountOf, metallicCountOf,
  metallicNameOf, colourSummary, colourSearchText, colourBandOf, derivedCounts,
  printColourWarnings, matchesColourFilters, colourFilterCounts, toggleInSet,
} from '../lib/printColour.js';

// Short heads for filter chips (they carry a count and live in tight rails);
// the whole phrase on a badge.
export const COLOUR_LABEL = {
  'CMYK': 'CMYK', 'Pantone': 'Pantone', 'CMYK + Pantone': 'CMYK + Pantone',
};
export const PROCESS_LABEL = {
  'Offset': 'Offset', 'Metallic': 'Metallic', 'Offset + Metallic': 'Offset + Metallic',
};
export const COLOUR_HINT = {
  'CMYK': 'four-colour process only — no spot ink',
  'Pantone': 'spot colours only — no process build',
  'CMYK + Pantone': 'process build plus one or more spot colours',
};
export const PROCESS_HINT = {
  'Offset': 'conventional offset — no metallic ink or metallic process',
  'Metallic': 'metallic ink or metallic process only',
  'Offset + Metallic': 'offset plus a metallic ink or metallic process',
};
// Distinct but professional — and never colour ALONE. Every badge carries its
// text label, because the press operator reading a printed run sheet has no hue
// at all. Composition runs cool (sky → violet), process runs warm (slate →
// amber), so the two axes can never be mistaken for one scale.
// Full class strings written out literally so Tailwind's JIT cannot purge them.
//
// The two SPOT states share the violet family and are separated by DEPTH, the
// same way BOARD_TONE separates its two red states. That is not decoration: the
// question this badge answers on the floor is "does the press need spot ink
// pulled from the store?", and the answer is no (sky) / yes (violet) / yes and
// process too (violet, heavier). One family, one question.
//
// `CMYK + Pantone` WAS indigo, and that was a real bug rather than a taste
// call: tailwind.config.js aliases `indigo` to systemBlue, so the badge painted
// #0A84FF — the exact hue this ERP reserves for "lit control" (RESERVED_HUES in
// lib/customerColour.js). Worse, at the tint a badge actually renders, indigo-50
// sat ΔE 1.3 from sky-50 — BELOW the ~2.3 an eye can catch — so CMYK and
// CMYK + Pantone were the same colour on screen. The depth pair below measures
// ΔE 14.6 apart at the background, 21.7 at the border, and 48.0 from the lit
// blue. Do not "restore" indigo here; a name check cannot see the alias.
// ── The ink axis wears a DOT, not a tint ───────────────────────────────────
// The tinted pills above collided head-on with the set-type vocabulary, and not
// approximately — three pairs were BYTE-IDENTICAL class strings, so on a card
// face a Gang chip and a Pantone badge were the same pixels:
//
//     ink 'Pantone'  ==  set-type 'gang'        border-violet-200 bg-violet-50 …
//     ink 'CMYK'     ==  set-type 'new_output'  border-sky-200    bg-sky-50    …
//     ink 'Offset'   ==  set-type 'single'      border-slate-200  bg-slate-50  …
//
// No hue swap fixes it. A badge renders its -50/-100, and every pale tint is
// near-white: measured against violet-50, fuchsia-50 is ΔE 1.5 away and
// purple-50 is 2.2 — BELOW the ~2.3 an eye can catch. Every hue that would
// separate is already spoken for (blue/emerald/violet/teal/amber/red are
// RESERVED_HUES, cyan is "partly printed", orange is Offset + Metallic, and
// pink/rose/lime/green/yellow/stone/slate are customer dots). Violet itself has
// only two usable pale steps and gang owns the first, so three ink states do
// not fit inside it either.
//
// So the axes are separated by FORM instead, and the set-type axis keeps the
// hues it owns by contract (RESERVED_HUES names violet for gang, and
// customer-colour.test.js measures every customer dot against it). The ink axis
// takes a NEUTRAL shell with a saturated dot — the same answer customerColour.js
// already reached for the same problem: "a chip tinted in a company's colour
// would be read as a status. A dot is small enough to identify without
// asserting anything." A filled violet pill and a neutral pill wearing a violet
// dot cannot be confused however pale the fill is.
//
// It also puts this axis back under the rule the filter rails now follow: hue
// marks what the plant must ACT on (board short, on hold, ganged). Ink is
// classification — it warns nobody — so it classifies with a dot and lights
// graphite, exactly like the customer chips beside it.
export const INK_SHELL = 'border-slate-200 bg-white text-slate-700';
// The two "both" states carry a dot that is literally half of each — the only
// honest way to draw "CMYK *and* Pantone", and it needs no new hue to do it.
export const COLOUR_DOT = {
  'CMYK': 'bg-sky-500',
  'Pantone': 'bg-violet-500',
  'CMYK + Pantone': 'bg-gradient-to-r from-sky-500 to-violet-500',
};
export const PROCESS_DOT = {
  'Offset': 'bg-slate-400',
  'Metallic': 'bg-amber-500',
  'Offset + Metallic': 'bg-gradient-to-r from-slate-400 to-amber-500',
};
// COLOUR_ICON / PROCESS_ICON retired with the tinted pills: the dot identifies
// on screen and the label identifies on paper, so a third glyph earned nothing.
// Sort order: richest build first, most special process first — "metallic jobs
// first" and "Pantone jobs first" are the two orders a press planner asks for.
export const COLOUR_RANK = { 'CMYK + Pantone': 0, 'Pantone': 1, 'CMYK': 2 };
export const PROCESS_RANK = { 'Offset + Metallic': 0, 'Metallic': 1, 'Offset': 2 };

// ---- Badges ----------------------------------------------------------------
// One component per axis with mode flags, never variants:
//   band    — the card face: full width, centred, read without leaning in
//   compact — drops the count, for rails too tight for the whole phrase
// Both always render their text. An unknown/absent value stays silent (returns
// null) so a stale payload paints nothing rather than something wrong.

// The dot replaces the icon rather than joining it: two leading glyphs in a
// 20px pill is clutter, and the icon was never the thing doing the work —
// PROCESS_ICON gave Metallic and Offset + Metallic the SAME Sparkles, so only
// the words told them apart. The dot distinguishes all three, and the text
// label is still what carries the badge into greyscale and onto paper, which is
// the reason this module has always refused to encode anything in colour alone.
function InkDot({ tone, band }) {
  return <span aria-hidden className={`${band ? 'h-2.5 w-2.5' : 'h-2 w-2'} shrink-0 rounded-full ${tone}`} />;
}

export function ColourBadge({ row, band, compact, className = '' }) {
  const type = colourTypeOf(row);
  if (!type) return null;
  const total = totalColoursOf(row);
  const text = compact || total == null ? COLOUR_LABEL[type] : `${COLOUR_LABEL[type]} · ${total}`;
  const title = `${colourSummary(row)}${row?.pantone_codes ? `\nPantone: ${row.pantone_codes}` : ''}\n${COLOUR_HINT[type]}`;
  return band ? (
    <div title={title}
      className={`mt-1 flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-extrabold uppercase tracking-[0.02em] ${INK_SHELL} ${className}`}>
      <InkDot tone={COLOUR_DOT[type]} band /> {text}
    </div>
  ) : (
    <span title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${INK_SHELL} ${className}`}>
      <InkDot tone={COLOUR_DOT[type]} /> {text}
    </span>
  );
}

export function ProcessBadge({ row, band, compact, className = '' }) {
  const p = processOf(row);
  if (!p) return null;
  // Offset is the plant default and says nothing worth a chip in a tight rail,
  // so the common case stays quiet and only metallic work shouts.
  if (compact && p === 'Offset') return null;
  const name = metallicNameOf(row);
  const text = !compact && name && p !== 'Offset' ? `${PROCESS_LABEL[p]} · ${name}` : PROCESS_LABEL[p];
  const title = `${PROCESS_HINT[p]}${row?.metallic_details ? `\n${row.metallic_details}` : ''}`;
  return band ? (
    <div title={title}
      className={`mt-1 flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-extrabold uppercase tracking-[0.02em] ${INK_SHELL} ${className}`}>
      <InkDot tone={PROCESS_DOT[p]} band /> {text}
    </div>
  ) : (
    <span title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${INK_SHELL} ${className}`}>
      <InkDot tone={PROCESS_DOT[p]} /> {text}
    </span>
  );
}

// Both axes side by side — the default way a queue row wears its ink.
export function PrintColourChips({ row, compact, className = '' }) {
  if (!colourTypeOf(row) && !processOf(row)) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      <ColourBadge row={row} compact={compact} />
      <ProcessBadge row={row} compact={compact} />
    </span>
  );
}

// The Pantone / metallic detail a queue row shows under its badges. Truncated
// with the whole value on hover — a Pantone list runs long.
export function ColourCodeLines({ row, className = '' }) {
  if (!row?.pantone_codes && !row?.metallic_details) return null;
  return (
    <span className={`block min-w-0 ${className}`}>
      {row.pantone_codes && (
        <span className="block truncate text-[11px] text-violet-600" title={row.pantone_codes}>{row.pantone_codes}</span>
      )}
      {row.metallic_details && (
        <span className="block truncate text-[11px] text-amber-700" title={row.metallic_details}>{row.metallic_details}</span>
      )}
    </span>
  );
}

// The long detail as [label, value] pairs, for a form panel, the Job Card form
// and the printed traveler. ONE source for all three, so the paper in the
// operator's hand and the screen behind them cannot disagree.
export function colourDetailLines(row) {
  const out = [];
  if (!row) return out;
  const type = colourTypeOf(row);
  if (type) out.push(['Colour Type', type]);
  const total = totalColoursOf(row);
  if (total != null) out.push(['Total Colours', String(total)]);
  const c = cmykCountOf(row); if (c) out.push(['CMYK Colours', String(c)]);
  const pc = pantoneCountOf(row); if (pc) out.push(['Pantone Colours', String(pc)]);
  if (row.pantone_codes) out.push(['Pantone Codes', row.pantone_codes]);
  const p = processOf(row);
  if (p) out.push(['Printing Process', p]);
  const m = metallicCountOf(row); if (m) out.push(['Metallic Colours', String(m)]);
  if (row.metallic_details) out.push(['Metallic Colour / Code', row.metallic_details]);
  if (row.print_instructions) out.push(['Printing Instructions', row.print_instructions]);
  return out;
}

// ---- Filter rail -----------------------------------------------------------
// Shared by Print Planning and the printing station queue so the two cannot
// drift into lookalike rails that filter differently. Chip shape is copied from
// BoardStatusChips deliberately: a planner already knows how these behave.
//
// MULTI-SELECT: picking Pantone AND CMYK + Pantone shows every job with any
// spot colour and hides CMYK-only work. Selection lives in the PAGE, so it
// survives switching between the card board and the table view.

// The chip shape itself now lives in FilterChip.jsx — shared with the board
// chips, the set-type zones and Customer WIP, which is what stopped Print
// Planning from alternating two pill styles across one line. This rail keeps
// only what is ITS OWN: which axes exist, and which tone each value wears.
export function PrintColourFilterRail({
  colour, setColour, process, setProcess, band, setBand,
  counts = {}, scope = 'across the board', showBands = true,
}) {
  const cc = counts.colour || {}, pc = counts.process || {}, bc = counts.band || {};
  // Still ONE element, not three loose groups: this rail is dropped into three
  // different toolbars (the board header, an expanded lane's toolbar, and the
  // printing station queue) and its three axes have to wrap together as a block
  // wherever it lands, rather than scattering among that toolbar's own buttons.
  return (
    <FilterRail className="shrink-0">
      {/* "Ink", not "Colour" — this group and the count group below it read
          "Colour" and "Colours" on the same rail, one letter apart, and the
          planner had to count characters to tell which axis they were on. */}
      <FilterGroup label="Ink">
        {COLOUR_TYPES.map(t => (
          // No `tone`, so these light GRAPHITE with the hue in the dot — the
          // same shape the customer chips take, and for the same reason: ink is
          // classification, and a tinted pill on this rail would be read as a
          // status the way Gang and Hold are.
          <FilterChip key={t} label={COLOUR_LABEL[t]} count={cc[t] || 0} on={colour.has(t)}
            dot={COLOUR_DOT[t]}
            title={`${cc[t] || 0} ${scope} — ${COLOUR_HINT[t]}`}
            onClick={() => setColour(toggleInSet(colour, t))} />
        ))}
      </FilterGroup>
      <FilterGroup label="Process">
        {PRINT_PROCESSES.map(t => (
          <FilterChip key={t} label={PROCESS_LABEL[t]} count={pc[t] || 0} on={process.has(t)}
            dot={PROCESS_DOT[t]}
            title={`${pc[t] || 0} ${scope} — ${PROCESS_HINT[t]}`}
            onClick={() => setProcess(toggleInSet(process, t))} />
        ))}
      </FilterGroup>
      {showBands && setBand && (
        // No tone, so these light GRAPHITE. They used to fall through to the
        // default lit blue, which put six chips in the exact hue this ERP
        // reserves for "lit control" — and, because tailwind.config.js aliases
        // indigo to systemBlue, in the exact hue of CMYK + Pantone three chips
        // to their left. A colour COUNT is a quantity, not a status; it has
        // nothing to warn about and so spends no hue.
        <FilterGroup label="Colours">
          {COLOUR_BANDS.map(b => (
            <FilterChip key={b.key} label={b.label} count={bc[b.key] || 0} on={band.has(b.key)}
              title={`${bc[b.key] || 0} ${scope} with ${b.label} printing colours`}
              onClick={() => setBand(toggleInSet(band, b.key))} />
          ))}
        </FilterGroup>
      )}
    </FilterRail>
  );
}

// The lit filters, said back to the reader above the queue, with one way out.
export function ActiveColourFilters({ colour, process, band, onClear, className = '' }) {
  if (!colour.size && !process.size && !band.size) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-[11px] ${className}`}>
      <span className="font-bold uppercase tracking-wide text-slate-400">Filtered to</span>
      {[...colour].map(t => (
        <span key={`c-${t}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-bold ${INK_SHELL}`}>
          <InkDot tone={COLOUR_DOT[t]} /> {COLOUR_LABEL[t]}
        </span>
      ))}
      {[...process].map(t => (
        <span key={`p-${t}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-bold ${INK_SHELL}`}>
          <InkDot tone={PROCESS_DOT[t]} /> {PROCESS_LABEL[t]}
        </span>
      ))}
      {[...band].map(t => (
        <span key={`b-${t}`} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-bold text-slate-600">{t} colours</span>
      ))}
      {onClear && (
        <button type="button" onClick={onClear}
          className="rounded-full border border-slate-300 px-2 py-0.5 font-bold text-slate-500 transition-colors hover:bg-white hover:text-slate-700">
          Clear all
        </button>
      )}
    </div>
  );
}
