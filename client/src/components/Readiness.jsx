// Readiness traffic light — the one dot an operator reads from across the hall,
// and the checklist behind it. Everything here is PAINT: server/readiness-light.js
// derives the `light` payload from the gates that already exist, so the floor and
// the ERP can never hold two opinions about what is missing.
//
// Three metres on a plant monitor is the design distance. At that range a pill
// with a word in it is a smudge, so the signal is a saturated dot with a matching
// bloom — the systemRed / systemOrange / systemGreen the theme already speaks.
// Colour never carries a fact alone: the dot has a title, and the checklist names
// every item in words for anyone who cannot separate the hues.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Clock, Hand, Minus } from 'lucide-react';

// Mirrors LIGHT_LABEL in server/src/readiness-light.js. The client cannot import
// a server module, and the words have to be the ones the audit trail uses.
const LIGHT_LABEL = { red: 'Blocked', amber: 'Partly ready', green: 'Ready to run' };

// `lit` is each ramp's 300 shade — a highlight from above-left, the same light
// source the glass material assumes, so the dot reads as a lens rather than a
// flat sticker. The halo is the near edge of the glow and the glow is its bloom.
const TONE = {
  red: { dot: '#FF3B30', lit: '#FF9C96', halo: 'rgba(255,59,48,.20)', glow: 'rgba(255,59,48,.55)', text: 'text-red-600' },
  amber: { dot: '#FF9500', lit: '#FFC470', halo: 'rgba(255,149,0,.20)', glow: 'rgba(255,149,0,.55)', text: 'text-amber-600' },
  green: { dot: '#34C759', lit: '#8CDCA2', halo: 'rgba(52,199,89,.20)', glow: 'rgba(52,199,89,.55)', text: 'text-emerald-600' },
};

const SIZES = {
  sm: { dot: 14, hand: 9, ring: 1.5, halo: 4, glow: 9 },
  md: { dot: 20, hand: 12, ring: 2, halo: 5, glow: 13 },
};

// Four states, four shapes — a tick, a clock, a warning triangle and a dash.
// 'na' is deliberately the quietest row on the panel: it is not a failure, it is
// a check that does not apply to this job, and painting it like a miss would
// send someone looking for a cutting stage the route never had.
const STATE = {
  ok: { icon: Check, chip: 'bg-emerald-100 text-emerald-700', row: 'bg-emerald-50/60', label: 'text-[#1D1D1F]', note: 'text-emerald-700' },
  pending: { icon: Clock, chip: 'bg-amber-100 text-amber-700', row: 'bg-amber-50/60', label: 'text-[#1D1D1F]', note: 'text-amber-700' },
  blocked: { icon: AlertTriangle, chip: 'bg-red-100 text-red-600', row: 'bg-red-50/70', label: 'text-[#1D1D1F]', note: 'text-red-600' },
  na: { icon: Minus, chip: 'bg-[#1D1D1F]/[0.05] text-[#B4B4B9]', row: 'bg-[#1D1D1F]/[0.03]', label: 'text-[#B4B4B9]', note: 'text-[#B4B4B9]' },
};

// What the checklist would say with nobody's hand on it. The dot goes green the
// moment a supervisor overrides, but the panel that exists to show what is
// outstanding must never colour itself as if nothing were.
function truthOf(light) {
  if (light.blockers?.length) return 'red';
  return (light.items || []).some(i => i.state === 'pending') ? 'amber' : 'green';
}

function overrideLine(override) {
  const by = override?.by || 'a supervisor';
  return `Marked ready to run by ${by}${override?.reason ? ` · ${override.reason}` : ''}`;
}

// Hover text: the state, then what is WRONG (the server puts the failing note in
// blockers, not the label), then who put their hand on it. An overridden dot that
// only said "Ready to run" would be the exact lie this whole module avoids.
function lightTitle(light) {
  const base = LIGHT_LABEL[light.light] || '';
  const first = light.blockers?.[0];
  return `${base}${first ? ` — ${first}` : ''}${light.overridden ? ` · ${overrideLine(light.override)}` : ''}`;
}

export function TrafficLight({ light, size = 'md', className = '' }) {
  // A job whose light the server has not attached yet shows nothing — a grey
  // fourth colour would read as a state the plant has to interpret.
  if (!light?.light) return null;
  const tone = TONE[light.light] || TONE.amber;
  const s = SIZES[size] || SIZES.md;
  const { overridden } = light;

  return (
    <span
      role="img"
      title={lightTitle(light)}
      aria-label={lightTitle(light)}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{
        width: s.dot,
        height: s.dot,
        background: `radial-gradient(circle at 32% 26%, ${tone.lit} 0%, ${tone.dot} 62%)`,
        // A white collar, then the halo, then the bloom. Overridden greens wear
        // the collar so "a person said so" is a different object at ten paces
        // from "the system checked" — one glance, no reading.
        boxShadow: `${overridden ? `0 0 0 ${s.ring}px rgba(255,255,255,.96), ` : ''}0 0 0 ${s.halo}px ${tone.halo}, 0 0 ${s.glow}px ${Math.round(s.glow / 3)}px ${tone.glow}`,
      }}
    >
      {overridden && <Hand size={s.hand} strokeWidth={2.75} className="text-white" />}
    </span>
  );
}

