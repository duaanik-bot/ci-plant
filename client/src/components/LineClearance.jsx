// Line clearance — the pre-start checklist every working station
// (cutting → pasting) confirms before a run begins. One shared panel used by
// the Section start modal and the quick-starts on Live Floor / Job Cards.
// The bulb button lights everything up (or clears it) in one tap.
import { Lightbulb, LightbulbOff, ClipboardCheck } from 'lucide-react';
import { LINE_CLEARANCE_ITEMS } from '../sections.js';

export const needsClearance = stage => stage !== 'qc';
export const freshClearance = () => LINE_CLEARANCE_ITEMS.map(label => ({ label, ok: false }));
export const allClear = checks => checks.length > 0 && checks.every(c => c.ok);
// Payload for POST /job-stages/:id/start — server refuses unticked points.
export const clearancePayload = checks => checks.map(c => ({ label: c.label, ok: c.ok }));

export default function LineClearancePanel({ checks, onChange }) {
  const done = checks.filter(c => c.ok).length;
  const all = done === checks.length;
  const setAll = ok => onChange(checks.map(c => ({ ...c, ok })));
  const toggle = i => onChange(checks.map((c, j) => (j === i ? { ...c, ok: !c.ok } : c)));

  return (
    <section className="ci-form-panel border-dashed">
      <div className="ci-form-panel-title">
        <span className="inline-flex items-center gap-1.5"><ClipboardCheck size={13} /> Line clearance</span>
        <span className={all ? 'text-emerald-600' : 'text-amber-600'}>{done}/{checks.length} confirmed</span>
      </div>
      {/* One-tap: confirm the whole checklist for this station at once. */}
      <button type="button" onClick={() => setAll(!all)}
        title={all ? 'Deselect all' : 'Select all'}
        className={`mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
          all ? 'bg-emerald-100 text-emerald-700 hover:bg-slate-100 hover:text-slate-500'
              : 'bg-amber-100 text-amber-700 hover:bg-emerald-100 hover:text-emerald-700'}`}>
        {all ? <LightbulbOff size={13} /> : <Lightbulb size={13} />}
        {all ? 'All clear — tap to reset' : 'Line is clear — select all points'}
      </button>
      <div className="space-y-1">
        {checks.map((c, i) => (
          <label key={i}
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${c.ok ? 'bg-emerald-50/70 text-slate-700' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
            <input type="checkbox" checked={c.ok} onChange={() => toggle(i)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
            <span className={c.ok ? 'font-medium' : ''}>{c.label}</span>
          </label>
        ))}
      </div>
      {!all && <p className="mt-2 text-[11px] font-semibold text-amber-600">Start unlocks when every point is confirmed</p>}
    </section>
  );
}
