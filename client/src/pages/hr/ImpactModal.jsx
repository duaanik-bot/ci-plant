// The pop-up for a change that moves payroll already worked out (owner's request 2026-11-14; lib/impact.js).
// Mounted once by pages/HR.jsx. It lists, person by person and month by month, what the change would move —
// payable, advance recovered, loan instalment — before and after, which approvals for payment it undoes, and any
// paid line it leaves as it is. A remark is required; "Approve and apply" sends the change again with it. Closing
// it changes nothing. Only an HR approver can approve (owner, 2026-11-14): for anyone else the server sends
// can_approve false, and the pop-up shows the same list with no approve button and says who must make the change.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { Button, Modal } from '../../components/ui.jsx';
import { inr2, monthLabel } from '../../lib/hr.js';
import { setImpactAsker } from '../../lib/impact.js';

const STATUS = { draft: 'draft', submitted: 'submitted' };
const same = (a, b) => String(a ?? '') === String(b ?? '');

function Move({ from, to }) {
  if (same(from, to)) return <span className="tabular-nums text-[#86868B]">{inr2(to)}</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
      <span className="text-[#86868B] line-through">{from == null ? '—' : inr2(from)}</span>
      <ArrowRight size={11} className="text-[#86868B]" />
      <span className="font-bold text-[#1D1D1F]">{inr2(to)}</span>
    </span>
  );
}

export default function ImpactHost() {
  const [ask, setAsk] = useState(null);           // { data, resolve }
  const [remark, setRemark] = useState('');
  const box = useRef(null);
  useEffect(() => {
    setImpactAsker(data => new Promise(resolve => { setRemark(''); setAsk({ data, resolve }); }));
    return () => setImpactAsker(null);
  }, []);
  useEffect(() => { if (ask) setTimeout(() => box.current?.focus(), 50); }, [ask]);
  if (!ask) return null;
  const { data, resolve } = ask;
  const done = value => { setAsk(null); resolve(value); };
  const rows = Array.isArray(data.impact) ? data.impact : [];
  const paid = Array.isArray(data.paid_unchanged) ? data.paid_unchanged : [];
  const months = [...new Set(rows.map(r => r.month))].sort();
  const later = months.filter(m => m > data.month);
  const canApprove = data.can_approve !== false;
  return (
    <Modal open wide onClose={() => done(null)} title="This change moves payroll already worked out"
      footer={(
        <div className="flex w-full items-center justify-end gap-2">
          {canApprove ? (
            <>
              <Button variant="ghost" onClick={() => done(null)}>Cancel — change nothing</Button>
              <Button onClick={() => done(remark.trim())} disabled={!remark.trim()}>Approve and apply</Button>
            </>
          ) : <Button onClick={() => done(null)}>Close — nothing changed</Button>}
        </div>
      )}>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">{data.what || 'This change'} for {monthLabel(data.month)}
              {later.length ? <> also changes {later.map(monthLabel).join(', ')}</> : null}.</p>
            <p className="mt-0.5 text-xs">{canApprove
              ? 'Check what moves below. Nothing has changed yet: give a remark and approve to apply it, or cancel.'
              : 'Only an HR approver can approve a change like this, so nothing has changed. Ask an approver to make it.'}</p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-[#1D1D1F]/10 bg-white/70">
          <table className="w-full text-xs">
            <thead>
              <tr className="ci-table-head">
                <th className="px-2.5 py-2 text-left">Person</th>
                <th className="px-2.5 py-2 text-left">Payroll month</th>
                <th className="px-2.5 py-2 text-right">Advance recovered</th>
                <th className="px-2.5 py-2 text-right">Loan instalment</th>
                <th className="px-2.5 py-2 text-right">Payable</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.month}:${r.person_id}`} className="border-t border-[#1D1D1F]/[0.05] align-top">
                  <td className="px-2.5 py-2">
                    <div className="font-semibold text-[#1D1D1F]">{r.name || `Person #${r.person_id}`}</div>
                    {r.code && <div className="text-[10px] text-[#86868B]">{r.code}</div>}
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="font-semibold">{monthLabel(r.month)}</div>
                    <div className="text-[10px] text-[#86868B]">{STATUS[r.run_status] || r.run_status}{r.month > data.month ? ' · next month' : ''}</div>
                    {r.approval_undone && <div className="mt-0.5 text-[10px] font-bold text-amber-800">Approval for payment undone</div>}
                  </td>
                  <td className="px-2.5 py-2 text-right"><Move from={r.before?.advance_recovery} to={r.after?.advance_recovery} /></td>
                  <td className="px-2.5 py-2 text-right"><Move from={r.before?.loan_recovery} to={r.after?.loan_recovery} /></td>
                  <td className="px-2.5 py-2 text-right"><Move from={r.before?.payable} to={r.after?.payable} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {paid.length > 0 && (
          <p className="text-xs text-[#515154]">
            Already paid, so left as it is: {paid.map(p => `${p.name || `#${p.person_id}`} (${monthLabel(p.month)})`).join(', ')}.
          </p>
        )}
        {canApprove && <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[#1D1D1F]">Remarks — why this change <span className="text-red-600">*</span></span>
          <textarea ref={box} rows={3} value={remark} onChange={e => setRemark(e.target.value)} maxLength={500}
            placeholder="e.g. Advance paid on 24 Nov for October, deducted in October; November's recovery follows"
            className="w-full rounded-xl border border-[#1D1D1F]/12 bg-white/80 px-3 py-2 text-sm outline-none focus:border-[#007AFF]" />
          <span className="text-[11px] text-[#86868B]">Kept with the change in the audit trail, with who approved it and when.</span>
        </label>}
      </div>
    </Modal>
  );
}
