// Size proposals for a carton size the Size Library has no layout for (owner, 12 Nov 2026: "Whenever there is a new
// size, I put the dimensions. You will propose the size to me … out of which I will select one"). First the dies that
// already exist — the Die Master and the 2024 die register — then layouts on whole pieces of the board master's sheets,
// least board a carton first (client/src/lib/sizing.js; routes/sizing.js). Picking one fills the sheet and ups and
// ticks New die; the KLD is drawn from it in the box below.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb, Ruler } from 'lucide-react';
import { api } from '../../api.js';
import { IN, layoutBlocks } from '../../lib/sizing.js';
import { num, styleLabel } from '../../lib/costing.js';

const GRAIN = {
  ok: ['Grain fits', 'bg-emerald-100 text-emerald-700'],
  wrong: ['Grain runs the wrong way', 'bg-rose-100 text-rose-700'],
  unknown: ['Grain not recorded', 'bg-slate-100 text-slate-600'],
};
const PIECE = { 1: 'a whole', 2: '½ of', 3: '⅓ of', 4: '¼ of' };
const pieceOf = (p, mill) => `${PIECE[p] || `1/${p} of`} ${mill.short} × ${mill.long}`;
const n1 = x => (x == null ? '—' : Number(x).toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const sizeText = d => [d.l, d.w, d.h].map(x => n1(x)).join(' × ');

// The print sheet with every up: body blue, glue flap yellow, flaps red; the green bar is the grain the layout needs.
export function LayoutPicture({ reading, option, className = '' }) {
  const W = option.sheet.long * IN, H = option.sheet.short * IN;
  const blocks = useMemo(() => layoutBlocks(null, reading, option), [reading, option]);
  const tone = { body: ['#e6ecf6', '#2a5598'], glue: ['#f6e7b4', '#2a5598'], flap: ['#fde3dc', '#b8362a'] };
  const along = option.acrossOn === 'long';
  // the output's settings (13 Nov 2026): the gripper band on the top long edge, the edges dashed
  const g = Number(option.settings?.gripper) || 0, e = Number(option.settings?.edge) || 0;
  return (
    <svg viewBox={`-4 -4 ${W + 34} ${H + 30}`} className={className} role="img"
      aria-label={`${option.ups} up on ${option.sheet.short} × ${option.sheet.long} in; board grain along the ${along ? option.sheet.long : option.sheet.short} in side`}>
      <rect x="0" y="0" width={W} height={H} fill="#fff" stroke="#334155" strokeWidth="2" />
      {g > 0 && <rect x="0" y="0" width={W} height={g} fill="#e2e8f0" />}
      {(g > 0 || e > 0) && <rect x={e} y={g} width={W - 2 * e} height={H - g - e} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="6 4" />}
      {blocks.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={tone[b.kind][0]} stroke={tone[b.kind][1]} strokeWidth="1" />)}
      {along
        ? <line x1={W * 0.3} y1={H + 16} x2={W * 0.7} y2={H + 16} stroke="#15803d" strokeWidth="5" strokeLinecap="round" />
        : <line x1={W + 18} y1={H * 0.7} x2={W + 18} y2={H * 0.3} stroke="#15803d" strokeWidth="5" strokeLinecap="round" />}
    </svg>
  );
}

