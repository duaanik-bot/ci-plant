// Who is at the machine — the station's operator rail, shared by every floor
// screen that has one (Section.jsx and SortPaste.jsx), so the two can never
// drift into looking or behaving differently.
//
// Men share ONE device and ONE login on the floor. This rail is how one of them
// says which he is: the queue narrows to his work, and his name goes onto
// everything he records. WHAT "his work" means is the station's business, not
// this component's — see client/src/lib/operatorScope.js.
//
// Hues follow the Print Planning lane order (blue / emerald / violet / teal), so
// a press chip is the colour of that press's column on the board and on the
// Line-up sheet that goes out on WhatsApp. Full class strings live here
// literally so Tailwind's JIT never purges them.
import { User, Users } from 'lucide-react';

export const OPERATOR_HUES = [
  { on: 'bg-blue-600 text-white shadow-[0_2px_8px_rgba(37,99,235,0.35)]',    badge: 'bg-white/25 text-white', off: 'text-blue-700 hover:bg-blue-50' },
  { on: 'bg-emerald-600 text-white shadow-[0_2px_8px_rgba(5,150,105,0.35)]', badge: 'bg-white/25 text-white', off: 'text-emerald-700 hover:bg-emerald-50' },
  { on: 'bg-violet-600 text-white shadow-[0_2px_8px_rgba(124,58,237,0.35)]', badge: 'bg-white/25 text-white', off: 'text-violet-700 hover:bg-violet-50' },
  { on: 'bg-teal-600 text-white shadow-[0_2px_8px_rgba(13,148,136,0.35)]',   badge: 'bg-white/25 text-white', off: 'text-teal-700 hover:bg-teal-50' },
];

export function OperatorRail({ chips, pick, onPick, mode }) {
  // Nobody to pick. A station whose machines carry no assigned crew shows no
  // rail at all rather than an empty shell.
  if (!chips.length) return null;
  const pool = mode === 'pool';
  const allLabel = pool ? 'All operators' : 'All presses';
  return (
    <div className="mb-4 flex items-center gap-1.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/70 text-slate-400 shadow-sm"
        title={pool ? 'Who is on the machine' : 'Who is at the press'}>
        <Users size={13} />
      </span>
      <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 shadow-[inset_0_1px_2px_rgba(29,29,31,0.05)] backdrop-blur-xl scrollbar-none">
        <button onClick={() => onPick(null)}
          title={pool ? 'Show every job at this station' : 'Show every press'}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold transition-all duration-200 ease-apple
            ${!pick ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
          {allLabel}
        </button>
        {chips.map((c, i) => {
          const hue = OPERATOR_HUES[i % OPERATOR_HUES.length];
          const on = pick?.key === c.key;
          return (
            <button key={c.key} onClick={() => onPick(on ? null : c)}
              title={pool
                ? (on ? `Showing what nobody has taken, plus ${c.name}'s own jobs — tap again for all`
                      : `${c.name}: free jobs plus his own, and his name on what he records`)
                : (on ? `Showing ${c.machineName} — tap again for all presses` : `Show only ${c.machineName}`)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold transition-all duration-200 ease-apple
                ${on ? hue.on : hue.off}`}>
              {c.name}
              {c.short && (
                <span className={`rounded-full px-1.5 text-[11px] font-bold tabular-nums ${on ? hue.badge : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>
                  {c.short}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The name a write is filed under, shown where the write actually happens. On a
// shared device the header rail alone is not enough — the man has to see whose
// name he is signing at the moment he presses the button.
export function RecordingAs({ pick, onChange }) {
  if (!pick) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2">
      <User size={13} className="shrink-0 text-brand-600" />
      <span className="text-xs text-slate-600">
        Recording as <b className="text-slate-900">{pick.name}</b>
        {/* Pooled stations have no machine to name — he picks that on Start. */}
        {pick.machineName && <span className="text-slate-400"> · {pick.machineName}</span>}
      </span>
      {onChange && (
        <button type="button" onClick={onChange}
          className="ml-auto shrink-0 text-xs font-semibold text-brand-700 underline-offset-2 hover:underline">
          Not you?
        </button>
      )}
    </div>
  );
}

