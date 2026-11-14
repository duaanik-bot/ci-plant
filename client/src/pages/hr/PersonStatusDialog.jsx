// HR · Payroll → activate, deactivate or delete people, from a card or for everyone ticked (owner's request 2026-11-14:
// "give option to activate or deactivate or delete employee at payroll and row level itself").
//
//   Deactivate  (operator and up) the person is marked left from the date given (today by default), with a reason.
//               "Also leave them out of <month>" (on while the month is a draft) takes them off this month's payroll
//               in the same step; otherwise they stay on it and the answer says so.
//   Activate    (operator and up) back to active; they are on the next months again.
//   Delete      (admin) the master goes for good, with their entries in months not finalised and their import matches.
//               Someone already paid, or with a loan or advances, cannot be deleted: the dialog lists them and offers
//               to deactivate them instead.
// Each person is done on their own; what worked and what was refused are both shown.
import { useState } from 'react';
import { Button, Checkbox, Input, Modal, Textarea } from '../../components/ui.jsx';
import { hrApi, monthLabel } from '../../lib/hr.js';
import { refusalText } from './PersonDrawer.jsx';

const TITLE = { deactivate: 'Deactivate', activate: 'Activate', delete: 'Delete' };
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function PersonStatusDialog({ action, people: given, month, draft, onClose, onDone }) {
  const [act, setAct] = useState(action);
  const [people, setPeople] = useState(given);
  const [reason, setReason] = useState('');
  const [exitedOn, setExitedOn] = useState(today());
  const [leaveOut, setLeaveOut] = useState(Boolean(draft));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState([]);          // [{ person, error, code }]
  const who = people.length === 1 ? `${people[0].name} (${people[0].code ?? ''})` : `${people.length} people`;

  const run = async () => {
    setBusy(true);
    const bad = [];
    let done = 0;
    for (const p of people) {
      try {
        if (act === 'activate') await hrApi.activatePerson(p.id);
        else if (act === 'delete') await hrApi.deletePerson(p.id);
        else {
          await hrApi.deactivatePerson(p.id, {
            reason: reason.trim() || null, exited_on: exitedOn || null, ...(leaveOut && draft ? { leave_out_month: month } : {}),
          });
        }
        done += 1;
      } catch (e) {
        const code = e?.data?.code;
        // Already in the state asked for: nothing to do, not a failure.
        if (code === 'ALREADY_ACTIVE' || code === 'ALREADY_INACTIVE') { done += 1; continue; }
        bad.push({ person: p, error: refusalText(e), code });
      }
    }
    setBusy(false);
    if (!bad.length) { await onDone(`${TITLE[act]}d: ${plural(done)}`); return; }
    setRefused(bad);
    if (done) await onDone(`${TITLE[act]}d: ${plural(done)}; ${bad.length} could not be`, { keepOpen: true });
  };
  const plural = n => `${n} ${n === 1 ? 'person' : 'people'}`;

  // Delete refused for history: deactivate those instead, in place.
  const instead = refused.filter(x => x.code === 'HAS_PAY_HISTORY');

  return (
    <Modal open onClose={onClose} title={`${TITLE[act]} — ${who}`}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{refused.length ? 'Close' : 'Cancel'}</Button>
          {refused.length > 0 && act === 'delete' && instead.length > 0 && (
            <Button variant="secondary" onClick={() => { setPeople(instead.map(x => x.person)); setAct('deactivate'); setRefused([]); }}>Deactivate {instead.length === 1 ? 'them' : `these ${instead.length}`} instead</Button>
          )}
          {!refused.length && (
            <Button variant={act === 'delete' ? 'danger' : 'primary'} onClick={run} disabled={busy}>
              {busy ? 'Working…' : `${TITLE[act]} ${people.length > 1 ? `(${people.length})` : ''}`}
            </Button>
          )}
        </div>
      )}>
      <div className="space-y-3 text-sm">
        {people.length > 1 && (
          <p className="max-h-24 overflow-auto rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-xs text-[#3A3A3C]">
            {people.map(p => `${p.name} (${p.code ?? ''})`).join(', ')}
          </p>
        )}
        {act === 'deactivate' && !refused.length && (
          <>
            <p className="text-xs text-[#515154]">Marked as left. Their history stays; they are no longer on new months.</p>
            <label className="block"><span className="mb-1 block text-xs font-semibold">Left on</span>
              <Input type="date" value={exitedOn} onChange={e => setExitedOn(e.target.value)} /></label>
            {draft
              ? <Checkbox label={`Also leave them out of ${monthLabel(month)}'s payroll`} checked={leaveOut} onChange={e => setLeaveOut(e.target.checked)} />
              : <p className="text-[11px] text-[#86868B]">{monthLabel(month)} is not a draft, so they stay on it; leave them out there once it is sent back.</p>}
            <label className="block"><span className="mb-1 block text-xs font-semibold">Reason (optional)</span>
              <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Left the job" /></label>
          </>
        )}
        {act === 'activate' && !refused.length && <p className="text-xs text-[#515154]">Back to active: they are on the payroll again from the next month worked out.</p>}
        {act === 'delete' && !refused.length && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            Deletes the person for good, with their entries in months not finalised and their matches in uploaded sheets. This cannot be undone.
            Anyone already paid, or with a loan or advances, is not deleted — you can deactivate them instead.
          </p>
        )}
        {refused.length > 0 && (
          <ul className="space-y-1 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            {refused.map(x => <li key={x.person.id}><b>{x.person.name}</b>: {x.error}</li>)}
          </ul>
        )}
      </div>
    </Modal>
  );
}
