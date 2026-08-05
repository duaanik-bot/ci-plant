// Live Floor — the plant as one stack of section bands, top to bottom in flow
// order. Each band carries its own machines and the jobs on them, so a machine
// is named once on the page; a section with no work collapses to a single row.
// Every control an operator is allowed to press sits on the job row itself:
// start, complete, hold, resume, request extra sheets, move up or down the
// queue. Auto-refreshes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, ExportMenu, Field, Input, Modal, PageHeader, rowMatches, SearchInput, Select, useToast } from '../components/ui.jsx';
import { Play, PackagePlus, RefreshCw, WifiOff } from 'lucide-react';
import { SECTION_META, SORT_PASTE_META, HOLD_REASONS } from '../sections.js';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import BoardIssue from '../components/BoardIssue.jsx';
// Which source a card's board mix comes from — its own line, or the run it
// shares. ONE reader for Job Cards, the Live Floor and the station workspace.
import { boardMixSource, normaliseMixRows } from '../lib/boardIssue.js';
import PlannedBreakup from '../components/PlannedBreakup.jsx';
import { GangMemberList } from '../components/Gang.jsx';
import { receivedQty } from '../lib/received.js';
import SectionBand from '../components/floor/SectionBand.jsx';
import { useTier } from '../lib/tier.js';

// One label for a gang parent job everywhere on the floor board — every member
// product named, in gang order, so the chip reads as one unit.
const jobLabel = job => job.gang_members?.length
  ? job.gang_members.map(m => m.product_name).join(' + ')
  : job.product_name;

