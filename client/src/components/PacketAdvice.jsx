// PACKET ADVICE — the picking hint beside a cut plan, a Board Mix row, or a
// run's board.
//
// Board is bought, stored and handed over in PACKETS (100 sheets on most
// boards, 144 on some, 150 on one) but a plan asks for a raw sheet count, so
// the storeman bridges the gap in his head: a job needing 910 sheets gets 10
// sealed packets opened while 60 loose sheets sit on the shelf from the last
// job. This panel turns the requirement into the picking choices the planner
// may make, with every figure each one implies.
//
// A HINT, NOT A DECISION. Nothing here changes what the job is issued or
// consumes — the requirement stays 910 and the cutting gate is untouched. The
// spare stays on the shelf, which is exactly where the next job's loose figure
// comes from.
//
// Every number is computed by packetPlan (client twin of server/src/
// packet-plan.js, tested against the owner's own two examples); this file does
// no arithmetic of its own beyond formatting, so the panel can never quote a
// figure the server would compute differently.
import { fmt } from '../api.js';
import { packetPlan } from '../lib/packetPlan.js';

// One label per option key, in ONE place, so the compact chips and the full
// cards can never name the same choice differently. `why` is the tooltip: the
// rule the option follows, in the plant's own terms.
const OPTION_META = {
  clear_loose: {
    title: 'Clear the loose', short: 'Clear loose',
    why: 'Empty the opened packets first, then whole packets for the rest. Opened packets age — this is the only option that always clears them.',
  },
  least_excess: {
    title: 'Least excess', short: 'Least excess',
    why: 'The fewest spare sheets left over. Where zero excess is reachable this also breaks the fewest sealed packets.',
  },
  packets_only: {
    title: 'Sealed packets only', short: 'Packets only',
    why: 'Break sealed packets only, no loose sheets touched — what the plant does today.',
  },
  exact: {
    title: 'Exactly the requirement', short: 'Exact',
    why: 'Hand over exactly what the job needs; the storeman counts the balance out of a packet. No whole-packet arithmetic.',
  },
};

// The system stores board as a SHEET COUNT ONLY — packets are a display
// conversion, and nothing tracks intact vs loose. So loose is inferred, per
// batch then summed (each pile's own remainder IS its opened packet). Said out
// loud everywhere the figure appears, so nobody reads it as counted.
const DERIVED_TITLE = 'Loose is not tracked — it is inferred from each available batch, per batch then summed: a batch of 960 on a 100-sheet packet reads as 9 intact and 60 loose. Counting on the shelf may differ.';

// A packet figure, or the one option that deliberately has none: `exact` opens
// no whole packets at all, so a "0 packets" there would read as "no board", not
// as "counted out of one".
const packetsText = p => (p == null ? 'counted out' : fmt.num(p));

