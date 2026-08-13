// Extra Sheet Control — the plant's controlled refill loop when a running job
// needs more sheets. Approval re-fires a linked Cutting counter, then Cutting's
// final handoff consumes stock and refills the target stage.
import { useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { Button, ExportMenu, Field, Input, KpiCard, KpiFilterNotice, Modal, PageHeader, ResetFilters, rowMatches, SearchInput, searchText, Select, StatusBadge, Tabs, useFilterReset, useKpiFilter, useToast } from '../components/ui.jsx';
import { ThreadCell, unreadRowClass } from '../components/ThreadCell.jsx';
import { PackagePlus, ClipboardCheck, Warehouse, Ban, ShieldCheck, Layers, AlertTriangle, Scissors, Undo2 } from 'lucide-react';
import { GENERAL_WASTAGE_REASONS } from '../sections.js';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';

// One batched call paints the thread cells for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

const canRequest = () => ['admin', 'planner', 'production'].includes(auth.user?.role);
// Approve/reject is the PLANT HEAD's decision alone — the xs_approver grant
// from Masters → Users (the Plant login, operated by Dharminder), refreshed by
// /auth/me on shell load. The server re-checks the flag on every decision, so
// this only controls what the page shows.
const canDecide = () => +(auth.user?.xs_approver ?? 0) === 1;
const CANCELLABLE_STATUSES = ['pending', 'approved', 'sent_to_cutting'];
const canCancel = r => CANCELLABLE_STATUSES.includes(r.status)
  && canRequest()
  && (canDecide() || Number(r.requested_by_id) === Number(auth.user?.id));
const OPEN_STATUSES = ['pending', 'approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing'];
const CUTTING_STATUSES = ['approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing'];
const APPROVAL_REVERSE_STATUSES = ['approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing', 'issued'];

// Same status tests the cards counted with; "received this month" repeats the
// month arithmetic from kpis so the card and its filter cannot drift apart.
const sameMonth = s => {
  const d = s ? new Date(s) : null;
  if (!d || Number.isNaN(+d)) return false;
  const n = new Date();
  return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
};
const XS_KPI_ROWS = {
  pending: r => r.status === 'pending',
  approved: r => CUTTING_STATUSES.includes(r.status),
  issued: r => r.status === 'issued',
  issued_month: r => r.status === 'issued' && sameMonth(r.issued_at),
  rejected: r => ['rejected', 'reversed'].includes(r.status),
};
const XS_KPI_LABEL = {
  pending: 'requests waiting for approval',
  approved: 'requests approved and waiting on Cutting / Printing receipt',
  issued: 'requests received by Printing and closed',
  issued_month: 'requests received by Printing this month',
  rejected: 'rejected or reversed requests',
};

export default function ExtraSheets() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [approving, setApproving] = useState(null);   // request → approve modal (qty trim + note)
  const [rejecting, setRejecting] = useState(null);   // request → reject modal (reason)
  const [reversing, setReversing] = useState(null);   // request → reverse approval
  const [creating, setCreating] = useState(null);     // {job_stage_id, qty, reason, note}
  const [threads, setThreads] = useState({});

  const load = () => Promise.all([
    api.get('/extra-sheets').then(rs => {
      setRows(rs);
      threadSummary('extra_sheet', rs.map(r => r.id)).then(setThreads).catch(() => {});
    }),
    api.get('/extra-sheets/eligible').then(setEligible),
  ]).catch(() => {});
  useFallbackRefresh(load, { intervalMs: 60000 });
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 500 });

  const kpis = useMemo(() => ({
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => CUTTING_STATUSES.includes(r.status)).length,
    issued_sheets: rows.filter(r => r.status === 'issued').reduce((s, r) => s + (r.cutting_actual_qty || r.qty), 0),
    issued_month: rows.filter(r => r.status === 'issued' && r.issued_at
      && new Date(r.issued_at).getMonth() === new Date().getMonth()
      && new Date(r.issued_at).getFullYear() === new Date().getFullYear()).reduce((s, r) => s + (r.cutting_actual_qty || r.qty), 0),
    rejected: rows.filter(r => ['rejected', 'reversed'].includes(r.status)).length,
  }), [rows]);

  const kpi = useKpiFilter(tab);
  const filters = useFilterReset([
    [q, setQ, '', 'search'],
    [kpi.keys, kpi.clear, [], 'KPI card'],
  ]);
  const searched = useMemo(() => {
    let out = rows;
    if (tab === 'open') out = out.filter(r => OPEN_STATUSES.includes(r.status));
    else if (tab === 'issued') out = out.filter(r => r.status === 'issued');
    else if (tab === 'closed') out = out.filter(r => ['rejected', 'cancelled', 'reversed'].includes(r.status));
    if (q) out = out.filter(r => rowMatches(r, q, productSearchText(r)));
    return out;
  }, [rows, tab, q]);
  // The strip is request-book-wide while the tabs split open/issued/closed, so a
  // card can name rows this tab does not hold — "Rejected" from the Open tab
  // selects nothing. The notice says so plainly rather than looking broken.
  const filtered = kpi.apply(searched, XS_KPI_ROWS);

  const act = async (fn, msg) => { await fn(); toast.success(msg); load(); };

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  const selEligible = eligible.find(e => String(e.job_stage_id) === String(creating?.job_stage_id));
  // Hand-mounted: this page paints its own <table>, so the row tint is applied
  // to the <tr> the same way DataTable's rowClass would.
  const threadRowClass = unreadRowClass(threads, r => r.id);

  return (
    <div>
      <PageHeader title="Extra Sheets" subtitle="Controlled re-issue of board to running jobs — request, approval, Cutting re-fire, Printing receipt"
        actions={canRequest() && (
          <Button onClick={() => setCreating({ job_stage_id: eligible[0] ? String(eligible[0].job_stage_id) : '', qty: '', reason: '', note: '' })}>
            <PackagePlus size={14} /> New Request
          </Button>
        )} />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Awaiting Approval" value={fmt.num(kpis.pending)} icon={ClipboardCheck}
          chip="bg-amber-50 text-amber-600" accent={kpis.pending ? 'text-amber-600' : 'text-slate-900'}
          onClick={() => kpi.toggle('pending')} active={kpi.is('pending')} />
        <KpiCard label="In Cutting Loop" value={fmt.num(kpis.approved)} icon={Scissors}
          chip="bg-brand-50 text-brand-600" accent={kpis.approved ? 'text-brand-700' : 'text-slate-900'}
          onClick={() => kpi.toggle('approved')} active={kpi.is('approved')} />
        <KpiCard label="Received This Month" value={fmt.num(kpis.issued_month)} sub="parent sheets" icon={Layers} chip="bg-emerald-50 text-emerald-600"
          onClick={() => kpi.toggle('issued_month')} active={kpi.is('issued_month')} />
        <KpiCard label="Received All Time" value={fmt.num(kpis.issued_sheets)} sub="parent sheets" icon={PackagePlus}
          onClick={() => kpi.toggle('issued')} active={kpi.is('issued')} />
        <KpiCard label="Rejected / Reversed" value={fmt.num(kpis.rejected)} icon={Ban} chip="bg-red-50 text-red-500"
          onClick={() => kpi.toggle('rejected')} active={kpi.is('rejected')} />
      </div>
      <KpiFilterNotice filter={kpi} label={XS_KPI_LABEL[kpi.key]}
        shown={filtered.length} total={searched.length} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'open', label: 'Open', count: rows.filter(r => OPEN_STATUSES.includes(r.status)).length },
          { key: 'issued', label: 'Received / Closed', count: rows.filter(r => r.status === 'issued').length },
          { key: 'closed', label: 'Rejected / Reversed', count: rows.filter(r => ['rejected', 'cancelled', 'reversed'].includes(r.status)).length },
          { key: 'all', label: 'All', count: rows.length },
        ]} />
        <div className="mb-4 flex items-center gap-2">
          <SearchInput className="w-80" value={q} onChange={setQ} placeholder="XS, JC, product, board, operator…" />
          <ResetFilters filters={filters} />
          <ExportMenu build={() => ({
            name: `Extra Sheets ${fmt.title(tab)}`,
            title: 'Extra Sheet Requests',
            subtitle: 'Controlled board re-issue · request → approve → cut → receive',
            meta: [`Tab: ${{ open: 'Open', issued: 'Received', closed: 'Rejected / Reversed', all: 'All' }[tab]}`, q ? `Search: "${q}"` : null],
            summary: [
              { label: 'Awaiting approval', value: fmt.num(kpis.pending) },
              { label: 'In cutting loop', value: fmt.num(kpis.approved) },
              { label: 'Received this month', value: fmt.num(kpis.issued_month) },
              { label: 'Received all time', value: fmt.num(kpis.issued_sheets) },
              { label: 'Rejected / reversed', value: fmt.num(kpis.rejected) },
            ],
            columns: [
              { key: 'xs_number', label: 'Request', export: r => `${r.xs_number} · ${fmt.dt(r.requested_at)}${r.requested_by ? ` · ${r.requested_by}` : ''}` },
              { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number} · ${productExport(r)}` },
              { key: 'stage', label: 'Stage', export: r => fmt.stage(r.stage) },
              { key: 'qty', label: 'Parent Sheets', align: 'right', export: r => fmt.num(r.qty) },
              { key: 'board_name', label: 'Board / Stock', export: r => `${r.board_name} · ${fmt.num(r.board_free)} beyond booked jobs` },
              { key: 'reason', label: 'Reason', export: r => `${r.reason}${r.note ? ` — ${r.note}` : ''}` },
              { key: 'status', label: 'Status', export: r => fmt.title(r.status) },
              { key: 'trail', label: 'Control Trail', export: r => [
                r.approved_by ? `appr ${r.approved_by}` : null,
                r.issued_by ? `received ${r.issued_by}` : null,
                r.rejected_by ? `rej ${r.rejected_by} — ${r.reject_reason}` : null,
                r.reversed_by ? `rev ${r.reversed_by} — ${r.reverse_reason}` : null,
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
              <th className={th} /><th className={th} />
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-sm text-slate-400">
                  No extra sheet requests in this view. Operators raise them from a running stage on the Live Floor.
                </td></tr>
              )}
              {filtered.map((r, i) => {
                // PLANNED-BOARD RULE: extra sheets are issued against the
                // PLANNED board, so the parent→child conversion uses that
                // board's CHOSEN cuts when the job carries a mix
                // (planned_cuts, from XS_VIEW), else the legacy cpp.
                const cpp = Math.max(1, r.planned_cuts || r.children_per_parent || 1);
                const short = r.status === 'pending' && r.board_free < r.qty;
                return (
                  <tr key={r.id} className={`ci-table-row ${threadRowClass(r)}`}>
                    <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                    <td className={`${td} font-bold text-slate-900`}>{r.xs_number}
                      <div className="text-[11px] font-normal text-slate-400">{fmt.dt(r.requested_at)} · {r.requested_by || '—'}</div>
                    </td>
                    <td className={td}>
                      <div className="font-semibold text-slate-800">{r.jc_number}</div>
                      <ProductIdentity row={r} compact meta={r.customer_name} />
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
                        {fmt.num(r.board_free)} beyond booked jobs
                      </div>
                    </td>
                    <td className={`${td} text-xs text-slate-500`}>{r.reason}{r.note && <div className="text-[11px] text-slate-400">{r.note}</div>}</td>
                    <td className={td}><StatusBadge status={r.status} /></td>
                    <td className={`${td} text-[11px] text-slate-500`}>
                      {r.approved_by && <div><ShieldCheck size={11} className="mr-0.5 inline text-emerald-500" /> {r.approved_by} · {fmt.dt(r.approved_at)}{r.approval_note ? ` — ${r.approval_note}` : ''}</div>}
                      {r.sent_to_cutting_at && <div><Scissors size={11} className="mr-0.5 inline text-amber-600" /> sent to Cutting · {fmt.dt(r.sent_to_cutting_at)}</div>}
                      {r.cutting_started_at && <div><Scissors size={11} className="mr-0.5 inline text-cyan-600" /> {r.cutting_started_by || 'Cutting'} started · {fmt.dt(r.cutting_started_at)}</div>}
                      {r.cutting_completed_at && (
                        <div><Scissors size={11} className="mr-0.5 inline text-teal-600" />
                          cut {fmt.num(r.cutting_actual_qty || 0)} · waste {fmt.num(r.cutting_wastage_qty || 0)} · ready {fmt.num(r.issued_stage_qty || 0)}
                        </div>
                      )}
                      {r.issued_by && <div><Warehouse size={11} className="mr-0.5 inline text-brand-500" /> received by Printing · {fmt.dt(r.issued_at)}</div>}
                      {r.rejected_by && <div className="text-red-500"><Ban size={11} className="mr-0.5 inline" /> {r.rejected_by} — {r.reject_reason}</div>}
                      {r.reversed_by && <div className="text-red-600"><Undo2 size={11} className="mr-0.5 inline" /> approval reversed by {r.reversed_by} · {fmt.dt(r.reversed_at)} — {r.reverse_reason}</div>}
                      {!r.approved_by && !r.rejected_by && r.status === 'pending' && <span className="text-slate-400">awaiting plant head approval</span>}
                    </td>
                    <td className={td}><ThreadCell entity="extra_sheet" id={r.id} summary={threads[r.id]} /></td>
                    <td className={`${td} text-right`}>
                      <div className="flex justify-end gap-1.5">
                        {r.status === 'pending' && canDecide() && (
                          <Button size="sm" onClick={() => setApproving({ req: r, qty: String(r.qty), note: '' })}>
                            <ShieldCheck size={13} /> Approve
                          </Button>
                        )}
                        {OPEN_STATUSES.includes(r.status) && canDecide() && (
                          <Button size="sm" variant="secondary" onClick={() => setRejecting({ req: r, reason: '' })}>Reject</Button>
                        )}
                        {APPROVAL_REVERSE_STATUSES.includes(r.status) && canDecide() && (
                          <Button size="sm" variant="secondary" onClick={() => setReversing({ req: r, reason: '' })}>
                            <Undo2 size={13} /> Reverse
                          </Button>
                        )}
                        {canCancel(r) && (
                          <Button size="sm" variant="secondary" onClick={() =>
                            act(() => api.post(`/extra-sheets/${r.id}/cancel`, {}), `${r.xs_number} cancelled`)}>Cancel Request</Button>
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
                        <option key={e0.job_stage_id} value={e0.job_stage_id} disabled={!!e0.open_request} data-search={searchText(e0)}>
                          {e0.jc_number} · {fmt.stage(e0.stage)} — {e0.product_name}{e0.open_request ? ` (open: ${e0.open_request})` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {selEligible && (
                    <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      Board <b>{selEligible.board_name}</b> · {fmt.num(selEligible.board_free)} parent sheets beyond every booked requirement — this job's own included, extras come on top of it (of {fmt.num(selEligible.board_available)} on the shelf) ·
                      issued so far {fmt.num(selEligible.sheets_issued)}
                    </p>
                  )}
                </section>
                <section className="ci-form-panel">
                  <div className="ci-form-grid">
                    <Field label="Parent sheets needed" required
                      hint={selEligible && selEligible.stage !== 'cutting' && +creating.qty > 0
                        // Planned-board rule: chosen cuts under a mix, else legacy cpp.
                        ? `= ${fmt.num(+creating.qty * Math.max(1, selEligible.planned_cuts || selEligible.children_per_parent || 1))} print sheets after cutting` : undefined}>
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

      {/* Approve — the plant head's decision, quantity can be trimmed */}
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
            }, `${approving.req.xs_number} approved — sent to Cutting`)}>
            <ShieldCheck size={13} /> Approve & Send to Cutting
          </Button>
        </>}>
        {approving && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              <ProductIdentity row={approving.req} compact />
              <span> at {fmt.stage(approving.req.stage)} · requested by {approving.req.requested_by} —
              reason: <b>{approving.req.reason}</b>{approving.req.note ? ` (${approving.req.note})` : ''}
              </span>
              <div className="mt-1 text-slate-500">
                Board {approving.req.board_name} · {fmt.num(approving.req.board_free)} sheets beyond booked jobs (this one's own base included) of {fmt.num(approving.req.board_available)} in stock ·
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

      {/* Reverse approval — plant-head override for an accidental approval */}
      <Modal open={!!reversing} onClose={() => setReversing(null)}
        title={reversing ? `Reverse Approval — ${reversing.req.xs_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReversing(null)}>Cancel</Button>
          <Button variant="danger" disabled={!reversing?.reason.trim()} onClick={() =>
            act(async () => {
              await api.post(`/extra-sheets/${reversing.req.id}/reverse`, { reason: reversing.reason });
              setReversing(null);
            }, `${reversing.req.xs_number} approval reversed`)}>
            <Undo2 size={13} /> Reverse Approval
          </Button>
        </>}>
        {reversing && (
          <section className="ci-form-panel space-y-3">
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              This removes the extra-sheet approval from the active flow. If Printing already received the sheets,
              the system will return the parent sheets to stock unless Printing has already consumed them.
            </p>
            <Field label="Reverse reason" required hint="Goes into the Job Card and Extra Sheets audit trail">
              <Input value={reversing.reason} autoFocus placeholder="e.g. approved against the wrong job"
                onChange={e => setReversing({ ...reversing, reason: e.target.value })} />
            </Field>
          </section>
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

    </div>
  );
}
