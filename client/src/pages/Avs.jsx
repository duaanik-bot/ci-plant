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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Camera, CheckCircle2, ExternalLink, FileText, Settings2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { api, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { Button, DataTable, KpiCard, KpiFilterNotice, Modal, PageHeader, useKpiFilter, useToast } from '../components/ui.jsx';
import {
  AVS_DECISIONS, AVS_REMARK_MAX, AVS_SET_ACTIVE, CASE_STATE_LABEL, decisionLabel, decisionProblem, reportLabel,
} from '../lib/avs.js';
import AvsUploadDialog from '../components/avs/AvsUpload.jsx';
import AvsSets from '../components/avs/AvsSets.jsx';
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
  const [uploading, setUploading] = useState(null); // { resume? } — the upload dialog
  const [setupOpen, setSetupOpen] = useState(false);
  const wasActive = useRef([]);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const loadUploads = useCallback(() => api.get('/avs/uploads').then(d => {
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
  const searched = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(r => [r.report_no, r.product_name, r.product, r.customer, r.artwork_code, r.item_code, r.job_card, r.po_no, r.print_status, r.status]
      .join(' ').toLowerCase().includes(t));
  }, [rows, q]);
  const kpi = useKpiFilter('avs');
  const filtered = kpi.apply(searched, KPI_ROWS);
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
        onContinue={s => setUploading({ resume: s })} onSetup={() => setSetupOpen(true)} />
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
      <div className="mt-3">
        <DataTable
          exportName="avs-reports"
          searchValue={q} onSearchChange={setQ}
          searchPlaceholder="Search product, AVS no., job card, PO, artwork code…"
          rows={filtered}
          // Newest check on top: it is the one QA has to act on.
          defaultSort={{ key: 'report_no', dir: 'desc' }}
          onRowClick={r => open(r.report_no)}
          empty={loadError ? 'Server unreachable — nothing to show until it reconnects.'
            : data === null ? 'Loading AVS reports…'
            : 'No AVS reports yet. They appear here after the next check in Claude.'}
          columns={[
            { key: 'report_no', label: 'Report', export: r => reportLabel(r),
              render: r => <span className="font-mono text-xs font-semibold text-slate-700">{reportLabel(r)}</span> },
            { key: 'product_name', label: 'Product',
              render: r => (
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900">{r.product_name || r.product}</div>
                  <div className="text-xs text-slate-500">{r.artwork_code}{r.revision ? `-${r.revision}` : ''}{r.customer ? ` · ${r.customer}` : ''}</div>
                </div>) },
            { key: 'status', label: 'Result', render: r => <Result value={r.status} /> },
            { key: 'case_state', label: 'Decision', export: r => CASE_STATE_LABEL[r.case_state],
              render: r => (
                <div className="flex flex-col gap-0.5">
                  <CaseChip state={r.case_state} />
                  {r.last_decision && <span className="text-[11px] text-slate-500">{decisionLabel(r.last_decision)} · {r.last_decided_by || '—'}</span>}
                </div>) },
            { key: 'open_points', label: 'Points to clear', align: 'right', export: r => r.open_points,
              render: r => (+r.open_points > 0 ? <span className="font-semibold text-slate-800">{r.open_points}</span> : <span className="text-slate-300">—</span>) },
            { key: 'job_card', label: 'Job card', render: r => <span className="font-mono text-xs">{r.job_card || '—'}</span> },
            { key: 'po_no', label: 'PO', export: r => r.po_no, render: r => <span className="font-mono text-xs">{shortPo(r.po_no)}</span> },
            { key: 'print_status', label: 'Print status', render: r => <span className="text-xs text-slate-600">{r.print_status || '—'}</span> },
            { key: 'checked_on', label: 'Checked', export: r => dateIn(r.checked_on), render: r => dateIn(r.checked_on) },
          ]}
        />
      </div>
      {openNo && (
        <ReportModal no={openNo} onClose={() => open(null)} onSaved={load} />
      )}
      <AvsUploadDialog open={!!uploading} resume={uploading?.resume || null}
        onClose={() => { setUploading(null); loadUploads(); }} onDone={() => loadUploads()} />
      {uploads?.is_admin && <AvsSetup open={setupOpen} onClose={() => setSetupOpen(false)} onChanged={loadUploads} />}
    </div>
  );
}

function ReportModal({ no, onClose, onSaved }) {
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
                ? <a href={r.drive_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071F0] px-3 py-2 text-sm font-semibold text-white"><FileText size={15} /> Open report PDF <ExternalLink size={13} /></a>
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
                        <td className="py-1 pr-3">{h.issued_at ? fmt.date(h.issued_at) : '—'}</td>
                        <td className="py-1 pr-3">{h.status ? <Result value={h.status} /> : '—'}</td>
                        <td className="py-1 text-slate-500">{h.note || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">QA decision</h3>
            {detail.decisions.length === 0
              ? <p className="text-sm text-slate-500">No decision recorded yet.</p>
              : (
                <ul className="space-y-1.5">
                  {detail.decisions.map(d => (
                    <li key={d.id} className="rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
                      <b>{decisionLabel(d.decision)}</b>
                      <span className="text-slate-500"> · {d.decided_by || '—'} · {fmt.date(d.decided_at)} · on {reportLabel({ report_no: no, ...d })}</span>
                      {d.remark && <div className="mt-0.5 text-slate-700">{d.remark}</div>}
                    </li>
                  ))}
                </ul>
              )}

            {!detail.can_decide && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><ShieldAlert size={14} /> Only QA or management can record the decision.</p>
            )}
            {detail.can_decide && r.case_state !== 'closed' && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {AVS_DECISIONS.filter(d => d.key !== 'ARTWORK ALERT OK' || hasAlert).map(d => {
                    const blocked = d.key === 'RELEASE' && r.status === 'REJECT';
                    return (
                      <Button key={d.key} repeatable size="md"
                        variant={pick === d.key ? DECISION_BUTTON[d.key] : 'secondary'}
                        className={pick === d.key && d.key === 'KEEP ON HOLD' ? 'bg-amber-500' : ''}
                        disabled={blocked}
                        title={blocked ? 'A REJECT report needs a new check of corrected cartons before release' : d.hint}
                        onClick={() => setPick(d.key)}>
                        {d.label}
                      </Button>
                    );
                  })}
                </div>
                {r.status === 'REJECT' && (
                  <p className="text-xs text-slate-500">Release needs a new check of corrected cartons (Check {(+r.check_no || 1) + 1}) that comes back PASS.</p>
                )}
                {pick && (
                  <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
                    <div className="text-sm"><b>{AVS_DECISIONS.find(d => d.key === pick)?.label}</b> <span className="text-slate-500">— {AVS_DECISIONS.find(d => d.key === pick)?.hint}</span></div>
                    <label htmlFor="avs-remark" className="block text-xs font-medium text-slate-600">
                      Remark {pick === 'RELEASE' && r.status === 'PASS' ? '(optional)' : '(required)'} — what was checked, who agreed, quantity
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

function Fact({ label, children, mono = false, wide = false }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`mt-0.5 text-slate-800 ${mono ? 'font-mono text-[13px]' : ''}`}>{children}</dd>
    </div>
  );
}
