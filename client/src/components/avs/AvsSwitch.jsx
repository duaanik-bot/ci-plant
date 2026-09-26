// Planning's per-job AVS switch, and the chip that shows it on a row.
//
// On: the PRINTING stage of this job's card can be completed only after QA has
// released the job in Artwork Verification (server/src/avs-gate.js). Off by
// default. Only Planning (planner, admin) switches it — the press never
// switches its own lock off. Switching it off once printing has started needs a
// reason: the server answers AVS_REASON_REQUIRED, this asks for the reason and
// sends the switch again with it.
import { useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { api, auth } from '../../api.js';
import { Button, Modal, useToast } from '../ui.jsx';
import { AVS_REMARK_MAX, AVS_SWITCH_REASON_MIN } from '../../lib/avs.js';

export const canSwitchAvs = user => user?.role === 'admin' || user?.role === 'planner';

export function AvsChip({ on, className = '' }) {
  if (!on || +on === 0) return null;
  return (
    <span title="AVS mandatory: printing can be completed only after QA releases this job in Artwork Verification"
      className={`inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200 ${className}`}>
      <ScanSearch size={11} /> AVS
    </span>
  );
}

// value: current state. Exactly one of lineId / runId / jobCardId names the job.
export default function AvsSwitch({ value, lineId, runId, jobCardId, onChanged, disabled = false, note }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState('');
  const on = !!value && +value !== 0;
  const editable = canSwitchAvs(auth.user) && !disabled;
  const target = lineId ? { line_id: lineId } : runId ? { gang_run_id: runId } : { job_card_id: jobCardId };

  const send = async (next, why) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post('/avs/switch', { ...target, on: next, reason: why || undefined });
      toast.success(next ? 'AVS is now mandatory for this job' : 'AVS switched off for this job');
      setAsking(null); setReason('');
      onChanged?.(next);
    } catch (e) {
      // Printing has started: the reason is asked for, then the switch goes again.
      if (e.data?.code === 'AVS_REASON_REQUIRED') setAsking({ message: e.message });
      // Anything else was already shown by api.js.
    } finally { setBusy(false); }
  };

  const seg = active => `flex-1 rounded-lg px-2 py-1.5 transition-colors disabled:cursor-not-allowed ${active}`;
  return (
    <div>
      <div className="flex rounded-xl bg-slate-100 p-1 text-[11px] font-semibold">
        <button type="button" disabled={!editable || busy} onClick={() => on && send(false)}
          className={seg(!on ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
          AVS not needed
        </button>
        <button type="button" disabled={!editable || busy} onClick={() => !on && send(true)}
          className={seg(on ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
          <span className="inline-flex items-center gap-1"><ScanSearch size={12} /> AVS mandatory</span>
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        {note || (on
          ? 'Printing can be completed only after QA releases this job in Artwork Verification.'
          : 'Printing completes without an AVS release.')}
        {!canSwitchAvs(auth.user) && ' Planning decides this.'}
      </p>

      <Modal open={!!asking} onClose={() => { if (!busy) { setAsking(null); setReason(''); } }}
        title="Switch AVS off for this job?"
        footer={<>
          <Button variant="secondary" repeatable onClick={() => { setAsking(null); setReason(''); }} disabled={busy}>Keep AVS on</Button>
          <Button variant="danger" onClick={() => send(false, reason.trim())}
            disabled={busy || reason.trim().length < AVS_SWITCH_REASON_MIN}>Switch AVS off</Button>
        </>}>
        <div className="space-y-2">
          <p className="text-sm text-slate-600">{asking?.message}</p>
          <label htmlFor="avs-off-reason" className="block text-xs font-medium text-slate-600">
            Reason (saved with your name) — why can printing be completed without QA's AVS release?
          </label>
          <textarea id="avs-off-reason" value={reason} maxLength={AVS_REMARK_MAX} onChange={e => setReason(e.target.value)}
            className="min-h-[72px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
        </div>
      </Modal>
    </div>
  );
}
