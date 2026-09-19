// Sending a job back one station — the shared dialog and its plumbing.
//
// Any floor screen can hand a job back upstream: bad blanks at pasting go to
// die cutting, a wrong stock at coating goes to printing. The act is the same
// wherever it happens, so it lives here once and Section.jsx and SortPaste.jsx
// both use it — otherwise the two would drift on the one screen where an
// operator is undoing real ledger movements.
//
// The PLAN is fetched before the dialog opens, deliberately: the operator signs
// off the actual consumption and output that will be undone, computed by the
// same server code that applies it, rather than a generic "are you sure". A 409
// on that fetch is the useful case — its message names the stage that has to go
// back BEFORE this one, and api.js already surfaces it, so we only avoid opening
// an empty dialog.
import { useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal } from './ui.jsx';
import { Undo2 } from 'lucide-react';

export function useSendBack({ toast, onDone }) {
  const [sendingBack, setSendingBack] = useState(null);   // { row, plan }
  const [reason, setReason] = useState('');

  // `stageId` is the stage actually on the floor — at Sort & Paste that is the
  // ACTIVE stage (sorting until it completes, then pasting), not the row id.
  const open = async (row, stageId = row.id) => {
    const plan = await api.get(`/job-stages/${stageId}/reverse-plan`).catch(() => null);
    if (!plan) return;
    setSendingBack({ row, plan, stageId });
    setReason('');
  };
  const close = () => { setSendingBack(null); setReason(''); };

  const sendBack = async () => {
    const { row, plan, stageId } = sendingBack;
    await api.post(`/job-stages/${stageId}/send-back`, { reason });
    toast.info(inPlace(plan)
      ? `${row.jc_number} is back in the ${fmt.stage(plan.stage)} queue`
      : `${row.jc_number} sent back to ${fmt.stage(plan.target)}`);
    close(); onDone?.();
  };
  // Off the floor in one act. Same guard, same manifest — the difference is only
  // where it lands: the Job Card, reopened for editing.
  const pullBack = async () => {
    const { row, stageId } = sendingBack;
    await api.post(`/job-stages/${stageId}/pull-back`, { reason });
    toast.info(`${row.jc_number} pulled off the floor — edit it at Job Cards`);
    close(); onDone?.();
  };

  return { open, sendingBack, dialogProps: { sendingBack, reason, setReason, close, sendBack, pullBack } };
}

// A split gang CHILD's first stage has no station before it on its own card —
// its die cutting was done once, for the whole gang, on the parent card — so
// "back" is its own queue, uncounted. The server says so by targeting the stage
// itself (helpers.js stageReversePlan).
const inPlace = plan => plan?.target === plan?.stage;

export function SendBackDialog({ sendingBack, reason, setReason, close, sendBack, pullBack, stationLabel }) {
  const plan = sendingBack?.plan;
  const where = plan ? (inPlace(plan) ? `the ${fmt.stage(plan.stage)} queue` : fmt.stage(plan.target)) : '';
  return (
    <Modal open={!!sendingBack} onClose={close}
      title={sendingBack ? `${inPlace(plan) ? 'Back to' : 'Send back to'} ${where} — ${sendingBack.row.jc_number}` : ''}
      footer={<>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        {/* A gang child has no Job Card step to be pulled out to (pull_back false). */}
        {plan?.pull_back !== false && (
          <Button variant="secondary" onClick={pullBack} disabled={!reason.trim()}
            title="Take the job off the floor entirely and reopen it at the Job Card station">
            <Undo2 size={13} /> Pull out to Job Card
          </Button>
        )}
        <Button variant="danger" onClick={sendBack} disabled={!reason.trim()}>
          <Undo2 size={13} /> {inPlace(plan) ? 'Back to the queue' : `Send back to ${where}`}
        </Button>
      </>}>
      {sendingBack && (
        <div className="space-y-3">
          <div className="ci-summary-panel text-xs">
            {sendingBack.row.product_name} · leaving <b>{stationLabel}</b> ({fmt.stage(sendingBack.plan.status)})
            {' → '}<b>{fmt.stage(sendingBack.plan.target)}</b>
          </div>
          {sendingBack.plan.gang && (
            <p className="rounded-xl bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800">
              This is one gang run — all {sendingBack.plan.cards} job cards leave {stationLabel} together.
            </p>
          )}
          {/* The operator signs off the real ledger effects, not a generic
              warning — this list is computed by the same code that applies it. */}
          {sendingBack.plan.items.length > 0 ? (
            <div className="rounded-xl bg-rose-50 px-3 py-2">
              <p className="mb-1 text-xs font-semibold text-rose-800">This will undo:</p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-rose-800">
                {sendingBack.plan.items.map(i => <li key={i.kind}>{i.text}</li>)}
              </ul>
            </div>
          ) : (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
              Nothing was consumed or produced here — only the stage returns to its queue.
            </p>
          )}
          {sendingBack.plan.child_of ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
              This card was split from the gang card <b>{sendingBack.plan.child_of}</b> after die cutting,
              so only this job moves — the rest of the gang stays where it is.
              {' '}{inPlace(sendingBack.plan)
                ? <>It goes back into the {fmt.stage(sendingBack.plan.stage)} queue, uncounted. Die cutting was
                    done once for the whole gang and is not reopened.</>
                : <>It moves one station, to {fmt.stage(sendingBack.plan.target)}.</>}
            </p>
          ) : (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
              <b>Send back</b> moves it one station, to {fmt.stage(sendingBack.plan.target)}.
              {' '}<b>Pull out to Job Card</b> takes it off the floor altogether and reopens the
              card so the spec or quantity can be corrected, then re-pushed. Both undo the same
              list above.
            </p>
          )}
          {sendingBack.plan.warnings.map(w => (
            <p key={w} className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{w}</p>
          ))}
          <Field label="Reason for sending back" required>
            <Input value={reason} placeholder="e.g. wrong board cut, printed on the wrong stock"
              onChange={e => setReason(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
