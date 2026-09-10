// The over-issue alarm — the large pop-up that stands between a planner and a
// parent-sheet figure well past what the planning engine worked out.
//
// CI-GANG-0051 is why it exists: the engine said 400 parent sheets, 1,200 was
// typed (the print-sheet count), and the run was saved, locked, cut and
// printed at three times its board without anything ever saying so. The
// server now refuses such a figure with OVER_ISSUE (server/src/over-issue-gate.js)
// until someone answers, and this is where they answer:
//
//   • more than 15% over — one "Are you sure?", Yes or No;
//   • double or more    — Yes, then a second step that asks for the number to
//                         be typed back before the final Yes is live.
//
// Never a block: Yes always gets through, for anyone who holds the planning
// module. No is the default — it has the focus, and Escape or a click outside
// means No.
//
// Screens never touch the dialog directly. They wrap the request in
// useOverIssueGuard's `guard`, which sends it, catches OVER_ISSUE, draws this,
// and re-sends with the planner's answer — so a guarded call either resolves
// with the server's response, or with null when the planner said No.
import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { fmt } from '../api.js';
import { Button, Input, Modal } from './ui.jsx';
import { overIssueVerdict } from '../lib/overIssue.js';

// Where the figure came from, in the planner's words.
const viaSentence = a => {
  if (a.via === 'mix') {
    return `The Board Mix rows add up to ${fmt.num(a.issuing)} parent sheets against the cut plan's ${fmt.num(a.required)}.`;
  }
  if (a.where === 'job_card') {
    return `Planning locked this job at ${fmt.num(a.required)} parent sheets; the job card now says ${fmt.num(a.issuing)}.`;
  }
  return `Typed into "Parent sheets to issue" — the engine worked this ${a.where === 'run' ? 'run' : 'job'} out at ${fmt.num(a.required)}.`;
};