function DieCheck({ dies, size, onUseDie }) {
  const master = dies?.master || { exact: [], near: [] }, reg = dies?.register || { exact: [], near: [] };
  const sheetOf = d => {
    const m = String(d.sheet_size || '').toLowerCase().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
    return m ? { a: +m[1], b: +m[2] } : null;
  };
  const any = master.exact.length + master.near.length + reg.exact.length + reg.near.length > 0;
  return (
    <div className="space-y-1.5 text-xs">
      {master.exact.map(d => {
        const s = sheetOf(d);
        return (
          <div key={`m${d.id}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-2.5 py-1.5 ring-1 ring-emerald-200">
            <CheckCircle2 size={14} className="text-emerald-600" />
            <span><b>Die {d.code}</b> in the Die Master is this size · {d.sheet_size || 'sheet not recorded'} · {d.ups ?? '?'} up — no new die needed.</span>
            {s && d.ups > 0 && (
              <button type="button" onClick={() => onUseDie({ sheet_l: Math.min(s.a, s.b), sheet_w: Math.max(s.a, s.b), ups: d.ups })}
                className="ml-auto rounded-md bg-white px-2 py-0.5 font-bold text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-100">Use this die's layout</button>
            )}
          </div>
        );
      })}
      {reg.exact.map(d => (
        <div key={`r${d.die_no}`} className="flex items-center gap-2 rounded-lg bg-emerald-50 px-2.5 py-1.5 ring-1 ring-emerald-200">
          <CheckCircle2 size={14} className="text-emerald-600" />
          <span><b>Die {d.die_no}</b> in the 2024 die register is this size · {styleLabel(d.style)} · {d.ups ?? '?'} up. Check it is still in the rack.</span>
        </div>
      ))}
      {(master.near.length > 0 || reg.near.length > 0) && (
        <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 ring-1 ring-amber-200">
          <b>Close dies</b> — if the customer can take one of these sizes, no new die:{' '}
          {[...master.near.map(d => `die ${d.code} ${String(d.carton_size).replace(/x/gi, ' × ')} (${d.ups ?? '?'} up)`),
            ...reg.near.map(d => `die ${d.die_no} ${sizeText(d)} ${styleLabel(d.style).toLowerCase()} (${d.ups ?? '?'} up, register)`)].slice(0, 6).join(' · ')}
        </div>
      )}
      {!any && <p className="text-slate-600">No die of this size or within 3 mm in the Die Master or the 2024 die register — a new die is needed.</p>}
      {size && <p className="sr-only">{size.label}</p>}
    </div>
  );
}

function OptionCard({ reading, option, onUse }) {
  const [label, tone] = GRAIN[option.grain] || GRAIN.unknown;
  const side = option.grainNeeded === 'long' ? option.sheet.long : option.sheet.short;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-white p-2.5 text-[11px] ring-1 ring-slate-200">
      <LayoutPicture reading={reading} option={option} className="h-28 w-full rounded-md bg-slate-50" />
      <div className="text-xs font-bold text-[#1D1D1F]">{option.sheet.short} × {option.sheet.long} in · {option.ups} up</div>
      <div className="text-slate-600">{pieceOf(option.pieces, option.mill)} · {option.m} × {option.n}</div>
      <div className="tabular-nums text-slate-700">{n1(option.sqInPerCarton)} sq in{option.gramsPerCarton != null ? ` · ${n1(option.gramsPerCarton)} g` : ''} a carton</div>
      <div className="tabular-nums text-slate-500">Spare {n1(option.spareAcross)} / {n1(option.spareAlong)} mm</div>
      <div><span className={`rounded-full px-1.5 py-px font-bold ${tone}`} title={`The board grain must run along the ${side} in side`}>{label}</span>
        <span className="ml-1 text-slate-500">along {side} in</span></div>
      {option.note && <div className="text-amber-700">{option.note}</div>}
      {option.marginNote && <div className="text-amber-700">{option.marginNote}</div>}
      <button type="button" onClick={onUse}
        className="mt-auto rounded-lg bg-brand-600 px-2 py-1 text-xs font-bold text-white hover:bg-brand-700">Use this layout</button>
    </div>
  );
}

export default function SizeProposals({ value, size, onPick }) {
  const style = value.style || '';
  const gsm = num(value.inputs?.gsm);
  const key = size?.kind === 'carton' ? `${size.key}|${style}|${gsm || ''}` : null;
  const [state, setState] = useState({ key: null, data: null, loading: false, error: null });
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    setState(s => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.get(`/costing/sizing/proposals?size=${encodeURIComponent(size.key)}&style=${encodeURIComponent(style)}&gsm=${gsm || ''}`)
        .then(data => { if (live) setState({ key, data, loading: false, error: null }); })
        .catch(e => { if (live) setState({ key, data: null, loading: false, error: e.message }); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return null;
  const data = state.key === key ? state.data : null;
  const use = (reading, option) => onPick({
    sheet_l: option.sheet.short, sheet_w: option.sheet.long, ups: option.ups, style: value.style, new_die: true,
    proposal: { sizeKey: size.key, style: value.style, reading: reading.key, option },
  });
  return (
    <div className="mt-3 space-y-3 rounded-xl bg-slate-50/80 p-3">
      <div className="flex items-center gap-1.5 text-xs font-bold"><Lightbulb size={13} className="text-amber-500" />New size — dies first, then layouts on your sheets</div>
      {state.loading && !data && <p className="text-xs text-slate-500">Working out the layouts…</p>}
      {state.error && <p className="text-xs text-rose-700">{state.error}</p>}
      {data && <DieCheck dies={data.dies} size={size} onUseDie={d => onPick({ ...d, style: value.style, new_die: false })} />}
      {data?.unsupported && (
        <p className="flex items-start gap-1.5 text-xs text-slate-600"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
          {style ? data.reason : 'Choose the pasting — Side pasting or Lock bottom — to see layouts.'}</p>
      )}
      {data && !data.unsupported && data.reason && <p className="text-xs text-slate-600">{data.reason}</p>}
      {data?.readings?.filter(r => r.options.length).map(r => (
        <div key={r.reading.key} className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="flex items-center gap-1 font-bold text-[#1D1D1F]"><Ruler size={12} className="text-brand-600" />{r.reading.label}</span>
            <span className="text-slate-500">blank {n1(r.plan.blank.across)} × {n1(r.plan.blank.along)} mm · glue {r.plan.glue} · tuck {r.plan.tuck}{r.plan.lock != null ? ` · lock ${n1(r.plan.lock)}` : ''}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {r.options.map(o => <OptionCard key={`${o.sheet.long}x${o.sheet.short}-${o.ups}`} reading={r.reading} option={o} onUse={() => use(r.reading, o)} />)}
          </div>
          {r.nearMisses.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-slate-600">
              {r.nearMisses.map(m => (
                <li key={`${m.sheet.long}x${m.sheet.short}-${m.ups}`}>
                  <b>Near miss:</b> {m.sheet.short} × {m.sheet.long} in ({pieceOf(m.pieces, m.mill)}) takes <b>{m.ups} up</b> with {n1(m.needMm)} mm less {m.axis === 'along' ? 'along the carton' : 'round the carton'} — {n1(m.sqInPerCarton)} sq in a carton.
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className="text-[11px] text-slate-500">House rules from your own dies and outputs, confirmed 14 Nov 2026: panels at the inner size, ups counted edge to edge, with a warning when a layout leaves less than the press margins (10 mm gripper + 5 mm edges). Check the die maker agrees before ordering a die.</p>
    </div>
  );
}
