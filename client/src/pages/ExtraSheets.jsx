// Extra Sheet Control — the plant's controlled refill loop when a running job
// needs more sheets. Approval re-fires a linked Cutting counter, then Cutting's
// final handoff consumes stock and refills the target stage.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { Button, Checkbox, ExportMenu, Field, Input, KpiCard, KpiFilterNotice, Modal, PageHeader, ResetFilters, rowMatches, SearchInput, searchText, Select, StatusBadge, Tabs, useFilterReset, useKpiFilter, useToast } from '../components/ui.jsx';
import { ThreadCell, unreadRowClass } from '../components/ThreadCell.jsx';
import { PackagePlus, ClipboardCheck, Warehouse, Ban, ShieldCheck, Layers, AlertTriangle, Scissors, Undo2, Replace, Check, Lock } from 'lucide-react';
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

// Which tab holds a request. An extra-sheet notification names a REQUEST, and
// the request can be in any of the three — so a deep link that did not switch
// tabs would open "Open" and honestly show nothing for a rejected one.
const tabOfStatus = status => (OPEN_STATUSES.includes(status) ? 'open' : status === 'issued' ? 'issued' : 'closed');

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

// ── The warehouse pick ─────────────────────────────────────────────────────
//
// Every figure below comes off the SERVER's verdict for that board. The two the
// dialog recomputes — yield and short — are recomputed with the server's own
// formula against the live quantity box, so the approver watches them move as
// he trims. The server re-judges the lot inside the approval transaction, so a
// stale dialog cannot approve terms nobody saw; it only ever gets a 409 back.
const yieldOf = (opt, qty, stage) =>
  stage === 'cutting' ? Math.max(0, qty) : Math.max(0, qty) * Math.max(1, opt?.cuts || 1);
const parentsFor = (printSheets, cuts) =>
  (printSheets > 0 && cuts > 0) ? Math.ceil(printSheets / cuts) : null;