export default function PacketAdvice({
  required, board, lots = [], chosen = null, onChoose, compact = false,
}) {
  // A packet size the board master does not carry is never assumed. packetPlan
  // returns null rather than a zero-filled answer for exactly this reason, and
  // guessing 100 here would quietly mis-advise every 144 and 150 board.
  const packetSize = Number(board?.sheets_per_packet) || 0;
  const plan = packetPlan({ required, packetSize, lots });

  // Read-only unless a caller actually gave somewhere for a click to go —
  // the same "wired, or render no control at all" rule BoardMix's leftover
  // chip follows. A display-only placement must not LOOK interactive, and it
  // must not show a selection it has no way to change.
  const interactive = typeof onChoose === 'function';
  const selectedKey = interactive ? chosen : null;

  if (!plan) {
    // packetPlan returns null for two different reasons and they must not be
    // reported as one. Nothing to plan for yet (an empty or zeroed sheets
    // figure) is not a master-data problem — say nothing.
    if (!(Number(required) > 0)) return null;
    // No board chosen on this row yet: also not a master-data problem.
    // Likewise a board whose master row could not be resolved at all — the
    // caller cannot vouch for its packet size either way, and claiming the
    // master has none would be a statement we have not checked.
    if (!board?.name) return null;
    return (
      <p className={`${compact ? 'mt-1.5' : 'mt-2.5'} rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500`}>
        No packet size on this board master — add it in Masters to see the packet picking advice.
      </p>
    );
  }

  const byKey = Object.fromEntries(plan.options.map(o => [o.key, o]));

  // Every packet option is derived from its loose_used alone (packetPlan builds
  // remaining, packets, total_issue and excess from it), so two of them sharing
  // a loose_used are the SAME physical pick under two names — and showing that
  // pick twice, with identical figures, hides the fact that there is no trade
  // to make. It is not a corner case: with NO loose on the shelf all three
  // packet options collapse onto "open whole packets" (the owner's Example 1),
  // and when the requirement is already a whole number of packets, least-excess
  // and packets-only coincide because using loose there only ADDS spare.
  //
  // So they are grouped, in packetPlan's own order, and each group names every
  // option it stands for — nothing is dropped, it is stated as one choice.
  // `exact` is never grouped: it opens no whole packets at all (its `packets` is
  // null by design), so it is a different act even where the totals agree.
  const groups = [];
  for (const key of ['clear_loose', 'least_excess', 'packets_only']) {
    const o = byKey[key];
    if (!o) continue;
    const hit = groups.find(g => g.opt.loose_used === o.loose_used);
    if (hit) hit.keys.push(key); else groups.push({ opt: o, keys: [key] });
  }
  // A group is "leading" if it stands for either option the owner asked to see
  // side by side. packets_only only earns a card when it is one of them.
  const leading = groups.filter(g => g.keys.includes('clear_loose') || g.keys.includes('least_excess'));
  const quiet = [
    ...groups.filter(g => !leading.includes(g)),
    ...(byKey.exact ? [{ opt: byKey.exact, keys: ['exact'] }] : []),
  ];
  // What a group is called, and what it coincides with. The FIRST key titles it,
  // so the recommendation keeps the prominent name it is picked by.
  const titleOf = g => OPTION_META[g.keys[0]].title;
  const alsoOf = g => {
    const rest = g.keys.slice(1).map(k => OPTION_META[k].title.toLowerCase());
    if (!rest.length) return null;
    return `Same pick as ${rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(', ')} and ${rest[rest.length - 1]}`}`;
  };
  // Selection and the suggested badge follow the GROUP, so a pick stored under
  // one of its names still shows as chosen once the group has absorbed it.
  const isSelected = g => g.keys.includes(selectedKey);
  const isRecommended = g => g.keys.includes(plan.recommended);
  // Clicking reports the group's OWN key, which is a faithful description: every
  // key in a group produces byte-identical figures.
  const pickOf = g => (interactive ? () => onChoose(g.keys[0]) : null);

  if (compact) {
    return (
      <div className="mt-1.5 rounded-lg bg-slate-50 px-2.5 py-2">
        {/* One line for the whole figure line-up: everything that does not
            depend on which option is picked. The per-option totals live on
            the chips below it. */}
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[10px] text-slate-500">
          <span><b className="font-bold tabular-nums text-slate-700">{fmt.num(plan.required)}</b> needed</span>
          <span className="text-slate-300">·</span>
          <span><b className="font-bold tabular-nums text-slate-700">{fmt.num(plan.packetSize)}</b> per packet</span>
          <span className="text-slate-300">·</span>
          <span title={DERIVED_TITLE} className="cursor-help">
            <b className="font-bold tabular-nums text-slate-700">{fmt.num(plan.loose_available)}</b> loose
            <span className="ml-0.5 text-slate-400">(derived)</span>
          </span>
          <span className="text-slate-300">·</span>
          <span><b className="font-bold tabular-nums text-slate-700">{fmt.num(plan.intact_available)}</b> intact packets on the shelf</span>
        </div>
        {/* The leading options only. A mix row is already a dense place, and
            the quiet options are one screen away on the single-line panel —
            which also means these chips are the only writers here, so no other
            key can be selected and left invisible. */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {leading.map(g => (
            <OptionChip key={g.keys[0]} opt={g.opt} title={titleOf(g)} also={alsoOf(g)}
              recommended={isRecommended(g)} selected={isSelected(g)} onPick={pickOf(g)} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">Picking in packets</span>
        <span className="shrink-0 text-[11px] text-slate-500">
          {fmt.num(plan.packetSize)} sheets per packet
        </span>
      </div>

      {/* THE FIGURE LINE-UP — only what does not change with the choice. The
          figures that DO (loose used, what is left after it, packets, total
          issue, spare) sit on each option's own card, so the trade between
          the two is read in one place instead of being re-explained. */}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        <Fig label="Required" value={fmt.num(plan.required)} strong />
        <Fig label="Per packet" value={fmt.num(plan.packetSize)} />
        <Fig label="Loose available" value={fmt.num(plan.loose_available)}
          note="derived" title={DERIVED_TITLE} />
        <Fig label="Intact packets" value={fmt.num(plan.intact_available)} />
      </div>

      {/* Both leading options, side by side with their own totals — the
          planner picks per job rather than being handed one answer. One card
          when they are the same pick (see the grouping above). */}
      <div className={`mt-2.5 grid gap-2 ${leading.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {leading.map(g => (
          <OptionCard key={g.keys[0]} opt={g.opt} title={titleOf(g)} also={alsoOf(g)}
            recommended={isRecommended(g)} selected={isSelected(g)} onPick={pickOf(g)} />
        ))}
      </div>

      {/* The remaining choices the owner listed. Quiet text, not cards: they
          are real options, but neither clears the shelf nor minimises the
          spare, so they should not compete for the eye. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 pt-2">
        {quiet.map(g => {
          const o = g.opt;
          const also = alsoOf(g);
          const label = `${titleOf(g)} — ${o.packets == null
            ? `${fmt.num(o.total_issue)} counted out`
            : `${fmt.num(o.packets)} packet${o.packets === 1 ? '' : 's'}, ${fmt.num(o.total_issue)} issued`}, ${fmt.num(o.excess)} spare`;
          const hint = also ? `${OPTION_META[g.keys[0]].why}\n\n${also}.` : OPTION_META[g.keys[0]].why;
          return interactive ? (
            <button key={g.keys[0]} type="button" onClick={pickOf(g)} title={hint}
              className={`text-left text-[11px] font-semibold underline-offset-2 hover:underline ${
                isSelected(g) ? 'text-emerald-700' : 'text-slate-500'}`}>
              {isSelected(g) ? '✓ ' : ''}{label}
            </button>
          ) : (
            <span key={g.keys[0]} title={hint} className="text-[11px] font-medium text-slate-500">{label}</span>
          );
        })}
      </div>

      {/* Why the loose figure must be read as an estimate, and why the
          suggestion never moves the issued figure. Both are the whole reason
          this panel is advice and not a control. */}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400" title={DERIVED_TITLE}>
        Loose is derived per batch, not counted — the warehouse stores a sheet count only.
        {interactive
          ? ` Picking one is a note for the pick; the job still issues its ${fmt.num(plan.required)} required sheets and the spare stays on the shelf.`
          : ` The job still issues its ${fmt.num(plan.required)} required sheets and the spare stays on the shelf.`}
      </p>
    </div>
  );
}