export function ReadinessChecklist({ light, className = '' }) {
  if (!light?.items?.length) return null;
  const tracked = light.items.filter(i => i.tracked);
  const done = tracked.filter(i => i.state === 'ok').length;
  const truth = truthOf(light);
  const tone = TONE[truth];

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-[#1D1D1F]/[0.06] pb-2">
        <span className="flex min-w-0 items-center gap-2">
          <TrafficLight light={light} size="sm" />
          <span className="truncate text-[13px] font-bold tracking-[-0.01em] text-[#1D1D1F]">{LIGHT_LABEL[light.light]}</span>
        </span>
        {/* The plant already reads "{done}/{n} confirmed" on every line clearance;
            the count here is the same sentence about a different checklist. */}
        <span className={`shrink-0 text-[11px] font-bold tabular-nums ${tone.text}`}>{done}/{tracked.length} ready</span>
      </div>

      <div className="mb-2.5 flex items-center gap-2">
        <div className="bar-track">
          <div className="h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] transition-all duration-500 ease-apple"
            style={{ width: `${light.pct}%`, background: `linear-gradient(90deg, ${tone.lit}, ${tone.dot})` }} />
        </div>
        <span className={`shrink-0 text-[11px] font-bold tabular-nums ${tone.text}`}>{light.pct}%</span>
      </div>

      {light.overridden && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-white px-2.5 py-2 text-[11px] font-semibold leading-snug text-amber-700">
          <Hand size={12} className="mt-px shrink-0" />
          <span className="min-w-0">{overrideLine(light.override)}</span>
        </div>
      )}

      <div className="space-y-1">
        {light.items.map(item => {
          const st = STATE[item.state] || STATE.na;
          return (
            <div key={item.key} className={`flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-xs ${st.row}`}>
              <span className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${st.chip}`}>
                <st.icon size={10} strokeWidth={3} />
              </span>
              <span className="min-w-0">
                <span className={`font-semibold ${st.label}`}>{item.label}</span>
                {item.note && <span className={`ml-1.5 ${st.note}`}>— {item.note}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PANEL_W = 300;

// Fixed coordinates measured off the trigger, because the dot sits inside a lane
// that scrolls and a table that scrolls sideways — a panel positioned in the flow
// would be clipped by either one.
function placement(rect) {
  const below = window.innerHeight - rect.bottom - 16;
  const above = rect.top - 16;
  const up = below < 260 && above > below;
  return {
    width: PANEL_W,
    left: Math.round(Math.min(Math.max(10, rect.left + rect.width / 2 - PANEL_W / 2), window.innerWidth - PANEL_W - 10)),
    maxHeight: Math.round(Math.max(220, up ? above : below)),
    ...(up ? { bottom: Math.round(window.innerHeight - rect.top + 8) } : { top: Math.round(rect.bottom + 8) }),
  };
}

export function ReadinessPopover({ light, children, className = '' }) {
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!rect) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setRect(null);
    };
    const onKey = e => e.key === 'Escape' && setRect(null);
    // Coordinates are frozen at open, so anything that moves the trigger has to
    // close the panel rather than leave it hanging over the wrong job.
    const onShift = e => { if (!panelRef.current?.contains(e.target)) setRect(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onShift, true);
    window.addEventListener('resize', onShift);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onShift, true);
      window.removeEventListener('resize', onShift);
    };
  }, [rect]);

  if (!light?.items?.length) return children;

  const toggle = e => {
    // The dot lives on a kanban card that opens a press chooser and on a table
    // row that opens the planning modal. Asking what is missing must not also
    // fire the thing underneath. Only the CLICK is swallowed — mousedown has to
    // keep bubbling, or opening this dot would leave the previous board's panel
    // hanging open behind it.
    e.stopPropagation();
    setRect(rect ? null : btnRef.current.getBoundingClientRect());
  };

  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle}
        aria-haspopup="dialog" aria-expanded={!!rect}
        className={`inline-flex items-center rounded-full transition-transform duration-200 ease-apple hover:scale-110 active:scale-95 ${className}`}>
        {children}
      </button>
      {rect && createPortal(
        <div ref={panelRef} style={placement(rect)}
          className="no-print glass fixed z-50 animate-liquidPop overflow-y-auto rounded-[18px] p-3 shadow-modal">
          <ReadinessChecklist light={light} />
        </div>,
        document.body,
      )}
    </>
  );
}
