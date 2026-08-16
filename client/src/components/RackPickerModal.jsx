// Which plate, not how many.
//
// The green "Use N from Rack" button took whichever plates plateCandidates
// ordered first and told nobody which. That ordering is a good default — Good
// before Fair, least-worn first, idle longest next — but it is a guess about a
// physical object the planner can see and the query cannot: the plate at the
// front of the rack, the one that ran this artwork last month, the one the
// press operator asked for by number. This modal shows the same candidate list
// the button would have picked from, opens on the same plate it would have
// taken, and lets that be overruled a line at a time.
//
// It renders and selects, nothing else. Every decision it displays —  what to
// open on, whether two lines have picked the same plate, what to send — comes
// from lib/plateRack.js, because a .jsx file cannot be imported by node --test
// and untested arithmetic in here would be arithmetic nobody checks.
import { Fragment, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShoppingBag } from 'lucide-react';
import { defaultPickSelection, duplicatePickAssets, pickPayload, PLATE_SET_ASIDE_REASONS } from '../lib/plateRack.js';
import { Button, Modal } from './ui.jsx';

// `lines` must be held in the caller's state, not rebuilt inline on each render:
// the effect below re-seeds on its identity, so a fresh array every render would
// throw away the planner's picks as fast as they are made.
export default function RackPickerModal({ open, requestNumber, lines = [], busy = false, onCancel, onConfirm, onSetAside }) {
  const [selection, setSelection] = useState(() => defaultPickSelection(lines));
  // Which row has its reason strip open. One at a time: the strip is the whole
  // question, so two open at once would be two half-asked questions.
  const [asideFor, setAsideFor] = useState(null);
  // Re-seed when the candidate list itself changes — reopening the picker on a
  // different PR, or reopening it after a Change released a plate back.
  useEffect(() => { setSelection(defaultPickSelection(lines)); }, [lines]);

  if (!open) return null;

  const picks = pickPayload(selection);
  // Caught here rather than at the server so the planner is told which plate is
  // doubled while both rows are still on screen to fix.
  const clashIds = new Set(duplicatePickAssets(selection));
  const clashNames = [...new Set(lines.flatMap(line => (line.candidates || [])
    .filter(row => clashIds.has(row.id))
    .map(row => row.asset_number)))];

  const choose = (componentId, assetId) =>
    setSelection(current => ({ ...current, [componentId]: assetId }));

  return (
    <Modal open onClose={onCancel}
      title={requestNumber ? `Choose plates from the rack — ${requestNumber}` : 'Choose plates from the rack'}
      footer={<>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="success" disabled={busy || !picks.length || clashNames.length > 0}
          onClick={() => onConfirm?.(pickPayload(selection))}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          Reserve {picks.length} {picks.length === 1 ? 'plate' : 'plates'}
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="ci-summary-panel text-xs text-slate-600">
          These plates are reserved for this requirement the moment you confirm, so nothing else
          can take them. A colour left on <b>Buy this one</b> stays on the PR to be bought.
        </div>

        {clashNames.length > 0 && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {clashNames.join(', ')} {clashNames.length === 1 ? 'is' : 'are'} picked for more than one
            colour. One plate can only go on one line — change one of them.
          </p>
        )}

        {!lines.length && (
          <p className="py-6 text-center text-sm text-slate-400">
            This requirement has no line the rack can be asked about.
          </p>
        )}

        {lines.map(line => {
          const candidates = line.candidates || [];
          return (
            <section key={line.component_id} className="ci-form-panel">
              <div className="ci-form-panel-title">
                <span>{line.component_label}</span>
                <span>{candidates.length} on rack</span>
              </div>
              <div>
                {candidates.map(row => {
                  const on = selection[line.component_id] === row.id;
                  const clash = on && clashIds.has(row.id);
                  return (
                    // A <label> wrapping a button makes the button toggle the radio, so the
                    // row can no longer BE the label once it has an action in it. The label
                    // keeps the radio, the identity and the stats; the button is its sibling.
                    // A Fragment rather than a wrapper <div>, so the row div stays a direct
                    // child of the same container and `last:border-0` keeps meaning what it
                    // meant — a wrapper would make every row its own last child and take the
                    // divider off all of them.
                    <Fragment key={row.id}>
                      <div className={`flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 ${clash ? 'bg-red-50/60' : ''}`}>
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input type="radio" checked={on}
                            name={`rack-pick-${line.component_id}`}
                            aria-label={`${row.asset_number} for ${line.component_label}`}
                            className="h-4 w-4 shrink-0 accent-[#007AFF]"
                            onChange={() => choose(line.component_id, row.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <b className="font-mono text-sm text-slate-800">{row.asset_number}</b>
                              {row.current && (
                                <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                                  on this line now
                                </span>
                              )}
                              {clash && (
                                <span className="whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
                                  picked twice
                                </span>
                              )}
                            </span>
                            <span className="block text-[10px] text-slate-400">
                              {row.rack_location || 'Rack not recorded'} · {row.condition || 'Good'}
                            </span>
                          </span>
                          {/* Wear and shelf age answer different questions and can
                              disagree completely — both are shown, neither is ranked. */}
                          <span className="shrink-0 text-right">
                            <span className="block text-sm font-bold tabular-nums text-slate-700">{row.use_count ?? 0}</span>
                            <span className="block text-[10px] text-slate-400">{(row.use_count ?? 0) === 1 ? 'run' : 'runs'}</span>
                          </span>
                          <span className="w-12 shrink-0 text-right">
                            <span className="block text-sm font-bold tabular-nums text-slate-700">
                              {row.age_days == null ? '—' : `${row.age_days}d`}
                            </span>
                            <span className="block text-[10px] text-slate-400">old</span>
                          </span>
                        </label>
                        {/* Not offered on the plate this line already holds: that one is
                            'reserved', so set-aside would meet the in-flight guard and
                            answer a considered click with a 409. Release it first.
                            Retire is not offered here at all — it is permanent, its
                            reasons are a different list, and a modal for choosing a
                            plate is the wrong place to scrap one. The warehouse keeps
                            that job. */}
                        {!row.current && (
                          <button type="button"
                            className="shrink-0 rounded-full px-2 py-1 text-[10px] font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            onClick={() => setAsideFor(asideFor === row.id ? null : row.id)}>
                            Not this one
                          </button>
                        )}
                      </div>
                      {/* The reason IS the confirmation. The first tap only opens this
                          strip — nothing is written until a reason is named, and there
                          is no second dialog after it. */}
                      {asideFor === row.id && (
                        <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 pb-2">
                          <span className="text-[10px] font-bold text-slate-500">Take {row.asset_number} off the rack —</span>
                          {PLATE_SET_ASIDE_REASONS.map(reason => (
                            <button key={reason.key} type="button"
                              className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:border-slate-400"
                              onClick={() => { setAsideFor(null); onSetAside(row.id, reason.key); }}>
                              {reason.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </Fragment>
                  );
                })}
                {/* Always offered, even where the rack has nothing: it is the line
                    that says "buy it" out loud, rather than leaving the planner to
                    read an absence. */}
                <label className="flex cursor-pointer items-center gap-3 border-t border-slate-100 py-2">
                  <input type="radio" checked={selection[line.component_id] == null}
                    name={`rack-pick-${line.component_id}`}
                    aria-label={`Buy ${line.component_label} on the purchase order`}
                    className="h-4 w-4 shrink-0 accent-[#007AFF]"
                    onChange={() => choose(line.component_id, null)} />
                  <span className="min-w-0 flex-1">
                    <b className="text-sm text-slate-600">Buy this one</b>
                    <span className="block text-[10px] text-slate-400">
                      {candidates.length ? 'Leave the rack alone — this colour goes on the purchase order' : 'Nothing on the rack for this colour'}
                    </span>
                  </span>
                  <ShoppingBag size={14} className="shrink-0 text-slate-300" />
                </label>
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
