// Artwork Verification (AVS) — every printed-carton check in one register, and
// QA's final decision on each.
//
// The checks themselves run in Claude: photos of a printed sheet are compared
// with the approved artwork, the customer's PO and our order book, and the
// report lands in the Supabase schema `avs`. This page reads those reports and
// records the decision — Release, Keep on hold, Reject cartons, Artwork alert
// checked — in avs.decisions, where the next check reads it back.
//
// Photos can be uploaded here too (Upload photos): they go to Google Drive (or
// are kept in CI Plant until the Drive link is set up) and, on Verify, Claude's
// AVS routine checks them in its own cloud session. The
// photo sets and their progress show under the KPI tiles (AvsSets).
//
// Redo verification (a set's row under Report ready, or the report itself):
// new photos, checked as the next check of the same report number. The
// register shows the latest check; the report keeps every earlier check, the
// photo sets behind each, why each redo was asked for, and QA's decisions.
//
// The register (owner's requests, 28 Sep 2026): newest check on top; filters
// All / Open / Released / Rejected; a search that finds any text on the row;
// on each row the report PDF and an Action list — Approve / Release, Hold,
// Reject, Undo the decision — for the logins that decide. Every action asks for
// its remark and is kept in the decision trail; an undo adds a row, never
// deletes one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Camera, CheckCircle2, Download, ExternalLink, FileText, FolderOpen, History, RotateCcw, Settings2, ShieldAlert, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { Button, DataTable, KpiCard, KpiFilterNotice, Modal, PageHeader, useKpiFilter, useToast } from '../components/ui.jsx';
import {
  AVS_DECISIONS, AVS_REGISTER_FILTERS, AVS_REMARK_MAX, AVS_REMARK_PRESETS, AVS_SET_ACTIVE, AVS_WHO_DECIDES, rowMatches, undoProblem, AVS_SET_STATUS_LABEL, CASE_STATE_LABEL, decisionLabel, decisionProblem,
  istStamp, reportLabel, setLabel, AVS_SEVERITIES, AVS_SEVERITY_LABEL, elapsedText, problemSeverity, reportTime,
} from '../lib/avs.js';
import AvsUploadDialog from '../components/avs/AvsUpload.jsx';
import AvsSets, { TotalTime } from '../components/avs/AvsSets.jsx';
import AvsSetup from '../components/avs/AvsSetup.jsx';

