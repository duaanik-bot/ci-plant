// Planning's per-job AVS switch, and the chip that shows it on a row.
//
// On: the PRINTING stage of this job's card can be completed only after QA has
// released the job in Artwork Verification (server/src/avs-gate.js). Off by
// default. Only Planning (planner, admin) switches it — the press never
// switches its own lock off. Switching it off once printing has started needs a
// reason: the server answers AVS_REASON_REQUIRED, this asks for the reason and
// sends the switch again with it.
import { useId, useState } from 'react';
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
  const switchId = useId();
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

  // One large on/off switch, so Planning sees at a glance whether this job
  // waits for QA's AVS release. Off (grey) by default; on turns it violet.
  const help = note || (on
    ? 'Printing can be completed only after QA releases this job in Artwork Verification.'
    : 'Off: printing completes without an AVS release. Switch on to make the AVS check mandatory.');
  return (
    <div>
      <div className={`flex items-center gap-4 rounded-2xl border-2 px-4 py-3 transition-colors ${on
        ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-slate-50'}`}>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${on
          ? 'bg-violet-600 text-white' : 'bg-white text-slate-400 ring-1 ring-slate-200'}`}>
          <ScanSearch size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div id={`${switchId}-label`} className="text-base font-bold text-slate-900">AVS check mandatory</div>
          <p className={`mt-0.5 text-xs ${on ? 'text-violet-800' : 'text-slate-500'}`}>
            {help}
            {!canSwitchAvs(auth.user) && ' Planning decides this.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <button type="button" role="switch" aria-checked={on} aria-labelledby={`${switchId}-label`}
            disabled={!editable || busy} onClick={() => send(!on)}
            title={on ? 'Switch AVS off for this job' : 'Make the AVS check mandatory for this job'}
            className={`relative inline-flex h-10 w-[76px] items-center rounded-full transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-60 ${on
              ? 'bg-violet-600' : 'bg-slate-300'}`}>
            <span className={`absolute text-[11px] font-extrabold tracking-wide ${on ? 'left-3 text-white' : 'right-3 text-slate-600'}`}>
              {on ? 'ON' : 'OFF'}
            </span>
            <span className={`absolute top-1 h-8 w-8 rounded-full bg-white shadow-md transition-all ${on ? 'left-[40px]' : 'left-1'}`} />
          </button>
          <span className={`text-[10px] font-bold uppercase tracking-wide ${on ? 'text-violet-700' : 'text-slate-400'}`}>
            {busy ? 'Saving…' : on ? 'Mandatory' : 'Not needed'}
          </span>
        </div>
      </div>

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
