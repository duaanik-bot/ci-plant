// Production — job cards as cards, stages as a rail. One button per moment:
// Start → Complete (with qty out + scrap). Final completion closes the job,
// credits FG stock and feeds Dispatch automatically.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { Button, ExportMenu, Field, Input, Modal, odDays, OutputChip, OverdueDays, PageHeader, rowMatches, SearchInput, searchText, Select, ShadeAge, StatusBadge, Tabs, useToast, WipChip } from '../components/ui.jsx';
import { Play, Check, ChevronRight, Printer, AlertTriangle, Undo2, MessageCircle, PackageSearch, FileDown, X, Wrench } from 'lucide-react';
import StartAlarmDialog, { NO_ACKS } from '../components/StartAlarms.jsx';
// Timeline — the register narrowed to a stretch of days, anchored on the
// PLANNED date. The rule and the presets live in one lib so the chip counts and
// the filtered list can never disagree; see its header for why planned_date.
import { TIMELINE_PRESETS, presetRange, inTimeline, timelineCounts, unplannedCount } from '../lib/jobCardTimeline.js';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BOARD_FULL, BoardBadge, boardStateOf } from '../components/BoardStatus.jsx';
import PlateStatus from '../components/PlateStatus.jsx';
// Printing colour + process — the same one-vocabulary rule, see PrintColour.jsx.
import { PrintColourChips, ColourBadge, ProcessBadge, colourDetailLines, colourSummary } from '../components/PrintColour.jsx';
import WorkflowControls from '../components/WorkflowControls.jsx';
import ToolingForwardModal from '../components/ToolingForwardModal.jsx';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import BoardIssue from '../components/BoardIssue.jsx';
import PacketsOpened from '../components/PacketsOpened.jsx';
import PlannedBreakup from '../components/PlannedBreakup.jsx';
import CutChildrenEntry, { needsCutChildren, seedCutChildren, cutChildrenPayload, cutChildrenOk } from '../components/CutChildrenEntry.jsx';
// Which source a card's board mix comes from — its own line, or the run it
// shares. ONE reader for Job Cards, the Live Floor and the station workspace.
import { boardMixSource, canCarryBoardMix, normaliseMixRows } from '../lib/boardIssue.js';
import { GangChip, GangMemberList, GangBanner, GangOriginLine } from '../components/Gang.jsx';
import { MergeBanner, MergeChip, MergeMemberList } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { scLabel } from './shade-cards/lifecycle.js';
import { receivedQty, expectedOutputQty } from '../lib/received.js';
import { boardUsed, pktText } from '../lib/boardUsed.js';
import { canPlan } from '../modules.js';

// Read-only inherited spec cell — label over value, used across the three
// source panels. Inherited data is never editable from the Job Card.
function Spec({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm font-semibold text-gray-900">{children ?? '—'}</div>
    </div>
  );
}
// Colour used to be GUESSED from the count here — 4 meant "CMYK", anything else
// "NC" — which read a 4-colour Pantone-only job as CMYK and could not see
// metallic at all. The build is recorded now: see components/PrintColour.jsx.

// The board this job is actually on, at the head of the card. It sits in the
// FIRST panel rather than down in Product Master because it is the one value a
// cutter must not get wrong, and because it is no longer necessarily what the
// master says: a planner can move a job onto another board in the warehouse.
function BoardBand({ board }) {
  if (!board) return null;
  const tone = board.differsFromMaster
    ? 'bg-violet-50 text-violet-700'
    : 'bg-slate-100 text-slate-500';
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Board in use</div>
        <span className={`ml-auto shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${tone}`}>
          {board.label}
        </span>
      </div>
      {/* Every parent in use, not just the primary — the screen and the printed
          traveler must name the same set of boards. */}
      <div className="mt-1 space-y-1">
        {(board.boards?.length ? board.boards : [{ material_id: 0, name: board.name || '—', sheet: board.sheet }]).map(b => (
          <div key={b.material_id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {!board.multi && board.grade && (
              <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white"
                title="Board grade">{board.grade}</span>
            )}
            <span className="min-w-0 break-words text-sm font-bold text-gray-900">{b.name}</span>
            {b.sheet && <span className="shrink-0 text-xs font-semibold text-slate-500">{b.sheet}</span>}
            {/* Packets first — the warehouse's own unit — then the sheet counts
                production works in. Same order and same words as the traveler. */}
            {b.packets != null && (
              <span className="ml-auto shrink-0 text-xs font-bold tabular-nums text-slate-700">{pktText(b.packets)} pkt</span>
            )}
            {b.parent != null && (
              <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-500">· {fmt.num(b.parent)} parent</span>
            )}
            {b.child != null && (
              <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-500">→ {fmt.num(b.child)} child</span>
            )}
          </div>
        ))}
      </div>
      {/* Only when they actually disagree — a card running on its own master
          board should say one thing, not two. */}
      {board.differsFromMaster && board.masterName && (
        <div className="mt-1 text-[11px] text-slate-500">
          Product master specs <span className="font-semibold text-slate-600">{board.masterName}</span> — this job was moved in Planning.
        </div>
      )}
      {board.issuedElsewhere.map(m => (
        <div key={m.material_id} className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-amber-700">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>Issued from <b>{m.name}</b> — {fmt.num(m.qty)} {m.unit} actually consumed.</span>
        </div>
      ))}
    </div>
  );
}

// The PO a card answers for, and how long that customer has been waiting.
// Mirrors Planning and Artwork, except the members live on `gang_members` here
// rather than `_gang`: a gang answers for its OLDEST PO, because the run is as
// overdue as the longest-waiting order printed on the sheet. `latest` is set
// only when the members were booked on different days, so the cell shows a span
// exactly when there is one.
//
// This is the card's only real clock. delivery_date is null on ~92% of the open
// book, which is why the Delivery line beside it is so often blank.
const poAgeOf = jc => {
  const ds = [...new Set([jc, ...(jc?.gang_members || [])].map(m => m?.po_date).filter(Boolean))].sort();
  return { date: ds[0] ?? null, latest: ds.length > 1 ? ds[ds.length - 1] : null, days: odDays(ds[0]), count: ds.length };
};

// PO date and OD on the card face. Deliberately its own line rather than more
// text crammed into ProductIdentity's `meta`: OD is a colour-coded chip, and a
// chip cannot live inside a joined string. Reads "27 May 2026 → 05 Jul 2026 41d"
// for a gang, "27 May 2026 41d" for a single card, and renders nothing at all
// when the order carries no PO date — an empty caption is worse than silence.
function PoAgeLine({ jc }) {
  const a = poAgeOf(jc);
  if (!a.date) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 tabular-nums text-gray-500">
      <span className="whitespace-nowrap">{fmt.date(a.date)}</span>
      {a.latest && <span className="whitespace-nowrap text-gray-400">→ {fmt.date(a.latest)}</span>}
      <OverdueDays days={a.days} count={a.count} />
    </div>
  );
}

// How the register is ordered. 'newest' is what the server already returns
// (newest job card first) and stays the default, so nobody's usual view changes
// until they ask for it.
//
// There is deliberately no separate "overdue" option: OD is a pure function of
// the PO date, so sorting by one IS sorting by the other. Offering both would
// be two buttons that do the same thing.
const JC_SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'po_date', label: 'Oldest PO' },
];

// The rungs of the ladder, named once so the tab strip and the export header
// cannot drift apart.
const TAB_LABELS = {
  pending: 'Pending Finalisation',
  finalised: 'Finalised',
  running: 'In Progress',
  closed: 'Completed',
  all: 'All',
};