const RESULT_TONE = {
  REJECT: 'bg-red-50 text-red-700 ring-red-200',
  HOLD: 'bg-amber-50 text-amber-800 ring-amber-200',
  PASS: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  VERIFY: 'bg-violet-50 text-violet-700 ring-violet-200',
  INFO: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const STRIPE = { REJECT: 'border-l-red-500', HOLD: 'border-l-amber-500', PASS: 'border-l-emerald-500', VERIFY: 'border-l-violet-500', INFO: 'border-l-slate-300' };
const BANNER = { REJECT: 'bg-red-50 text-red-800 border-red-200', HOLD: 'bg-amber-50 text-amber-900 border-amber-200', PASS: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
const CASE_TONE = {
  open: 'bg-slate-100 text-slate-600', waiting: 'bg-sky-50 text-sky-700', released: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-700', closed: 'bg-slate-100 text-slate-500',
};
const DECISION_BUTTON = {
  RELEASE: 'success', 'KEEP ON HOLD': 'solid', REJECT: 'danger', 'ARTWORK ALERT OK': 'secondary',
};

const KPI_ROWS = {
  reject: r => r.case_state === 'open' && r.status === 'REJECT',
  hold: r => r.case_state === 'open' && r.status === 'HOLD',
  waiting: r => r.case_state === 'waiting',
  decided: r => ['released', 'rejected', 'closed'].includes(r.case_state),
};
const KPI_LABEL = {
  reject: 'open REJECT reports — do not use these cartons',
  hold: 'open HOLD reports — check before going ahead',
  waiting: 'PASS reports waiting for QA to release',
  decided: 'reports QA has decided, or the owner closed',
};

function Result({ value, className = '' }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${RESULT_TONE[value] || RESULT_TONE.INFO} ${className}`}>{value}</span>;
}
function CaseChip({ state }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${CASE_TONE[state] || CASE_TONE.open}`}>{CASE_STATE_LABEL[state] || state}</span>;
}
const shortPo = p => String(p || '').match(/(\d{3,6})$/)?.[1] ?? (p || '—');
const dateIn = d => (d ? fmt.date(d) : '—');

export default function Avs() {
  const [params, setParams] = useSearchParams();
  const openNo = params.get('open');
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');

  const load = useCallback(() => api.get('/avs/reports')
    .then(d => { setData(d); setLoadError(false); })
    .catch(() => setLoadError(true)), []);
  useFallbackRefresh(load, { intervalMs: 60000 });

  // Photo sets: every 10 s while Claude has one waiting or in hand, else every
  // minute. A set that just finished brings its report into the register and
  // says where it went (its chip in the photo-set list).
  const [uploads, setUploads] = useState(null);
  const [uploading, setUploading] = useState(null); // { resume?, redo? } — the upload dialog
  const [setupOpen, setSetupOpen] = useState(false);
  const wasActive = useRef([]);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // Up to 100 of each finished status: the list shows them by time window.
  const loadUploads = useCallback(() => api.get('/avs/uploads?per_status=100').then(d => {
    const sets = d.sets || [];
    const ended = sets.filter(x => wasActive.current.includes(x.id) && !AVS_SET_ACTIVE.includes(x.status));
    wasActive.current = sets.filter(x => AVS_SET_ACTIVE.includes(x.status)).map(x => x.id);
    setUploads(d);
    for (const x of ended) {
      if (x.status === 'done') {
        toastRef.current.success(`${x.label}: report ready${x.report_no ? ` (${x.report_no}${x.result ? ` ${x.result}` : ''})` : ''}. It is under Report ready.`);
      } else if (x.status === 'failed') {
        toastRef.current.error(`${x.label}: the check could not be finished. It is under Check failed.`);
      }
    }
    if (ended.length) load();
  }).catch(() => {}), [load]);
  const activeSets = (uploads?.sets || []).some(x => AVS_SET_ACTIVE.includes(x.status));
  useFallbackRefresh(loadUploads, { intervalMs: activeSets ? 10000 : 60000 });

  const rows = useMemo(() => (data?.reports || []).map(r => ({ ...r, id: r.report_no })), [data]);
  const kpis = useMemo(() => Object.fromEntries(Object.entries(KPI_ROWS).map(([k, f]) => [k, rows.filter(f).length])), [rows]);
  // Any text on the row: every field, the labels the row shows, and the date.
  const searched = useMemo(() => rows.filter(r => rowMatches([
    ...Object.values(r).filter(v => v == null || typeof v !== 'object'), reportLabel(r), CASE_STATE_LABEL[r.case_state],
    r.last_decision ? decisionLabel(r.last_decision) : '', istStamp(r.issued_at), dateIn(r.checked_on),
  ], q)), [rows, q]);
  const [view, setView] = useState('all');
  const viewOf = AVS_REGISTER_FILTERS.find(f => f.key === view) || AVS_REGISTER_FILTERS[0];
  const kpi = useKpiFilter('avs');
  const filtered = kpi.apply(searched.filter(viewOf.match), KPI_ROWS);
  const [acting, setActing] = useState(null); // { row, action } — the row's Action list
  // Redo from a set's row (Report ready) or from the report itself.
  const redoFromSet = x => setUploading({ redo: {
    report_no: x.report_no, set_id: x.id, jc_number: x.jc_number, product: x.product_hint, status: x.result,
    check_no: x.check_no ?? 1, label: reportLabel({ report_no: x.report_no, check_no: x.check_no ?? 1, report_rev: x.report_rev ?? 0 }),
  } });
  const redoFromReport = r => setUploading({ redo: {
    report_no: r.report_no, jc_number: r.job_card, product: r.product_name || r.product, status: r.status,
    check_no: r.check_no ?? 1, label: reportLabel(r),
  } });
  const open = no => setParams(p => { const n = new URLSearchParams(p); if (no) n.set('open', no); else n.delete('open'); return n; }, { replace: true });

  return (
    <div>
      <PageHeader title="Artwork Verification (AVS)"
        subtitle="Printed-carton checks against the approved artwork, the customer's PO and our job card — and QA's final decision"
        actions={<>
          {uploads?.is_admin && (
            <Button variant="secondary" repeatable onClick={() => setSetupOpen(true)}>
              <span className="inline-flex items-center gap-1.5"><Settings2 size={15} /> Setup</span>
            </Button>
          )}
          {uploads?.can_upload && (
            <Button repeatable onClick={() => setUploading({})}>
              <span className="inline-flex items-center gap-1.5"><Camera size={15} /> Upload photos</span>
            </Button>
          )}
        </>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={XCircle} tone="bad" label="Reject — do not use" value={fmt.num(kpis.reject)}
          onClick={() => kpi.toggle('reject')} active={kpi.is('reject')} />
        <KpiCard icon={AlertTriangle} tone="warn" label="Hold — check first" value={fmt.num(kpis.hold)}
          onClick={() => kpi.toggle('hold')} active={kpi.is('hold')} />
        <KpiCard icon={ShieldCheck} tone="info" label="PASS — waiting for QA" value={fmt.num(kpis.waiting)}
          onClick={() => kpi.toggle('waiting')} active={kpi.is('waiting')} />
        <KpiCard icon={CheckCircle2} tone="good" label="Decided or closed" value={fmt.num(kpis.decided)}
          onClick={() => kpi.toggle('decided')} active={kpi.is('decided')} />
      </div>
      <AvsSets data={uploads} onChanged={loadUploads} onOpenReport={no => open(no)}
        onContinue={s => setUploading({ resume: s })} onSetup={() => setSetupOpen(true)} onRedo={redoFromSet} />
      <KpiFilterNotice filter={kpi} label={KPI_LABEL[kpi.key]} shown={filtered.length} total={searched.length} />
      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last reports loaded' : 'the AVS reports can’t load'}. Retrying every minute…
        </div>
      )}
      {data && !data.enabled && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          AVS reports are not set up on this database yet.
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {AVS_REGISTER_FILTERS.map(f => {
          const n = searched.filter(f.match).length;
          const on = view === f.key;
          return (
            <button key={f.key} type="button" onClick={() => setView(f.key)} aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition ${on
                ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}>
              {f.label}
              <span className={`min-w-[1.4rem] rounded-full px-1.5 text-center text-xs tabular-nums ${on ? 'bg-white/20' : 'bg-slate-100'}`}>{n}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2">
        <DataTable
          exportName="avs-reports"
          searchValue={q} onSearchChange={setQ}
          searchPlaceholder="Search anything: product, AVS no., job card, PO, customer, result, decision, date…"
          rows={filtered}
          // Newest check on top — by when it was checked, so a new check of an
          // old report comes up too. It is the one QA has to act on.
          defaultSort={{ key: 'issued_at', dir: 'desc' }}
          onRowClick={r => open(r.report_no)}
          empty={loadError ? 'Server unreachable — nothing to show until it reconnects.'
            : data === null ? 'Loading AVS reports…'
            : 'No AVS reports yet. They appear here after the next check in Claude.'}
          columns={[
            { key: 'report_no', label: 'Report', export: r => reportLabel(r),
              sortValue: r => `${r.report_no}|${String(r.check_no ?? 1).padStart(3, '0')}|${String(r.report_rev ?? 0).padStart(3, '0')}`,
              render: r => <span className="whitespace-nowrap font-mono text-xs font-semibold text-slate-700">{reportLabel(r)}</span> },
            { key: 'product_name', label: 'Product', sortValue: r => String(r.product_name || r.product || '').toLowerCase(),
              render: r => (
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900">{r.product_name || r.product}</div>
                  <div className="text-xs text-slate-500">{r.artwork_code}{r.revision ? `-${r.revision}` : ''}{r.customer ? ` · ${r.customer}` : ''}</div>
                </div>) },
            { key: 'status', label: 'Result', sortValue: r => ({ REJECT: 3, HOLD: 2, PASS: 1 }[r.status] ?? 0),
              render: r => <Result value={r.status} /> },
            { key: 'case_state', label: 'Decision', export: r => CASE_STATE_LABEL[r.case_state],
              sortValue: r => ({ open: 0, waiting: 1, rejected: 2, released: 3, closed: 4 }[r.case_state] ?? 9),
              render: r => (
                <div className="flex flex-col gap-0.5">
                  <CaseChip state={r.case_state} />
                  {r.last_decision && <span className="text-[11px] text-slate-500">{decisionLabel(r.last_decision)} · {r.last_decided_by || '—'}</span>}
                </div>) },
            // How many points QA must clear, and how serious they are (Critical / Major / Minor).
            { key: 'open_points', label: 'Points to clear', align: 'right',
              export: r => `${r.open_points || 0}${+r.open_points ? ` (${AVS_SEVERITIES.filter(k => +r[k.toLowerCase()]).map(k => `${r[k.toLowerCase()]} ${AVS_SEVERITY_LABEL[k]}`).join(', ')})` : ''}`,
              sortValue: r => (+r.critical || 0) * 10000 + (+r.major || 0) * 100 + (+r.minor || 0),
              render: r => (+r.open_points > 0 ? <SeverityCounts r={r} /> : <span className="text-slate-300">—</span>) },
            // From Verify in CI Plant to the report (the photo set behind this issue).
            { key: 'time_taken', label: 'Time taken', align: 'right',
              export: r => (reportTime(r) ? elapsedText(reportTime(r).totalMs) : ''),
              sortValue: r => reportTime(r)?.totalMs ?? -1,
              render: r => <TimeTaken r={r} /> },
            { key: 'job_card', label: 'Job card', render: r => <span className="font-mono text-xs">{r.job_card || '—'}</span> },
            { key: 'po_no', label: 'PO', export: r => r.po_no, sortValue: r => shortPo(r.po_no), render: r => <span className="font-mono text-xs">{shortPo(r.po_no)}</span> },
            { key: 'print_status', label: 'Print status', render: r => <span className="text-xs text-slate-600">{r.print_status || '—'}</span> },
            // When this issue was filed, in India time: the register is newest first.
            { key: 'issued_at', label: 'Checked', export: r => istStamp(r.issued_at) || dateIn(r.checked_on),
              sortValue: r => Date.parse(r.issued_at || r.checked_on) || 0,
              render: r => (
                <div className="whitespace-nowrap">
                  <div>{r.issued_at ? istStamp(r.issued_at).replace(/, [^,]*$/, '') : dateIn(r.checked_on)}</div>
                  {r.issued_at && <div className="text-[11px] tabular-nums text-slate-500">{istStamp(r.issued_at).split(', ').pop()}</div>}
                </div>) },
            { key: '_actions', label: 'Action', sortable: false,
              render: r => <RowActions r={r} canDecide={!!data?.can_decide}
                onAct={action => (action === 'UNDO'
                  ? undoDecision(r.report_no, r.last_decision_id, toast).then(load).catch(() => {})
                  : setActing({ row: r, action }))} /> },
          ]}
        />
      </div>
      {acting && (
        <QuickDecision row={acting.row} action={acting.action} onClose={() => setActing(null)}
          onSaved={() => { setActing(null); load(); }} />
      )}
      {openNo && (
        <ReportModal no={openNo} onClose={() => open(null)} onSaved={load}
          canRedo={!!uploads?.can_upload} onRedo={redoFromReport} refreshKey={uploads} />
      )}
      <AvsUploadDialog open={!!uploading} resume={uploading?.resume || null} redo={uploading?.redo || null}
        onClose={() => { setUploading(null); loadUploads(); }} onDone={() => loadUploads()} />
      {uploads?.is_admin && <AvsSetup open={setupOpen} onClose={() => setSetupOpen(false)} onChanged={loadUploads} />}
    </div>
  );
}

function ReportModal({ no, onClose, onSaved, canRedo = false, onRedo, refreshKey }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [pick, setPick] = useState(null);
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api.get(`/avs/reports/${encodeURIComponent(no)}`)
    .then(d => { setDetail(d); setErr(null); })
    .catch(e => setErr(e?.message || 'Could not load this report')), [no]);
  useEffect(() => { setDetail(null); setPick(null); setRemark(''); load(); }, [load]);
  // A redo started or finished from here shows up without closing the report.
  useEffect(() => { if (refreshKey) load(); }, [refreshKey, load]);

  const r = detail?.report;
  const problems = detail?.problems || [];
  const hasAlert = problems.some(p => p.result === 'VERIFY');
  const problem = r && pick ? decisionProblem({ decision: pick, remark, status: r.status, hasAlert }) : null;

  const save = async () => {
    if (!r || !pick || problem) return;
    setSaving(true);
    try {
      await api.post(`/avs/reports/${encodeURIComponent(no)}/decisions`, {
        decision: pick, remark: remark.trim() || null, report_rev: r.report_rev, check_no: r.check_no,
      });
      toast.success(`${reportLabel(r)}: ${decisionLabel(pick)}`);
      setPick(null); setRemark('');
      await load(); onSaved?.();
    } catch {
      // api.js already showed the server's reason as a toast.
    } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} wide title={r ? `${r.product_name || r.product} · ${reportLabel(r)}` : no}>
      {!detail && !err && <div className="p-6 text-sm text-slate-400">Loading…</div>}
      {err && <div className="p-6 text-sm text-red-600">{err}</div>}
      {r && (
        <div className="space-y-5">
          <div className={`rounded-xl border px-4 py-3 ${BANNER[r.status] || 'bg-slate-50 border-slate-200'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Result value={r.status} />
              <CaseChip state={r.case_state} />
              {r.heading_line && <span className="text-xs text-slate-600">{r.heading_line}</span>}
            </div>
            <div className="mt-2 text-[15px] font-bold leading-snug">{r.headline || r.key_finding}</div>
            {r.summary && <p className="mt-1 text-sm leading-relaxed text-slate-700">{r.summary}</p>}
          </div>

          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Key facts</h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Fact label="Job card" mono>{r.job_card || '—'}</Fact>
              <Fact label="Print status">{r.print_headline || r.print_status || '—'}</Fact>
              <Fact label="Latest PO"><span className="font-mono">{r.po_no || 'none'}</span>{r.po_date ? ` · ${dateIn(r.po_date)}` : ''}{r.po_age_days != null ? ` · ${r.po_age_days} days old` : ''}</Fact>
              <Fact label="PO check">{r.po_result || '—'}</Fact>
              <Fact label="Our order book" wide>{r.order_book_strip || r.ob_note || '—'}</Fact>
              <Fact label="Artwork" mono>{r.artwork_code}{r.revision ? `-${r.revision}` : ''}{r.item_code ? ` · item ${r.item_code}` : ''}</Fact>
              <Fact label="Customer">{r.customer || '—'}</Fact>
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">What was found ({problems.length})</h3>
            <div className="space-y-2">
              {problems.length === 0 && <div className="text-sm text-slate-500">No problems found.</div>}
              {problems.map(p => (
                <div key={p.ref} className={`rounded-lg border border-slate-200 border-l-4 bg-white px-3 py-2.5 ${STRIPE[p.result] || STRIPE.INFO}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-slate-500">{p.ref}</span>
                    <span className="text-sm font-semibold text-slate-900">{p.title}</span>
                    <Result value={p.result} />
                    {problemSeverity(p) && <SeverityChip value={problemSeverity(p)} />}
                  </div>
                  {p.detail && <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{p.detail}</p>}
                  {p.action && <p className="mt-1 text-[13px] leading-relaxed text-slate-800"><b>Do:</b> {p.action}</p>}
                  {p.rows && <p className="mt-1 font-mono text-[11px] text-slate-400">Report {p.rows}</p>}
                </div>
              ))}
            </div>
          </section>

          {Array.isArray(r.recommendation) && r.recommendation.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">What to do next</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                {r.recommendation.map((x, i) => <li key={i}>{x}</li>)}
              </ol>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Full report</h3>
            <div className="flex flex-wrap items-center gap-3">
              {r.drive_url
                ? <a href={r.drive_url} onClick={e => { e.preventDefault(); openPdf(r); }} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071F0] px-3 py-2 text-sm font-semibold text-white"><FileText size={15} /> Open report PDF <ExternalLink size={13} /></a>
                : <span className="text-sm text-slate-500">PDF link not added yet.</span>}
              {r.report_file && <span className="text-xs text-slate-500">{r.date_folder ? `${r.date_folder}/${r.product_folder}/` : ''}{r.report_file}</span>}
            </div>
            {detail.history?.length > 1 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400"><tr><th className="py-1 pr-3">Issue</th><th className="py-1 pr-3">Date</th><th className="py-1 pr-3">Result</th><th className="py-1">Note</th></tr></thead>
                  <tbody>
                    {detail.history.map((h, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="py-1 pr-3 font-mono">{h.row_type === 'CLOSE' ? 'Closed' : reportLabel({ report_no: no, ...h })}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{h.issued_at ? istStamp(h.issued_at) : '—'}</td>
                        <td className="py-1 pr-3">{h.status ? <Result value={h.status} /> : '—'}</td>
                        <td className="py-1 text-slate-500">{h.note || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <RedoAndTrail no={no} r={r} detail={detail} canRedo={canRedo} onRedo={onRedo} />


          <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">QA decision</h3>
            {detail.decisions.length === 0
              ? <p className="text-sm text-slate-500">No decision recorded yet.</p>
              : (
                <ul className="space-y-1.5">
                  {detail.decisions.map(d => {
                    const inForce = +detail.decisions_in_force === +d.id;
                    const onLatest = +d.report_rev === +r.report_rev && +(d.check_no ?? 1) === +(r.check_no ?? 1);
                    return (
                      <li key={d.id} className={`rounded-lg px-3 py-2 text-sm ring-1 ${d.decision === 'UNDO' ? 'bg-slate-50 ring-slate-200' : inForce ? 'bg-white ring-emerald-300' : 'bg-white ring-slate-200'}`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <span>
                            <b className={d.undone ? 'text-slate-400 line-through' : ''}>{decisionLabel(d.decision)}</b>
                            {d.undone && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">Undone</span>}
                            {inForce && <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">In force</span>}
                            <span className="text-slate-500"> · {d.decided_by || '—'} · {istStamp(d.decided_at)} · on {reportLabel({ report_no: no, ...d })}</span>
                          </span>
                          {detail.can_decide && onLatest && !d.undone && d.decision !== 'UNDO' && (inForce || d.decision === 'ARTWORK ALERT OK') && r.case_state !== 'closed' && (
                            <Button size="sm" variant="ghost" repeatable
                              onClick={() => undoDecision(no, d.id, toast).then(async () => { await load(); onSaved?.(); }).catch(() => {})}>
                              <span className="inline-flex items-center gap-1"><Undo2 size={12} /> Undo</span>
                            </Button>
                          )}
                        </div>
                        {d.remark && <div className="mt-0.5 text-slate-700">{d.decision === 'UNDO' ? 'Why: ' : ''}{d.remark}</div>}
                      </li>
                    );
                  })}
                </ul>
              )}

            {!detail.can_decide && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><ShieldAlert size={14} /> {AVS_WHO_DECIDES}</p>
            )}
            {detail.can_decide && r.case_state !== 'closed' && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {AVS_DECISIONS.filter(d => d.key !== 'ARTWORK ALERT OK' || hasAlert).map(d => {
                    return (
                      <Button key={d.key} repeatable size="md"
                        variant={pick === d.key ? DECISION_BUTTON[d.key] : 'secondary'}
                        className={pick === d.key && d.key === 'KEEP ON HOLD' ? 'bg-amber-500' : ''}
                        title={d.hint}
                        onClick={() => { setPick(d.key); setRemark(''); }}>
                        {d.label}
                      </Button>
                    );
                  })}
                </div>
                {pick === 'RELEASE' && r.status === 'REJECT' && (
                  <p className="text-xs text-amber-800">This report is REJECT. Releasing it is your call; the remark is kept as the reason.</p>
                )}
                {pick && (
                  <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
                    <div className="text-sm"><b>{AVS_DECISIONS.find(d => d.key === pick)?.label}</b> <span className="text-slate-500">— {AVS_DECISIONS.find(d => d.key === pick)?.hint}</span></div>
                    <RemarkPresets decision={pick} value={remark} onPick={setRemark} />
                    <label htmlFor="avs-remark" className="block text-xs font-medium text-slate-600">
                      Or write your own{pick === 'RELEASE' && r.status === 'PASS' ? ' (optional)' : ''} — saved with your name
                    </label>
                    <textarea id="avs-remark" value={remark} maxLength={AVS_REMARK_MAX} onChange={e => setRemark(e.target.value)}
                      className="min-h-[72px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
                    {problem && remark.trim() !== '' && <p className="text-xs text-red-600">{problem}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={save} disabled={!!problem || saving}>{saving ? 'Saving…' : `Confirm: ${AVS_DECISIONS.find(d => d.key === pick)?.label}`}</Button>
                      <Button variant="ghost" repeatable onClick={() => { setPick(null); setRemark(''); }}>Cancel</Button>
                    </div>
                    {problem && remark.trim() === '' && <p className="text-xs text-slate-500">{problem}</p>}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

// Ready-made remarks: one tap fills the remark; more words can be added.
function RemarkPresets({ decision, value, onPick }) {
  const list = AVS_REMARK_PRESETS[decision] || [];
  if (!list.length) return null;
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

// Undo, no questions asked: who and when are kept on the UNDO row.
async function undoDecision(reportNo, decisionId, toast) {
  await api.post(`/avs/reports/${encodeURIComponent(reportNo)}/decisions/${decisionId}/undo`, {});
  toast.success(`${reportNo}: decision undone`);
}

// The report PDF, straight from the row: open it, or download it.
const pdfDownloadUrl = r => (r.drive_file_id ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(r.drive_file_id)}` : null);

// The PDF comes from CI Plant, with QA's decision stamped on it once QA has
// decided this issue ("RELEASED BY QA ..."; server avs-stamp.js). If CI Plant
// cannot fetch it, the Drive copy opens instead (filed before QA decided).
async function openPdf(r, { download = false } = {}) {
  const win = download ? null : window.open('', '_blank');
  try {
    // Google's Drive link answers in 5 to 25 s and now and then not in time:
    // a second try usually comes back at once.
    let res = null;
    for (let attempt = 0; attempt < 2 && !res?.ok; attempt++) {
      res = await fetch(`/api/avs/reports/${encodeURIComponent(r.report_no)}/pdf${download ? '?download=1' : ''}`, {
        headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      });
      if (!res.ok && ![502, 504].includes(res.status)) break;
    }
    if (!res?.ok) throw new Error(String(res?.status));
    const url = URL.createObjectURL(await res.blob());
    if (download) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportLabel(r)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (win) win.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch {
    const fallback = download ? pdfDownloadUrl(r) : r.drive_url;
    if (win) { if (fallback) win.location.href = fallback; else win.close(); } else if (fallback) window.open(fallback, '_blank');
  }
}

const SEVERITY_TONE = {
  CRITICAL: 'bg-red-600 text-white', MAJOR: 'bg-amber-100 text-amber-800 ring-1 ring-amber-300', MINOR: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
};
function SeverityChip({ value, n = null }) {
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${SEVERITY_TONE[value] || ''}`}>
      {n != null ? `${n} ` : ''}{AVS_SEVERITY_LABEL[value]}
    </span>
  );
}
// The Points to clear cell: the number, then how many are Critical, Major, Minor.
function SeverityCounts({ r }) {
  const parts = AVS_SEVERITIES.map(k => [k, +r[k.toLowerCase()] || 0]).filter(([, n]) => n > 0);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="font-semibold text-slate-800">{r.open_points}</span>
      <span className="flex flex-wrap justify-end gap-1">{parts.map(([k, n]) => <SeverityChip key={k} value={k} n={n} />)}</span>
    </div>
  );
}
// Time taken: Verify to the report, with the wait for Claude and the check.
function TimeTaken({ r }) {
  const t = reportTime(r);
  if (!t) return <span className="text-[11px] text-slate-400" title="Made in Cowork, not from a CI Plant photo set">—</span>;
  return (
    <div className="whitespace-nowrap text-right" title="From Verify in CI Plant to the report">
      <div className="font-semibold tabular-nums text-slate-800">{elapsedText(t.totalMs)}</div>
      {t.checkMs != null && (
        <div className="text-[11px] tabular-nums text-slate-500">wait {elapsedText(t.waitMs)} · check {elapsedText(t.checkMs)}</div>
      )}
    </div>
  );
}

// The row's Action list: for the logins that decide. Undo only when a decision
// is in force on this issue of the report.
function RowActions({ r, canDecide, onAct }) {
  const stop = e => e.stopPropagation();
  const decidedHere = r.last_decision_id && +r.last_decision_rev === +r.report_rev && +(r.last_decision_check ?? 1) === +(r.check_no ?? 1);
  const closed = r.case_state === 'closed';
  return (
    <div className="flex items-center gap-1.5" onClick={stop} onKeyDown={stop} role="presentation">
      {r.drive_url && (
        <a href={r.drive_url} onClick={e => { e.preventDefault(); openPdf(r); }} target="_blank" rel="noreferrer" title="Open the report PDF"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">
          <FileText size={15} />
        </a>
      )}
      {pdfDownloadUrl(r) && (
        <a href={pdfDownloadUrl(r)} onClick={e => { e.preventDefault(); openPdf(r, { download: true }); }} target="_blank" rel="noreferrer" title="Download the report PDF"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">
          <Download size={15} />
        </a>
      )}
      {canDecide && !closed && (
        <select value="" aria-label={`Action on ${reportLabel(r)}`}
          onChange={e => { if (e.target.value) onAct(e.target.value); }}
          className="h-8 w-28 shrink-0 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 focus:border-[#0071F0] focus:outline-none">
          <option value="">Action…</option>
          <option value="RELEASE">Approve / Release</option>
          <option value="KEEP ON HOLD">Hold</option>
          <option value="REJECT">Reject</option>
          {decidedHere && <option value="UNDO">Undo: {decisionLabel(r.last_decision)}</option>}
        </select>
      )}
    </div>
  );
}

// One decision from the row, with its remark. Same rules and same trail as the
// report's own QA decision.
function QuickDecision({ row, action, onClose, onSaved }) {
  const toast = useToast();
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const undo = action === 'UNDO';
  const meta = AVS_DECISIONS.find(d => d.key === action);
  const problem = undo ? undoProblem({ remark })
    : decisionProblem({ decision: action, remark, status: row.status, hasAlert: false });
  const title = undo ? `Undo "${decisionLabel(row.last_decision)}"` : action === 'RELEASE' ? 'Approve / Release' : meta?.label;
  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      if (undo) {
        await api.post(`/avs/reports/${encodeURIComponent(row.report_no)}/decisions/${row.last_decision_id}/undo`, { remark: remark.trim() });
        toast.success(`${reportLabel(row)}: decision undone`);
      } else {
        await api.post(`/avs/reports/${encodeURIComponent(row.report_no)}/decisions`, {
          decision: action, remark: remark.trim() || null, report_rev: row.report_rev, check_no: row.check_no,
        });
        toast.success(`${reportLabel(row)}: ${decisionLabel(action)}`);
      }
      onSaved?.();
    } catch { /* api.js said why */ } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title={`${title} · ${reportLabel(row)}`}
      footer={<>
        <Button variant="secondary" repeatable onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant={undo ? 'secondary' : DECISION_BUTTON[action] || 'solid'} onClick={save} disabled={!!problem || saving}>
          <span className="inline-flex items-center gap-1.5">{undo && <Undo2 size={15} />}{saving ? 'Saving…' : `Confirm: ${title}`}</span>
        </Button>
      </>}>
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-semibold text-slate-900">{row.product_name || row.product}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <Result value={row.status} /> <CaseChip state={row.case_state} />
            <span className="font-mono">{row.job_card || '—'}</span>
          </div>
        </div>
        {undo
          ? <p className="text-sm text-slate-600">The decision stays in the trail, marked undone{row.last_decided_by ? ` (made by ${row.last_decided_by})` : ''}. The decision before it, if any, applies again. Printing locks again if this job needs AVS.</p>
          : <p className="text-sm text-slate-600">{meta?.hint}</p>}
        {!undo && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600">Pick a remark</div>
            <RemarkPresets decision={action} value={remark} onPick={setRemark} />
          </div>
        )}
        <label htmlFor="avs-quick-remark" className="block text-xs font-medium text-slate-600">
          {undo ? 'Note (optional)' : `Or write your own ${action === 'RELEASE' && row.status === 'PASS' ? '(optional)' : ''}`} — saved with your name
        </label>
        <textarea id="avs-quick-remark" value={remark} maxLength={AVS_REMARK_MAX} onChange={e => setRemark(e.target.value)}
          className="min-h-[64px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
        {problem && <p className="text-xs text-slate-500">{problem}</p>}
        {!undo && action === 'RELEASE' && row.status === 'REJECT' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">This report is REJECT. Releasing it is your call; the remark is kept as the reason.</p>
        )}
      </div>
    </Modal>
  );
}

// Redo verification, and the photo sets behind the report: the first check and
// every redo — who asked, why, when, and how each ended.
function RedoAndTrail({ no, r, detail, canRedo, onRedo }) {
  const sets = detail.sets || [];
  const busy = detail.open_redo;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Checks and photo sets</h3>
        {canRedo && r.case_state !== 'closed' && !busy && (
          <Button repeatable onClick={() => onRedo?.(r)}>
            <span className="inline-flex items-center gap-1.5"><RotateCcw size={15} /> Redo verification</span>
          </Button>
        )}
      </div>
      {busy && (
        <p className="mb-2 flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <History size={15} className="shrink-0" />
          Being checked again: {setLabel(busy.id)} ({AVS_SET_STATUS_LABEL[busy.status]}), asked by {busy.created_by || '—'}. Reason: {busy.redo_reason}
        </p>
      )}
      {r.case_state === 'closed' && <p className="mb-2 text-xs text-slate-500">This case was closed by the owner; it cannot be checked again.</p>}
      {sets.length === 0
        ? <p className="text-sm text-slate-500">This report was made from photos put in the AVS folder, not from a CI Plant photo set.</p>
        : (
          <ul className="space-y-1.5">
            {sets.map(x => (
              <li key={x.id} className="rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-700">{setLabel(x.id)}</span>
                  <span className="text-xs text-slate-600">
                    {x.status === 'done' && x.report_no
                      ? reportLabel({ report_no: no, check_no: x.check_no ?? 1, report_rev: x.report_rev ?? 0 })
                      : AVS_SET_STATUS_LABEL[x.status] || x.status}
                  </span>
                  {x.result && <Result value={x.result} />}
                  {x.redo_report_no && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">Redo</span>}
                  {x.drive_folder_url && (
                    <a href={x.drive_folder_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
                      <FolderOpen size={12} /> Photos
                    </a>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {x.created_by || '—'} · uploaded {istStamp(x.created_at)}{x.finished_at ? ` · checked ${istStamp(x.finished_at)}` : ''}
                  {x.status === 'cancelled' ? ` · cancelled by ${x.cancelled_by || '—'}` : ''}
                </div>
                <TotalTime set={x} />
                {x.redo_reason && <div className="mt-0.5 text-xs text-violet-800">Why redone: {x.redo_reason}</div>}
                {x.robot_note && x.status !== 'uploading' && <div className="mt-0.5 text-xs text-slate-600">{x.robot_note}</div>}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Fact({ label, children, mono = false, wide = false }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`mt-0.5 text-slate-800 ${mono ? 'font-mono text-[13px]' : ''}`}>{children}</dd>
    </div>
  );
}