function Tile({ label, value, sub, tone }) {
  return (
    <div className={`rounded-2xl border px-3 py-2.5 ${tone}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 text-[28px] font-extrabold leading-none tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] font-semibold opacity-80">{sub}</div>
    </div>
  );
}

export default function OverIssueAlarm({ alarm, busy = false, onCancel, onConfirm }) {
  const [step, setStep] = useState(1);
  const [typed, setTyped] = useState('');
  const double = alarm.level === 'double';
  const typedOk = String(typed).trim() !== '' && Math.round(Number(typed)) === alarm.issuing;
  const products = Array.isArray(alarm.products) ? alarm.products : [];
  const ref = alarm.ref || 'This plan';

  const yes = () => {
    if (busy) return;
    if (double && step === 1) { setStep(2); return; }
    if (double && !typedOk) return;
    onConfirm();
  };
  const no = () => { if (!busy) onCancel(); };

  return (
    <Modal open layer="nested" size="alarm" onClose={no}
      title={step === 1 ? 'Over-issue alarm — are you sure?' : 'Second confirmation — type the number'}
      footer={<>
        <Button variant="secondary" autoFocus onClick={no} disabled={busy}>No — go back</Button>
        <Button variant="danger" onClick={yes} disabled={busy || (step === 2 && !typedOk)}>
          {busy ? 'Saving…'
            : step === 1 ? `Yes, issue ${fmt.num(alarm.issuing)} sheets`
              : `Yes, I am sure — issue ${fmt.num(alarm.issuing)}`}
        </Button>
      </>}>
      <div className="space-y-3">
        <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${double ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
          <ShieldAlert size={30} className={`mt-0.5 shrink-0 ${double ? 'text-red-600' : 'text-amber-600'}`} />
          <div className="min-w-0">
            <p className="text-[15px] font-bold leading-snug text-[#1D1D1F]">
              You are issuing <span className="tabular-nums">{fmt.num(alarm.issuing)}</span> parent sheets.
              The planning engine needs <span className="tabular-nums">{fmt.num(alarm.required)}</span>.
            </p>
            <p className={`mt-1 text-xs font-semibold ${double ? 'text-red-700' : 'text-amber-700'}`}>
              {ref} — {fmt.num(alarm.excess)} extra parent sheets of board, {alarm.pct}% more than required
              {alarm.ratio >= 2 ? ` (${alarm.ratio}× the requirement)` : ''}.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Tile label="Engine requirement" value={fmt.num(alarm.required)} sub="parent sheets"
            tone="border-slate-200 bg-white text-slate-800" />
          <Tile label="You are issuing" value={fmt.num(alarm.issuing)} sub="parent sheets"
            tone={double ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'} />
          <Tile label="Extra board" value={`+${fmt.num(alarm.excess)}`} sub={`+${alarm.pct}% over`}
            tone={double ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'} />
        </div>

        {alarm.slip && (
          <div className="flex items-start gap-2 rounded-xl border-2 border-red-300 bg-white px-3 py-2.5 text-[13px] leading-snug text-red-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
            <span>
              <b>{fmt.num(alarm.issuing)} is the PRINT-sheet count, not the parent count.</b>{' '}
              {fmt.num(alarm.child_sheets)} print sheets, cut {alarm.cpp} to a parent, is {fmt.num(alarm.required)} parent
              sheets. Did you mean {fmt.num(alarm.required)}?
            </span>
          </div>
        )}

        <p className="text-xs text-slate-600">{viaSentence(alarm)}</p>

        {products.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Order qty</th>
                  <th className="px-3 py-2 text-right">Yield at {fmt.num(alarm.required)}</th>
                  <th className="px-3 py-2 text-right">Yield at {fmt.num(alarm.issuing)}</th>
                  <th className="px-3 py-2 text-right">Extra cartons</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={`${p.code || p.name}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-semibold text-slate-800">
                      {p.name}{p.code ? <span className="ml-1 font-normal text-slate-400">{p.code}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmt.num(p.ordered)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmt.num(p.yield_required)}</td>
                    <td className={`px-3 py-2 text-right font-bold tabular-nums ${double ? 'text-red-700' : 'text-amber-700'}`}>{fmt.num(p.yield_issuing)}</td>
                    <td className={`px-3 py-2 text-right font-bold tabular-nums ${double ? 'text-red-700' : 'text-amber-700'}`}>
                      +{fmt.num(Math.max(0, (p.yield_issuing || 0) - (p.yield_required || 0)))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {step === 2 ? (
          <div className="rounded-2xl border-2 border-red-300 bg-red-50/70 px-4 py-3">
            <p className="text-[13px] font-bold text-red-700">
              This is double the requirement or more. To confirm, type the number of parent sheets you are issuing.
            </p>
            <Input autoFocus inputMode="numeric" value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') yes(); }}
              placeholder={`Type ${alarm.issuing}`}
              className="mt-2 text-lg font-bold tabular-nums" />
            <p className="mt-1 text-[11px] font-semibold text-red-600">
              {typed && !typedOk
                ? `That is not ${fmt.num(alarm.issuing)} — type exactly the figure you are issuing, or go back and correct it.`
                : `Must match ${fmt.num(alarm.issuing)}.`}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">
            {double ? 'Double or more — you will be asked once more, and asked to type the number. ' : ''}
            Your answer is recorded against {ref} with your name.
          </p>
        )}
      </div>
    </Modal>
  );
}

// Live, while the planner is still typing — the same verdict the save will
// reach (lib/overIssue.js is the server rule's twin), said before anyone
// presses anything. Renders nothing inside the rule.
export function OverIssueHint({ required, issuing, childSheets, cpp }) {
  const j = overIssueVerdict({ required, issuing, childSheets, cpp });
  if (j.level === 'none') return null;
  const slip = j.slip;
  const double = j.level === 'double';
  return (
    <div className={`mt-1.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold leading-snug ${double ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
      <AlertTriangle size={13} className="mt-px shrink-0" />
      <span>
        {slip && <>{fmt.num(j.issuing)} is this run's <b>print</b>-sheet count — {fmt.num(childSheets)} print sheets
          ÷ {cpp} per parent = {fmt.num(j.required)} parent sheets. </>}
        +{j.pct}% over the engine's {fmt.num(j.required)}{j.ratio >= 2 ? ` (${j.ratio}×)` : ''} —
        {double ? ' saving or locking will ask you to confirm twice.' : ' saving or locking will ask you to confirm.'}
      </span>
    </div>
  );
}

// Wrap any request that can come back OVER_ISSUE:
//
//   const overIssue = useOverIssueGuard();
//   const d = await overIssue.guard(ack => api.post(url, { ...body, ...(ack ? { ack_over_issue: ack } : {}) }));
//   if (!d) return;            // the planner said No
//   …and render {overIssue.dialog} once, anywhere in the screen.
//
// `send` is called with null first, then again with the answer. Every other
// failure rejects exactly as the bare call would have, so a caller's own catch
// (a collision dialog, a toast) keeps working untouched. If the figures moved
// between the question and the answer, the server asks again and so does this.
export function useOverIssueGuard() {
  const [ask, setAsk] = useState(null);   // { alarm, send, resolve, reject, key }
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const isAlarm = e => e?.data?.code === 'OVER_ISSUE' && !!e.data.over_issue;
  const open = (alarm, send, resolve, reject) => {
    seq.current += 1;
    setAsk({ alarm, send, resolve, reject, key: seq.current });
  };

  const guard = useCallback(send => new Promise((resolve, reject) => {
    Promise.resolve().then(() => send(null)).then(resolve, e => {
      if (isAlarm(e)) open(e.data.over_issue, send, resolve, reject);
      else reject(e);
    });
  }), []);

  const cancel = () => {
    if (!ask || busy) return;
    ask.resolve(null);
    setAsk(null);
  };
  const confirm = async () => {
    const cur = ask;
    if (!cur || busy) return;
    setBusy(true);
    try {
      const out = await cur.send({ required: cur.alarm.required, issuing: cur.alarm.issuing });
      setAsk(null);
      cur.resolve(out);
    } catch (e) {
      if (isAlarm(e)) open(e.data.over_issue, cur.send, cur.resolve, cur.reject);
      else { setAsk(null); cur.reject(e); }
    } finally { setBusy(false); }
  };

  const dialog = ask
    ? <OverIssueAlarm key={ask.key} alarm={ask.alarm} busy={busy} onCancel={cancel} onConfirm={confirm} />
    : null;
  return { guard, dialog };
}
