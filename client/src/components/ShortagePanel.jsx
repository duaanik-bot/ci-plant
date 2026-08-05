// The board shortage panel, shared by the single-line engine and the run view.
// Both used to hold their own inline copy of this row; the wording differences
// between them are props now, because a real difference in one term argues for a
// parameter rather than a second reader.
import { useState } from 'react';
import { AlertTriangle, Truck, Check } from 'lucide-react';
import { Button, Modal } from './ui.jsx';
import { fmt } from '../api.js';
import { panelMode } from '../lib/shortagePanel.js';
// The same rule the PR register gates its row menu on, so a user who is offered
// Undo/Cancel here is offered the equivalent actions there, and vice versa.
import { prControls } from '../lib/requisitionControls.js';

export default function ShortagePanel({
  short, fresh, prs = [], lastMove = null, role,
  ownIncoming = 0, neededBy = null, boardName = null, jobLabel = null,
  coverCandidate = null,
  // Overrides the primary button's text only. A run needs to say "Raise ONE PR"
  // at the point of click — one requisition covers every member — because the
  // opposite reading is how CI-GANG-0007 collected four full-size PRs
  // (server/src/routes/gangs.js). The default is right everywhere else.
  raiseLabel = null,
  onRaisePr, onTakeBoard, onCoverMix,
  onUndoPr, onCancelPr, onTrackPr, onMoveBack,
  busy = false,
}) {
  const [confirm, setConfirm] = useState(null);
  const mode = panelMode({ short, prs, lastMove });
  if (!mode) return null;

  if (mode === 'card') {
    const tone = fresh
      ? { bg: 'bg-indigo-50', text: 'text-indigo-700', rule: 'border-indigo-200', variant: 'primary' }
      : { bg: 'bg-red-50', text: 'text-red-700', rule: 'border-red-200', variant: 'danger' };
    // A PR can exist while short stays > 0 — raising one is paperwork, it does
    // not move board into the warehouse. panelMode deliberately keeps 'card'
    // (not 'pr') on top while short > 0: the physical shortage is still the
    // true, urgent fact, and flipping to the calm emerald 'pr' strip here would
    // be exactly the confident-but-false signal this codebase's readiness
    // rules exist to prevent. So card mode absorbs the PR instead of hiding it.
    const pr = prs[0];
    const c = prControls({ pr, role });
    return (
      <div className={`mt-2.5 rounded-xl px-3 py-2.5 ${tone.bg}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${tone.text}`}>
            {fresh ? <Truck size={13} /> : <AlertTriangle size={13} />}
            {fresh
              ? `Buying fresh — ${fmt.num(short)} parent sheets to order`
              : `Short ${fmt.num(short)} parent sheets`}
          </span>
          <span className={`shrink-0 text-[11px] ${tone.text} opacity-70`}>
            {fresh
              ? (ownIncoming > 0 ? `${fmt.num(ownIncoming)} on PR` : 'not yet ordered')
              : 'cutting waits'}
          </span>
        </div>

        {pr ? (
          // Same three facts the emerald 'pr' strip leads with (number, status,
          // quantity), same order — but a neutral white inset instead of
          // emerald, so it reads as "already in flight", not as a second,
          // calmer alarm competing with the red headline above it.
          <div className="mt-2 rounded-lg bg-white/70 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <Check size={13} className="text-emerald-600" /> {pr.pr_number} raised
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {pr.status === 'approved' ? 'approved' : 'awaiting approval'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {fmt.num(pr.qty)} sheets{neededBy ? ` · needed by ${fmt.date(neededBy)}` : ''}
            </p>
            {c.blockedReason && (
              <p className="mt-1 text-[11px] font-medium text-slate-500">{c.blockedReason}</p>
            )}
          </div>
        ) : (
          <Button size="sm" variant={tone.variant} className="mt-2 w-full" disabled={busy}
            onClick={() => setConfirm('pr')}>
            {raiseLabel || `Raise PR for ${fmt.num(short)}`}
          </Button>
        )}

        {(onTakeBoard || onCoverMix || pr) && (
          <div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 ${tone.rule}`}>
            {/* busy disables every action this panel can start, not just the
                primary button — otherwise a second request can be opened while
                the first is still in flight. Disabled styling matches the
                codebase's existing bare-button idiom (e.g. Invoices.jsx). */}
            {onTakeBoard && (
              <button type="button" disabled={busy} onClick={() => setConfirm('take')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline ${tone.text}`}>
                Take from another job
              </button>
            )}
            {onCoverMix && (
              <button type="button" disabled={busy} onClick={() => setConfirm('cover')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline ${tone.text}`}>
                Cover with a board
              </button>
            )}
            {pr && (
              <button type="button" onClick={() => onTrackPr?.(pr)}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline ${tone.text}`}>
                Track requisition
              </button>
            )}
            {pr && c.undo && (
              <button type="button" disabled={busy} onClick={() => setConfirm('undo')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline ${tone.text}`}>
                Undo
              </button>
            )}
            {pr && c.cancel && (
              <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
                className="text-[11px] font-semibold text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline">
                Cancel
              </button>
            )}
            {/* Demoted to a quiet link on purpose once a PR already exists — the
                loud primary button is exactly what invited a second requisition
                for a shortage that already has one open. Still the same action
                (setConfirm('pr') → the caller's onRaisePr), so it still goes
                through whatever duplicate-PR guard the caller already enforces;
                this only changes how strongly the panel invites using it again. */}
            {pr && (
              <button type="button" disabled={busy} onClick={() => setConfirm('pr')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline ${tone.text}`}>
                Raise another PR
              </button>
            )}
          </div>
        )}

        <Confirmations kind={confirm} onClose={() => setConfirm(null)}
          short={short} boardName={boardName} jobLabel={jobLabel} neededBy={neededBy}
          coverCandidate={coverCandidate} busy={busy}
          onRaisePr={onRaisePr} onTakeBoard={onTakeBoard} onCoverMix={onCoverMix} />

        {pr && (
          <PrConfirmations kind={confirm} pr={pr} busy={busy} onClose={() => setConfirm(null)}
            onUndoPr={onUndoPr} onCancelPr={onCancelPr} />
        )}
      </div>
    );
  }

  if (mode === 'pr') {
    const pr = prs[0];
    // panelMode only checks prs.length, not the shape of prs[0] — a caller that
    // hands a sparse/malformed array would otherwise crash this render (and the
    // page above it) on pr.pr_number below rather than degrade quietly.
    if (!pr) return null;
    const c = prControls({ pr, role });
    return (
      <div className="mt-2.5 rounded-xl bg-emerald-50 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
            <Check size={13} /> {pr.pr_number} raised
          </span>
          <span className="shrink-0 text-[11px] text-emerald-700">
            {pr.status === 'approved' ? 'approved' : 'awaiting approval'}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-emerald-700">
          {fmt.num(pr.qty)} sheets{neededBy ? ` · needed by ${fmt.date(neededBy)}` : ''}
        </p>
        {c.blockedReason && (
          <p className="mt-1 text-[11px] font-medium text-emerald-700 opacity-80">{c.blockedReason}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-emerald-200 pt-2">
          <button type="button" onClick={() => onTrackPr?.(pr)}
            className="text-[11px] font-semibold text-emerald-800 underline-offset-2 hover:underline">
            Track requisition
          </button>
          {c.undo && (
            <button type="button" disabled={busy} onClick={() => setConfirm('undo')}
              className="text-[11px] font-semibold text-emerald-800 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline">
              Undo
            </button>
          )}
          {c.cancel && (
            <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
              className="text-[11px] font-semibold text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:no-underline">
              Cancel
            </button>
          )}
        </div>
        <PrConfirmations kind={confirm} pr={pr} busy={busy} onClose={() => setConfirm(null)}
          onUndoPr={onUndoPr} onCancelPr={onCancelPr} />
      </div>
    );
  }

  // mode === 'move'
  return (
    <div className="mt-2.5 rounded-xl bg-sky-50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-sky-800">
          <Check size={13} /> {fmt.num(lastMove.qty)} sheets moved in
        </span>
        {onMoveBack && (
          <button type="button" onClick={() => onMoveBack(lastMove)}
            className="shrink-0 text-[11px] font-semibold text-sky-800 underline-offset-2 hover:underline">
            Move it back
          </button>
        )}
      </div>
      {/* A move can auto-raise a PR for the job it took board from. Naming it is
          the whole point — releasing the hold would leave that PR standing. */}
      {(lastMove.raised || []).length > 0 && (
        <p className="mt-1 text-[11px] text-sky-800">
          Raised {lastMove.raised.map(p => p.pr_number).join(', ')} for the job it came from —
          undo that separately if the move was wrong.
        </p>
      )}
    </div>
  );
}

// Each modal names what its own action does. A generic "are you sure" would put
// buying board, taking it off another job, and drafting a throwaway mix behind
// identical words, which is exactly the equivalence this redesign removes. Dismiss
// reads "Not now", not "Cancel" — "Cancel" is the live destructive action on a
// raised PR (see PrConfirmations below); reusing it here for a no-op would
// recreate the exact collision this component exists to remove.
function Confirmations({ kind, onClose, short, boardName, jobLabel, neededBy, coverCandidate, busy, onRaisePr, onTakeBoard, onCoverMix }) {
  const act = fn => () => { onClose(); fn?.(); };
  return (
    <>
      <Modal open={kind === 'pr'} onClose={onClose} title="Raise a requisition?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button variant="danger" disabled={busy} onClick={act(onRaisePr)}>Raise PR</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p><b className="text-slate-900">{fmt.num(short)} parent sheets</b>{boardName ? <> of <b className="text-slate-900">{boardName}</b></> : null}</p>
          {jobLabel && <p>For {jobLabel}</p>}
          {neededBy && <p>Needed by {fmt.date(neededBy)}</p>}
          <p className="text-[11px] text-slate-400">Goes to Procurement as a pending requisition. You can undo it from here while it is still pending.</p>
        </div>
      </Modal>

      <Modal open={kind === 'take'} onClose={onClose} title="Take board from another job?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button variant="primary" onClick={act(onTakeBoard)}>Choose a job</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p>This moves board off another job's hold and onto this one.</p>
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
            A requisition may be raised automatically for the job you take it from, so it is not left short. A move cannot be undone in one step.
          </p>
          <p className="text-[11px] text-slate-400">You pick which job on the next screen.</p>
        </div>
      </Modal>

      <Modal open={kind === 'cover'} onClose={onClose} title="Cover with another board?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button variant="primary" onClick={act(onCoverMix)}>Draft the mix</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p>{coverCandidate
            ? <>Covers the {fmt.num(short)} shortfall with <b className="text-slate-900">{coverCandidate}</b>.</>
            : <>Covers the {fmt.num(short)} shortfall with the closest available board.</>}</p>
          <p className="text-[11px] text-slate-400">This only drafts rows in Board Mix on the left. Nothing is committed until you save the plan.</p>
        </div>
      </Modal>
    </>
  );
}

