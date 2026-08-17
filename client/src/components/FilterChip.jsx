// Filter chips — ONE shape, one lit contract, for every filter rail in the ERP.
//
// This is the BoardStatus.jsx / PrintColour.jsx contract applied to the CHIP
// ITSELF. Those modules already own what a fact MEANS and what hue it wears;
// nothing owned how the control around it is built, so each rail grew its own.
// Print Planning ended up alternating two shapes on a single line — glassy
// bordered pills for Board and Customer WIP, flat grey pills for the set-type
// zones between them — which is most of why that rail reads as clutter rather
// than as a row of controls. A page that writes its own chip class string is
// the bug this module prevents.
//
// THREE RULES, and they are the whole design:
//
//   1. STRUCTURE carries identity. Which axis a chip belongs to is said by its
//      GROUP CAPTION and its position, never by its colour. That is what lets
//      Board's "All" and Set Type's "All" sit on one rail without ambiguity —
//      before captions they were two identical pills reading 30 and 30.
//
//   2. COLOUR carries severity. A hue is spent only where the plant has to DO
//      something about it: emerald covered, red short, amber hold, violet gang,
//      teal combined. Everything else — Single, a colour-count band, a customer
//      — is classification, and lights GRAPHITE. Ten competing hues on one rail
//      is a paint chart; four meaningful ones plus graphite is a legend.
//
//   3. NOTHING MOVES when a chip lights. Every chip carries a border at all
//      times (transparent when unlit) and a fixed height, so toggling one never
//      reflows the rail by a pixel. The old rails swapped border-on for
//      border-off and jittered the whole line.
//
// Behaviour lives entirely in the caller: this file renders a button and calls
// onClick. It never decides what is filtered, never hides a chip, and never
// changes a count.

// Local, the same way ui.jsx keeps its own — a leaf component this widely
// imported should not drag api.js in behind it for one toLocaleString.
const fmtNum = n => (n ?? 0).toLocaleString('en-IN');

// The neutral lit state — a chip that is ON but has nothing to warn about.
// Graphite rather than the system blue on purpose: blue is spoken for. It means
// "lit control" across this ERP (see RESERVED_HUES in lib/customerColour.js),
// and the day a classification chip borrows it, Customer WIP and Reset filters
// stop being the two things on the rail that blue points at.
const LIT_NEUTRAL = 'border-transparent bg-[#1D1D1F]/[0.88] text-white';
// An unlit chip must still LOOK LIKE A CONTROL. The first version of this file
// set `border-transparent` on it and leaned on a 5% wash to draw the pill, which
// measured fine in isolation and failed in place: several of these rails sit on
// pure #ffffff, where a 5% wash is a 1.10 contrast ratio and a transparent
// border is 1.00. The chip had NO perceptible edge — the rail read as a row of
// grey words rather than buttons, and Anik reported the Artwork chips as simply
// missing. Definition now comes from a real hairline plus a 1px lift, which
// survives a white background instead of depending on a tinted one.
// The 0.22 hairline measures 1.58 against white — just past slate-300 (1.48),
// the border weight most UIs trust on white, and well short of slate-400 (2.56),
// which on a rail of twenty chips reads as a cage. Paired with a 1px lift so the
// pill has a top edge as well as an outline.
const UNLIT = 'border-[#1D1D1F]/[0.22] bg-white text-[#4B4B4F] shadow-[0_1px_2px_rgba(29,29,31,0.07)] '
  + 'hover:border-[#1D1D1F]/40 hover:bg-[#1D1D1F]/[0.04] hover:text-[#1D1D1F]';
// A chip for something this board does not currently have. It stays a control —
// same size, same place, same click — but stops competing for the eye with the
// chips that have work behind them. On a typical Print Planning rail eight of
// twenty chips read zero, and at full strength they are half the visual weight
// of the line. Deliberately NOT hidden: a chip that vanishes at zero makes the
// rail change width as the board works through the day, and "Stock Short 0" is
// itself worth reading — it is the good news.
//
// It recedes by DROPPING THE LIFT and lightening the hairline, not by fading the
// text to nothing. `text-[#1D1D1F]/25` composited to #C2C2C3 on white — a 1.69
// contrast ratio, far under the 4.5 WCAG AA floor and under even the 3.0 large-
// text floor. "Stock Short 0" is the good news and has to be READABLE to deliver
// it. This keeps the text above 4.5 and lets the flat, borderless-looking shell
// carry the "nothing here" signal.
const UNLIT_EMPTY = 'border-[#1D1D1F]/[0.14] bg-white/50 text-[#6E6E73] '
  + 'hover:border-[#1D1D1F]/30 hover:bg-white hover:text-[#1D1D1F]';

// Fixed height, not padding — a rail mixing icon chips with text-only chips
// otherwise sits on two different baselines. touch: bumps it to a 40px target
// on the floor tablets without changing the desktop line.
const BASE = 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 '
  + 'text-[11px] font-bold transition-colors duration-150 active:scale-[0.97] touch:h-10 touch:px-3';

export function FilterChip({
  label, count, icon: Icon, dot, on, tone, countTone, onClick, title, className = '',
}) {
  // A tone is only spent when the chip is LIT. An unlit rail is one flat grey
  // texture the eye skims; the colour appears as the answer to a click.
  const empty = count === 0 && !on;
  const shell = on ? (tone || LIT_NEUTRAL) : empty ? UNLIT_EMPTY : UNLIT;
  // Tinted tones (emerald-50, sky-50 …) need an OPAQUE count pill — white/25
  // over a pale wash is invisible. Graphite and solid fills take the knockout.
  // BOARD_COUNT_TONE and friends override both when a state needs something
  // else again (`short` is a solid red fill and knocks its count out in white).
  // Unlit pills sit on a WHITE shell now, so they need real weight of their own —
  // the old 4%/7% washes were drawn against a grey chip and disappear on white.
  const pill = on ? (countTone || (tone ? 'bg-white/70' : 'bg-white/25')) : empty ? 'bg-[#1D1D1F]/[0.06]' : 'bg-[#1D1D1F]/[0.09]';
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={!!on}
      className={`${BASE} ${shell} ${className}`}>
      {dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
      {Icon && <Icon size={11} className="shrink-0" />}
      {label}
      {count != null && (
        <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${pill}`}>{fmtNum(count)}</span>
      )}
    </button>
  );
}

// One axis of a rail: a caption, then its chips, behind a hairline that says
// where the previous axis ended.
//
// The caption is the load-bearing part. Nine axes narrow the Print Planning
// board and six of them used to be unlabelled, so the rail read as one run of
// twenty chips instead of six short questions — and two of those chips both
// said "All". Pass `divider={false}` on the first group of a rail only.
export function FilterGroup({ label, divider = true, children, className = '' }) {
  return (
    <>
      {divider && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 self-center bg-[#1D1D1F]/[0.10]" />}
      <div className={`flex shrink-0 flex-wrap items-center gap-1 ${className}`}>
        {label && (
          <span className="mr-0.5 shrink-0 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/35">
            {label}
          </span>
        )}
        {children}
      </div>
    </>
  );
}

// The rail itself — the one place the gaps between groups are decided. Groups
// breathe (gap-x-2.5) while chips inside a group sit tight (gap-1), which is
// what makes six axes read as six clusters rather than one long line.
export function FilterRail({ children, className = '' }) {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 ${className}`}>
      {children}
    </div>
  );
}