export default function Floor() {
  const touch = useTier() !== 'desktop';
  const toast = useToast();
  const nav = useNavigate();
  const [sections, setSections] = useState(null);
  const [q, setQ] = useState('');
  const [completing, setCompleting] = useState(null);
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0' });
  // "As planned" breakup for the completion modal, cutting stages only — see
  // PlannedBreakup.jsx's own header comment. Unlike Section.jsx's row (from
  // STAGE_VIEW, which already carries board_name/sheet_l/sheet_w), this
  // board's plain /floor row carries NEITHER — so unlike Section.jsx, this
  // fetch runs for EVERY cutting completion, single-board included, and
  // `breakupSingle` (not the row itself) is what PlannedBreakup falls back to.
  // Fails OPEN, same as Section.jsx: completion records cutting that has
  // already happened, so a failed fetch must never block it.
  const [breakupStatus, setBreakupStatus] = useState('idle');
  const [breakupRows, setBreakupRows] = useState([]);
  const [breakupPhase, setBreakupPhase] = useState(null);
  const [breakupSingle, setBreakupSingle] = useState(null);
  const breakupReqRef = useRef(0);
  const [logFor, setLogFor] = useState(null);   // machine whose log is open
  const [log, setLog] = useState(null);
  const [clearing, setClearing] = useState(null);  // job awaiting line clearance before start
  const [checks, setChecks] = useState([]);
  // Board issue — board is consumed only at a job's FIRST stage (cutting is
  // always first in routingFor()), and never for a gang card (order_line_id is
  // null; Planning already refuses a gang line a mix — see BoardMix.jsx). A
  // split gang child's own first stage is sorting, not cutting, so it never
  // reaches this either. Every other quick-start never touches this at all:
  // issueStatus stays 'idle'. 'idle' | 'loading' | 'loaded' | 'error' — three
  // real states, never collapsed into two. See BoardIssue.jsx's header comment
  // for why a caught fetch failure must never look like a confirmed empty mix.
  // Mirrors Section.jsx's own wiring exactly — see it for the full rationale.
  const [issueStatus, setIssueStatus] = useState('idle');
  const [issuePlan, setIssuePlan] = useState([]);          // last CONFIRMED load — the plan, untouched
  const [issueRows, setIssueRows] = useState([]);          // editable copy shown/posted
  const [issueLots, setIssueLots] = useState([]);
  const [issueReason, setIssueReason] = useState('');
  const [issuePlannedUps, setIssuePlannedUps] = useState(0);
  // Guards against a stale request landing after a newer row/retry started.
  const issueReqRef = useRef(0);
  const [holding, setHolding] = useState(null);    // job → hold reason
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [sheets, setSheets] = useState(null);      // job → extra sheet request
  const [sheetForm, setSheetForm] = useState({ qty: '', reason: '', note: '' });
  const [failed, setFailed] = useState(null);      // last refresh error, null while healthy
  const [seenAt, setSeenAt] = useState(null);      // when the board on screen was true
  const fails = useRef(0);                         // consecutive failed refreshes
  const skips = useRef(0);                         // poll ticks to sit out after a failure

  // /floor now carries each section's machines and their jobs, so the board is
  // one request. Machines used to come from a second call whose `shared` lane
  // repeated the section queue under every machine of the type.
  //
  // A refresh that fails must NOT take the board off the wall — the plant reads
  // this screen while it works, so the last good picture stays up and only a
  // small "not refreshing" marker appears. Without the catch a first-load
  // failure stuck the floor on "Loading the floor…" forever.
  const load = () => api.get('/floor')
    .then(secs => {
      setSections(secs); setFailed(null); setSeenAt(new Date());
      fails.current = 0; skips.current = 0;
    })
    .catch(e => {
      setFailed(e?.message || 'Could not reach the server.');
      // Back off instead of hammering a server that is already down — every
      // failed poll costs the whole plant one red toast from the API layer.
      fails.current += 1;
      skips.current = Math.min(30, fails.current * 2);
    });
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (skips.current > 0) { skips.current -= 1; return; }
      load();
    }, 10000);
    return () => clearInterval(t);
  }, []);

  const allMachines = useMemo(() => (sections || []).flatMap(s => s.machines || []), [sections]);

  // Board is consumed only at a job's very first stage. cutting is always
  // first in routingFor() — a split gang child's own first stage is sorting,
  // but it never has a 'cutting' job_stage at all, so gating on job.stage
  // (rather than trying to infer stage position client-side) already excludes
  // it for free. WHICH source the mix comes from — the card's own line, or the
  // run it shares (a run parent has no line of its own) — is boardIssue.js's
  // one answer, so this screen, Job Cards and the station workspace cannot
  // fetch three different things for the same card. A null source means the
  // card can carry no mix at all.
  const loadBoardIssue = job => {
    const myReq = ++issueReqRef.current;
    setIssueReason('');
    const src = job.stage === 'cutting' ? boardMixSource(job) : null;
    if (!src) {
      setIssueStatus('idle'); setIssuePlan([]); setIssueRows([]); setIssueLots([]); setIssuePlannedUps(0);
      return;
    }
    setIssueStatus('loading'); setIssuePlan([]); setIssueRows([]); setIssueLots([]); setIssuePlannedUps(0);
    api.get(src.path)
      .then(d => {
        if (issueReqRef.current !== myReq) return; // superseded by a newer row/retry
        const { rows, lots, plannedUps } = normaliseMixRows(d);
        setIssuePlan(rows);
        setIssueRows(rows.map(x => ({ ...x })));
        setIssueLots(lots);
        setIssuePlannedUps(plannedUps);
        setIssueStatus('loaded');
      })
      .catch(() => {
        if (issueReqRef.current !== myReq) return;
        // FAIL CLOSED — never resolve this to [] the way a genuinely
        // mix-free job would read. 'error' blocks Start with a visible,
        // retryable message instead of silently taking the no-mix branch.
        setIssueStatus('error');
      });
  };

  // Line clearance stands between the button and the machine on every working
  // station (cutting → pasting) — QC starts straight away. QC can never be a
  // job's first stage, so it never carries a board mix to confirm — doStart()
  // below is deliberately untouched by issueStatus for that direct path.
  const start = job => {
    if (needsClearance(job.stage)) {
      setClearing(job); setChecks(freshClearance());
      loadBoardIssue(job);
    } else doStart(job);
  };
  const doStart = async (job, lc) => {
    await api.post(`/job-stages/${job.stage_id}/start`, { line_clearance: lc });
    toast.success(`${job.jc_number} started`);
    setClearing(null);
    load();
  };
  // The clearing modal's Start Run button ONLY — the one path that ever
  // carries a board issue to confirm. The issued mix must be recorded BEFORE
  // the stage start, because stage start is what consumes it from the
  // warehouse. Only a CONFIRMED load with rows present posts anything —
  // 'idle' (not cutting, or a gang card) and a confirmed empty mix both skip
  // it, exactly as they did before this feature existed.
  const startClearing = async () => {
    if (issueStatus === 'loading' || issueStatus === 'error') return; // belt and braces — Start is already disabled
    if (issueStatus === 'loaded' && issueRows.length) {
      await api.post(`/job-cards/${clearing.job_card_id}/board-issue`,
        { rows: issueRows, reason: issueReason });
    }
    await doStart(clearing, clearancePayload(checks));
    setIssueStatus('idle'); setIssuePlan([]); setIssueRows([]); setIssueLots([]);
    setIssuePlannedUps(0); setIssueReason('');
  };
  const openComplete = job => {
    setCompleting(job);
    // Cutting yields child print sheets = parent in × cuts per parent; other
    // stages carry forward 1:1. Default the good output to that yield.
    const cpp = job.stage === 'cutting' ? Math.max(1, job.children_per_parent || 1) : 1;
    setForm({ qty_out: receivedQty(job) ? String(receivedQty(job) * cpp) : '', qty_scrap: '0' });
    // As-planned breakup — cutting only. This board's /floor row carries no
    // board_name/sheet size at all (unlike Section.jsx's STAGE_VIEW row), so
    // the single-board case needs the same GET a mixed job needs; there is no
    // row-only fallback to skip it with.
    const myReq = ++breakupReqRef.current;
    if (job.stage !== 'cutting') {
      setBreakupStatus('idle'); setBreakupRows([]); setBreakupPhase(null); setBreakupSingle(null);
      return;
    }
    setBreakupStatus('loading'); setBreakupRows([]); setBreakupPhase(null); setBreakupSingle(null);
    api.get(`/job-cards/${job.job_card_id}`)
      .then(jc => {
        if (breakupReqRef.current !== myReq) return; // superseded
        setBreakupRows(jc.board_mix || []);
        setBreakupPhase(jc.board_mix_phase || null);
        setBreakupSingle({ board_name: jc.board_name, count: jc.children_per_parent || 1,
                           sheets: jc.sheets_issued, sheets_per_packet: jc.sheets_per_packet });
        setBreakupStatus('loaded');
      })
      .catch(() => {
        if (breakupReqRef.current !== myReq) return;
        // FAIL OPEN — the opposite of the board-issue load above (which gates
        // consumption that hasn't happened yet). Completing records cutting
        // that has ALREADY happened, so a blip here must never block it.
        setBreakupStatus('error');
      });
  };
  const complete = async () => {
    await api.post(`/job-stages/${completing.stage_id}/complete`, { qty_out: +form.qty_out, qty_scrap: +form.qty_scrap });
    toast.success(`${completing.jc_number} — stage completed`);
    setCompleting(null);
    load();
  };
  const hold = async () => {
    await api.post(`/job-stages/${holding.stage_id}/hold`, { reason: holdReason });
    toast.success(`${holding.jc_number} on hold`);
    setHolding(null);
    load();
  };
  const resume = async job => {
    await api.post(`/job-stages/${job.stage_id}/resume`, {});
    toast.success(`${job.jc_number} resumed`);
    load();
  };
  // The floor RAISES a CI-XS request; the plant head approves it and the
  // warehouse issues the board. Nothing here puts sheets on a machine.
  const askSheets = async () => {
    const xs = await api.post('/extra-sheets', {
      job_stage_id: sheets.stage_id,
      qty: +sheetForm.qty,
      reason: sheetForm.reason,
      note: sheetForm.note || null,
    });
    toast.success(`${xs.xs_number} raised — sent for approval`);
    setSheets(null);
    load();
  };
  const move = async (job, dir) => {
    const { moved } = await api.post('/floor/queue/move', { job_stage_id: job.stage_id, dir });
    if (!moved) return toast.info(`${job.jc_number} is already ${dir === 'up' ? 'first' : 'last'} in this queue`);
    load();
  };
  const openLog = m => {
    setLogFor(m);
    setLog(null);
    api.get(`/floor/machines/${m.id}/log`).then(setLog);
  };
  const setMachineStatus = async (m, status) => {
    await api.put(`/floor/machines/${m.id}/status`, { status });
    toast.success(`${m.name} marked ${status}`);
    load();
  };

  const jobHandlers = useMemo(() => ({
    onStart: start, onComplete: openComplete, onResume: resume, onMove: move,
    onHold: j => { setHolding(j); setHoldReason(HOLD_REASONS[0]); },
    onSheets: j => { setSheets(j); setSheetForm({ qty: '', reason: '', note: '' }); },
  }), []);
  // The merged station enforces the waste gate + hybrid grid, so its rows open
  // the station rather than the quick start/complete modals.
  const sortPasteHandlers = useMemo(() => ({
    ...jobHandlers, onStart: () => nav('/floor/sort-paste'), onComplete: () => nav('/floor/sort-paste'),
  }), [jobHandlers]);

  // Collapse Sorting + Pasting into one "Sort & Paste" band — the two stations
  // are a single operator workspace. Placed where Sorting sat.
  const displaySections = useMemo(() => {
    if (!sections) return null;
    const bySec = Object.fromEntries(sections.map(s => [s.section, s]));
    const out = [];
    for (const s of sections) {
      if (s.section === 'pasting') continue;               // merged into the band below
      if (s.section === 'sorting') {
        const p = bySec.pasting || { running: [], held: [], queued: [], incoming: [], machines: [], unpinned: [], today: {} };
        out.push({
          section: 'sort_paste', merged: true,
          running: [...s.running, ...p.running], held: [...(s.held || []), ...(p.held || [])],
          queued: [...s.queued, ...p.queued], incoming: [...s.incoming, ...p.incoming],
          machines: [...(s.machines || []), ...(p.machines || [])],
          unpinned: [...(s.unpinned || []), ...(p.unpinned || [])],
          unpinned_more: (s.unpinned_more || 0) + (p.unpinned_more || 0),
          today: {
            completed_today: (s.today?.completed_today || 0) + (p.today?.completed_today || 0),
            produced_today: p.today?.produced_today || 0,
            scrap_today: (s.today?.scrap_today || 0) + (p.today?.scrap_today || 0),
          },
        });
        continue;
      }
      out.push(s);
    }
    return out;
  }, [sections]);

  // Search narrows the board to the jobs that match — every lane of every
  // section, the section's unpinned queue, and the jobs sitting on each machine.
  // A band with nothing left is hidden, so a search for one JC leaves just the
  // bands that job actually touches. Matching is the deep row search used by
  // every table, so "2038" finds a job by its board size. Gang parents carry
  // their members' product names, so a member name finds the gang chip too.
  //
  // A band also survives on its OWN identity: searching a section name
  // ("cutting") or a machine name should open that band even when it is
  // standing idle, which is exactly when someone looks it up.
  //
  // The rows the band DRAWS come from the full lanes, never from the arrays the
  // server pre-sliced to three (`machines[].jobs`, `unpinned`). A JC sitting
  // fourth in a queue matched the band but had no row inside it, so a search
  // that found the job showed an empty section back at the floor.
  const searched = useMemo(() => {
    const hit = j => rowMatches(j, q, jobLabel(j));
    if (!q.trim()) return displaySections;
    return (displaySections || []).map(s => {
      const running = s.running.filter(hit);
      const held = (s.held || []).filter(hit);
      const queued = s.queued.filter(hit);
      const incoming = s.incoming.filter(hit);
      // Lane order is the order the floor already works in; a job pinned to a
      // machine also sits in its section lane, so key on stage_id to draw it once.
      const seen = new Set();
      const matches = [];
      for (const j of [...running, ...held, ...queued, ...incoming]) {
        if (seen.has(j.stage_id)) continue;
        seen.add(j.stage_id);
        matches.push(j);
      }
      return { ...s, running, held, queued, incoming, matches };
    }).filter(s =>
      s.matches.length > 0
      || (s.machines || []).some(m => rowMatches({ ...m, jobs: undefined }, q))
      || rowMatches({ section: s.section }, q, (s.merged ? SORT_PASTE_META : SECTION_META[s.section])?.label || ''));
  }, [displaySections, q]);

  // Nothing has ever loaded: say so and offer the way back, rather than leaving
  // the plant staring at "Loading the floor…" while the poll quietly backs off.
  if (!sections) return failed ? (
    <div className="py-20">
      <div className="mx-auto max-w-sm rounded-[22px] border border-white/70 bg-white/65 px-6 py-8 text-center shadow-card backdrop-blur-xl">
        <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-red-50 text-red-500">
          <WifiOff size={16} />
        </span>
        <p className="text-sm font-extrabold text-slate-900">The floor board didn’t load</p>
        <p className="mt-1 text-xs text-slate-500">{failed}</p>
        <Button className="mt-4" onClick={load}><RefreshCw size={13} /> Retry</Button>
      </div>
    </div>
  ) : (
    <div className="py-20 text-center text-sm text-slate-400">Loading the floor…</div>
  );

  const totalRunning = sections.reduce((s, x) => s + x.running.length, 0);
  const totalQueued = sections.reduce((s, x) => s + x.queued.length, 0);

  return (
    <div>
      <PageHeader title="Live Floor"
        subtitle={`${totalRunning} running · ${totalQueued} waiting in queues — refreshes every 10s`}
        actions={<>
        <SearchInput value={q} onChange={setQ} placeholder="JC, product, board, machine…" />
        <ExportMenu build={() => ({
          name: 'Live Floor Snapshot',
          title: 'Live Floor Snapshot',
          subtitle: 'Plant-wide section and machine position at export time',
          summary: [
            { label: 'Running', value: totalRunning },
            { label: 'In queues', value: totalQueued },
            { label: 'Machines up', value: `${allMachines.filter(m => m.live === 'running').length}/${allMachines.length}` },
          ],
          sections: [
            {
              heading: 'Section Position',
              columns: [
                { key: 'section', label: 'Section', export: s => SECTION_META[s.section]?.label || s.section },
                { key: 'running', label: 'Running', align: 'right', export: s => s.running.length },
                { key: 'queued', label: 'Queued', align: 'right', export: s => s.queued.length },
                { key: 'machines', label: 'Machines Up', export: s => (s.machines.length ? `${s.machines.filter(m => m.live === 'running').length}/${s.machines.length}` : 'bench') },
                { key: 'completed_today', label: 'Completed Today', align: 'right', export: s => fmt.num(s.today?.completed_today || 0) },
                { key: 'produced_today', label: 'Produced Today', align: 'right', export: s => fmt.num(s.today?.produced_today || 0) },
                { key: 'scrap_today', label: 'Wastage Today', align: 'right', export: s => fmt.num(s.today?.scrap_today || 0) },
              ],
              rows: sections,
            },
            {
              heading: 'Machine Control',
              columns: [
                { key: 'name', label: 'Machine' },
                { key: 'type', label: 'Type', export: m => fmt.title(m.type || '') },
                { key: 'live', label: 'Status', export: m => fmt.title(m.live || m.status || '') },
                { key: 'jobs', label: 'Jobs on Machine', export: m => (m.jobs || []).map(j => j.jc_number).join(', ') || '—' },
              ],
              rows: allMachines,
            },
          ],
        })} />
        </>} />

      {/* The board is still the last true one — say when it was true rather than
          blanking a screen the floor is working off. */}
      {failed && (
        <div className="mb-3 flex items-center gap-2 rounded-2xl border border-amber-200/70 bg-amber-50/70 px-3.5 py-2 text-[11px] font-semibold text-amber-800 backdrop-blur-xl">
          <WifiOff size={13} className="shrink-0" />
          <span className="truncate">Couldn’t refresh — showing the floor as of {fmt.dt(seenAt)}</span>
          <button onClick={load}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 text-amber-800 transition hover:bg-white">
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {q.trim() && !searched.length && (
        <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
          Nothing on the floor matches “{q}”.
        </div>
      )}
      <div className="space-y-3">
        {searched.map(sec => (
          // A searched band draws its own matching rows and stays open even when
          // it is otherwise clear — an idle machine is exactly what someone looks up.
          <SectionBand key={sec.section} sec={sec} onLog={openLog} onStatus={setMachineStatus}
            collapsible={touch}
            matches={q.trim() ? sec.matches : null} expanded={!!q.trim()}
            jobHandlers={sec.merged ? sortPasteHandlers : jobHandlers} />
        ))}
      </div>

      {/* Machine log — recent runs on this machine + full activity trail */}
      <Modal open={!!logFor} onClose={() => setLogFor(null)} wide
        title={logFor ? `${logFor.name} — Machine Log` : ''}>
        {!log ? (
          <div className="py-12 text-center text-sm text-slate-400">Loading log…</div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2 text-[11px] font-bold">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                {SECTION_META[log.machine.type]?.label || fmt.stage(log.machine.type)}
              </span>
              {log.machine.capacity_per_hour > 0 && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                  {fmt.num(log.machine.capacity_per_hour)}/hr capacity
                </span>
              )}
              <span className="rounded-full bg-slate-100 px-2.5 py-1 capitalize text-slate-600">{log.machine.status}</span>
            </div>

            <div>
              <h4 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">Recent runs</h4>
              {log.runs.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">No runs recorded on this machine yet.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="py-1.5 pr-3 font-bold">When</th>
                      <th className="py-1.5 pr-3 font-bold">Job</th>
                      <th className="py-1.5 pr-3 font-bold">Stage</th>
                      <th className="py-1.5 pr-3 font-bold">In → Out</th>
                      <th className="py-1.5 pr-3 font-bold">Scrap</th>
                      <th className="py-1.5 pr-3 font-bold">Yield</th>
                      <th className="py-1.5 font-bold">Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.runs.map(rn => (
                      <tr key={rn.id} className="border-t border-slate-100">
                        <td className="py-2 pr-3 tabular-nums text-slate-500">{fmt.dt(rn.completed_at ?? rn.started_at)}</td>
                        <td className="py-2 pr-3">
                          <span className="font-bold text-slate-900">{rn.jc_number}</span>
                          <div className="max-w-[200px] truncate text-slate-400">{rn.product_name}</div>
                        </td>
                        <td className="py-2 pr-3">{fmt.stage(rn.stage)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {rn.status === 'completed' ? `${fmt.num(rn.qty_in)} → ${fmt.num(rn.qty_out)}`
                            : rn.status === 'in_progress' ? <span className="font-semibold text-amber-700">{fmt.num(rn.qty_in)} running</span>
                            : rn.status === 'partially_completed' ? <span className="font-semibold text-cyan-700">{fmt.num(rn.qty_out)} of {fmt.num(rn.qty_in)} done</span>
                            : rn.status === 'hold' ? <span className="font-semibold text-red-600">on hold</span>
                            : '—'} {rn.status === 'completed' ? rn.unit : ''}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{rn.status === 'completed' ? fmt.num(rn.qty_scrap) : '—'}</td>
                        <td className="py-2 pr-3 tabular-nums">{rn.yield_pct != null ? `${rn.yield_pct}%` : '—'}</td>
                        <td className="py-2">{rn.operator || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">Activity trail</h4>
              {log.audit.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">No activity recorded yet.</p>
              ) : (
                <ol className="relative ml-2 border-l-2 border-slate-100">
                  {log.audit.map(a => (
                    <li key={a.id} className="relative pb-4 pl-5 last:pb-0">
                      <span className={`absolute -left-[5px] top-1.5 h-2 w-2 rounded-full ${
                        a.action === 'start' ? 'bg-amber-400'
                          : a.action === 'complete' ? 'bg-emerald-500'
                          : a.entity === 'machine' ? 'bg-brand-400' : 'bg-slate-300'}`} />
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm">
                          <b className="font-bold text-slate-900">{a.jc_number || logFor?.name}</b>
                          <span className="ml-2 font-semibold capitalize text-slate-600">{a.action.replace(/:/g, ' → ')}</span>
                          {a.stage && <span className="ml-2 text-xs text-slate-400">{fmt.stage(a.stage)}</span>}
                          {a.detail && <span className="ml-2 text-xs text-slate-400">{a.detail}</span>}
                        </span>
                        <span className="text-[11px] tabular-nums text-slate-400">
                          {fmt.dt(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${fmt.stage(completing.stage)} — ${completing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete} disabled={form.qty_out === ''}>Complete Stage</Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {completing.gang_number
                ? <span className="font-semibold text-violet-700">{completing.gang_number} — one combined count</span>
                : completing.product_name} · Input: <b>{fmt.num(completing.qty_in)} {completing.unit}</b>
              {completing.gang_members?.length > 0 && <GangMemberList members={completing.gang_members} className="mt-2" />}
            </div>
            {completing.stage === 'cutting' && (
              <PlannedBreakup status={breakupStatus} rows={breakupRows} phase={breakupPhase} single={breakupSingle} />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Good output (${completing.unit})`} required>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setForm({ ...form, qty_out: e.target.value })} />
              </Field>
              <Field label={`Scrap (${completing.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>

      {/* Line clearance before a quick start from the floor board */}
      <Modal open={!!clearing} onClose={() => setClearing(null)}
        title={clearing ? `Line Clearance — ${clearing.jc_number} · ${fmt.stage(clearing.stage)}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setClearing(null)}>Cancel</Button>
          <Button onClick={startClearing}
            disabled={issueStatus === 'loading' || issueStatus === 'error' || !allClear(checks)}
            title={
              issueStatus === 'loading' ? 'Loading this job’s board plan…'
              : issueStatus === 'error' ? 'Could not load the board plan — retry before starting'
              : !allClear(checks) ? 'Confirm line clearance first'
              : undefined}>
            <Play size={13} /> Start Run
          </Button>
        </>}>
        {clearing && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {clearing.gang_number
                ? <span className="font-semibold text-violet-700">{clearing.gang_number} — {jobLabel(clearing)}</span>
                : clearing.product_name} · Expected input: <b>{fmt.num(clearing.expected_qty)} {clearing.unit}</b>
            </div>
            <BoardIssue status={issueStatus} mix={issuePlan} lots={issueLots} rows={issueRows}
              onChange={setIssueRows} reason={issueReason} onReason={setIssueReason}
              plannedUps={issuePlannedUps} onRetry={() => loadBoardIssue(clearing)} />
            <LineClearancePanel checks={checks} onChange={setChecks} />
          </div>
        )}
      </Modal>

      <Modal open={!!holding} onClose={() => setHolding(null)}
        title={holding ? `Hold ${fmt.stage(holding.stage)} — ${holding.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setHolding(null)}>Cancel</Button>
          <Button variant="danger" onClick={hold}>Put on Hold</Button>
        </>}>
        {holding && (
          <Field label="Why is this job stopping?" required>
            <Select value={holdReason} onChange={e => setHoldReason(e.target.value)}>
              {HOLD_REASONS.map(h => <option key={h} value={h}>{h}</option>)}
            </Select>
          </Field>
        )}
      </Modal>

      <Modal open={!!sheets} onClose={() => setSheets(null)}
        title={sheets ? `Request Extra Sheets — ${sheets.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setSheets(null)}>Cancel</Button>
          <Button onClick={askSheets} disabled={!sheetForm.qty || !sheetForm.reason.trim()}>
            <PackagePlus size={13} /> Raise Request
          </Button>
        </>}>
        {sheets && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {sheets.product_name} · {fmt.stage(sheets.stage)} · received <b>{fmt.num(receivedQty(sheets))} {sheets.unit}</b>
              <div className="mt-1 text-slate-400">
                This raises a CI-XS request. It is approved first and the warehouse issues the board — no sheets move yet.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Extra parent sheets" required>
                <Input type="number" min="1" value={sheetForm.qty}
                  onChange={e => setSheetForm({ ...sheetForm, qty: e.target.value })} />
              </Field>
              <Field label="Reason" required>
                <Input value={sheetForm.reason} placeholder="Setup wastage"
                  onChange={e => setSheetForm({ ...sheetForm, reason: e.target.value })} />
              </Field>
            </div>
            <Field label="Note">
              <Input value={sheetForm.note} onChange={e => setSheetForm({ ...sheetForm, note: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
