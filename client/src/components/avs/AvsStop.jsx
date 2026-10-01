// Cancel, delete and redo an AVS check, and the audit trail (owner's request,
// 1 Oct 2026).
//
//   Cancel   stops a set at any stage before its report — also while Claude is
//            checking it: the database then refuses the rest of Claude's run,
//            so no report appears.
//   Delete   a photo set without a report, or a whole report with every check
//            behind it. Nothing is erased: it leaves the lists and the register
//            (and the printing lock), and is kept on record with who, when, why.
//   Redo     after a delete: a new set for the same job cards, the same photos
//            carried over one by one, more can be added, then Verify. Claude
//            gives it a new report number.
//
// Every step, with its reason, is in the audit trail (GET /api/avs/audit).
import { useEffect, useState } from 'react';
import { AlertTriangle, History, Loader2, RotateCcw, Square, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal, useToast } from '../ui.jsx';
import {
  AVS_CANCEL_PRESETS, AVS_DELETE_PRESETS, AVS_REMARK_MAX, AVS_SET_STATUS_LABEL, auditLabel, istStamp, reasonProblem, reportLabel, setLabel,
} from '../../lib/avs.js';

function Presets({ list, value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map(t => {
        const on = String(value || '').trim().startsWith(t);
        return (
          <button key={t} type="button" onClick={() => onPick(t)} aria-pressed={on}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${on
              ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`}>
            {t}
          </button>
        );
      })}
    </div>
  );
}

function ReasonBox({ id, presets, value, onChange }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-slate-600">Why? Pick one, or write your own — saved with your name in the audit trail</div>
      <Presets list={presets} value={value} onPick={onChange} />
      <textarea id={id} value={value} maxLength={AVS_REMARK_MAX} onChange={e => onChange(e.target.value)} placeholder="Reason"
        className="min-h-[60px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
    </div>
  );
}

// ── Cancel ───────────────────────────────────────────────────────────────────
export function CancelDialog({ set, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const problem = reasonProblem(reason, 'Write why it is cancelled');
  const running = set.status === 'checking';
  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      const out = await api.post(`/avs/uploads/${set.id}/cancel`, { reason: reason.trim() });
      toast.success(out.stopped_while_checking
        ? `${setLabel(set.id)} cancelled. Claude's check is stopped; no report will come from it.`
        : `${setLabel(set.id)} cancelled.`);
      onDone?.(out);
    } catch { /* api.js said why */ } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title={`Cancel ${setLabel(set.id)}`}
      footer={<>
        <Button variant="secondary" repeatable onClick={onClose} disabled={saving}>Keep it</Button>
        <Button variant="danger" onClick={save} disabled={!!problem || saving}>
          <span className="inline-flex items-center gap-1.5"><Square size={14} />{saving ? 'Stopping…' : running ? 'Stop the check' : 'Cancel the set'}</span>
        </Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {running
            ? <>Claude is checking this set now ({set.progress || AVS_SET_STATUS_LABEL.checking}). It is stopped at its next step and no report comes out of it.</>
            : <>The set is not checked. Its photos stay on record.</>}
          {' '}To do it again afterwards, use <b>Delete and redo</b> on the cancelled set.
        </p>
        <ReasonBox id="avs-cancel-reason" presets={AVS_CANCEL_PRESETS} value={reason} onChange={setReason} />
      </div>
    </Modal>
  );
}

// ── Delete (a set, or a report), and redo ───────────────────────────────────
// target: { kind: 'set', set } | { kind: 'report', report }
// onRedo(set): the new set, its photos carried over, ready for more photos and Verify.
export function DeleteDialog({ target, onClose, onDone, onRedo }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [redo, setRedo] = useState(true);
  const [stage, setStage] = useState('ask'); // ask → deleting → carrying
  const [carried, setCarried] = useState({ done: 0, total: 0, failed: 0 });
  const isReport = target.kind === 'report';
  const name = isReport ? reportLabel(target.report) : setLabel(target.set.id);
  const problem = reasonProblem(reason, isReport ? 'Write why the report is deleted' : 'Write why it is deleted');
  const busy = stage !== 'ask';

  const save = async () => {
    if (problem || busy) return;
    setStage('deleting');
    let out;
    try {
      out = isReport
        ? await api.post(`/avs/reports/${encodeURIComponent(target.report.report_no)}/delete`, { reason: reason.trim(), redo })
        : await api.post(`/avs/uploads/${target.set.id}/delete`, { reason: reason.trim(), redo });
    } catch { setStage('ask'); return; }
    toast.success(`${name} deleted. It stays on record in the audit trail.`);
    onDone?.(out);
    const fresh = out.replacement;
    if (!fresh) { onClose(); return; }
    // The same photos, one per call (Vercel's limits). A photo that will not
    // come is left out; the person can add it again by hand.
    const list = out.carry || [];
    setCarried({ done: 0, total: list.length, failed: 0 });
    setStage('carrying');
    let last = fresh;
    let failed = 0;
    for (let i = 0; i < list.length; i += 1) {
      try {
        last = await api.post(`/avs/uploads/${fresh.id}/carry`, { photo_id: list[i] });
      } catch {
        try { last = await api.post(`/avs/uploads/${fresh.id}/carry`, { photo_id: list[i] }); } catch { failed += 1; }
      }
      setCarried({ done: i + 1, total: list.length, failed });
    }
    if (failed) toast.error(`${failed} photo${failed === 1 ? '' : 's'} could not be carried over. Add ${failed === 1 ? 'it' : 'them'} again in the new set.`);
    toast.info(`${setLabel(fresh.id)} is ready: add more photos if needed, then press Verify.`);
    onRedo?.(last);
    onClose();
  };

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title={`Delete ${name}`}
      footer={stage === 'ask' ? <>
        <Button variant="secondary" repeatable onClick={onClose}>Keep it</Button>
        <Button variant="danger" onClick={save} disabled={!!problem}>
          <span className="inline-flex items-center gap-1.5">
            {redo ? <RotateCcw size={14} /> : <Trash2 size={14} />}{redo ? 'Delete and redo' : 'Delete'}
          </span>
        </Button>
      </> : null}>
      {stage === 'ask' && (
        <div className="space-y-3">
          {isReport ? (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="font-semibold text-slate-900">{target.report.product_name || target.report.product}</div>
              <div className="mt-0.5 text-xs text-slate-600">
                {target.report.status} · <span className="font-mono">{target.report.job_card || '—'}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="font-semibold text-slate-900">{target.set.product_hint || setLabel(target.set.id)}</div>
              <div className="mt-0.5 text-xs text-slate-600">
                {AVS_SET_STATUS_LABEL[target.set.status] || target.set.status} · {target.set.photos?.length || 0} photos
                {target.set.robot_note ? ` · ${target.set.robot_note}` : ''}
              </div>
            </div>
          )}
          <p className="text-sm text-slate-600">
            {isReport
              ? <>The whole verification goes: every check of {target.report.report_no} and every photo set behind it. It leaves the register and the printing lock, and its number is never used again. Nothing is erased — the PDF in Drive, QA&apos;s decisions and the photos stay on record.</>
              : <>The set leaves the list (it stays under <b>Deleted</b>, with your reason).{target.set.status === 'checking' ? ' Claude\'s check on it is stopped first.' : ''}</>}
          </p>
          {isReport && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              If AVS is mandatory for this job, printing stays locked until the new check is released by QA.
            </p>
          )}
          <ReasonBox id="avs-delete-reason" presets={AVS_DELETE_PRESETS} value={reason} onChange={setReason} />
          <label className="flex items-start gap-2 rounded-lg px-1 py-1 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={redo} onChange={e => setRedo(e.target.checked)} />
            <span>
              <b>Redo it</b> — start a new set for the same job card{isReport ? 's' : ''} with the same photos. You can add more
              photos, then press Verify. Claude checks it afresh under a new report number.
            </span>
          </label>
        </div>
      )}
      {stage === 'deleting' && <p className="flex items-center gap-2 p-2 text-sm text-slate-600"><Loader2 size={15} className="animate-spin" /> Deleting {name}…</p>}
      {stage === 'carrying' && (
        <div className="space-y-2 p-2">
          <p className="flex items-center gap-2 text-sm text-slate-700">
            <Loader2 size={15} className="animate-spin" /> Carrying the photos into the new set: {carried.done} of {carried.total}
            {carried.failed ? ` (${carried.failed} could not be carried)` : ''}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
              style={{ width: `${carried.total ? Math.round((100 * carried.done) / carried.total) : 100}%` }} />
          </div>
          <p className="text-[11px] text-slate-500">Photos in Google Drive take a few seconds each. Keep this open.</p>
        </div>
      )}
    </Modal>
  );
}

// ── The audit trail ─────────────────────────────────────────────────────────
// reportNo: one report's trail (its sets' lines included); none: everything.
const TONE = {
  SET_CANCELLED: 'bg-amber-50 text-amber-800 ring-amber-200',
  SET_DELETED: 'bg-red-50 text-red-700 ring-red-200',
  REPORT_DELETED: 'bg-red-50 text-red-700 ring-red-200',
  REDO_STARTED: 'bg-violet-50 text-violet-700 ring-violet-200',
  DECISION: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  DECISION_UNDONE: 'bg-slate-100 text-slate-700 ring-slate-200',
};
function detailText(e) {
  const d = e.details || {};
  const bits = [];
  if (e.action === 'DECISION' && d.decision) bits.push(d.decision);
  if (e.action === 'DECISION_UNDONE' && d.undone) bits.push(`undid ${d.undone}`);
  if (e.action === 'SET_CANCELLED' && d.was) bits.push(d.was === 'checking' ? `stopped while Claude was checking${d.progress ? ` (${d.progress})` : ''}` : `was ${AVS_SET_STATUS_LABEL[d.was] || d.was}`);
  if (e.action === 'REPORT_DELETED' && Array.isArray(d.sets) && d.sets.length) bits.push(`sets ${d.sets.map(setLabel).join(', ')}`);
  if (e.action === 'REDO_STARTED' && typeof d.redo === 'string') bits.push(d.redo);
  if (e.action === 'PHOTOS_CARRIED' && d.from_set) bits.push(`photo ${d.seq} from ${setLabel(d.from_set)}`);
  if (e.action === 'SET_VERIFIED' && d.photos) bits.push(`${d.photos} photos`);
  if (d.redo === true) bits.push('with redo');
  return bits.join(' · ');
}

export function AuditTrail({ reportNo = null, refreshKey = null, limit = 200 }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const qs = new URLSearchParams({ limit: String(limit) });
    if (reportNo) qs.set('report_no', reportNo);
    api.get(`/avs/audit?${qs}`).then(d => { if (live) setData(d); }).catch(() => { if (live) setData({ entries: [] }); });
    return () => { live = false; };
  }, [open, reportNo, refreshKey, limit]);
  const entries = data?.entries || [];
  return (
    <section>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-800">
        <History size={13} /> Audit trail {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-2">
          {!data && <p className="text-sm text-slate-400">Loading…</p>}
          {data && !entries.length && <p className="text-sm text-slate-500">Nothing recorded yet.</p>}
          {entries.length > 0 && (
            <ol className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {entries.map(e => (
                <li key={e.id} className="rounded-lg bg-white px-3 py-1.5 text-xs ring-1 ring-slate-200">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums text-slate-500">{istStamp(e.at)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TONE[e.action] || 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
                      {auditLabel(e.action)}
                    </span>
                    {e.report_no && !reportNo && <span className="font-mono text-slate-600">{e.report_no}</span>}
                    {e.set_id && <span className="font-mono text-slate-600">{setLabel(e.set_id)}</span>}
                    <span className="text-slate-700">{e.actor || '—'}{e.actor_role ? ` (${e.actor_role})` : ''}</span>
                  </div>
                  {(e.reason || detailText(e)) && (
                    <div className="mt-0.5 text-slate-600">
                      {e.reason ? <span>“{e.reason}”</span> : null}
                      {e.reason && detailText(e) ? ' · ' : ''}
                      {detailText(e)}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