// Undo removes the row outright and needs no reason. Cancel keeps it as `closed`
// with a reason, which the server requires — POST /close 400s on a blank one.
function PrConfirmations({ kind, pr, busy, onClose, onUndoPr, onCancelPr }) {
  const [reason, setReason] = useState('');
  // Now reachable from two call sites (the 'pr' branch, and card mode once a
  // PR exists alongside a live shortage) — both already guard before calling
  // this, but guard here too so neither call site can crash this by forgetting
  // to check first. The hook above runs unconditionally either way, then this
  // can bail.
  if (!pr) return null;
  // Every way to leave this modal without submitting — Escape/backdrop/the
  // header × (all routed through Modal's own onClose) and "Keep it" — needs to
  // clear the typed reason the same way, or it can reappear next time the
  // Cancel modal opens, possibly against a different PR.
  const closeCancel = () => { setReason(''); onClose(); };
  return (
    <>
      <Modal open={kind === 'undo'} onClose={onClose} title={`Undo ${pr.pr_number}?`}
        footer={<>
          <Button variant="secondary" onClick={onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy} onClick={() => { onClose(); onUndoPr?.(pr); }}>Undo it</Button>
        </>}>
        <p className="text-sm text-slate-600">
          Removes {pr.pr_number} completely, as though it were never raised. The shortage comes back.
        </p>
      </Modal>

      <Modal open={kind === 'cancel'} onClose={closeCancel} title={`Cancel ${pr.pr_number}?`}
        footer={<>
          <Button variant="secondary" onClick={closeCancel}>Keep it</Button>
          <Button variant="danger" disabled={busy || !reason.trim()}
            onClick={() => { closeCancel(); onCancelPr?.(pr, reason.trim()); }}>
            Cancel the PR
          </Button>
        </>}>
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Keeps {pr.pr_number} on record as closed, with your reason against it. Use this when the decision changed — use Undo for a mistake.
          </p>
          <input value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why is it being cancelled?"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </div>
      </Modal>
    </>
  );
}