const AXIS_CHIP = {
  grade: { label: 'different grade', cls: 'bg-red-50 text-red-600 ring-red-100' },
  gsm:   { label: 'GSM moves',       cls: 'bg-amber-50 text-amber-700 ring-amber-100' },
  size:  { label: 'different size',  cls: 'bg-amber-50 text-amber-700 ring-amber-100' },
  cuts:  { label: 'cuts change',     cls: 'bg-red-50 text-red-600 ring-red-100' },
};
const Chip = ({ cls, children }) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}`}>{children}</span>
);

// One board on the shelf, as the plant head has to weigh it: what it is, how
// much of it he may have, and what changes if he takes it.
function BoardOption({ opt, qty, stage, selected, onPick }) {
  const short = !opt.blocked && opt.free < qty;
  const y = yieldOf(opt, qty, stage);
  return (
    <button type="button" disabled={opt.blocked} onClick={() => onPick(opt)}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition
        ${opt.blocked ? 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-60'
          : selected ? 'border-brand-400 bg-brand-50/70 ring-2 ring-brand-200'
          : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/30'}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected && <Check size={13} className="text-brand-600" />}
        <span className="text-sm font-bold text-slate-800">{opt.name}</span>
        {opt.planned && <Chip cls="bg-brand-50 text-brand-700 ring-brand-100">planned board</Chip>}
        {!opt.planned && opt.kind === 'exact' && <Chip cls="bg-emerald-50 text-emerald-700 ring-emerald-100">identical spec</Chip>}
        {opt.leftover && <Chip cls="bg-slate-100 text-slate-500 ring-slate-200">leftover</Chip>}
        {!opt.blocked && opt.cautions.map(c => (
          <Chip key={c.axis} cls={AXIS_CHIP[c.axis]?.cls || 'bg-slate-100 text-slate-500 ring-slate-200'}>
            {AXIS_CHIP[c.axis]?.label || c.axis}
          </Chip>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
        <span>{opt.size_label}{opt.gsm ? ` · ${opt.gsm} GSM` : ''}{opt.grade ? ` · ${opt.grade}` : ''}</span>
        {!opt.blocked && (
          <span className="tabular-nums">
            <b className={short ? 'text-amber-700' : 'text-emerald-700'}>{fmt.num(opt.free)}</b> free
            {opt.committed_elsewhere > 0 && <span className="text-slate-400"> · {fmt.num(opt.committed_elsewhere)} booked elsewhere</span>}
            <span className="text-slate-400"> · {fmt.num(opt.shelf)} on the shelf</span>
          </span>
        )}
        {!opt.blocked && (
          <span className="tabular-nums font-semibold text-slate-600">
            {opt.cuts} up → {fmt.num(y)} print sheets
          </span>
        )}
      </div>
      {opt.blocked && (
        <div className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-slate-500">
          <Lock size={11} className="mt-0.5 shrink-0" /> {opt.block_reason}
        </div>
      )}
      {short && !opt.blocked && (
        <div className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-amber-700">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          {opt.shelf < qty
            ? `Only ${fmt.num(opt.shelf)} sheets physically on the shelf.`
            : `${fmt.num(opt.free)} free — the other ${fmt.num(opt.committed_elsewhere)} are booked to other jobs.`}
        </div>
      )}
    </button>
  );
}

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
  // The warehouse pick. `board` is the full server verdict for the board the
  // approval will run on — never a bare id, because every number the dialog
  // shows (cuts, yield, free, what it costs) comes off that verdict, and a
  // second client-side derivation of any of them is a second place to be wrong.
  const [picker, setPicker] = useState(null);         // {options, planned_cuts, ...} | 'loading'
  const [pickQ, setPickQ] = useState('');
  // /extra-sheets?xs=7 — the request a notification named. The bell used to
  // link at the page, which opened the request book at whatever sorted first.
  const [params] = useSearchParams();
  const focusXs = Number(params.get('xs')) || null;
  const focusedOnce = useRef(null);

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

  // Bring the named request into view: the right tab, no filter left hiding it,
  // and the row itself scrolled to and ringed. Runs once per target — the
  // planner's own filtering after they have arrived is theirs to keep.
  useEffect(() => {
    if (!focusXs || !rows.length || focusedOnce.current === focusXs) return;
    const r = rows.find(x => Number(x.id) === focusXs);
    if (!r) return;
    focusedOnce.current = focusXs;
    filters.reset();
    setTab(tabOfStatus(r.status));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`[data-row-id="${CSS.escape(String(focusXs))}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }, [focusXs, rows]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn, msg) => { await fn(); toast.success(msg); load(); };

  // Opening the approval loads the warehouse with it. The plant head should not
  // have to guess whether an alternative exists before he goes looking for one —
  // if the planned board is short, the answer is already on the screen.
  const openApprove = async r => {
    setApproving({ req: r, qty: String(r.qty), note: '', board: null, substitute_reason: '', allow_committed: false, browsing: false });
    setPickQ('');
    setPicker('loading');
    try {
      const p = await api.get(`/extra-sheets/${r.id}/board-options?qty=${r.qty}`);
      setPicker(p);
      const planned = p.options.find(o => o.planned);
      // Pre-select the planned board so the dialog opens on exactly the
      // approval it has always been, and open the shelf unprompted only when
      // that board cannot cover the request.
      setApproving(a => a && a.req.id === r.id
        ? { ...a, board: planned || null, browsing: !!planned && planned.free < r.qty }
        : a);
    } catch { setPicker(null); }
  };

  const pickBoard = opt => setApproving(a => ({
    ...a, board: opt, browsing: false,
    // Moving back to the planned board drops the deviation paperwork with it —
    // a stale reason left on the payload is a lie in the audit trail.
    substitute_reason: opt.planned ? '' : a.substitute_reason,
    allow_committed: opt.planned ? false : a.allow_committed,
  }));

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  const selEligible = eligible.find(e => String(e.job_stage_id) === String(creating?.job_stage_id));

  // ── The approval's live arithmetic ──────────────────────────────────────
  // Derived from the SERVER's verdict for the selected board plus whatever is
  // in the quantity box right now, so the yield moves as the plant head trims.
  const approveQty = Math.max(0, Math.round(+approving?.qty || 0));
  const substituting = !!(approving?.board && !approving.board.planned);
  const boardShort = !!(approving?.board && approving.board.free < approveQty);
  const approveYield = approving?.board ? yieldOf(approving.board, approveQty, approving.req.stage) : 0;
  const cutsMoved = !!(picker && picker !== 'loading' && approving?.board
    && approving.board.cuts !== picker.planned_cuts);
  // "I was short 200 print sheets and this sheet only cuts 2 up" — how many
  // parents of THIS board buy what the request was actually asking for.
  const matchParents = cutsMoved && picker !== 'loading'
    ? parentsFor(picker.planned_yield, approving.board.cuts) : null;

  const visibleOptions = useMemo(() => {
    const all = (picker && picker !== 'loading' ? picker.options : []) || [];
    if (!pickQ.trim()) return all;
    return all.filter(o => rowMatches(o, pickQ, `${o.size_label} ${o.grade || ''} ${o.gsm || ''}`));
  }, [picker, pickQ]);

  // The same three conditions the server's gate enforces, so the button is dark
  // exactly when the POST would come back 409 — never the other way round. The
  // server stays the judge; this only stops a pointless round trip.
  const approveReady = !!approving?.board
    && approveQty > 0 && approveQty <= approving.req.qty
    && !approving.board.blocked
    && (!substituting || approving.substitute_reason.trim().length > 0)
    && (!boardShort || (substituting && approving.allow_committed && approving.board.shelf >= approveQty));
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
                // The parent→child conversion follows the board that will
                // actually be CUT. effective_cuts is that board's own count:
                // the cuts stored at approval (geometry, for a substitute),
                // else the planned board's chosen cuts under a mix, else the
                // legacy cpp. Reading planned_cuts here printed the PLANNED
                // board's 4-up against a request approved onto a 2-up sheet.
                const cpp = Math.max(1, r.effective_cuts || r.planned_cuts || r.children_per_parent || 1);
                const short = r.status === 'pending' && r.board_free < r.qty;
                return (
                  <tr key={r.id} data-row-id={r.id}
                    className={`ci-table-row ${threadRowClass(r)} ${Number(r.id) === focusXs ? '!bg-amber-50 ring-2 ring-inset ring-amber-400' : ''}`}>
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
                      {r.board_substituted && (
                        <div className="text-[11px] font-semibold text-amber-700" title={`Planned board: ${r.planned_board_name}`}>
                          <Replace size={11} className="mr-0.5 inline" />
                          substituted for {r.planned_board_name}
                        </div>
                      )}
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
                          <Button size="sm" onClick={() => openApprove(r)}>
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

      {/* Approve — the plant head's decision: how many, and OFF WHICH BOARD */}
      <Modal open={!!approving} onClose={() => { setApproving(null); setPicker(null); }} wide
        title={approving ? `Approve ${approving.req.xs_number} — ${approving.req.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => { setApproving(null); setPicker(null); }}>Cancel</Button>
          <Button disabled={!approveReady} onClick={() =>
            act(async () => {
              await api.post(`/extra-sheets/${approving.req.id}/approve`, {
                qty: +approving.qty,
                note: approving.note || undefined,
                // Only ever sent when the plant head actually moved off the
                // planned board — an unchanged approval posts the payload it
                // always did, and takes the path it always took.
                board_material_id: substituting ? approving.board.id : undefined,
                substitute_reason: substituting ? approving.substitute_reason : undefined,
                allow_committed: substituting && boardShort ? true : undefined,
              });
              setApproving(null); setPicker(null);
            }, substituting
              ? `${approving.req.xs_number} approved on ${approving.board.name} — sent to Cutting`
              : `${approving.req.xs_number} approved — sent to Cutting`)}>
            <ShieldCheck size={13} /> Approve &amp; Send to Cutting
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
                Job already issued {fmt.num(approving.req.sheets_issued)} parent sheets
                {picker?.product?.child_l ? ` · print sheet ${picker.product.child_l}×${picker.product.child_w}″` : ''}
                {picker?.product?.parent_l ? ` · parent ${picker.product.parent_l}×${picker.product.parent_w}″` : ''}
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

            {/* ── The board this will actually come off ───────────────────── */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">
                <span>Board</span>
                <span>{picker === 'loading' ? 'reading the warehouse…'
                  : `${(picker?.options || []).filter(o => !o.blocked).length} boards on the shelf`}</span>
              </div>

              {picker === 'loading' && <p className="py-3 text-center text-xs text-slate-400">Reading the warehouse…</p>}

              {picker && picker !== 'loading' && approving.board && (
                <>
                  <div className={`rounded-xl border px-3 py-2.5 ${substituting
                    ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-bold text-slate-800">{approving.board.name}</span>
                          {substituting
                            ? <Chip cls="bg-amber-100 text-amber-800 ring-amber-200">substituted</Chip>
                            : <Chip cls="bg-brand-50 text-brand-700 ring-brand-100">planned board</Chip>}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {approving.board.size_label}{approving.board.gsm ? ` · ${approving.board.gsm} GSM` : ''}
                          {approving.board.grade ? ` · ${approving.board.grade}` : ''} ·{' '}
                          <b className={boardShort ? 'text-amber-700' : 'text-emerald-700'}>{fmt.num(approving.board.free)}</b> free
                          {approving.board.committed_elsewhere > 0 && ` · ${fmt.num(approving.board.committed_elsewhere)} booked elsewhere`}
                          {` · ${fmt.num(approving.board.shelf)} on the shelf`}
                          {substituting && <> · planned was <b>{picker.options.find(o => o.planned)?.name || approving.req.planned_board_name}</b></>}
                        </div>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => setApproving({ ...approving, browsing: !approving.browsing })}>
                        <Warehouse size={13} /> {approving.browsing ? 'Close warehouse' : 'Pick from warehouse'}
                      </Button>
                    </div>

                    {/* The number the press actually cares about. */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200/70 pt-2 text-xs">
                      <span className="tabular-nums text-slate-600">
                        <b>{fmt.num(+approving.qty || 0)}</b> parent sheets × <b>{approving.board.cuts}</b> up ={' '}
                        <b className="text-slate-900">{fmt.num(approveYield)}</b>{' '}
                        {approving.req.stage === 'cutting' ? 'parent sheets to Cutting' : 'print sheets at the press'}
                      </span>
                      {cutsMoved && (
                        <span className="rounded-lg bg-red-50 px-2 py-0.5 font-semibold text-red-600">
                          the planned board cuts {picker.planned_cuts} up — {fmt.num(picker.planned_yield)} sheets was what {fmt.num(picker.needed)} parents used to buy
                        </span>
                      )}
                      {cutsMoved && matchParents && (
                        <button type="button" className="rounded-lg bg-brand-50 px-2 py-0.5 font-semibold text-brand-700 hover:bg-brand-100"
                          onClick={() => setApproving({ ...approving, qty: String(Math.min(approving.req.qty, matchParents)) })}>
                          {matchParents > approving.req.qty
                            ? `${fmt.num(matchParents)} parents would be needed to match — above the ${fmt.num(approving.req.qty)} requested`
                            : `use ${fmt.num(matchParents)} parents to match the ${fmt.num(picker.planned_yield)} sheets requested`}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* What changes on the floor if he takes it. */}
                  {substituting && approving.board.cautions.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {approving.board.cautions.map(c => (
                        <li key={c.axis} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {c.text}
                        </li>
                      ))}
                    </ul>
                  )}

                  {substituting && (
                    <div className="mt-3 space-y-2">
                      <Field label="Why not the planned board?" required
                        hint="Goes on the job card, the Cutting slip and the audit trail — the board a job ran on is the first thing anyone asks later">
                        <Input value={approving.substitute_reason} placeholder="e.g. planned board frozen for CI-JC-0161, press waiting"
                          onChange={e => setApproving({ ...approving, substitute_reason: e.target.value })} />
                      </Field>
                      {boardShort && approving.board.shelf >= (+approving.qty || 0) && (
                        <div className="rounded-xl bg-red-50 px-3 py-2">
                          <Checkbox label={`Take ${fmt.num(+approving.qty || 0)} sheets that are booked to other jobs`}
                            checked={!!approving.allow_committed}
                            onChange={e => setApproving({ ...approving, allow_committed: e.target.checked })} />
                          <p className="mt-1 text-[11px] font-semibold text-red-700">
                            Only {fmt.num(approving.board.free)} of the {fmt.num(approving.board.shelf)} sheets on this pile are free.
                            The rest are promised to other jobs, and those jobs will go short by what you take.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {boardShort && !substituting && approving.board.shelf >= (+approving.qty || 0) && (
                    <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                      The planned board has only {fmt.num(approving.board.free)} free of {fmt.num(approving.board.shelf)} on the shelf.
                      Pick another board from the warehouse, or trim the quantity.
                    </p>
                  )}

                  {/* The shelf. */}
                  {approving.browsing && (
                    <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                      <SearchInput className="w-full" value={pickQ} onChange={setPickQ}
                        placeholder="Board, grade, GSM, size…" />
                      <div className="max-h-[42vh] space-y-1.5 overflow-y-auto pr-1">
                        {visibleOptions.length === 0 && (
                          <p className="py-6 text-center text-xs text-slate-400">No board on the shelf matches that.</p>
                        )}
                        {visibleOptions.map(o => (
                          <BoardOption key={o.id} opt={o} qty={+approving.qty || 0} stage={approving.req.stage}
                            selected={Number(o.id) === Number(approving.board?.id)} onPick={pickBoard} />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
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