// One figure from the line-up. `note` is for the single figure that is inferred
// rather than recorded — it carries the word on screen, not only in a tooltip.
function Fig({ label, value, strong, note, title }) {
  return (
    <div title={title} className={title ? 'cursor-help' : undefined}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
        {label}{note ? <span className="ml-1 font-semibold normal-case tracking-normal text-slate-400">({note})</span> : null}
      </div>
      <div className={`tabular-nums ${strong ? 'text-sm font-extrabold text-slate-800' : 'text-sm font-bold text-slate-600'}`}>
        {value}
      </div>
    </div>
  );
}

// A leading option, with every figure it implies. Renders as a button only when
// the caller wired onChoose — a display-only panel must not look clickable.
// `also` names the other options this one has absorbed, when their figures are
// identical, so a collapsed choice is stated rather than silently missing.
function OptionCard({ opt, title, also, recommended, selected, onPick }) {
  const Tag = onPick ? 'button' : 'div';
  return (
    <Tag
      {...(onPick ? { type: 'button', onClick: onPick } : {})}
      title={OPTION_META[opt.key].why}
      className={`block w-full rounded-xl border px-2.5 py-2 text-left transition-colors ${
        selected
          ? 'border-emerald-300 bg-emerald-50'
          : `border-[#1D1D1F]/[0.08] bg-white/70${onPick ? ' hover:border-[#1D1D1F]/[0.16] hover:bg-white' : ''}`
      }`}>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className={`text-[11px] font-bold ${selected ? 'text-emerald-800' : 'text-slate-700'}`}>
          {selected ? '✓ ' : ''}{title}
        </span>
        {recommended && (
          <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-brand-600">
            Suggested
          </span>
        )}
      </div>
      {also && <p className="mt-0.5 text-[10px] font-medium text-slate-400">{also}</p>}
      <div className="mt-1 space-y-0.5">
        <Line label="Loose used" value={fmt.num(opt.loose_used)} />
        <Line label="Left after loose" value={fmt.num(opt.remaining)} />
        <Line label="Intact packets" value={packetsText(opt.packets)} />
        <Line label="Total issue" value={fmt.num(opt.total_issue)} strong />
        <Line label="Spare left over" value={fmt.num(opt.excess)} />
      </div>
    </Tag>
  );
}

function Line({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-slate-500">{label}</span>
      <span className={`shrink-0 tabular-nums ${strong
        ? 'text-[11px] font-extrabold text-slate-800' : 'text-[11px] font-semibold text-slate-600'}`}>
        {value}
      </span>
    </div>
  );
}

// The compact form of a leading option — the same totals, on one chip. The
// tooltip carries what the chip has no room for: the option's rule, what is
// left after the loose, and any option this one has absorbed.
function OptionChip({ opt, title, also, recommended, selected, onPick }) {
  // A group's representative option IS its first key's (see the grouping
  // above), so the option's own meta always names the group correctly.
  const short = OPTION_META[opt.key].short;
  const sum = `${fmt.num(opt.loose_used)} loose + ${packetsText(opt.packets)}${
    opt.packets == null ? '' : ` packet${opt.packets === 1 ? '' : 's'}`} = ${fmt.num(opt.total_issue)}, ${fmt.num(opt.excess)} spare`;
  const Tag = onPick ? 'button' : 'div';
  return (
    <Tag
      {...(onPick ? { type: 'button', onClick: onPick } : {})}
      title={`${title}. ${OPTION_META[opt.key].why}\n\nLeaves ${fmt.num(opt.remaining)} after the loose.${also ? `\n\n${also}.` : ''}`}
      className={`rounded-full px-2 py-1 text-left text-[9px] font-bold uppercase tracking-wide transition-colors ${
        selected
          ? 'bg-emerald-50 text-emerald-700'
          : `bg-white text-slate-500${onPick ? ' hover:bg-slate-200' : ''}`
      }`}>
      {selected ? '✓ ' : ''}{short}{recommended ? ' ★' : ''} — {sum}
    </Tag>
  );
}
