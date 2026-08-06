// How many SEALED PACKETS the storeman actually broke to fill this issue.
//
// This is the one number that turns loose board stock from a guess into a
// count. The ledger holds a sheet count only, so loose has always been DERIVED
// as `qty mod P` — the smallest figure consistent with the pile. The truth is
// `(qty mod P) + k·P`, and k is exactly what nobody has ever recorded. Opening
// ten packets to fill a 910-sheet job puts 90 sheets back on the stack loose;
// say so once, here, and the shelf stops drifting.
//
// BLANK IS THE NORMAL ANSWER, and that is deliberate. Left empty, the server
// moves loose by the packets the picking rule implies — the same arithmetic the
// packet advice already showed the planner — so Start stays ONE TAP and a job
// started without touching this behaves exactly as it did before the column
// existed. Typing a number is a CORRECTION, not a required entry.
//
// It therefore needs no lots and no fetch of its own: it renders off the packet
// size the job card already carries, and a board master with none renders
// nothing at all rather than asking about packets that are not a unit here.
// Same "say nothing rather than assume 100" rule as PacketAdvice.
import { fmt } from '../api.js';

export default function PacketsOpened({ packetSize, sheets, value, onChange, boardName = null }) {
  const P = Number(packetSize) || 0;
  if (!(P > 0) || !(Number(sheets) > 0)) return null;

  return (
    <label className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
      <span className="font-semibold text-slate-600">
        Sealed packets opened{boardName ? ` — ${boardName}` : ''}
      </span>
      <input
        type="number" min="0" step="1" inputMode="numeric"
        // 16px or iOS zooms the whole screen on focus. `text-sm` beats a bare
        // element rule on specificity, so the size is set here — see the
        // device-responsive tier notes.
        className="w-16 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[16px] font-semibold tabular-nums text-slate-700 sm:text-xs"
        value={value ?? ''}
        placeholder="auto"
        onChange={e => {
          const v = e.target.value;
          // Empty string, not 0 — those are different answers. 0 means "I broke
          // nothing, it all came off the loose pile"; empty means "the usual".
          onChange(v === '' ? null : Math.max(0, Math.floor(Number(v) || 0)));
        }}
      />
      <span className="text-slate-400">
        {value == null
          ? `blank = as usual, ${fmt.num(P)} sheets to a packet`
          : `${fmt.num(value * P)} sheets out of ${fmt.num(value)} packet${value === 1 ? '' : 's'}`}
      </span>
    </label>
  );
}