export default function Production() {
  const toast = useToast();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  // Opens on the planner's queue — the cards still owing a finalise.
  const [tab, setTab] = useState('pending');
  const [q, setQ] = useState('');
  // Timeline — which days of the register to show, by planned date. Opens on
  // 'all': the tab a planner lands on is his whole queue, and a date filter he
  // did not ask for would hide work on the first paint.
  const [timeline, setTimeline] = useState('all');
  const [sort, setSort] = useState('newest');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  // Ticked cards, by id. Deliberately NOT pruned when the tab or the timeline
  // changes: gathering Monday's cards and Tuesday's into one print run is the
  // whole point, and a selection that silently emptied itself on a tab click
  // would make that impossible. The count is always shown, so nothing is
  // selected invisibly.
  const [picked, setPicked] = useState(() => new Set());
  const [completing, setCompleting] = useState(null); // {stage, jc}
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0', operator: '' });
  // Per-board children entry — cutting completion on a job whose mix cut MORE
  // THAN ONE board. {[material_id]: string}, wired to the server's
  // cut_children contract (see CutChildrenEntry.jsx). Empty for every other
  // completion, and nothing extra is sent.
  const [cutChildren, setCutChildren] = useState({});
  // "As planned" breakup for the completion modal, cutting stages only — see
  // PlannedBreakup.jsx's own header comment. `jc` here comes from the /job-cards
  // LIST (no board_mix attached — only the singular GET/PUT do that), but it
  // already carries board_name/children_per_parent/sheets_issued off JC_VIEW,
  // so the single-board case needs no fetch at all — same situation as
  // Section.jsx, not Floor.jsx (whose /floor row carries neither).
  const [breakupStatus, setBreakupStatus] = useState('idle');
  const [breakupRows, setBreakupRows] = useState([]);
  const [breakupPhase, setBreakupPhase] = useState(null);
  const breakupReqRef = useRef(0);
  const [clearing, setClearing] = useState(null);     // {jc, st} awaiting line clearance
  const [alarm, setAlarm] = useState(null);          // soft shade/plate 409 → { kind, jc, st, lc, ack }
  const [reversing, setReversing] = useState(null);   // {jc, st}
  const [reverseReason, setReverseReason] = useState('');
  const [checks, setChecks] = useState([]);
  // Board issue — board is consumed only at a job's FIRST stage (cutting is
  // always first in routingFor()), and never for a gang card (order_line_id is
  // null; Planning already refuses a gang line a mix — see BoardMix.jsx). A
  // split gang child's own first stage is sorting, not cutting, so it never
  // reaches this either. Every other Start never touches this at all:
  // issueStatus stays 'idle'. 'idle' | 'loading' | 'loaded' | 'error' — three
  // real states, never collapsed into two. See BoardIssue.jsx's header comment
  // for why a caught fetch failure must never look like a confirmed empty mix.
  // Mirrors Section.jsx's own wiring exactly — see it for the full rationale.
  const [issueStatus, setIssueStatus] = useState('idle');
  const [issuePlan, setIssuePlan] = useState([]);          // last CONFIRMED load — the plan, untouched
  const [issueRows, setIssueRows] = useState([]);          // editable copy shown/posted
  const [issueLots, setIssueLots] = useState([]);
  const [issueReason, setIssueReason] = useState('');
  // Sealed packets opened per board — see PacketsOpened.jsx. Blank = implied.
  const [packetsOpened, setPacketsOpened] = useState({});
  const [issuePlannedUps, setIssuePlannedUps] = useState(0);
  // Guards against a stale request landing after a newer row/retry started.
  const issueReqRef = useRef(0);
  const [machines, setMachines] = useState([]);
  const [editing, setEditing] = useState(null);
  const [toolingForward, setToolingForward] = useState(null);
  const [jobForm, setJobForm] = useState({ qty_planned: '', sheets_issued: '', machine_id: '' });
  // Inherited-spec editor (pre-finalise): output/shade/die/block/emboss/leafing
  // are editable on the card and fire the same "update the master?" question
  // Planning and Artwork use. jcSyncPrompt = { changed } while it asks.
  const [jcSpec, setJcSpec] = useState({});
  const [jcSyncPrompt, setJcSyncPrompt] = useState(null);
  const [runNums, setRunNums] = useState({ output_number: '', die_number: '' }); // the gang RUN's own plate + die
  const [runNumBusy, setRunNumBusy] = useState(false);
  // Post-finalise amendment of qty/sheets — reason mandatory, full audit trail.
  const [amending, setAmending] = useState(null); // the jc being amended
  const [amendForm, setAmendForm] = useState({ order_qty: '', qty_planned: '', sheets_issued: '', reason: '' });

  const load = () => api.get('/job-cards').then(setJobs);
  useEffect(() => { load(); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 500 });
  useEffect(() => { api.get('/floor/machines').then(setMachines).catch(() => setMachines([])); }, []);
  const canEditJobCard = canPlan(auth.user);

  // The rungs of the job-card ladder. Every card sits on exactly one, so the
  // tab counts add up to the register total and nothing hides between tabs.
  // A gang parent that has split is history — it lives with the closed cards.
  //
  // Finalisation does NOT gate starting a stage (job-stages/:id/start flips
  // open → in_progress without asking), so a card can run while still
  // unfinalised. Such a card belongs under In Progress — that is what it is —
  // and carries a "Not finalised" chip so the planner still sees the debt
  // instead of losing it behind a tab.
  const rung = j => {
    if (j.status === 'closed' || j.status === 'split') return 'closed';
    if (j.status === 'in_progress') return 'running';
    return j.finalised_at ? 'finalised' : 'pending';
  };
  const rungs = { pending: [], finalised: [], running: [], closed: [] };
  jobs.forEach(j => rungs[rung(j)].push(j));
  // Tab → timeline → search, in that order, so each count means what it says:
  // the TAB counts stay the true plant totals, the TIMELINE chips count within
  // the chosen tab, and only the search narrows what is finally listed.
  const inTab = tab === 'all' ? jobs : rungs[tab] || [];
  const range = timeline === 'custom'
    ? (customRange.from || customRange.to ? customRange : null)
    : presetRange(timeline);
  const inWindow = inTab.filter(j => inTimeline(j, range));
  const tlCounts = timelineCounts(inTab);
  // Cards this timeline is hiding purely because nobody planned them — named
  // on screen rather than left to evaporate. Zero while the timeline is off.
  const unplanned = range ? unplannedCount(inTab) : 0;
  // Deep row search, so a job is findable by any value on it — JC, product,
  // customer, PO, board size ("2038"), stage — and a gang parent by any of its
  // member products.
  // Ordering is the LAST step, after tab → timeline → search, so it only ever
  // rearranges what those three already decided to show — no count moves.
  // A card with no PO date sorts to the back of either PO ordering rather than
  // to the top: an undated card is not the oldest thing on the board.
  const listed = inWindow
    .filter(j => rowMatches(j, q, (j.gang_members || []).map(productSearchText).join(' ')));
  const shown = sort === 'newest' ? listed : [...listed].sort((a, b) => {
    const x = poAgeOf(a), y = poAgeOf(b);
    if (!x.date && !y.date) return 0;
    if (!x.date) return 1;
    if (!y.date) return -1;
    // Oldest PO first — which IS most-overdue first, the same ordering.
    return x.date < y.date ? -1 : x.date > y.date ? 1 : 0;
  });

  // ── Selection ─────────────────────────────────────────────────────────────
  // Ticking a card is pure client state: nothing is written, nothing is locked,
  // and a reload clears it. It exists to build ONE print run out of many cards.
  const toggle = id => setPicked(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const shownIds = shown.map(j => j.id);
  const allShownPicked = shownIds.length > 0 && shownIds.every(id => picked.has(id));
  const toggleAllShown = () => setPicked(prev => {
    const next = new Set(prev);
    // Ticking adds the visible cards to whatever was already picked elsewhere;
    // un-ticking removes only the visible ones and leaves the rest alone.
    if (allShownPicked) shownIds.forEach(id => next.delete(id));
    else shownIds.forEach(id => next.add(id));
    return next;
  });
  // The stack is printed in REGISTER order, not tick order — the paper comes
  // off the printer in the order the planner reads the screen. `jobs` is the
  // server's own ordering, so this holds even for cards picked across tabs.
  const exportPdf = () => {
    const ids = jobs.filter(j => picked.has(j.id)).map(j => j.id);
    if (!ids.length) return;
    navigate(`/production/jobcards/print?ids=${ids.join(',')}`);
  };
  // Produced/scrap are only real once a card has closed.
  const showOutput = tab === 'closed' || tab === 'all';

  // Board is consumed only at a job's very first stage. cutting is always
  // first in routingFor() — a split gang child's own first stage is sorting,
  // but it never has a 'cutting' job_stage at all, so gating on st.stage
  // (rather than trying to infer stage position client-side) already excludes
  // it for free. WHICH source the mix comes from — the card's own line, or the
  // run it shares (a run parent has no line of its own) — is boardIssue.js's
  // one answer, so this screen, the Live Floor and the station workspace cannot
  // fetch three different things for the same card. A null source means the
  // card can carry no mix at all.
  const loadBoardIssue = (jc, st) => {
    const myReq = ++issueReqRef.current;
    setIssueReason('');
    const src = st.stage === 'cutting' ? boardMixSource(jc) : null;
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

  // Line clearance gates every working station (cutting → pasting); QC starts
  // directly. QC can never be a job's first stage, so it never carries a
  // board mix to confirm — doStart() below is deliberately untouched by
  // issueStatus for that direct path.
  const startStage = (jc, st) => {
    if (needsClearance(st.stage)) {
      setClearing({ jc, st }); setChecks(freshClearance());
      loadBoardIssue(jc, st);
    } else doStart(jc, st);
  };
  // Printing's two soft alarms (shade card, plate rack) come back as structured
  // 409s that api.js keeps quiet for the caller to draw. This page drew neither,
  // so Start silently did nothing. Acks accumulate — the shade gate throws
  // before the plate gate, and answering only one would bounce between them.
  const doStart = async (jc, st, lc, ack = NO_ACKS) => {
    try {
      await api.post(`/job-stages/${st.id}/start`, { line_clearance: lc,
        packets_opened: Object.keys(packetsOpened).length ? packetsOpened : undefined,
        ack_shade: ack.shade || undefined, ack_plates: ack.plates || undefined });
    } catch (e) {
      if (e.data?.code === 'SHADE_CARD_NOT_ELIGIBLE') { setAlarm({ kind: 'shade', shade: e.data.shade, jc, st, lc, ack }); return; }
      if (e.data?.code === 'PLATES_NOT_READY') { setAlarm({ kind: 'plates', plates: e.data.plates, jc, st, lc, ack }); return; }
      throw e;
    }
    toast.success(`${fmt.stage(st.stage)} started on ${jc.jc_number}`);
    setClearing(null);
    setAlarm(null);
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
    const { jc, st } = clearing;
    if (issueStatus === 'loaded' && issueRows.length) {
      await api.post(`/job-cards/${jc.id}/board-issue`, { rows: issueRows, reason: issueReason });
    }
    await doStart(jc, st, clearancePayload(checks));
    setIssueStatus('idle'); setIssuePlan([]); setIssueRows([]); setIssueLots([]);
    setIssuePlannedUps(0); setIssueReason('');
  };

  const openComplete = (jc, st) => {
    setCompleting({ jc, st });
    // Cutting turns parent sheets into child print sheets, so the good output
    // defaults to the cut yield (parent in × cuts per parent), not the input.
    // A mixed job cuts each board at its own chosen count, so its yield is
    // Σ issued × cuts off the card's mix_cuts payload instead — the legacy cpp
    // is one board's figure and simply wrong across a mix.
    const mix = st.stage === 'cutting' && Array.isArray(jc.mix_cuts) && jc.mix_cuts.length ? jc.mix_cuts : null;
    const cpp = st.stage === 'cutting' ? Math.max(1, jc.children_per_parent || 1) : 1;
    const opening = mix
      ? expectedOutputQty(st, 'cutting', jc.children_per_parent, mix)
      : receivedQty(st) ? receivedQty(st) * cpp : 0;
    setForm({ qty_out: opening ? String(opening) : '', qty_scrap: '0', operator: st.operator || '' });
    // One input per pile when the mix cut more than one board — seeded on each
    // board's own expected children so a clean completion stays one click.
    setCutChildren(needsCutChildren(st.stage, jc.mix_cuts) ? seedCutChildren(jc.mix_cuts) : {});
    // As-planned breakup — cutting only, and only a fetch when this job could
    // actually carry a mix: a line card, or a RUN parent card (the server
    // aggregates a run's member-split rows — see attachBoardMix). The
    // single-board render needs nothing from this fetch: `jc` already has
    // board_name/children_per_parent/sheets_issued.
    const myReq = ++breakupReqRef.current;
    if (st.stage !== 'cutting') {
      setBreakupStatus('idle'); setBreakupRows([]); setBreakupPhase(null);
    } else if (!canCarryBoardMix(jc)) {
      setBreakupStatus('loaded'); setBreakupRows([]); setBreakupPhase(null);
    } else {
      setBreakupStatus('loading'); setBreakupRows([]); setBreakupPhase(null);
      api.get(`/job-cards/${jc.id}`)
        .then(full => {
          if (breakupReqRef.current !== myReq) return; // superseded
          setBreakupRows(full.board_mix || []);
          setBreakupPhase(full.board_mix_phase || null);
          setBreakupStatus('loaded');
        })
        .catch(() => {
          if (breakupReqRef.current !== myReq) return;
          // FAIL OPEN — completion records cutting that already happened, so
          // a failed load here must never block it (opposite of Start's board
          // issue load above, which fails closed).
          setBreakupStatus('error');
        });
    }
  };

  const complete = async () => {
    const { st, jc } = completing;
    // Multi-board cutting owes the server the per-board split (cut_children) —
    // without it the completion 400s. Everything else sends the legacy body.
    const perBoard = needsCutChildren(st.stage, jc.mix_cuts)
      ? cutChildrenPayload(jc.mix_cuts, cutChildren) : null;
    await api.post(`/job-stages/${st.id}/complete`, {
      qty_out: +form.qty_out, qty_scrap: +form.qty_scrap,
      ...(perBoard ? { cut_children: perBoard } : {}),
    });
    const isLast = st.seq === Math.max(...jc.stages.map(s => s.seq));
    toast.success(isLast ? `${jc.jc_number} closed — FG added to stock, ready for dispatch` : `${fmt.stage(st.stage)} completed`);
    setCompleting(null); load();
  };

  const reverseStage = async () => {
    await api.post(`/job-stages/${reversing.st.id}/reverse`, { reason: reverseReason });
    toast.info(`${fmt.stage(reversing.st.stage)} reversed on ${reversing.jc.jc_number}`);
    setReversing(null); setReverseReason(''); load();
  };
  const openJobForm = async jc => {
    const full = await api.get(`/job-cards/${jc.id}`).catch(() => jc);
    setEditing(full);
    setJobForm({
      qty_planned: full.qty_planned ?? '',
      sheets_issued: full.sheets_issued ?? '',
      machine_id: full.machine_id || '',
    });
    setJcSpec({
      output_number: full.output_number || '',
      die_number: full.die_number || '',
      block_number: full.block_number || '',
      emboss: String(full.emboss ? 1 : 0),
      leafing: String(full.leafing ? 1 : 0),
      leafing_colour: full.leafing_colour || '',
    });
    // The RUN's own numbers — seeded from run_output_number/run_die_number,
    // never from the resolved output_number, or a carton's master value would
    // look like the run's and be saved back onto the run.
    setRunNums({ output_number: full.run_output_number || '', die_number: full.run_die_number || '' });
  };
  const runNumsDirty = !!editing && ((runNums.output_number || '') !== (editing.run_output_number || '')
    || (runNums.die_number || '') !== (editing.run_die_number || ''));
  const saveRunNums = async () => {
    setRunNumBusy(true);
    try {
      await api.patch(`/gang-runs/${editing.gang_run_id}/numbers`, runNums);
      const full = await api.get(`/job-cards/${editing.id}`);
      setEditing(full);
      setRunNums({ output_number: full.run_output_number || '', die_number: full.run_die_number || '' });
      toast.success('Run numbers saved — every station on this run now shows them');
      load();
    } catch (e) { toast.error(e.message || 'Could not save the run numbers'); }
    finally { setRunNumBusy(false); }
  };
  const JC_SPEC_LABELS = {
    output_number: 'Output Number', die_number: 'Die Number',
    block_number: 'Block Number', emboss: 'Emboss', leafing: 'Leafing',
    leafing_colour: 'Leafing Colour',
  };
  const changedJcSpec = () => {
    if (!editing) return {};
    const out = {};
    for (const f of Object.keys(JC_SPEC_LABELS)) {
      const cur = (f === 'emboss' || f === 'leafing') ? String(editing[f] ? 1 : 0)
        : String(editing[f] ?? '');
      if (String(jcSpec[f] ?? '').trim() !== cur) out[f] = String(jcSpec[f] ?? '').trim();
    }
    return out;
  };
  const saveJcSpec = () => {
    const changed = changedJcSpec();
    if (!Object.keys(changed).length) return;
    setJcSyncPrompt({ changed });
  };
  const doSaveJcSpec = async update_master => {
    try {
      await api.put(`/order-lines/${editing.order_line_id}/spec`, { spec: jcSyncPrompt.changed, update_master });
      toast.success(update_master ? 'Saved — Carton Product Master updated' : 'Saved for this job only');
      setJcSyncPrompt(null);
      await openJobForm(editing);
      load();
    } catch (e) { toast.error(e.message || 'Could not save spec'); }
  };
  const saveJobForm = async () => {
    if (!editing) return;
    await api.put(`/job-cards/${editing.id}`, jobForm);
    toast.success(`${editing.jc_number} updated`);
    setEditing(null);
    load();
  };
  const jobHasStarted = jc => jc.stages.some(st => ['in_progress', 'partially_completed', 'hold', 'completed'].includes(st.status));
  const cuttingStarted = jc => (jc.stages || []).some(st => st.stage === 'cutting' && st.status !== 'pending');
  const openAmend = jc => {
    setAmending(jc);
    setAmendForm({
      order_qty: jc.gang_parent ? '' : String(jc.line_qty ?? ''),
      qty_planned: String(jc.qty_planned ?? ''),
      sheets_issued: String(jc.sheets_issued ?? ''),
      reason: '',
    });
  };
  const submitAmend = async () => {
    try {
      const body = { reason: amendForm.reason };
      if (!amending.gang_parent && amendForm.order_qty !== '' && +amendForm.order_qty !== +amending.line_qty) body.order_qty = amendForm.order_qty;
      if (amendForm.qty_planned !== '' && +amendForm.qty_planned !== +amending.qty_planned) body.qty_planned = amendForm.qty_planned;
      if (amendForm.sheets_issued !== '' && +amendForm.sheets_issued !== +amending.sheets_issued) body.sheets_issued = amendForm.sheets_issued;
      const updated = await api.post(`/job-cards/${amending.id}/amend`, body);
      toast.success(`${updated.jc_number} amended — trail recorded`);
      setAmending(null);
      if (editing?.id === updated.id) { setEditing(updated); setJobForm(f => ({ ...f, qty_planned: updated.qty_planned ?? '', sheets_issued: updated.sheets_issued ?? '' })); }
      load();
    } catch (e) { toast.error(e.message || 'Could not amend'); }
  };
  const canSaveEditing = editing && canEditJobCard && editing.status !== 'closed' && !jobHasStarted(editing) && !editing.finalised_at;
  // Inherited spec stays editable until Finalise freezes the card. A gang
  // parent shows per-carton spec — those edit from Planning / Artwork instead.
  const canEditSpec = editing && canEditJobCard && editing.status !== 'closed' && !editing.finalised_at && !editing.gang_parent && editing.order_line_id;
  const canFinalise = editing && canEditJobCard && !editing.finalised_at && editing.status !== 'closed' && editing.artwork_locked;
  const canReopen = editing && canEditJobCard && !!editing.finalised_at && !jobHasStarted(editing) && editing.status !== 'closed';
  const finalise = async () => {
    if (!editing) return;
    try {
      const updated = await api.post(`/job-cards/${editing.id}/finalise`, {});
      setEditing(null);
      setToolingForward(updated);
      toast.success(`${updated.jc_number} finalised`);
      load();
    } catch (e) { toast.error(e.message || 'Could not finalise'); }
  };
  const reopen = async () => {
    if (!editing) return;
    try {
      const updated = await api.post(`/job-cards/${editing.id}/reopen`, {});
      setEditing(updated);
      toast.info(`${updated.jc_number} reopened`);
      load();
    } catch (e) { toast.error(e.message || 'Could not reopen'); }
  };

  return (
    <div>
      <PageHeader title="Job Cards" subtitle="Every job with its stage rail — strictly one running stage per job. Run the day from Live Floor."
        actions={<>
        <Link to="/production/board-stock-verification">
          <Button variant="secondary" title="Physically verify board stock for jobs headed to cutting">
            <PackageSearch size={14} /> Board Stock Verification
          </Button>
        </Link>
        <SearchInput className="w-80" value={q} onChange={setQ} placeholder="JC, product, customer, PO, board…" />
        <ExportMenu build={() => ({
          name: `Job Cards ${TAB_LABELS[tab]}`,
          title: `Job Cards — ${TAB_LABELS[tab]}`,
          subtitle: 'Production · Job register with current stage',
          summary: [
            { label: 'Job cards', value: shown.length },
            { label: 'Ordered', value: fmt.num(shown.reduce((s, j) => s + (+j.qty_planned || 0), 0)) },
            { label: 'Sheets issued', value: fmt.num(shown.reduce((s, j) => s + (+j.sheets_issued || 0), 0)) },
            ...(showOutput ? [
              { label: 'Produced', value: fmt.num(shown.reduce((s, j) => s + (+j.qty_produced || 0), 0)) },
              { label: 'Scrap', value: fmt.num(shown.reduce((s, j) => s + (+j.qty_scrap || 0), 0)) },
            ] : []),
          ],
          columns: [
            { key: 'jc_number', label: 'Job Card', export: j => `${j.jc_number}${j.gang_number ? ` (${j.gang_number})` : ''}${j.output_number ? ` · Out ${j.output_number}` : ''}` },
            { key: 'status', label: 'Status', export: j => fmt.title(j.status) },
            { key: 'board_state', label: 'Board Status', export: j => BOARD_FULL[boardStateOf(j)] || '—' },
            { key: 'product_name', label: 'Product', export: j => j.gang_parent && j.gang_members?.length
              ? j.gang_members.map(productExport).join(' + ') : productExport(j) },
            { key: 'customer_name', label: 'Customer / PO', export: j => j.gang_parent && j.gang_members?.length
              ? [...new Set(j.gang_members.map(m => `${m.customer_name} · PO ${m.po_number}`))].join(' | ')
              : `${j.customer_name} · PO ${j.po_number}` },
            { key: 'po_date', label: 'PO Date',
              export: j => { const a = poAgeOf(j); return a.date
                ? fmt.date(a.date) + (a.latest ? ` — ${fmt.date(a.latest)}` : '') : '—'; } },
            { key: 'od', label: 'OD', align: 'right',
              export: j => { const d = poAgeOf(j).days; return d == null ? '—' : `${d}d`; } },
            { key: 'delivery_date', label: 'Delivery', export: j => fmt.date(j.delivery_date) },
            { key: 'qty_planned', label: 'Ordered', align: 'right', export: j => fmt.num(j.qty_planned) },
            { key: 'sheets_issued', label: 'Sheets Issued', align: 'right', export: j => fmt.num(j.sheets_issued) },
            { key: 'stage', label: 'Stage Position', export: j => {
              const running = j.stages.find(s => ['in_progress', 'partially_completed'].includes(s.status));
              const done = j.stages.filter(s => s.status === 'completed').length;
              return running ? `${fmt.stage(running.stage)} ${running.status === 'partially_completed' ? 'partially done' : 'running'} (${done}/${j.stages.length} done)` : `${done}/${j.stages.length} stages done`;
            } },
            ...(showOutput ? [
              { key: 'qty_produced', label: 'Produced', align: 'right', export: j => fmt.num(j.qty_produced) },
              { key: 'qty_scrap', label: 'Scrap', align: 'right', export: j => fmt.num(j.qty_scrap) },
            ] : []),
          ],
          rows: shown,
        })} />
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'pending', label: 'Pending Finalisation', count: rungs.pending.length },
        { key: 'finalised', label: 'Finalised', count: rungs.finalised.length },
        { key: 'running', label: 'In Progress', count: rungs.running.length },
        { key: 'closed', label: 'Completed', count: rungs.closed.length },
        { key: 'all', label: 'All', count: jobs.length },
      ]} />

      {/* Timeline — by PLANNED date, the day the job runs on the press. Sits
          under the tabs because it narrows whichever rung is open, and carries
          live counts so a planner can see at a glance how much of the queue is
          actually dated before he clicks. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-full bg-white/50 p-1 ring-1 ring-white/70">
          {TIMELINE_PRESETS.map(p => (
            <button key={p.key} type="button" onClick={() => setTimeline(p.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple touch:min-h-[40px]
                ${timeline === p.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
              {p.label}
              {tlCounts[p.key] != null && (
                <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${timeline === p.key ? 'bg-[#E1EFFF] text-[#0064D2]' : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>
                  {tlCounts[p.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        {timeline === 'custom' && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={customRange.from}
              onChange={e => setCustomRange(r => ({ ...r, from: e.target.value }))} /></Field>
            <Field label="To"><Input type="date" value={customRange.to}
              onChange={e => setCustomRange(r => ({ ...r, to: e.target.value }))} /></Field>
          </div>
        )}
        {/* Order, not filter. The timeline above answers "which days"; this
            answers "which end first" — and it is the only way to put the
            longest-waiting customer at the top, since the register's own
            date is the PLANNED date and most cards carry no delivery date. */}
        <div className="flex items-center gap-1 rounded-full bg-white/50 p-1 ring-1 ring-white/70">
          {JC_SORTS.map(s => (
            <button key={s.key} type="button" onClick={() => setSort(s.key)}
              title={s.key === 'po_date' ? 'Longest-waiting customer PO first' : 'Most recently raised job card first'}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple touch:min-h-[40px]
                ${sort === s.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
              {s.label}
            </button>
          ))}
        </div>
        {/* An unplanned card has no date to file under, so no preset can show
            it. Say the number — an undated job in the queue is exactly what a
            planner wants to notice, not something to hide behind a filter. */}
        {unplanned > 0 && (
          <button type="button" onClick={() => setTimeline('all')}
            className="text-[11px] font-semibold text-amber-700 underline-offset-2 hover:underline">
            {unplanned} card{unplanned === 1 ? '' : 's'} with no planned date — not in any timeline
          </button>
        )}
      </div>

      {/* Selection bar — appears only once something is ticked. It reports the
          FULL selection, including cards picked under another tab or timeline,
          so a print run can never be larger than the number on screen. */}
      {/* Anchored to --ci-header-h, never a literal px: the phone header grows
          by the notch inset and a hard-coded top opens this inside the dock.
          touch:static for the same reason Inventory's bulk bar is — a sticky
          bar on a phone eats a third of the list. */}
      {picked.size > 0 && (
        <div className="sticky top-[var(--ci-header-h)] z-20 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-brand-200 bg-brand-50/90 px-3 py-2 backdrop-blur-xl touch:static">
          <span className="text-sm font-extrabold text-brand-700 tabular-nums">{picked.size} selected</span>
          {shownIds.length > 0 && (
            <button type="button" onClick={toggleAllShown}
              className="text-xs font-semibold text-brand-600 hover:underline">
              {allShownPicked ? 'Deselect' : 'Select'} all {shownIds.length} shown
            </button>
          )}
          <button type="button" onClick={() => setPicked(new Set())}
            className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800">
            <X size={12} /> Clear
          </button>
          <Button className="ml-auto" onClick={exportPdf}>
            <FileDown size={14} /> Export PDF ({picked.size})
          </Button>
        </div>
      )}

      {shown.length === 0 && <p className="rounded-xl border border-dashed border-white/70 bg-white/65 backdrop-blur-xl py-14 text-center text-sm text-gray-400">
        {q.trim() ? `No job cards match “${q}”.`
          : range ? `No job cards planned in this window under ${TAB_LABELS[tab]}.`
          : `No job cards under ${TAB_LABELS[tab]}.`}</p>}

      <div className="space-y-4">
        {shown.map(jc => (
          <div key={jc.id} className={`ci-form-panel cursor-pointer transition hover:border-brand-200 ${jc.gang_parent ? 'border-l-[3px] !border-l-violet-400' : ''} ${picked.has(jc.id) ? 'ring-2 ring-brand-300' : ''}`}
            onClick={e => {
              if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
              openJobForm(jc);
            }}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {/* Tick to add this card to the print run. Both the box and
                      its label are in the card's own click guard above, so
                      picking a card never also opens its form. */}
                  <label className="-my-1 flex cursor-pointer items-center py-1 pr-0.5"
                    title={`${picked.has(jc.id) ? 'Remove from' : 'Add to'} the PDF print run`}>
                    <input type="checkbox" checked={picked.has(jc.id)} onChange={() => toggle(jc.id)}
                      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                  </label>
                  <span className="text-sm font-extrabold text-gray-900">{jc.jc_number}</span>
                  {jc.gang_number && (jc.run_kind === 'merge' ? <MergeChip number={jc.gang_number} /> : <GangChip number={jc.gang_number} />)}
                  {/* The plate number the floor calls this job by — the run's
                      own for a gang, the carton's master for a single. Same
                      chip the station queues and the press board wear. */}
                  <OutputChip number={jc.output_number} />
                  <WipChip on={jc.wip} />
                  <StatusBadge status={jc.status} />
                  {/* A card can start without being finalised, so the debt is
                      flagged on the card rather than left to the tab it sits in. */}
                  {jc.status === 'in_progress' && !jc.finalised_at && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-amber-200"
                      title="This job started before it was finalised. Finalise it to lock the spec.">
                      <AlertTriangle size={11} /> Not finalised
                    </span>
                  )}
                  {/* The board verdict in the plant's one vocabulary, replacing
                      a lone amber "Board pending" that could not tell bought-
                      and-coming from nobody-ordered-it — the difference between
                      chasing a delivery and raising a PR. Only troubled states
                      show here: a job card is a working document and a green
                      "Stock OK" on every row of a long list is noise, unlike
                      the planning screens where the queue is being triaged. */}
                  {boardStateOf(jc) !== 'covered' && (
                    <BoardBadge state={boardStateOf(jc)} compact />
                  )}
                  {/* Plates show in EVERY state, unlike board above. A job card is
                      the document the floor works from, and "are the plates in?" is
                      asked on every one of them — a green tick answers it, where an
                      absent badge would just look like nobody had checked. */}
                  {jc.plate_state && <PlateStatus state={jc.plate_state} compact className="ml-1" />}
                  <Link to={`/production/jobcard/${jc.id}`} title="Print job card"
                    className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-brand-600">
                    <Printer size={13} />
                  </Link>
                  {/* One thread per job — problems discussed next to the work. */}
                  <button type="button" title="Discuss this job in CI Messenger"
                    onClick={() => window.dispatchEvent(new CustomEvent('ci-chat-open', { detail: { jobCardId: jc.id } }))}
                    className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-brand-600">
                    <MessageCircle size={13} />
                  </button>
                </div>
                {jc.gang_parent && jc.gang_members?.length ? (
                  <div className="mt-1.5 max-w-lg">
                    {jc.run_kind === 'merge' ? (
                      <>
                        <MergeBanner number={jc.gang_number} members={jc.gang_members} />
                        <ProductIdentity row={jc} className="mt-1.5 max-w-lg"
                          meta={[jc.customer_name, jc.po_number ? `PO ${jc.po_number}` : null, jc.delivery_date ? `delivery ${fmt.date(jc.delivery_date)}` : null].filter(Boolean).join(' · ')} />
                        <MergeMemberList members={jc.gang_members} className="mt-1.5" />
                      </>
                    ) : (
                      <>
                    <GangBanner number={jc.gang_number} members={jc.gang_members} />
                    <GangMemberList members={jc.gang_members} className="mt-1.5" />
                      </>
                    )}
                  </div>
                ) : (
                  <div className="mt-0.5 text-xs text-gray-500">
                    <ProductIdentity row={jc}
                      meta={[jc.customer_name, jc.po_number ? `PO ${jc.po_number}` : null, jc.delivery_date ? `delivery ${fmt.date(jc.delivery_date)}` : null].filter(Boolean).join(' · ')} />
                    <GangOriginLine className="mt-0.5" number={jc.gang_number} mates={jc.gang_run_mates} />
                  </div>
                )}
                {/* One line for every shape of card — gang, merge or single —
                    because all three branches above land here. */}
                <PoAgeLine jc={jc} />
              </div>
              <div className="flex gap-5 text-right text-xs text-gray-500">
                <div><div className="font-bold text-gray-900 tabular-nums">{fmt.num(jc.qty_planned)}</div>{jc.gang_parent ? 'print sheets' : 'ordered'}</div>
                <div><div className="font-bold text-gray-900 tabular-nums">{fmt.num(jc.sheets_issued)}</div>sheets issued</div>
                {jc.status === 'closed' && <>
                  <div><div className="font-bold text-emerald-600 tabular-nums">{fmt.num(jc.qty_produced)}</div>produced</div>
                  <div><div className="font-bold text-red-500 tabular-nums">{fmt.num(jc.qty_scrap)}</div>scrap</div>
                </>}
              </div>
            </div>
            <div className="mb-3 flex items-center justify-end gap-1.5">
              <WorkflowControls jobCard={jc} context="jobcard" onDone={load} asMenu includeDanger
                extraItems={jc.finalised_at && jc.status !== 'closed' ? [{
                  key: 'tooling', label: 'Forward to Tooling Hub', icon: Wrench,
                  onClick: () => setToolingForward(jc),
                }] : []} />
            </div>

            {/* Stage rail */}
            <div className="rounded-2xl border border-slate-100 bg-white/80 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {jc.stages.map((st, i) => (
                <div key={st.id} className="flex items-center gap-1.5">
                  <div className={`rounded-xl border px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,.04)] ${
                    st.status === 'completed' ? 'border-emerald-200 bg-emerald-50'
                    : st.status === 'in_progress' ? 'border-amber-300 bg-amber-50 ring-2 ring-amber-200'
                    : st.status === 'partially_completed' ? 'border-cyan-300 bg-cyan-50 ring-2 ring-cyan-200'
                    : 'border-gray-200 bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold ${st.status === 'completed' ? 'text-emerald-700' : st.status === 'in_progress' ? 'text-amber-700' : st.status === 'partially_completed' ? 'text-cyan-700' : 'text-gray-400'}`}>
                        {fmt.stage(st.stage)}
                      </span>
                      {st.status === 'completed' && jc.status !== 'closed' && (
                        <button onClick={() => { setReversing({ jc, st }); setReverseReason(''); }}
                          className="rounded bg-white p-1 text-slate-400 shadow-sm hover:text-slate-700" title="Reverse completed stage">
                          <Undo2 size={12} />
                        </button>
                      )}
                      {st.status === 'pending' && jc.status !== 'closed' && (
                        <button onClick={() => startStage(jc, st)}
                          className="rounded bg-white p-1 text-gray-500 shadow-sm hover:text-brand-600" title="Start stage">
                          <Play size={12} />
                        </button>
                      )}
                      {['in_progress', 'partially_completed'].includes(st.status) && (
                        <button onClick={() => openComplete(jc, st)}
                          className={`rounded p-1 text-white shadow-sm ${st.status === 'partially_completed' ? 'bg-cyan-500 hover:bg-cyan-600' : 'bg-amber-500 hover:bg-amber-600'}`}
                          title={st.status === 'partially_completed' ? 'Partially done — complete stage' : 'Complete stage'}>
                          <Check size={12} />
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] tabular-nums text-gray-500">
                      {st.status === 'completed' ? `${fmt.num(st.qty_out)} ${st.unit}${st.qty_scrap ? ` · ${fmt.num(st.qty_scrap)} scrap` : ''}`
                        : st.status === 'in_progress' ? `${fmt.num(receivedQty(st))} ${st.unit} in`
                        : st.status === 'partially_completed' ? `${fmt.num(st.qty_out)} of ${fmt.num(expectedOutputQty(st, st.stage, jc.children_per_parent, jc.mix_cuts))} done`
                        : '—'}
                    </div>
                  </div>
                  {i < jc.stages.length - 1 && <ChevronRight size={13} className="text-gray-300" />}
                </div>
              ))}
            </div>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${fmt.stage(completing.st.stage)} — ${completing.jc.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete}
            disabled={form.qty_out === ''
              // Multi-board cutting: the server 400/409s a missing or
              // mismatched per-board split, so the button waits for it.
              || (needsCutChildren(completing?.st.stage, completing?.jc.mix_cuts)
                  && !cutChildrenOk(completing.jc.mix_cuts, cutChildren, (+form.qty_out || 0) + (+form.qty_scrap || 0)))}>
            Complete Stage
          </Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              Input: <b>{fmt.num(receivedQty(completing.st))} {completing.st.unit}</b>
              {completing.st.seq === Math.max(...completing.jc.stages.map(s => s.seq)) &&
                <span className="ml-2 font-semibold text-emerald-600">Final stage — closing this completes the job and adds finished goods.</span>}
            </div>
            {completing.st.stage === 'cutting' && (
              <PlannedBreakup status={breakupStatus} rows={breakupRows} phase={breakupPhase}
                single={{ board_name: completing.jc.board_name, count: completing.jc.children_per_parent || 1,
                          sheets: completing.jc.sheets_issued, sheets_per_packet: completing.jc.sheets_per_packet }} />
            )}
            {completing.st.stage === 'cutting' && (
              <CutChildrenEntry mixCuts={completing.jc.mix_cuts} entries={cutChildren}
                onChange={setCutChildren} declared={(+form.qty_out || 0) + (+form.qty_scrap || 0)} />
            )}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Stage output</span><span>{fmt.stage(completing.st.stage)}</span></div>
              <div className="ci-form-grid">
              <Field label={`Good output (${completing.st.unit})`} required>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setForm({ ...form, qty_out: e.target.value })} />
              </Field>
              <Field label={`Scrap (${completing.st.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>

      <Modal open={!!reversing} onClose={() => setReversing(null)}
        title={reversing ? `Reverse ${fmt.stage(reversing.st.stage)} — ${reversing.jc.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReversing(null)}>Cancel</Button>
          <Button variant="secondary" onClick={reverseStage} disabled={!reverseReason.trim()}>
            <Undo2 size={13} /> Reverse Stage
          </Button>
        </>}>
        {reversing && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              This sends the completed stage back to in-progress. It is allowed only when no downstream stage has started.
            </div>
            <Field label="Reason" required>
              <Input value={reverseReason} onChange={e => setReverseReason(e.target.value)}
                placeholder="e.g. quantity correction, wrong completion, QC hold" />
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Job Card Form — ${editing.jc_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Close</Button>
          {editing && !editing.finalised_at && canEditJobCard &&
            <Button variant="secondary" onClick={saveJobForm} disabled={!canSaveEditing}>Save Changes</Button>}
          {editing && canEditJobCard && editing.finalised_at && editing.status !== 'closed' && editing.status !== 'split' &&
            <Button variant="secondary" onClick={() => openAmend(editing)}>Amend Qty / Sheets</Button>}
          {canReopen && <Button variant="secondary" onClick={reopen}>Reopen</Button>}
          {!editing?.finalised_at
            ? <Button onClick={finalise} disabled={!canFinalise}>Finalise Job Card</Button>
            : <Link to={`/production/jobcard/${editing.id}`}><Button><Printer size={14} /> Print</Button></Link>}
        </>}>
        {editing && (() => {
          const t = (fam) => (editing.tools || []).filter(x => x.family === fam);
          const block = t('block')[0]; const plate = t('plate')[0];
          const shade = editing.shade_card; // live from the Shade Card Management module
          // A mixed job's yield is per board — the BoardBand above names each
          // pile's own cuts, so the single line defers to it rather than
          // printing the legacy column's one figure. Same rule as the traveler.
          const yieldTxt = editing.mix_cuts?.length > 1
            ? `per board — ${editing.mix_cuts.length} boards, see Board in use`
            : editing.children_per_parent > 1 ? `${editing.children_per_parent} print / parent` : '1:1';
          return (
          <div className="space-y-4">
            <div className="ci-summary-panel text-xs">
              {editing.gang_parent && editing.gang_members?.length ? (
                <>
                  <GangBanner number={editing.gang_number} members={editing.gang_members} />
                  <GangMemberList members={editing.gang_members} className="mt-1.5" />
                </>
              ) : (
                <>
                  {editing.product_name} · {editing.customer_name} · PO {editing.po_number} · delivery {fmt.date(editing.delivery_date)}
                  {/* A card split off a gang after die cutting is an ordinary
                      single job from here on, so it falls to this branch — and
                      this is the only thing left saying where it came from. */}
                  <GangOriginLine className="mt-1" number={editing.gang_number} mates={editing.gang_run_mates} />
                </>
              )}
            </div>

            {editing.finalised_at
              ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                  Finalised {fmt.date(editing.finalised_at)} — inherited data is read-only. Reopen to edit fields.
                </div>
              : !editing.artwork_locked
                ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                    Artwork is not locked yet — finalise once customer + QA approvals are in.
                  </div>
                : null}

            {/* Editable fields */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Editable job fields</span><span>{fmt.title(editing.status)}</span></div>
              <BoardBand board={boardUsed(editing)} />
              <div className="ci-form-grid">
                <Field label="Planned Quantity">
                  <Input type="number" min="1" value={jobForm.qty_planned} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, qty_planned: e.target.value })} />
                </Field>
                <Field label="Sheets Issued">
                  <Input type="number" min="0" value={jobForm.sheets_issued} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, sheets_issued: e.target.value })} />
                </Field>
                <Field label="Press / Machine">
                  <Select value={jobForm.machine_id} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, machine_id: e.target.value })}>
                    <option value="">No press assigned</option>
                    {machines.map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
                  </Select>
                </Field>
                <Field label="Job Status">
                  <Input value={fmt.title(editing.status)} disabled readOnly />
                </Field>
              </div>
            </section>

            {/* Inherited — Planning */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Planning Engine</span><span className="text-gray-400">Plan {fmt.date(editing.planned_date) || '—'}</span></div>
              <div className="ci-form-grid">
                <Spec label="Ordered Qty">{editing.gang_parent && editing.gang_members?.length
                  ? `${fmt.num(editing.gang_members.reduce((s, m) => s + (+m.qty || 0), 0))} cartons · ${editing.gang_members.length} products`
                  : `${fmt.num(editing.line_qty)} cartons`}</Spec>
                <Spec label="Sheets Required">{editing.sheets_required != null ? fmt.num(editing.sheets_required) : '—'}</Spec>
                <Spec label="Parent Sheets Issued">{fmt.num(editing.sheets_issued)}</Spec>
                <Spec label="Print Sheets / Parent">{yieldTxt}</Spec>
                <Spec label="Press">{editing.machine_name || '—'}</Spec>
                <Spec label="Delivery">{fmt.date(editing.delivery_date)}</Spec>
              </div>
            </section>

            {/* Printing Specifications — what the press has to hang on the units.
                A gang parent takes its ink from the run's anchor line; each
                carton's own build is listed in the per-carton panel below. */}
            {!editing.gang_parent && (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title">
                  <span>Printing Specifications</span>
                  <span className="text-gray-400">{colourSummary(editing)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <ColourBadge row={editing} />
                  <ProcessBadge row={editing} />
                </div>
                <div className="ci-form-grid mt-3">
                  {colourDetailLines(editing).map(([k, v]) => <Spec key={k} label={k}>{v}</Spec>)}
                  <Spec label="Shade Card No">{editing.shade_card_number || '—'}</Spec>
                  <Spec label="Approved Artwork">{editing.artwork_locked ? 'Locked' : 'Open'}</Spec>
                </div>
                {colourDetailLines(editing).length === 0 && (
                  <div className="mt-2 text-xs text-slate-400">No printing colour recorded on the master yet.</div>
                )}
              </section>
            )}

            {/* Inherited — Artwork. A gang carries several products on one sheet,
                so each carton keeps its OWN shade card, colours, finishes and
                approvals — shown per carton, not as one merged block. */}
            {/* The RUN's own plate + die number. A gang's layout is made for
                this run alone, so these belong to the run, not to any carton's
                master — and this is where a card already on the floor gets
                named without going back to Planning. The Planning engine and
                Artwork edit the same record. Combined runs print one product
                from its own master plate, so they never show it. */}
            {editing.gang_run_id && editing.run_kind !== 'merge' && (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title">
                  <span>This run's own numbers</span>
                  <span className="text-gray-400">new every gang — not from a master</span>
                </div>
                {canEditJobCard && editing.status !== 'closed' ? (<>
                  <div className="ci-form-grid">
                    <Field label="Output No (this run)">
                      <Input value={runNums.output_number} placeholder="e.g. OP-2207"
                        onChange={e => setRunNums({ ...runNums, output_number: e.target.value })} />
                    </Field>
                    <Field label="Die No (this run)">
                      <Input value={runNums.die_number} placeholder="e.g. D-318"
                        onChange={e => setRunNums({ ...runNums, die_number: e.target.value })} />
                    </Field>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-gray-400">
                      Carried by every station this run passes — press, die cutting, the traveler.
                    </span>
                    <Button size="sm" disabled={!runNumsDirty || runNumBusy} onClick={saveRunNums}>
                      {runNumBusy ? 'Saving…' : 'Save run numbers'}
                    </Button>
                  </div>
                </>) : (
                  <div className="ci-form-grid">
                    <Spec label="Output No (this run)">{editing.run_output_number || '—'}</Spec>
                    <Spec label="Die No (this run)">{editing.run_die_number || '—'}</Spec>
                  </div>
                )}
              </section>
            )}

            {editing.gang_parent && editing.gang_members?.length ? (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Artwork Module — per carton</span>
                  <span className="text-gray-400">{editing.gang_members.filter(m => m.artwork_locked).length}/{editing.gang_members.length} locked</span></div>
                <div className="space-y-2.5">
                  {editing.gang_members.map(m => (
                    <div key={m.line_id} className="rounded-xl border border-violet-100 bg-violet-50/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <ProductIdentity row={m} compact className="min-w-0 flex-1" />
                      </div>
                      <div className="ci-form-grid">
                        <Spec label="Customer Approval">{m.artwork_customer_ok ? '✓ Approved' : 'Pending'}</Spec>
                        <Spec label="QA Approval">{m.artwork_qa_ok ? '✓ Approved' : 'Pending'}</Spec>
                        <Spec label="Colours">
                          <span className="block">{colourSummary(m)}</span>
                          <PrintColourChips row={m} compact className="mt-1" />
                        </Spec>
                        <Spec label="Shade Card No">{m.sc_number || m.shade_card_number || '—'}</Spec>
                        <Spec label="Shade Card Age"><ShadeAge date={m.sc_date || m.shade_card_date} /></Spec>
                        <Spec label="Shade Approval">{m.sc_status ? scLabel(m.sc_status) : '—'}</Spec>
                        <Spec label="Output No">{m.output_number || '—'}</Spec>
                        <Spec label="Die">{m.die_number ? `#${m.die_number}` : '—'}</Spec>
                        <Spec label="Block No">{m.block_number || '—'}</Spec>
                        <Spec label="Emboss">{m.emboss ? 'Yes' : 'No'}</Spec>
                        <Spec label="Leafing">{m.leafing ? (m.leafing_colour ? fmt.title(m.leafing_colour) : 'Yes') : 'No'}</Spec>
                        <Spec label="Carton Size">{m.size || '—'}</Spec>
                        <Spec label="Print Sheet">{m.child_l ? `${m.child_l}×${m.child_w}"` : '—'}</Spec>
                        <Spec label="Ups">{m.ups ?? '—'}</Spec>
                        <Spec label="Pasting">{m.pasting_type ? fmt.title(m.pasting_type) : '—'}</Spec>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Artwork Module</span>
                <span className={editing.artwork_locked ? 'text-emerald-600' : 'text-gray-400'}>{editing.artwork_locked ? 'Locked' : 'Open'}</span></div>
              <div className="ci-form-grid">
                <Spec label="Customer Approval">{editing.artwork_customer_ok ? '✓ Approved' : 'Pending'}</Spec>
                <Spec label="QA Approval">{editing.artwork_qa_ok ? '✓ Approved' : 'Pending'}</Spec>
                {/* Colours used to be guessed here from the count alone. The
                    whole build now has its own Printing Specifications panel
                    above; repeating a weaker version of it here would put two
                    disagreeing answers on one screen. */}
                {/* Shade card number/date: live managed card wins for display,
                    but the editable value is the master/job field — the same one
                    Planning and Artwork edit. */}
                {/* Read-only even when the rest of the spec is editable: the
                    shade card lives in its own module now. This was one of FOUR
                    places the same number was typed by hand, which is how 297
                    products ended up carrying a number with no card behind it.
                    The number links out so the card is one click away. */}
                <Spec label="Shade Card No">
                  {shade?.sc_number
                    ? <a href={`/shade-cards?q=${encodeURIComponent(shade.sc_number)}`}
                         className="font-mono text-brand-600 hover:underline">{shade.sc_number}</a>
                    : editing.shade_card_number || '—'}
                </Spec>
                <Spec label="Shade Approval">{shade ? scLabel(shade.status) : '—'}</Spec>
                <Spec label="Shade Card Age"><ShadeAge date={shade?.creation_date || editing.shade_card_date} /></Spec>
                <Spec label="Shade Ref">{shade?.print_reference || shade?.colour_details || '—'}</Spec>
                {/* Output No = the print-set number from the master / this job's
                    override — the value Planning and Artwork edit. The plate
                    tool's own number shows separately below. */}
                {canEditSpec ? (
                  <Field label="Output No">
                    <Input value={jcSpec.output_number} placeholder="e.g. OP-1042"
                      onChange={e => setJcSpec({ ...jcSpec, output_number: e.target.value })} />
                  </Field>
                ) : <Spec label="Output No">{editing.output_number || '—'}</Spec>}
                {canEditSpec ? (
                  <Field label="Die Number">
                    <Input value={jcSpec.die_number} placeholder="e.g. D-105"
                      onChange={e => setJcSpec({ ...jcSpec, die_number: e.target.value })} />
                  </Field>
                ) : <Spec label="Die Number">{editing.die_number || '—'}</Spec>}
                {canEditSpec ? (
                  <Field label="Block No">
                    <Input value={jcSpec.block_number} placeholder="e.g. B-22"
                      onChange={e => setJcSpec({ ...jcSpec, block_number: e.target.value })} />
                  </Field>
                ) : <Spec label="Block No">{editing.block_number || block?.code || '—'}</Spec>}
                {canEditSpec ? (
                  <Field label="Emboss">
                    <Select value={jcSpec.emboss} onChange={e => setJcSpec({ ...jcSpec, emboss: e.target.value })}>
                      <option value="0">No</option><option value="1">Yes</option>
                    </Select>
                  </Field>
                ) : <Spec label="Emboss">{editing.emboss ? 'Yes' : 'No'}</Spec>}
                {canEditSpec ? (
                  <Field label="Leafing">
                    <Select value={jcSpec.leafing}
                      onChange={e => setJcSpec({ ...jcSpec, leafing: e.target.value, ...(e.target.value === '0' ? { leafing_colour: '' } : {}) })}>
                      <option value="0">No</option><option value="1">Yes</option>
                    </Select>
                  </Field>
                ) : <Spec label="Leafing">{editing.leafing ? 'Yes' : 'No'}</Spec>}
                {canEditSpec && jcSpec.leafing === '1' ? (
                  <Field label="Leafing Colour">
                    <Input value={jcSpec.leafing_colour} placeholder="e.g. gold"
                      onChange={e => setJcSpec({ ...jcSpec, leafing_colour: e.target.value })} />
                  </Field>
                ) : (!canEditSpec && editing.leafing ? <Spec label="Leafing Colour">{editing.leafing_colour ? fmt.title(editing.leafing_colour) : '—'}</Spec> : null)}
              </div>
              {canEditSpec && Object.keys(changedJcSpec()).length > 0 && (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2">
                  <span className="text-[11px] font-semibold text-amber-700">
                    {Object.keys(changedJcSpec()).map(k => JC_SPEC_LABELS[k]).join(', ')} edited
                  </span>
                  <Button size="sm" onClick={saveJcSpec}>Save spec changes</Button>
                </div>
              )}
            </section>
            )}

            {/* Inherited — Product Master. For a gang the shared sheet (board,
                parent, coating) is common; each carton's own size / print sheet /
                ups / pasting are shown per carton in the Artwork Module above. */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>{editing.gang_parent ? 'Shared Sheet' : 'Product Master'}</span><span className="text-gray-400">{editing.gang_parent ? 'one mother sheet' : editing.product_code}</span></div>
              <div className="ci-form-grid">
                {/* The MASTER's board — the board in use is in the band at the
                    head of the card, and the two can differ. This panel states
                    what the carton is specced on, which is its whole job. */}
                <Spec label="Board (master)">{editing.master_board_name || editing.board_name || '—'}</Spec>
                <Spec label="Parent Sheet">{editing.sheet_l ? `${editing.sheet_l}×${editing.sheet_w}"` : '—'}</Spec>
                <Spec label="Coating / Lam">{editing.coating && editing.coating !== 'none' ? fmt.title(editing.coating) : 'None'}</Spec>
                {!editing.gang_parent && <Spec label="Print Sheet">{editing.child_l ? `${editing.child_l}×${editing.child_w}"` : '—'}</Spec>}
                {!editing.gang_parent && <Spec label="Carton Size">{editing.size || '—'}</Spec>}
                {!editing.gang_parent && <Spec label="Pasting">{editing.pasting_type ? fmt.title(editing.pasting_type) : '—'}</Spec>}
                {!editing.gang_parent && <Spec label="Die">{editing.die_number ? `#${editing.die_number}${editing.die_location ? ` · ${editing.die_location}` : ''}` : '—'}</Spec>}
                {!editing.gang_parent && <Spec label="UPS">{editing.ups}</Spec>}
              </div>
            </section>

            {/* Push to next stages — only once finalised */}
            {editing.finalised_at && editing.status !== 'closed' && (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Route to production</span><span className="text-gray-400">Finalised</span></div>
                {editing.gang_parent ? (
                  // A gang travels as ONE card: it's already live in Print Planning
                  // and Cutting. Assign a press there (not a hard blocker here);
                  // after die cutting it splits into per-carton jobs automatically.
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-500">
                      This gang is live in <b>Print Planning</b> and <b>Cutting</b> as one job. Assign a press in Print Planning to begin printing — it travels as one product to die cutting, then splits into individual cartons.
                    </p>
                    <div className="flex items-center gap-2">
                      <Link to="/print-planning"><Button variant="secondary"><Printer size={14} /> Print Planning</Button></Link>
                      <WorkflowControls jobCard={editing} context="jobcard" onDone={load} asMenu includeDanger
                        extraItems={[{ key: 'tooling', label: 'Forward to Tooling Hub', icon: Wrench,
                          onClick: () => setToolingForward(editing) }]} />
                    </div>
                  </div>
                ) : (
                <div className="flex items-center justify-end gap-1.5">
                  <WorkflowControls jobCard={editing} context="jobcard" onDone={load} asMenu includeDanger
                    extraItems={[{ key: 'tooling', label: 'Forward to Tooling Hub', icon: Wrench,
                      onClick: () => setToolingForward(editing) }]} />
                </div>
                )}
              </section>
            )}
          </div>
          );
        })()}
      </Modal>

      {toolingForward && (
        <ToolingForwardModal jobCard={toolingForward} onClose={() => setToolingForward(null)} onDone={load} />
      )}

      {/* Amend — qty/sheets change after finalise, reason mandatory. Order qty
          flows back to the sales line and re-derives the plan; the trail lands
          in the universal timeline as order_line/qty_amended + job_card/amended. */}
      <Modal open={!!amending} onClose={() => setAmending(null)}
        title={amending ? `Amend — ${amending.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setAmending(null)}>Cancel</Button>
          <Button onClick={submitAmend} disabled={!amendForm.reason.trim()}>Record Amendment</Button>
        </>}>
        {amending && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Changes flow everywhere live — the sales line, Planning, Pendency, board demand and the stations —
              and every amendment is recorded with your name and reason in the history trail.
            </p>
            <div className="ci-form-grid">
              {!amending.gang_parent && (
                <Field label={`Order Qty (now ${fmt.num(amending.line_qty)})`} hint="flows back to the sales order line — plan sheets re-derive automatically">
                  <Input type="number" min="1" value={amendForm.order_qty}
                    onChange={e => setAmendForm({ ...amendForm, order_qty: e.target.value })} />
                </Field>
              )}
              <Field label={`Planned Qty (now ${fmt.num(amending.qty_planned)})`}>
                <Input type="number" min="1" value={amendForm.qty_planned}
                  onChange={e => setAmendForm({ ...amendForm, qty_planned: e.target.value })} />
              </Field>
              <Field label={`Sheets Issued (now ${fmt.num(amending.sheets_issued)})`}
                hint={cuttingStarted(amending) ? 'cutting already ran — board is consumed; use Adjust on the cutting stage' : 'board to issue at cutting start'}>
                <Input type="number" min="0" value={amendForm.sheets_issued} disabled={cuttingStarted(amending)}
                  onChange={e => setAmendForm({ ...amendForm, sheets_issued: e.target.value })} />
              </Field>
            </div>
            <Field label="Reason (required)">
              <Input value={amendForm.reason} placeholder="e.g. customer revised PO 01732 from 5,000 to 8,000"
                onChange={e => setAmendForm({ ...amendForm, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      {/* Sync Master? — inherited spec edited on the Job Card */}
      <Modal open={!!jcSyncPrompt} onClose={() => setJcSyncPrompt(null)} title="Save master-driven changes"
        footer={<>
          <Button variant="secondary" onClick={() => setJcSyncPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => doSaveJcSpec(false)}>Save for this Job Only</Button>
          <Button onClick={() => doSaveJcSpec(true)}>Update Product Master</Button>
        </>}>
        {jcSyncPrompt && editing && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Update the <b>Carton Product Master</b> with the edited {Object.keys(jcSyncPrompt.changed).map(k => JC_SPEC_LABELS[k] || fmt.title(k)).join(', ')} so
              future jobs auto-populate, or keep the change scoped to this job card?
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              {Object.entries(jcSyncPrompt.changed).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="shrink-0 font-semibold text-slate-700">{JC_SPEC_LABELS[k] || fmt.title(k)}</span>
                  <span className="min-w-0 text-right text-slate-500">
                    <span className="line-through">{(k === 'shade_card_date' ? String(editing[k] ?? '').slice(0, 10) : (k === 'emboss' || k === 'leafing') ? (editing[k] ? 'Yes' : 'No') : editing[k]) || '—'}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{(k === 'emboss' || k === 'leafing') ? (+v ? 'Yes' : 'No') : (v || '—')}</b>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              “This Job Only” keeps the change as a job-level override; the master keeps its current values.
            </p>
          </div>
        )}
      </Modal>

      {/* Line clearance before a stage starts from the job card rail */}
      <Modal open={!!clearing} onClose={() => setClearing(null)}
        title={clearing ? `Line Clearance — ${clearing.jc.jc_number} · ${fmt.stage(clearing.st.stage)}` : ''}
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
            <div className="ci-summary-panel text-xs">
              {clearing.jc.product_name} · {clearing.jc.customer_name}
            </div>
            <BoardIssue status={issueStatus} mix={issuePlan} lots={issueLots} rows={issueRows}
              packetsOpened={packetsOpened} onPacketsOpened={setPacketsOpened}
              onChange={setIssueRows} reason={issueReason} onReason={setIssueReason}
              plannedUps={issuePlannedUps} onRetry={() => loadBoardIssue(clearing.jc, clearing.st)} />
            {/* Mix-free job — the single planned board is consumed straight
                off the card, so there are no BoardIssue rows to hang the
                confirmation on. Only on a CONFIRMED empty mix: 'loading' and
                'error' must not quietly present a field for a board plan we
                could not read, and 'idle' means no board is consumed here at
                all. */}
            {issueStatus === 'loaded' && !issuePlan.length && clearing.jc?.board_material_id && (
              <PacketsOpened
                packetSize={clearing.jc.sheets_per_packet} sheets={clearing.jc.sheets_issued}
                boardName={clearing.jc.board_name}
                value={packetsOpened[clearing.jc.board_material_id] ?? null}
                onChange={v => setPacketsOpened({ ...packetsOpened, [clearing.jc.board_material_id]: v })} />
            )}
            <LineClearancePanel checks={checks} onChange={setChecks} />
          </div>
        )}
      </Modal>

      {/* Soft shade-card / plate alarms — named, overridable, audited. */}
      <StartAlarmDialog alarm={alarm} onClose={() => setAlarm(null)}
        onAcknowledge={kind => doStart(alarm.jc, alarm.st, alarm.lc, { ...alarm.ack, [kind]: true })} />
    </div>
  );
}
