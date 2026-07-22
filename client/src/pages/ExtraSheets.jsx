// Extra Sheet Control — the plant's answer to "cutting gave me a few more".
// Every extra board sheet a running job needs is requested by the operator,
// approved by the JOB CARD ISSUER, and physically issued by the WAREHOUSE.
// The issue consumes stock FIFO against the job card and feeds the running
// stage, so wastage math and the traveler stay true.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import { Button, ExportMenu, Field, Input, KpiCard, Modal, PageHeader, rowMatches, SearchInput, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { PackagePlus, ClipboardCheck, Warehouse, Ban, ShieldCheck, Layers, AlertTriangle } from 'lucide-react';
import { GENERAL_WASTAGE_REASONS } from '../sections.js';

const canControl = () => ['admin', 'planner'].includes(auth.user?.role);
const canRequest = () => ['admin', 'planner', 'production'].includes(auth.user?.role);

export default function ExtraSheets() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [approving, setApproving] = useState(null);   // request → approve modal (qty trim + note)
  const [rejecting, setRejecting] = useState(null);   // request → reject modal (reason)
  const [issuing, setIssuing] = useState(null);       // request → warehouse issue confirm
  const [creating, setCreating] = useState(null);     // {job_stage_id, qty, reason, note}

  const load = () => {
    api.get('/extra-sheets').then(setRows);
    api.get('/extra-sheets/eligible').then(setEligible);
  };
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  const kpis = useMemo(() => ({
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    issued_sheets: rows.filter(r => r.status === 'issued').reduce((s, r) => s + r.qty, 0),
    issued_month: rows.filter(r => r.status === 'issued' && r.issued_at
      && new Date(r.issued_at).getMonth() === new Date().getMonth()
      && new Date(r.issued_at).getFullYear() === new Date().getFullYear()).reduce((s, r) => s + r.qty, 0),
    rejected: rows.filter(r => r.status === 'rejected').length,
  }), [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (tab === 'open') out = out.filter(r => ['pending', 'approved'].includes(r.status));
    else if (tab === 'issued') out = out.filter(r => r.status === 'issued');
    else if (tab === 'closed') out = out.filter(r => ['rejected', 'cancelled'].includes(r.status));
    if (q) out = out.filter(r => rowMatches(r, q));
    return out;
  }, [rows, tab, q]);

  const act = async (fn, msg) => { await fn(); toast.success(msg); load(); };

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  const selEligible = eligible.find(e => String(e.job_stage_id) === String(creating?.job_stage_id));

  return (
    <div>
      <PageHeader title="Extra Sheets" subtitle="Controlled re-issue of board to running jobs — operator requests, job card issuer approves, warehouse issues"
        actions={canRequest() && (
          <Button onClick={() => setCreating({ job_stage_id: eligible[0] ? String(eligible[0].job_stage_id) : '', qty: '', reason: '', note: '' })}>
            <PackagePlus size={14} /> New Request
          </Button>
        )} />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Awaiting Approval" value={fmt.num(kpis.pending)} icon={ClipboardCheck}
          chip="bg-amber-50 text-amber-600" accent={kpis.pending ? 'text-amber-600' : 'text-slate-900'} />
        <KpiCard label="Awaiting Issue" value={fmt.num(kpis.approved)} icon={Warehouse}
          chip="bg-brand-50 text-brand-600" accent={kpis.approved ? 'text-brand-700' : 'text-slate-900'} />
        <KpiCard label="Issued This Month" value={fmt.num(kpis.issued_month)} sub="parent sheets" icon={Layers} chip="bg-emerald-50 text-emerald-600" />
        <KpiCard label="Issued All Time" value={fmt.num(kpis.issued_sheets)} sub="parent sheets" icon={PackagePlus} />
        <KpiCard label="Rejected" value={fmt.num(kpis.rejected)} icon={Ban} chip="bg-red-50 text-red-500" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'open', label: 'Open', count: rows.filter(r => ['pending', 'approved'].includes(r.status)).length },
          { key: 'issued', label: 'Issued', count: rows.filter(r => r.status === 'issued').length },
          { key: 'closed', label: 'Rejected / Cancelled', count: rows.filter(r => ['rejected', 'cancelled'].includes(r.status)).length },
          { key: 'all', label: 'All', count: rows.length },
        ]} />
        <div className="mb-4 flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="XS, JC, product, board, operator…" />
          <ExportMenu build={() => ({
            name: `Extra Sheets ${fmt.title(tab)}`,
            title: 'Extra Sheet Requests',
            subtitle: 'Controlled board re-issue · request → approve → issue',
            meta: [`Tab: ${{ open: 'Open', issued: 'Issued', closed: 'Rejected / Cancelled', all: 'All' }[tab]}`, q ? `Search: "${q}"` : null],
            summary: [
              { label: 'Awaiting approval', value: fmt.num(kpis.pending) },
              { label: 'Awaiting issue', value: fmt.num(kpis.approved) },
              { label: 'Issued this month', value: fmt.num(kpis.issued_month) },
              { label: 'Issued all time', value: fmt.num(kpis.issued_sheets) },
              { label: 'Rejected', value: fmt.num(kpis.rejected) },
            ],
            columns: [
              { key: 'xs_number', label: 'Request', export: r => `${r.xs_number} · ${fmt.dt(r.requested_at)}${r.requested_by ? ` · ${r.requested_by}` : ''}` },
              { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number} · ${r.product_name}` },
              { key: 'stage', label: 'Stage', export: r => fmt.stage(r.stage) },
              { key: 'qty', label: 'Parent Sheets', align: 'right', export: r => fmt.num(r.qty) },
              { key: 'board_name', label: 'Board / Stock', export: r => `${r.board_name} · ${fmt.num(r.board_available)} available` },
              { key: 'reason', label: 'Reason', export: r => `${r.reason}${r.note ? ` — ${r.note}` : ''}` },
              { key: 'status', label: 'Status', export: r => fmt.title(r.status) },
              { key: 'trail', label: 'Control Trail', export: r => [
                r.approved_by ? `appr ${r.approved_by}` : null,
                r.issued_by ? `issue ${r.issued_by}` : null,
                r.rejected_by ? `rej ${r.rejected_by} — ${r.reject_reason}` : null,
              ].filter(Boolean).join(' · ') || '—' },
            ],
            rows: filtered,
          })} />
        </div>
      </div>

      <div className="ci-data-panel">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="ci-table-head">
              <th className={`${th} text-right`}>S.No.</th>
              <th className={th}>Request</th><th className={th}>Job Card</th><th className={th}>Stage</th>
              <th className={`${th} text-right`}>Parent Sheets</th><th className={th}>Board / Stock</th>
              <th className={th}>Reason</th><th className={th}>Status</th><th className={th}>Control Trail</th>
              <th className={th} />
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-400">
                  No extra sheet requests in this view. Operators raise them from a running stage on the Live Floor.
                </td></tr>
              )}
              {filtered.map((r, i) => {
                const cpp = Math.max(1, r.children_per_parent || 1);
                const short = r.status !== 'issued' && r.board_available < r.qty;
                return (
                  <tr key={r.id} className="ci-table-row">
                    <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                    <td className={`${td} font-bold text-slate-900`}>{r.xs_number}
                      <div className="text-[11px] font-normal text-slate-400">{fmt.dt(r.requested_at)} · {r.requested_by || '—'}</div>
                    </td>
                    <td className={td}>
                      <div className="font-semibold text-slate-800">{r.jc_number}</div>
                      <div className="text-xs text-slate-400">{r.product_name} · {r.customer_name}</div>
                    </td>
                    <td className={`${td} text-xs`}>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-semibold text-slate-600">{fmt.stage(r.stage)}</span>
                    </td>
                    <td className={`${td} text-right font-bold tabular-nums`}>{fmt.num(r.qty)}
                      {r.stage !== 'cutting' && <div className="text-[11px] font-normal text-slate-400">→ {fmt.num(r.qty * cpp)} print sheets</div>}
                    </td>
                    <td className={`${td} text-xs`}>
                      <div className="text-slate-600">{r.board_name}</div>
                      <div className={`tabular-nums ${short ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                        {short && <AlertTriangle size={11} className="mr-0.5 inline" />}
                        {fmt.num(r.board_available)} available
                      </div>
                    </td>
                    <td className={`${td} text-xs text-slate-500`}>{r.reason}{r.note && <div className="text-[11px] text-slate-400">{r.note}</div>}</td>
                    <td className={td}><StatusBadge status={r.status} /></td>
                    <td className={`${td} text-[11px] text-slate-500`}>
                      {r.approved_by && <div><ShieldCheck size={11} className="mr-0.5 inline text-emerald-500" /> {r.approved_by} · {fmt.dt(r.approved_at)}{r.approval_note ? ` — ${r.approval_note}` : ''}</div>}
                      {r.issued_by && <div><Warehouse size={11} className="mr-0.5 inline text-brand-500" /> {r.issued_by} · {fmt.dt(r.issued_at)}</div>}
                      {r.rejected_by && <div className="text-red-500"><Ban size={11} className="mr-0.5 inline" /> {r.rejected_by} — {r.reject_reason}</div>}
                      {!r.approved_by && !r.rejected_by && r.status === 'pending' && <span className="text-slate-400">awaiting job card issuer</span>}
                    </td>
                    <td className={`${td} text-right`}>
                      <div className="flex justify-end gap-1.5">
                        {r.status === 'pending' && canControl() && (
                          <Button size="sm" onClick={() => setApproving({ req: r, qty: String(r.qty), note: '' })}>
                            <ShieldCheck size={13} /> Approve
                          </Button>
                        )}
                        {r.status === 'approved' && canControl() && (
                          <Button size="sm" variant="success" onClick={() => setIssuing(r)} title="Warehouse: issue the sheets">
                            <Warehouse size={13} /> Issue
                          </Button>
                        )}
                        {['pending', 'approved'].includes(r.status) && canControl() && (
                          <Button size="sm" variant="secondary" onClick={() => setRejecting({ req: r, reason: '' })}>Reject</Button>
                        )}
                        {r.status === 'pending' && canRequest() && !canControl() && (
                          <Button size="sm" variant="secondary" onClick={() =>
                            act(() => api.post(`/extra-sheets/${r.id}/cancel`, {}), `${r.xs_number} cancelled`)}>Cancel</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* New request — planner/operator raising against a running sheet stage */}
      <Modal open={!!creating} onClose={() => setCreating(null)}
        title="New Extra Sheet Request"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
          <Button disabled={!creating?.job_stage_id || !(+creating?.qty > 0) || !creating?.reason} onClick={() =>
            act(async () => {
              const xs = await api.post('/extra-sheets', {
                job_stage_id: +creating.job_stage_id, qty: +creating.qty,
                reason: creating.reason, note: creating.note || undefined,
              });
              setCreating(null);
              return xs;
            }, 'Request raised — pending approval')}>
            <PackagePlus size={13} /> Raise Request
          </Button>
        </>}>
        {creating && (
          <div className="space-y-3">
            {eligible.length === 0 ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-700">
                No running sheet stage right now — extra sheets can only be requested for a job that is
                running (or on hold) at cutting → die cutting.
              </p>
            ) : (
              <>
                <section className="ci-form-panel">
                  <div className="ci-form-panel-title"><span>Running job</span><span>Sheet stages only</span></div>
                  <Field label="Job card · stage" required>
                    <Select value={creating.job_stage_id} onChange={e => setCreating({ ...creating, job_stage_id: e.target.value })}>
                      {eligible.map(e0 => (
                        <option key={e0.job_stage_id} value={e0.job_stage_id} disabled={!!e0.open_request}>
                          {e0.jc_number} · {fmt.stage(e0.stage)} — {e0.product_name}{e0.open_request ? ` (open: ${e0.open_request})` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {selEligible && (
                    <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      Board <b>{selEligible.board_name}</b> · {fmt.num(selEligible.board_available)} parent sheets available ·
                      issued so far {fmt.num(selEligible.sheets_issued)}
                    </p>
                  )}
                </section>
                <section className="ci-form-panel">
                  <div className="ci-form-grid">
                    <Field label="Parent sheets needed" required
                      hint={selEligible && selEligible.stage !== 'cutting' && +creating.qty > 0
                        ? `= ${fmt.num(+creating.qty * Math.max(1, selEligible.children_per_parent || 1))} print sheets after cutting` : undefined}>
                      <Input type="number" min="1" value={creating.qty} onChange={e => setCreating({ ...creating, qty: e.target.value })} />
                    </Field>
                    <Field label="Reason" required>
                      <Select value={creating.reason} onChange={e => setCreating({ ...creating, reason: e.target.value })}>
                        <option value="">Select reason…</option>
                        {GENERAL_WASTAGE_REASONS.map(r0 => <option key={r0} value={r0}>{r0}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="mt-3">
                    <Field label="Note"><Input value={creating.note} placeholder="Optional" onChange={e => setCreating({ ...creating, note: e.target.value })} /></Field>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Approve — the job card issuer's decision, quantity can be trimmed */}
      <Modal open={!!approving} onClose={() => setApproving(null)}
        title={approving ? `Approve ${approving.req.xs_number} — ${approving.req.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setApproving(null)}>Cancel</Button>
          <Button disabled={!(+approving?.qty > 0) || +approving?.qty > approving?.req.qty} onClick={() =>
            act(async () => {
              await api.post(`/extra-sheets/${approving.req.id}/approve`, {
                qty: +approving.qty, note: approving.note || undefined,
              });
              setApproving(null);
            }, `${approving.req.xs_number} approved — warehouse can now issue`)}>
            <ShieldCheck size={13} /> Approve for Issue
          </Button>
        </>}>
        {approving && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              <b>{approving.req.product_name}</b> at {fmt.stage(approving.req.stage)} · requested by {approving.req.requested_by} —
              reason: <b>{approving.req.reason}</b>{approving.req.note ? ` (${approving.req.note})` : ''}
              <div className="mt-1 text-slate-500">
                Board {approving.req.board_name} · {fmt.num(approving.req.board_available)} sheets in stock ·
                job already issued {fmt.num(approving.req.sheets_issued)} parent sheets
              </div>
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-grid">
                <Field label="Approved quantity (parent sheets)" required hint={`Requested: ${fmt.num(approving.req.qty)} — you may trim, not raise`}>
                  <Input type="number" min="1" max={approving.req.qty} value={approving.qty} autoFocus
                    onChange={e => setApproving({ ...approving, qty: e.target.value })} />
                </Field>
                <Field label="Approval note">
                  <Input value={approving.note} placeholder="Optional" onChange={e => setApproving({ ...approving, note: e.target.value })} />
                </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* Reject — either controller, reason mandatory */}
      <Modal open={!!rejecting} onClose={() => setRejecting(null)}
        title={rejecting ? `Reject ${rejecting.req.xs_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" disabled={!rejecting?.reason.trim()} onClick={() =>
            act(async () => {
              await api.post(`/extra-sheets/${rejecting.req.id}/reject`, { reason: rejecting.reason });
              setRejecting(null);
            }, `${rejecting.req.xs_number} rejected`)}>
            <Ban size={13} /> Reject Request
          </Button>
        </>}>
        {rejecting && (
          <section className="ci-form-panel">
            <Field label="Rejection reason" required hint="Goes back to the operator and into the audit trail">
              <Input value={rejecting.reason} autoFocus placeholder="e.g. wastage unexplained — recount first"
                onChange={e => setRejecting({ ...rejecting, reason: e.target.value })} />
            </Field>
          </section>
        )}
      </Modal>

      {/* Issue — the warehouse moves stock; everything updates in one transaction */}
      <Modal open={!!issuing} onClose={() => setIssuing(null)}
        title={issuing ? `Warehouse Issue — ${issuing.xs_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setIssuing(null)}>Cancel</Button>
          <Button variant="success" disabled={issuing?.board_available < issuing?.qty} onClick={() =>
            act(async () => {
              await api.post(`/extra-sheets/${issuing.id}/issue`, {});
              setIssuing(null);
            }, `${issuing.xs_number} issued — ${fmt.num(issuing.qty)} sheets to ${issuing.jc_number}`)}>
            <Warehouse size={13} /> Issue {issuing ? fmt.num(issuing.qty) : ''} Sheets
          </Button>
        </>}>
        {issuing && (
          <div className="space-y-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Issue <b>{fmt.num(issuing.qty)} parent sheets</b> of <b>{issuing.board_name}</b> to{' '}
              <b>{issuing.jc_number}</b> ({issuing.product_name}) at {fmt.stage(issuing.stage)}?
              Approved by {issuing.approved_by}.
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stock after issue</div>
                <div className={`text-sm font-bold ${issuing.board_available - issuing.qty < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                  {fmt.num(issuing.board_available)} → {fmt.num(issuing.board_available - issuing.qty)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{fmt.stage(issuing.stage)} receives</div>
                <div className="text-sm font-bold text-emerald-700">
                  +{fmt.num(issuing.stage === 'cutting' ? issuing.qty : issuing.qty * Math.max(1, issuing.children_per_parent || 1))} {issuing.stage_unit}
                </div>
              </div>
            </div>
            {issuing.board_available < issuing.qty && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                Not enough stock — only {fmt.num(issuing.board_available)} sheets available. Receive board first (GRN → QC release).
              </p>
            )}
            <p className="text-xs text-slate-400">
              Consumes stock FIFO on the ledger against {issuing.jc_number}, raises its issued-sheet count, and the running
              stage's received quantity updates automatically.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
