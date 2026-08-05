// Chip pickers for the shop floor.
//
// A dropdown hides its options until you tap it, costs two taps to change, and
// on a bench screen it opens a list you then have to aim at. Every choice at
// Sort & Paste is between three or four known things, so they belong on the
// surface: one tap, everything visible, nothing to discover.
//
// ONE accent per group, never per chip. Three chip rows sit above each other in
// the row editor — method, machine, operator — and if each chip picked its own
// colour the block would read as confetti. A single hue per row says "these are
// the same kind of decision", and the rows differ from each other so the eye
// can tell which question it is answering without reading the label.
const ACCENTS = {
  brand: { on: 'border-[#0A84FF] bg-[#0A84FF] text-white shadow-sm shadow-[#0A84FF]/25' },
  sky: { on: 'border-sky-500 bg-sky-500 text-white shadow-sm shadow-sky-500/25' },
  violet: { on: 'border-violet-500 bg-violet-500 text-white shadow-sm shadow-violet-500/25' },
  // Sorting is fuchsia everywhere else on this screen — the sorted-waste figure
  // and the SORTING phase label both wear it — so the sorters do too.
  fuchsia: { on: 'border-fuchsia-500 bg-fuchsia-500 text-white shadow-sm shadow-fuchsia-500/25' },
};
const OFF = 'border-[#1D1D1F]/[0.10] bg-white/75 text-slate-600 hover:border-slate-300 hover:bg-white';

// `multiple` turns the group into a set: chips toggle instead of replacing each
// other, and `value` is an array. Some jobs really are worked by three men at
// once, and recording only the first credits one of them with all of it.
export function ChipGroup({ label, hint, value, onChange, options, accent = 'brand', emptyLabel, multiple = false }) {
  const a = ACCENTS[accent] || ACCENTS.brand;
  const picked = multiple ? (Array.isArray(value) ? value : []) : [];
  const isOn = v => (multiple ? picked.some(x => String(x) === String(v)) : String(value) === String(v));
  const choose = v => {
    if (!multiple) return onChange(v);
    onChange(isOn(v) ? picked.filter(x => String(x) !== String(v)) : [...picked, v]);
  };
  const noneOn = multiple ? picked.length === 0 : !value;
  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
          {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
          {multiple && picked.length > 1 && (
            <span className="text-[11px] font-semibold text-slate-400">{picked.length} selected</span>
          )}
        </div>
      )}
      {/* gap-2 both ways: the row wraps on a narrow bench screen, and chips that
          wrap without vertical gap read as one run-on block. */}
      <div className="flex flex-wrap gap-2">
        {emptyLabel && (
          <Chip on={noneOn} accent={a} onClick={() => onChange(multiple ? [] : '')}>{emptyLabel}</Chip>
        )}
        {options.map(o => (
          <Chip key={o.value} on={isOn(o.value)} accent={a} onClick={() => choose(o.value)}
            title={o.title || o.sub}>
            {o.label}
            {o.sub && <span className={`ml-1.5 text-[10px] font-semibold ${isOn(o.value) ? 'text-white/70' : 'text-slate-400'}`}>{o.sub}</span>}
          </Chip>
        ))}
      </div>
    </div>
  );
}

// min-h-[38px] rather than padding alone: a gloved thumb on the bench tablet
// needs the target height whatever the label length. active:scale is the whole
// of the "smooth" — it confirms the tap on a screen where nothing else moves.
function Chip({ on, accent, onClick, title, children }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={on}
      className={`inline-flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-semibold
        backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97]
        ${on ? accent.on : OFF}`}>
      {children}
    </button>
  );
}
