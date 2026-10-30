// One saved costing, read-only: the figures and the working, what was entered, every revision, and the
// comparison with earlier costings of the same size. An old cost-sheet row shows the figures the sheet
// itself showed, and every place the sheet broke its own rule.
import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, BadgeCheck, Copy, FileSpreadsheet, PencilLine } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ExportMenu, Modal, useToast } from '../../components/ui.jsx';
import { computeCosting, INPUTS, num, styleLabel } from '../../lib/costing.js';
import { costingExportSpec, perUnit, plain, rupees, valueFromSaved } from '../../lib/costingUi.js';
import { ResultCard, SizeKnowledge, Working } from './CostingEditor.jsx';
import { ApprovalChip } from './SingleCosting.jsx';

export default function CostingView({ id, boot, onClose, onRevise, onCostAgain, onChanged }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const load = () => api.get(`/costing/costings/${id}`).then(setC).catch(() => onClose());
  useEffect(() => { if (id) load(); else setC(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const approve = async () => {
    await api.post(`/costing/costings/${c.id}/approve`, {});
    toast.success(`${c.costing_no} approved`);
    await load();
    onChanged?.();
  };

  const archive = async () => {
    await api.post(`/costing/costings/${c.id}/archive`, { archived: !c.archived });
    toast.success(c.archived ? `${c.costing_no} shown again` : `${c.costing_no} hidden from the lists`);
    await load();
    onChanged?.();
  };

  const sheet = c?.source === 'sheet';
  const result = c ? (c.result?.ok ? c.result : computeCosting(c.inputs || {}, c.formula)) : null;
  const formula = boot?.formulas?.find(f => f.key === c?.formula);
  const entered = c ? INPUTS.filter(i => num(c.inputs?.[i.key]) != null) : [];

  return (
    <Modal open={!!id} onClose={onClose} size="xl"
      title={c ? `${c.costing_no} · ${c.product_name}` : 'Costing'}
      footer={c && (
        <>
          <Button variant="secondary" onClick={archive}>{c.archived ? <><ArchiveRestore size={15} className="mr-1.5 inline" />Show again</> : <><Archive size={15} className="mr-1.5 inline" />Hide</>}</Button>
          <ExportMenu build={() => costingExportSpec(c)} />
          {boot?.can_approve && !sheet && !c.archived && c.complete && c.status !== 'approved' && (
            <Button variant="success" onClick={approve}><BadgeCheck size={15} className="mr-1.5 inline" />Approve</Button>
          )}
          <Button variant="secondary" onClick={() => onCostAgain(c.id)}><Copy size={15} className="mr-1.5 inline" />Cost again</Button>
          {!sheet && !c.archived && <Button onClick={() => onRevise(c.id)}><PencilLine size={15} className="mr-1.5 inline" />Revise</Button>}
        </>
      )}>
      {!c ? <div className="p-6 text-sm text-slate-400">Loading…</div> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-white/70 p-4 text-sm sm:grid-cols-3">
              <Item k="Customer" v={c.customer_name || '—'} />
              <Item k="Size" v={c.size_text || '—'} />
              <Item k="Pasting" v={styleLabel(c.style)} />
              <Item k="Costed on" v={c.costed_on || '—'} />
              <Item k="Quantity" v={plain(c.qty, 0)} />
              <Item k="Rules used" v={formula ? formula.label : c.formula} />
              {c.batch_no && <Item k="Bulk costing" v={`${c.batch_no}${c.batch_title ? ` · ${c.batch_title}` : ''}`} />}
              <Item k="Made by" v={c.created_by_name || '—'} />
              {!sheet && <Item k="Approval" v={<ApprovalChip c={c} />} />}
              {c.remarks && <Item k="Remarks" v={c.remarks} wide />}
            </dl>

            {sheet && (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm ring-1 ring-slate-200">
                <div className="mb-1 flex items-center gap-2 font-bold"><FileSpreadsheet size={16} className="text-emerald-700" />From the old cost sheet</div>
                <p className="text-slate-600">Row {c.source_row} of {c.source_file}. Kept exactly as the sheet had it: cost {perUnit(c.sheet_result?.cost_per_unit)}, quote {perUnit(c.sheet_result?.quote_per_unit)}, value {rupees(c.sheet_result?.cost_value)}.</p>
                {c.reproduced === false && (
                  <p className="mt-1 text-amber-800">The row's own inputs give {perUnit(result?.cost_per_unit)} — the sheet broke its own rule on this row (below).</p>
                )}
                {c.notes?.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">{c.notes.map((n, i) => <li key={i}>{n.text}</li>)}</ul>
                )}
              </div>
            )}

            <div className="rounded-2xl bg-white/70 p-4">
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">What was entered</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                {entered.map(i => (
                  <div key={i.key} className="flex justify-between gap-2 border-b border-slate-100 py-0.5">
                    <span className="text-slate-500">{i.label}</span><span className="font-semibold tabular-nums">{plain(num(c.inputs[i.key]), 4)}</span>
                  </div>
                ))}
              </div>
            </div>

            {c.versions?.length > 0 && (
              <div className="rounded-2xl bg-white/70 p-4">
                <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">Revisions</div>
                <ul className="space-y-1 text-sm">
                  {c.versions.map(v => (
                    <li key={v.version} className="flex flex-wrap items-baseline gap-x-2 border-b border-slate-100 py-1">
                      <b>Revision {v.version}</b>
                      <span className="tabular-nums">{v.result?.ok ? perUnit(v.result.cost_per_unit) : 'incomplete'}</span>
                      <span className="text-slate-500">{v.note || '—'}</span>
                      {v.approved_by_name && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-px text-[11px] font-bold text-emerald-800"><BadgeCheck size={11} />approved by {v.approved_by_name}, {v.approved_at}</span>}
                      <span className="ml-auto text-xs text-slate-400">{v.created_by_name} · {v.created_at}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            {sheet ? (
              <div className="glass rounded-2xl p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">The sheet's figures</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums">{perUnit(c.sheet_result?.cost_per_unit ?? c.cost_per_unit)}</div>
                <div className="text-sm text-slate-500">cost per carton · quote {perUnit(c.sheet_result?.quote_per_unit ?? c.quote_per_unit)}</div>
                {result?.ok && <Working lines={result.lines} title="The working, from the row's inputs" />}
              </div>
            ) : <ResultCard result={result} />}
            <SizeKnowledge readOnly value={valueFromSaved(c)} result={result} onChange={() => {}} excludeId={c.id} alertPct={boot?.settings?.alert_pct || 15} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function Item({ k, v, wide }) {
  return (
    <div className={wide ? 'col-span-full' : ''}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k}</dt>
      <dd className="font-semibold text-[#1D1D1F]">{v}</dd>
    </div>
  );
}
