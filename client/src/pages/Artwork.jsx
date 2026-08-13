// Artwork — two approvals, one DELIBERATE lock. Both ticks make a line
// lockable; the planner locks it with the Lock button (nothing locks by
// itself), and the Locked queue can reverse it while no job card exists.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, odDays, odExport, OverdueDays, PageHeader, PlanSavedBadge, ResetFilters, Select, ShadeAge, StatusBadge, Tabs, Textarea, useFilterReset, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { Lock, LockOpen, Hammer, FolderOpen, Link2, GitBranch, Pencil } from 'lucide-react';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BOARD_LABEL, BOARD_FULL, BOARD_HINT, BOARD_TONE, BOARD_COUNT_TONE, BOARD_RANK, BOARD_ROW_CLASS, BoardBadge, rowBoardStateOf } from '../components/BoardStatus.jsx';
import PlateStatus, { PLATE_LABEL, PLATE_FULL, PLATE_HINT, PLATE_TONE, PLATE_RANK } from '../components/PlateStatus.jsx';
// Printing colour + process — one vocabulary for the whole ERP, see PrintColour.jsx.
import { PrintColourChips, ColourBadge, ProcessBadge, ColourCodeLines, colourDetailLines,
         colourSummary, colourSearchText, colourTypeOf, totalColoursOf, printColourWarnings } from '../components/PrintColour.jsx';
import WorkflowControls, { BulkWorkflowControls, DangerZone } from '../components/WorkflowControls.jsx';
import { GangChip, GangCellParts } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { canPlan } from '../modules.js';

// One batched call paints the thread column for a whole list. /threads/summary
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

// A collapsed gang row carries a synthetic `gang-<run>` id and stands for
// several order lines at once — there is no single record to discuss, so it
// gets no doorbell rather than a thread hung on a fake id.
const threadLineId = l => (l._gang ? null : l.id);

// The PO a row answers for — its own, or a gang's OLDEST member, because the
// run is as overdue as the longest-waiting order in it. Mirrors Planning.
const poAgeOf = line => {
  const ds = [...new Set((line._gang || [line]).map(m => m.po_date).filter(Boolean))].sort();
  return {
    date: ds[0] ?? null,
    latest: ds.length > 1 ? ds[ds.length - 1] : null,
    days: odDays(ds[0]),
    count: ds.length,
  };
};

// Tooling readiness chip — the Artwork ↔ Tooling Hub bridge. Emerald = gate
// satisfied; amber = registered tooling not ready yet; red = die missing.
function ToolingChip({ line }) {
  const nav = useNavigate();
  const d = line.tooling || [];
  const gaps = d.filter(x => (x.hard ? x.status !== 'ready' : x.status === 'not_ready'));
  const cls = line.tooling_ready ? 'bg-emerald-100 text-emerald-700'
    : gaps.some(g => g.hard && g.status === 'missing') ? 'bg-red-100 text-red-700'
    : 'bg-amber-100 text-amber-700';
  const label = line.tooling_ready ? '✓ Ready'
    : gaps.map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`).join(' · ');
  return (
    <button title="Open in Tooling Hub"
      onClick={e => { e.stopPropagation(); nav(`/tooling?product=${line.product_id}`); }}
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-75 ${cls}`}>
      {label}
    </button>
  );
}

// ── Board coverage ──────────────────────────────────────────────────────────
// The plant's ONE board vocabulary. The server resolves it (boardStateOf in
// helpers.js) and Planning, the Print Planning triage and this queue all just
// render the verdict, so no two pages can disagree about whether a job's board
// is sorted:
//   covered   the board is HERE — warehouse stock, an alternate/mixed board the
//             engine planned onto, or sheets this job has already drawn
//   on_order  a PR names this job; bought, still to be received
//   short     nobody covered it and nobody ordered it
// The three PARTITION the queue — every job is in exactly one — so the chip
// counts add up to the tab and no job gets chased down two lists. The words,
// tones and icons come from BoardStatus.jsx; this page adds only the row wash,
// which is its own idea.
// Artwork is not where board is fixed, so the two troubled states both wash
// their row red (BOARD_ROW_CLASS, shared with Planning) — the planner is meant
// to notice on the way past, not to read a column. The chip keeps them apart at
// close range; the wash only says "this job is not going to print on time
// unless someone moves". Every row is eligible here: unlike Planning there is
// no tab where short is the normal state.
// A gang prints as ONE sheet, so its weakest member decides for the whole run —
// evaluated AFTER the rows are grouped, since filtering members would split a
// run that has to move as one. `rowBoardStateOf` is that collapse, shared with
// Planning; this queue takes its default fallback ('covered' for a member with
// no verdict), because it has no other board signal to read and a stale payload
// must not paint the whole page red.
//
// Note the name: NOT `boardStateOf`, which BoardStatus.jsx exports for a single
// server-resolved row. That name is a documented grep for board-verdict fixes,
// and two functions answering to it send the next fix to the wrong one.

// Board filter — MULTI-select, because the two kinds of trouble are chased
// together ("what isn't covered?" is Short + PR raised) and a single-select
// control makes that two passes over the same queue. Selecting several states
// is a UNION; selecting none is no filter at all, which is what makes "All"
// the way back rather than a fourth state to keep in sync.
function BoardFilterChips({ active, counts, onToggle, onClear }) {
  const chips = ['covered', 'on_order', 'short'];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 shrink-0 text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Board</span>
      <button type="button" onClick={onClear}
        title={`${counts.all} job${counts.all === 1 ? '' : 's'} in this tab`}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] touch:min-h-[40px] ${
          active.length === 0 ? 'border-[#0A84FF]/25 bg-[#E1EFFF] text-[#0064D2]' : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
        All
        <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active.length === 0 ? 'bg-white/70' : 'bg-[#1D1D1F]/[0.07]'}`}>{counts.all}</span>
      </button>
      {chips.map(k => {
        const on = active.includes(k);
        return (
          <button key={k} type="button" onClick={() => onToggle(k)} title={`${counts[k]} — ${BOARD_HINT[k]}`}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] touch:min-h-[40px] ${
              on ? BOARD_TONE[k] : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
            {BOARD_LABEL[k]}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? BOARD_COUNT_TONE[k] : 'bg-[#1D1D1F]/[0.07]'}`}>{counts[k]}</span>
          </button>
        );
      })}
    </div>
  );
}

// The plate twin of BoardFilterChips. Same three-way PARTITION — every job is
// in exactly one state — so the counts always add to the tab total and a planner
// can ask "what have I not raised plates for" in one click instead of reading
// down a column. Deliberately the same shape, tones and vocabulary as the board
// rail directly above it: two readiness questions asked the same way.
function PlateFilterChips({ active, counts, onToggle, onClear }) {
  const chips = ['none', 'on_order', 'ready'];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 shrink-0 text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Plates</span>
      <button type="button" onClick={onClear}
        title={`${counts.all} job${counts.all === 1 ? '' : 's'} in this tab`}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] touch:min-h-[40px] ${
          active.length === 0 ? 'border-[#0A84FF]/25 bg-[#E1EFFF] text-[#0064D2]' : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
        All
        <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active.length === 0 ? 'bg-white/70' : 'bg-[#1D1D1F]/[0.07]'}`}>{counts.all}</span>
      </button>
      {chips.map(k => {
        const on = active.includes(k);
        return (
          <button key={k} type="button" onClick={() => onToggle(k)} title={`${counts[k]} — ${PLATE_HINT[k]}`}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] touch:min-h-[40px] ${
              on ? PLATE_TONE[k] : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
            {PLATE_LABEL[k]}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? 'bg-white/70 text-slate-700' : 'bg-[#1D1D1F]/[0.07]'}`}>{counts[k]}</span>
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ on, onClick, label, disabled }) {
  return (
    <button onClick={disabled ? undefined : onClick}
      title={disabled ? 'Locked — unlock the artwork to change approvals' : undefined}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
        on ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'} ${
        disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

// Total sheets = ceil(qty / ups) + wastage — the same figure the cut plan
// prints. 200 mirrors the server DEFAULT_WASTAGE_SHEETS fallback.
const WASTAGE_SHEETS = 200;
const sheetsFor = l => Math.ceil((Number(l.qty) || 0) / Math.max(1, Number(l.ups) || 1)) + (l.wastage_sheets ?? WASTAGE_SHEETS);
// Colour used to be GUESSED here — 4 colours meant "CMYK", anything else "NC" —
// which read a 4-colour Pantone-only job as CMYK and could not see metallic at
// all. The build is recorded now, so it is read, not inferred: see
// components/PrintColour.jsx.
// Sub-line of the Board & sheet cell — imposition · die. (Board, GSM and
// sheet size already live inside board_name, e.g. "Saffire · 300 GSM · 23 x 36".)
const imposition = l => [l.ups ? `${l.ups}-up` : null, l.die_number ? `Die ${l.die_number}` : null].filter(Boolean).join(' · ');

// Identity codes + finish spec on the Artwork form that follow the
// master-update philosophy (Sync Master? / This Job Only).
const CODE_LABELS = {
  party_artwork_code: 'Artwork Code',
  output_number: 'Output Number',
  die_number: 'Die Number',
  block_number: 'Block Number',
  emboss: 'Emboss',
  leafing: 'Leafing',
  leafing_colour: 'Leafing Colour',
};
const CODE_FIELDS = Object.keys(CODE_LABELS);

// Ink the studio checks but never owns. Each pair is [effective, master's own,
// label]; LINE_VIEW serves the master_* twins beside the effective value.
// Artwork's job is to notice the drift and say so — Planning is where a real
// change is made, questioned and audited, so nothing here writes either side.
const MASTER_MIRROR = [
  ['colour_type', 'master_colour_type', 'Colour Type'],
  ['colors', 'master_colors', 'Total Colours'],
  ['print_process', 'master_print_process', 'Printing Process'],
  ['pantone_codes', 'master_pantone_codes', 'Pantone Codes'],
  ['metallic_details', 'master_metallic_details', 'Metallic Colour'],
];
// A row served by an older API mid-deploy has no master_* twin at all; that is
// silence, not a mismatch, so an undefined twin is skipped rather than reported
// as "master —".
const colourMismatch = row => (!row ? [] : MASTER_MIRROR
  .filter(([job, master]) => row[master] !== undefined
    && String(row[job] ?? '').trim() !== String(row[master] ?? '').trim())
  .map(([job, master, label]) => ({ label, job: row[job], master: row[master] })));

// The Tooling Hub sections a locked artwork can be fanned into; each lands in
// that section's triage. Block is a foil/emboss tool, so it is only offered
// when the line actually embosses or foils (see PushToToolingModal).
const TOOL_SECTIONS = [
  { key: 'plate', label: 'Plate', hint: 'Printing plates → plate triage' },
  { key: 'die', label: 'Die', hint: 'Cutting die → die triage' },
  { key: 'shade_card', label: 'Shade Card', hint: 'Approved shade → shade-card triage' },
  { key: 'block', label: 'Block', hint: 'Foil / emboss block → block triage', needsEmboss: true },
];

// Fan-out popup — Artwork's only job is to push into the selected sections'
// triage; the send-decision then happens inside each section of the hub.
function PushToToolingModal({ line, onClose, onDone }) {
  const toast = useToast();
  const statusOf = fam => (line?.tooling || []).find(t => t.family === fam);
  // Block only applies when the job embosses or foils/leafs — hide it otherwise.
  const embossable = !!line?.emboss || !!line?.leafing;
  const sections = TOOL_SECTIONS.filter(s => !s.needsEmboss || embossable);
  // Default: every applicable section ticked. Plate / Die / Shade Card are always
  // in view; Block is only in `sections` when there is real block work, so ticking
  // all visible sections keeps Block on only for emboss/foil jobs.
  const [sel, setSel] = useState(() => Object.fromEntries(
    sections.map(s => [s.key, true])));
  const [busy, setBusy] = useState(false);
  const chosen = sections.filter(s => sel[s.key]).map(s => s.key);

  const push = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const res = await api.post('/tools/push', { product_id: line.product_id, families: chosen });
      if (res.created?.length) toast.success(`Pushed to ${res.created.map(c => c.label).join(', ')} triage`);
      if (res.skipped?.length) toast.info(`Already in hub: ${res.skipped.join(', ')}`);
      if (!res.created?.length && !res.skipped?.length) toast.info('Nothing to push');
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e.message || 'Push failed');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!line} onClose={onClose}
      title={line ? `Push to Tooling Hub — ${line.product_name}` : ''}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={push} disabled={busy || !chosen.length}>
          {busy ? 'Pushing…' : `Push ${chosen.length || ''} to triage`.replace('  ', ' ')}
        </Button>
      </>}>
      {line && (
        <div className="space-y-3">
          <div className="ci-summary-panel text-xs">
            Sends this product into each selected section&rsquo;s <b>triage (Incoming)</b> at once — the send-decision is then made inside the section.
          </div>
          <div className="space-y-1.5">
            {sections.map(s => {
              const d = statusOf(s.key);
              const inHub = d && d.status !== 'missing';
              return (
                <label key={s.key}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition-colors ${
                    sel[s.key] ? 'border-[#0A84FF]/40 bg-[#0A84FF]/[0.06]' : 'border-white/70 bg-white/60 hover:bg-white/80'}`}>
                  <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                    checked={!!sel[s.key]} onChange={e => setSel(v => ({ ...v, [s.key]: e.target.checked }))} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#1D1D1F]">{s.label}</span>
                      {d && <span className="rounded-full bg-[#1D1D1F]/[0.06] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">Required</span>}
                    </div>
                    <div className="text-xs text-gray-400">{s.hint}</div>
                  </div>
                  {inHub && <span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">In hub{d.zone ? ` · ${fmt.title(d.zone)}` : ''}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Artwork() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [tab, setTab] = useState('open');
  const [boardFilters, setBoardFilters] = useState([]); // [] = no filter, i.e. All
  const [plateFilters, setPlateFilters] = useState([]); // [] = no filter, i.e. All
  // Both chip rails plus the table's own search box. The tab stays put.
  const filters = useFilterReset([
    [boardFilters, setBoardFilters, [], 'board'],
    [plateFilters, setPlateFilters, [], 'plate'],
  ], () => setSelectedIds([]));
  const [editing, setEditing] = useState(null);
  const [gangOpen, setGangOpen] = useState(null); // gang_run_id of the gang whose unified panel is open
  const [pushLine, setPushLine] = useState(null);
  const [form, setForm] = useState({ customer_ok: false, qa_ok: false, planned_date: '', qty: '', notes: '', party_artwork_code: '', output_number: '', die_number: '', block_number: '', emboss: '0', leafing: '0', leafing_colour: '' });
  const [syncPrompt, setSyncPrompt] = useState(null); // { changed } — "Sync Master?" for artwork/output/shade codes
  // The gang's OWN plate + die number, edited from the gang panel. Belongs to
  // the run, not to any carton's master, so it saves straight to the run.
  const [gangNums, setGangNums] = useState({ output_number: '', die_number: '' });
  const [gangNumBusy, setGangNumBusy] = useState(false);
  const [threads, setThreads] = useState({});
  const load = () => api.get('/artwork').then(ls => {
    setLines(ls);
    threadSummary('order_line', ls.map(l => l.id)).then(setThreads).catch(() => {});
  });
  useEffect(() => { load(); }, []);
  const canApprove = canPlan(auth.user) || auth.user?.role === 'qc';
  const canEditPlanning = canPlan(auth.user);
  const canPush = canPlan(auth.user);
  const open = lines.filter(l => !l.artwork_locked);
  const locked = lines.filter(l => l.artwork_locked && !l.jc_number);
  const completed = lines.filter(l => !!l.jc_number); // pushed to a job card
  const shown = { open, locked, completed, all: lines }[tab] || open;
  // A gang travels as ONE product up to die cutting — so it must READ as one
  // row here too. Collapse every member line of a gang into a single synthetic
  // row carrying `_gang` (all members, in id order); everything else is a plain
  // line. Mirrors the Planning queue so a gang looks identical plan-to-artwork.
  const displayRows = (() => {
    const out = [];
    const seen = new Set();
    for (const r of shown) {
      if (!r.gang_run_id) { out.push(r); continue; }
      if (seen.has(r.gang_run_id)) continue;
      seen.add(r.gang_run_id);
      const members = shown.filter(x => x.gang_run_id === r.gang_run_id);
      out.push(members.length > 1 ? { ...r, id: `gang-${r.gang_run_id}`, _gang: members } : r);
    }
    return out;
  })();
  // Board counts are taken from the GROUPED rows and BEFORE the board filter is
  // applied — a chip that counted only its own filter would just be restating
  // itself, and the planner needs to see the size of the pile he is not
  // currently looking at. Filtering then runs on the same grouped rows, so a
  // gang is one job to the chips exactly as it is one row in the table.
  const boardCounts = displayRows.reduce((n, r) => { n[rowBoardStateOf(r)]++; return n; },
    { all: displayRows.length, covered: 0, on_order: 0, short: 0 });
  const boardOnly = boardFilters.length === 0 ? displayRows
    : displayRows.filter(r => boardFilters.includes(rowBoardStateOf(r)));
  // Counted on what the BOARD rail has already left, so the plate numbers
  // describe the pile actually on screen rather than the whole tab. A row with
  // no plate state at all reads as `none` — nothing has been raised for it,
  // which is exactly the pile "PR Not Raised" is asking for.
  const plateCounts = boardOnly.reduce((n, r) => { n[r.plate_state || 'none']++; return n; },
    { all: boardOnly.length, ready: 0, on_order: 0, none: 0 });
  const boardRows = plateFilters.length === 0 ? boardOnly
    : boardOnly.filter(r => plateFilters.includes(r.plate_state || 'none'));
  const togglePlateFilter = key => {
    setPlateFilters(cur => (cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]));
    clearSelection();
  };
  const toggleBoardFilter = key => {
    setBoardFilters(cur => (cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]));
    clearSelection();
  };
  // Board trouble outranks an unread thread. Both tint the same cells, and the
  // alarm rule — plain CSS, outside the utility layer — out-specifies the
  // utility the thread highlight uses, so a job short of board stays red even
  // while someone is talking on it. A covered row falls through to the thread
  // tint exactly as it does today.
  const unreadClass = unreadRowClass(threads, threadLineId);
  const rowClass = r => `${BOARD_ROW_CLASS[rowBoardStateOf(r)]} ${unreadClass(r)}`.trim();
  const selectedLines = lines.filter(l => selectedIds.includes(l.id));
  // Members of the gang whose unified panel is open (live from `lines` so it
  // reflects every approval as it lands). Null panel → empty.
  const gangMembers = gangOpen ? lines.filter(l => l.gang_run_id === gangOpen) : [];
  // Seed the run-number draft whenever a gang panel opens. run_output_number /
  // run_die_number are the RUN's own values (null until someone names them) —
  // never the resolved ones, or a carton's master number would look like the
  // run's and get saved back onto the run.
  const gangRunOut = gangMembers[0]?.run_output_number || '';
  const gangRunDie = gangMembers[0]?.run_die_number || '';
  useEffect(() => {
    setGangNums({ output_number: gangRunOut, die_number: gangRunDie });
  }, [gangOpen, gangRunOut, gangRunDie]);
  const gangNumsDirty = (gangNums.output_number || '') !== gangRunOut
    || (gangNums.die_number || '') !== gangRunDie;
  const saveGangNums = async () => {
    setGangNumBusy(true);
    try {
      await api.patch(`/gang-runs/${gangOpen}/numbers`, gangNums);
      toast.success('Run numbers saved — every carton of this gang now carries them');
      load();
    } catch (e) { toast.error(e.message || 'Could not save the run numbers'); }
    finally { setGangNumBusy(false); }
  };
  const clearSelection = () => setSelectedIds([]);
  // Selecting a gang row selects every member line — they act as one job.
  const rowIds = row => (row._gang ? row._gang.map(m => m.id) : [row.id]);
  const toggleSelected = (row, checked) => setSelectedIds(ids => checked
    ? [...new Set([...ids, ...rowIds(row)])]
    : ids.filter(id => !rowIds(row).includes(id)));
  const toggleAll = (visibleRows, checked) => {
    const visibleIds = visibleRows.flatMap(rowIds);
    setSelectedIds(ids => checked
      ? [...new Set([...ids, ...visibleIds])]
      : ids.filter(id => !visibleIds.includes(id)));
  };

  const setApproval = async (l, patch) => {
    await api.post(`/order-lines/${l.id}/artwork`, patch);
    load();
  };
  // The deliberate lock/unlock pair — approvals never lock a line by themselves.
  const lockArtwork = async l => {
    await api.post(`/order-lines/${l.id}/artwork/lock`, {});
    toast.success(`Artwork locked for ${l.product_name}`);
    load();
  };
  const unlockArtwork = async l => {
    if (!window.confirm(`Unlock artwork for ${l.product_name}? It leaves the Locked queue and, if the line was Ready, it goes back to Planned.`)) return;
    await api.post(`/order-lines/${l.id}/artwork/unlock`, {});
    toast.success(`Artwork unlocked for ${l.product_name}`);
    load();
  };
  // Gang variants — the gang locks and unlocks as ONE product.
  const lockGang = async members => {
    for (const m of members.filter(x => !x.artwork_locked)) await api.post(`/order-lines/${m.id}/artwork/lock`, {});
    toast.success(`Artwork locked for all ${members.length} cartons`);
    load();
  };
  const unlockGang = async members => {
    if (!window.confirm(`Unlock artwork for all ${members.length} cartons of this gang?`)) return;
    for (const m of members.filter(x => x.artwork_locked)) await api.post(`/order-lines/${m.id}/artwork/unlock`, {});
    toast.success('Gang artwork unlocked');
    load();
  };
  // Approve/clear ONE flag across EVERY carton in a gang at once — the gang is one
  // product, so it approves and locks as one. Each carton keeps its other flag.
  const setGangApproval = async (members, key, val) => {
    for (const m of members) {
      await api.post(`/order-lines/${m.id}/artwork`, {
        customer_ok: key === 'customer' ? val : !!m.artwork_customer_ok,
        qa_ok: key === 'qa' ? val : !!m.artwork_qa_ok,
      });
    }
    toast.success(`${key === 'customer' ? 'Customer' : 'QA shade/text'} ${val ? 'approved' : 'cleared'} for all ${members.length} cartons`);
    load();
  };
  // Push EVERY carton's tooling to the hub in one go (each product keeps its own
  // plate/die/shade; a block only where that carton embosses or foils).
  const pushGangTooling = async members => {
    let n = 0;
    for (const m of members) {
      const fams = ['plate', 'die', 'shade_card', ...(m.emboss || m.leafing ? ['block'] : [])];
      const res = await api.post('/tools/push', { product_id: m.product_id, families: fams }).catch(() => null);
      n += res?.created?.length || 0;
    }
    toast.success(n ? `Pushed ${members.length} cartons' tooling to triage` : 'Tooling already in the hub');
    load();
  };
  // Send the gang to the Job Card station as ONE parent card. createJobCardForLine
  // is gang-aware, so a single call on any member builds the shared parent JC.
  const gangToJobCard = async members => {
    await api.post(`/workflow/order-lines/${members[0].id}`, { action: 'push_to_job_card', destinations: [] });
    toast.success(`${members[0].gang_number} sent to Job Card as one gang`);
    setGangOpen(null); load();
  };
  const openForm = line => {
    if (line._gang) { setGangOpen(line.gang_run_id); return; } // gang → unified panel
    setEditing(line);
    setForm({
      customer_ok: !!line.artwork_customer_ok,
      qa_ok: !!line.artwork_qa_ok,
      planned_date: line.planned_date ? String(line.planned_date).slice(0, 10) : '',
      qty: line.qty ?? '',
      notes: line.notes || '',
      party_artwork_code: line.party_artwork_code || '',
      output_number: line.output_number || '',
      die_number: line.die_number || '',
      block_number: line.block_number || '',
      emboss: String(line.emboss ? 1 : 0),
      leafing: String(line.leafing ? 1 : 0),
      leafing_colour: line.leafing_colour || '',
    });
  };
  // Which identity codes / finish fields were edited away from what the line
  // currently carries (emboss/leafing are 0/1 — String() compares them fine).
  const changedCodes = () => {
    if (!editing) return {};
    const out = {};
    for (const f of CODE_FIELDS) {
      const cur = (f === 'emboss' || f === 'leafing') ? String(editing[f] ? 1 : 0)
        : String(editing[f] ?? '');
      if (String(form[f] ?? '').trim() !== cur) out[f] = String(form[f] ?? '').trim();
    }
    return out;
  };
  // The same soft colour rules the server exposes, read off the line as served.
  const artworkColourWarnings = editing ? printColourWarnings(editing) : [];
  // Save intercepts an Artwork Code / Output Number change with the master-sync
  // question — update the Carton Product Master, or keep it for this job only.
  const saveForm = () => {
    if (!editing) return;
    const changed = canEditPlanning ? changedCodes() : {};
    if (Object.keys(changed).length) { setSyncPrompt({ changed }); return; }
    doSave({});
  };
  const doSave = async ({ spec, update_master }) => {
    await api.put(`/order-lines/${editing.id}/artwork`, {
      customer_ok: form.customer_ok,
      qa_ok: form.qa_ok,
      ...(canEditPlanning ? { planned_date: form.planned_date, qty: form.qty, notes: form.notes } : {}),
      ...(spec && Object.keys(spec).length ? { spec, update_master: !!update_master } : {}),
    });
    if (spec && Object.keys(spec).length) {
      toast.success(update_master ? 'Saved — Carton Product Master updated' : 'Saved for this job only');
    }
    setSyncPrompt(null);
    setEditing(null);
    load();
  };

  return (
    <div>
      <PageHeader title="Artwork Queue" subtitle="Customer approval + QA shade/text approval, then lock deliberately — the Locked queue can reverse until a job card exists" />
      <Tabs active={tab} onChange={k => { setTab(k); clearSelection(); }} tabs={[
        { key: 'open', label: 'Awaiting Approval', count: open.length },
        { key: 'locked', label: 'Locked', count: locked.length },
        { key: 'completed', label: 'Completed', count: completed.length },
        { key: 'all', label: 'All', count: lines.length },
      ]} />
      {/* Second lens, under the tabs: the tab says where a job is in artwork,
          this says whether it will have board to print on when it gets there.
          Deliberately NOT reset when the tab changes — "show me everything
          short" is a standing question, and the counts go to 0 in a tab that
          has none, which explains itself. */}
      <PlateFilterChips active={plateFilters} counts={plateCounts}
        onToggle={togglePlateFilter} onClear={() => { setPlateFilters([]); clearSelection(); }} />
      <BoardFilterChips active={boardFilters} counts={boardCounts}
        onToggle={toggleBoardFilter}
        onClear={() => { setBoardFilters([]); clearSelection(); }} />
      {filters.dirty && (
        <div className="mb-2 flex justify-end"><ResetFilters filters={filters} /></div>
      )}
      <BulkWorkflowControls lines={selectedLines} context="artwork" onDone={load} onClear={clearSelection} />
      <DataTable searchable resetSignal={filters.token}
        selectable
        selectedIds={selectedIds}
        onToggleRow={toggleSelected}
        onToggleAll={toggleAll}
        onRowClick={openForm}
        groupBy={l => (l._gang ? `gang-${l.gang_run_id}` : null)}
        groupTone={l => (l.run_kind === 'merge' ? 'teal' : 'violet')}
        columns={[
          { key: 'customer_name', label: 'Client / PO',
            export: l => l._gang
              ? `${l.gang_number}: ${[...new Set(l._gang.map(m => `${m.po_number} (${m.customer_name})`))].join(' | ')}`
              : `${l.customer_name} · PO ${l.po_number}`,
            render: l => l._gang
            ? (() => {
                const pos = [...new Set(l._gang.map(m => m.po_number))];
                const custs = [...new Set(l._gang.map(m => m.customer_name))];
                return (
                  <div className="max-w-[180px]">
                    {l.run_kind === 'merge' ? <MergeChip number={l.gang_number} /> : <GangChip number={l.gang_number} />}
                    <div className="mt-1 font-semibold leading-snug text-[#1D1D1F]">{custs.join(' · ')}</div>
                    <div className="mt-0.5 text-xs text-gray-500">PO {pos.join(' · ')}</div>
                    <div className={`mt-0.5 text-[10px] font-bold uppercase tracking-wide ${l.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-500'}`}>
                      {l.run_kind === 'merge' ? `${l._gang.length} orders · one pile` : `${l._gang.length} cartons · one run`}
                    </div>
                  </div>
                );
              })()
            : (
            <div className="max-w-[160px]">
              <div className="font-semibold leading-snug text-[#1D1D1F] line-clamp-2">{l.customer_name}</div>
              <div className="mt-0.5 text-xs text-gray-500">PO {l.po_number}</div>
            </div>) },
          // PO Date and OD — the same pair, and the same vocabulary, as the
          // Planning board. Artwork carries no delivery date at all, so before
          // this the queue had no clock on it: nothing on the row said which
          // approval had been waiting a week and which had been waiting a month.
          { key: 'po_date', label: 'PO Date', card: 'detail',
            sortValue: l => poAgeOf(l).date || '',
            export: l => { const a = poAgeOf(l); return a.date
              ? fmt.date(a.date) + (a.latest ? ` — ${fmt.date(a.latest)}` : '') : '—'; },
            render: l => { const a = poAgeOf(l);
              if (!a.date) return <span className="text-gray-300">—</span>;
              return (
                <div className="text-xs tabular-nums text-gray-600">
                  <div>{fmt.date(a.date)}</div>
                  {a.latest && <div className="text-[10px] text-gray-400">→ {fmt.date(a.latest)}</div>}
                </div>
              ); } },
          { key: 'od', label: 'OD', align: 'right',
            sortValue: l => poAgeOf(l).days ?? -1,
            export: l => { return odExport(poAgeOf(l).days); },
            render: l => { const a = poAgeOf(l);
              return <OverdueDays days={a.days} count={a.count} />; } },
          { key: 'product_name', label: 'Product',
            searchValue: l => (l._gang || [l]).map(productSearchText).join(' '),
            export: l => l._gang ? l._gang.map(productExport).join(' + ') : productExport(l),
            render: l => l._gang
            ? <GangCellParts members={l._gang} tone={l.run_kind === 'merge' ? 'teal' : 'violet'}
                total={<span className={`font-semibold normal-case ${l.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-600'}`}>
                  {l.run_kind === 'merge' ? 'one pile — no split' : 'together until die cutting'}</span>}
                render={m => (
                  <ProductIdentity row={m} compact className="min-w-0 max-w-[240px]"
                    meta={[m.colors != null ? `${m.colors} colours` : null, m.special && m.special !== 'none' ? fmt.title(m.special) : null].filter(Boolean).join(' · ')} />
                )} />
            : (
            <div className="max-w-[300px]">
              <ProductIdentity row={l}
                meta={[l.colors != null ? `${l.colors} colours` : null, l.special && l.special !== 'none' ? fmt.title(l.special) : null, l.size].filter(Boolean).join(' · ')} />
              <PrintColourChips row={l} compact className="mt-1.5" />
            </div>) },
          // The studio's own column: what ink this job needs, before anyone
          // opens the form. Pantone codes and the metallic shade sit right
          // under the badges because they are what actually gets ordered.
          { key: 'printing', label: 'Printing', card: 'detail',
            sortValue: l => totalColoursOf(l._gang ? l._gang[0] : l) ?? -1,
            searchValue: l => (l._gang || [l]).map(colourSearchText).join(' '),
            export: l => colourSummary(l._gang ? l._gang[0] : l),
            render: l => {
              const b = l._gang ? l._gang[0] : l;
              if (!colourTypeOf(b) && !b.print_process) return <span className="text-xs text-gray-300">—</span>;
              return (
                <div className="max-w-[170px]">
                  <PrintColourChips row={b} compact />
                  <div className="mt-0.5 truncate text-[11px] text-slate-400" title={colourSummary(b)}>{colourSummary(b)}</div>
                  <ColourCodeLines row={b} />
                </div>);
            } },
          // Same rule as Planning's Board column: a product still carrying its
          // placeholder board shows a dash, never the placeholder's name. The
          // GSM fallback goes too — it is read off the same parked board.
          { key: 'board_name', colClass: 'ci-p3', label: 'Board & sheet', sortable: false,
            export: l => ((l._gang ? l._gang[0] : l).spec_incomplete ? '—'
              : [(l._gang ? l._gang[0] : l).board_name || (l.gsm ? `${l.gsm} gsm` : '—'), imposition(l._gang ? l._gang[0] : l)].filter(Boolean).join(' · ')),
            render: l => {
              const b = l._gang ? l._gang[0] : l; // a gang shares ONE mother sheet
              return (
                <div className="max-w-[220px]">
                  <div className="font-medium leading-snug text-[#1D1D1F]">
                    {b.spec_incomplete
                      ? <span className="text-gray-300" title="No board chosen yet — picked in planning">—</span>
                      : (b.board_name || (b.gsm ? `${b.gsm} gsm` : '—'))}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400">{l._gang ? `${b.child_l && b.child_w ? `${b.child_l}×${b.child_w}" child · ` : ''}${l.run_kind === 'merge' ? 'one pile' : 'shared sheet'}` : (imposition(l) || '—')}</div>
                </div>);
            } },
          // Sits beside the board it describes, not off at the end of the row:
          // "Saffire · 350 GSM · 23x36" and "do we have any" are one thought.
          { key: 'board_state', label: 'Board Status',
            // card:'metric' is load-bearing, not decoration. classifyColumns
            // hands the card's one status badge to the first column whose key
            // matches /status|stage|state/ — `board_state` does, and it sits
            // above the real `status` column, so without this the phone card
            // lost its Planned / In Production badge to this chip. As a metric
            // it rides the card face (visible without opening Details) and the
            // line status keeps the badge it has always had.
            card: 'metric',
            sortValue: l => BOARD_RANK[rowBoardStateOf(l)],       // worst first
            searchValue: l => `${BOARD_FULL[rowBoardStateOf(l)]} board`,
            export: l => BOARD_FULL[rowBoardStateOf(l)],
            render: l => <BoardBadge state={rowBoardStateOf(l)} /> },
          // Plates get their OWN column rather than riding in the board cell.
          // They are a separate question with a separate owner — the board is
          // bought, the plates are made — and sharing one cell meant the plate
          // state could not be sorted, exported or read as a column at all.
          { key: 'plate_state', label: 'Plates',
            sortValue: l => PLATE_RANK[l.plate_state || 'none'],   // worst first
            searchValue: l => `${PLATE_FULL[l.plate_state || 'none']} plates`,
            export: l => PLATE_FULL[l.plate_state || 'none']
              + (l.plate_counts ? ` (${l.plate_counts.have}/${l.plate_counts.need} on the rack)` : ''),
            render: l => <PlateStatus state={l.plate_state || 'none'} counts={l.plate_counts} /> },
          { key: 'qty', label: 'Quantity', align: 'right',
            sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (Number(m.qty) || 0), 0) : Number(l.qty) || 0),
            export: l => l._gang
              ? `${fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))} (${l.run_kind === 'merge' ? 'combined run' : 'gang'})`
              : `${fmt.num(l.qty)} (${fmt.num(sheetsFor(l))} sheets)`,
            render: l => l._gang
              ? <GangCellParts members={l._gang} align="right" tone={l.run_kind === 'merge' ? 'teal' : 'violet'}
                  total={fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))}
                  render={m => (
                    <div>
                      <div className="font-bold tabular-nums text-[#1D1D1F]">{fmt.num(m.qty)}</div>
                      <div className="text-xs tabular-nums text-gray-400">{fmt.num(sheetsFor(m))} sheets</div>
                    </div>)} />
              : (
            <div>
              <div className="font-bold tabular-nums text-[#1D1D1F]">{fmt.num(l.qty)}</div>
              <div className="text-xs tabular-nums text-gray-400">{fmt.num(sheetsFor(l))} sheets</div>
            </div>) },
          { key: 'planned_date', label: 'Planned', render: l => {
            if (!l._gang) return fmt.date(l.planned_date);
            const dates = [...new Set(l._gang.map(m => m.planned_date).filter(Boolean))].sort();
            return <div><div>{fmt.date(dates[0])}</div>{dates.length > 1 && <div className="text-[10px] font-semibold text-amber-600">earliest of {dates.length}</div>}</div>;
          } },
          { key: 'appr', label: 'Approvals', sortable: false, render: l => {
            if (l._gang) {
              // The gang is ONE product — approve every carton together.
              const allC = l._gang.every(m => m.artwork_customer_ok);
              const allQ = l._gang.every(m => m.artwork_qa_ok);
              const anyLocked = l._gang.some(m => m.artwork_locked);
              return (
                <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                  <Toggle on={allC} label="Customer" disabled={anyLocked} onClick={() => canApprove && setGangApproval(l._gang, 'customer', !allC)} />
                  <Toggle on={allQ} label="QA Shade/Text" disabled={anyLocked} onClick={() => canApprove && setGangApproval(l._gang, 'qa', !allQ)} />
                </div>);
            }
            return (
              <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                <Toggle on={!!l.artwork_customer_ok} label="Customer" disabled={!!l.artwork_locked} onClick={() => canApprove && setApproval(l, { customer_ok: !l.artwork_customer_ok, qa_ok: !!l.artwork_qa_ok })} />
                <Toggle on={!!l.artwork_qa_ok} label="QA Shade/Text" disabled={!!l.artwork_locked} onClick={() => canApprove && setApproval(l, { customer_ok: !!l.artwork_customer_ok, qa_ok: !l.artwork_qa_ok })} />
              </div>);
          } },
          { key: 'lock', label: 'Lock', sortable: false, render: l => {
            // The deliberate action cell: approved-but-open rows get the Lock
            // button; locked rows without a job card get Unlock (the reverse).
            const cell = m => {
              if (m.artwork_locked) {
                return canApprove && !m.jc_number
                  ? (
                    <button onClick={e => { e.stopPropagation(); unlockArtwork(m); }} title="Reverse — unlock this artwork"
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700 transition-colors hover:bg-amber-100 hover:text-amber-700">
                      <Lock size={13} /> Locked
                    </button>)
                  : <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600"><Lock size={13} /> Locked</span>;
              }
              if (canApprove && m.artwork_customer_ok && m.artwork_qa_ok) {
                return (
                  <button onClick={e => { e.stopPropagation(); lockArtwork(m); }} title="Lock this artwork for print"
                    className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs font-bold text-white transition-colors hover:bg-slate-700">
                    <Lock size={13} /> Lock
                  </button>);
              }
              return <span className="inline-flex items-center gap-1 text-xs text-gray-400"><LockOpen size={13} /> Open</span>;
            };
            if (!l._gang) return <span onClick={e => e.stopPropagation()}>{cell(l)}</span>;
            const n = l._gang.filter(m => m.artwork_locked).length;
            const allApproved = l._gang.every(m => m.artwork_customer_ok && m.artwork_qa_ok);
            return (
              <div onClick={e => e.stopPropagation()}>
                {canApprove && allApproved && n < l._gang.length && (
                  <button onClick={() => lockGang(l._gang)} title="Lock the whole gang for print"
                    className="mb-1 inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs font-bold text-white transition-colors hover:bg-slate-700">
                    <Lock size={13} /> Lock gang
                  </button>)}
                {canApprove && n === l._gang.length && !l._gang.some(m => m.jc_number) && (
                  <button onClick={() => unlockGang(l._gang)} title="Reverse — unlock the whole gang"
                    className="mb-1 inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700 transition-colors hover:bg-amber-100 hover:text-amber-700">
                    <Lock size={13} /> {n}/{l._gang.length} locked
                  </button>)}
                {!(canApprove && ((allApproved && n < l._gang.length) || (n === l._gang.length && !l._gang.some(m => m.jc_number)))) && (
                  <span className={`text-xs font-bold ${n === l._gang.length ? 'text-emerald-600' : 'text-violet-700'}`}>{n}/{l._gang.length} locked</span>)}
              </div>);
          } },
          { key: 'tooling', label: 'Tooling', sortable: false, render: l => {
            const cell = m => <div className="flex items-center gap-1.5"><ToolingChip line={m} /></div>;
            return l._gang ? <GangCellParts members={l._gang} tone={l.run_kind === 'merge' ? 'teal' : 'violet'} render={cell} /> : cell(l);
          } },
          // Explicitly claimed, so the card badge stays the LINE's status no
          // matter what other /state/-shaped columns land above it later.
          { key: 'status', label: 'Status', card: 'status', render: l => {
            // A job whose plan is SAVED but not locked says so here instead of
            // "pending". It reached this queue early on purpose — the spec the
            // designer needs is settled, the board is not — and "pending" on a
            // job sitting in the artwork queue reads as "nobody has planned
            // this", which is the one thing it must not say. The hint carries
            // what a DESIGNER needs from that fact, not what a planner needs:
            // the sizes can still move, so finish the approvals but expect a
            // second look if the planner retunes the cut.
            const cell = m => (m.plan_draft
              ? <PlanSavedBadge hint="The planner has saved this setup but not locked it — the spec is real, the board is not secured yet, and the cut plan can still change." />
              : <StatusBadge status={m.status} />);
            return l._gang ? <GangCellParts members={l._gang} tone={l.run_kind === 'merge' ? 'teal' : 'violet'} render={cell} /> : cell(l);
          } },
          threadColumn({ entity: 'order_line', threads, idOf: threadLineId }),
          { key: 'workflow', label: '', sortable: false, render: l => {
            // A gang carries ONE unified action set — open its panel (approve,
            // push tooling, send to job card) instead of per-carton buttons.
            if (l._gang) return (
              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="secondary" onClick={() => setGangOpen(l.gang_run_id)}>
                  <FolderOpen size={13} /> Open
                </Button>
                {/* A gang row used to offer Open and nothing else, so a ganged job
                    could not be reversed from this queue at all — the control simply
                    was not rendered for it. Anchored on a REAL member line: this row's
                    own id is the synthetic `gang-<id>` string, and the server resolves
                    the run's parent job card from the member. */}
                <WorkflowControls line={l._gang[0]} context="artwork" onDone={load} iconOnly />
              </div>);
            return (
              <div className="flex items-center justify-end gap-1.5">
                {canPush && (
                  <button title="Push to Tooling Hub"
                    onClick={e => { e.stopPropagation(); setPushLine(l); }}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[#D7E0EC] bg-white text-[#596E64] shadow-none transition-colors hover:border-[#BFCBC4] hover:bg-[#F5F8F6] hover:text-[#31443D]">
                    <Hammer size={14} />
                  </button>
                )}
                <WorkflowControls line={l} context="artwork" onDone={load} iconOnly />
                <DangerZone line={l} onDone={load} asMenu />
              </div>);
          } },
        ]}
        rows={boardRows}
        rowClass={rowClass}
        empty={boardFilters.length
          ? `Nothing in this tab is ${boardFilters.map(k => BOARD_LABEL[k]).join(' or ')}`
          : {
            open: 'No artwork waiting for approval',
            locked: 'No locked artwork yet',
            completed: 'Nothing pushed to a job card yet',
            all: 'No artwork in the queue',
          }[tab]}
        exportName="Artwork Queue"
        exportSubtitle="Customer + QA approvals, board coverage and lock status"
        exportMeta={() => [
          `Tab: ${({ open: 'Awaiting Approval', locked: 'Locked', completed: 'Completed', all: 'All' })[tab]}`,
          boardFilters.length ? `Board filter: ${boardFilters.map(k => BOARD_LABEL[k]).join(' + ')}` : null,
        ].filter(Boolean)} />

      <Modal open={!!editing} onClose={() => { if (!syncPrompt) setEditing(null); }} title={editing ? `Artwork Form — ${editing.po_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Close</Button>
          {(canApprove || canEditPlanning) && <Button onClick={saveForm}>Save Changes</Button>}
        </>}>
        {editing && (
          <div className="space-y-4">
            <div className="ci-summary-panel text-xs">
              {editing.product_name} · {editing.customer_name} · {editing.product_code}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Artwork approvals</span><span>{editing.artwork_locked ? 'Locked' : 'Open'}</span></div>
              <div className="flex flex-wrap gap-2">
                <Toggle on={form.customer_ok} label="Customer" disabled={!!editing.artwork_locked} onClick={() => canApprove && setForm(f => ({ ...f, customer_ok: !f.customer_ok }))} />
                <Toggle on={form.qa_ok} label="QA Shade/Text" disabled={!!editing.artwork_locked} onClick={() => canApprove && setForm(f => ({ ...f, qa_ok: !f.qa_ok }))} />
              </div>
              {!editing.artwork_locked && (
                <p className="mt-2 text-[11px] text-slate-400">Approvals don't lock the artwork — lock it with the Lock button in the queue when both are ticked.</p>
              )}
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Codes &amp; technical spec</span><span>mapped to the Carton Product Master</span></div>
              <div className="ci-form-grid">
                <Field label="Artwork Code" hint="Party artwork code — auto-populates single-run plans">
                  <Input value={form.party_artwork_code} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, party_artwork_code: e.target.value })} />
                </Field>
                <Field label="Output Number" hint="Print set number for this carton">
                  <Input value={form.output_number} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, output_number: e.target.value })} />
                </Field>
                {/* Shade card — read-only: typed in exactly one place now, the
                    Shade Card module. editing (not form) is the source, since
                    it is never edited here. */}
                <Field label="Shade Card">
                  {editing.shade_card_number ? (
                    <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                      <a href={`/shade-cards?q=${encodeURIComponent(editing.shade_card_number)}`}
                         className="font-mono text-xs font-semibold text-brand-600 hover:underline">
                        {editing.shade_card_number}</a>
                      {editing.shade_card_date && <ShadeAge date={editing.shade_card_date} />}
                    </div>
                  ) : (
                    <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                      No shade card registered for this product — create one in Shade Cards.
                    </p>)}
                </Field>
                <Field label="Die Number" hint="master die text — hub DIE code is the fallback">
                  <Input value={form.die_number} disabled={!canEditPlanning} placeholder="e.g. D-105"
                    onChange={e => setForm({ ...form, die_number: e.target.value })} />
                </Field>
                <Field label="Block Number" hint="foil/emboss block — hub BLK code is the fallback">
                  <Input value={form.block_number} disabled={!canEditPlanning} placeholder="e.g. B-22"
                    onChange={e => setForm({ ...form, block_number: e.target.value })} />
                </Field>
                <Field label="Emboss">
                  <Select value={form.emboss} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, emboss: e.target.value })}>
                    <option value="0">No</option><option value="1">Yes</option>
                  </Select>
                </Field>
                <Field label="Leafing">
                  <Select value={form.leafing} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, leafing: e.target.value, ...(e.target.value === '0' ? { leafing_colour: '' } : {}) })}>
                    <option value="0">No</option><option value="1">Yes</option>
                  </Select>
                </Field>
                {form.leafing === '1' && (
                  <Field label="Leafing Colour">
                    <Input value={form.leafing_colour} disabled={!canEditPlanning} placeholder="e.g. gold"
                      onChange={e => setForm({ ...form, leafing_colour: e.target.value })} />
                  </Field>
                )}
                {/* One code, not two — internal_carton_code is a server-kept
                    mirror of the product code now, so showing both fields was
                    the same value twice. */}
                <Field label="Internal Code">
                  <Input value={editing.product_code || '—'} disabled readOnly />
                </Field>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[['Board', editing.board_name || '—'], ['GSM', editing.gsm || '—'],
                  ['Size', editing.size || '—'], ['Colours', colourSummary(editing)],
                  ['Ups', editing.ups || '—'],
                  ['Coating', editing.coating && editing.coating !== 'none' ? fmt.title(editing.coating) : '—'],
                  ['Print Sheet', editing.child_l && editing.child_w ? `${editing.child_l}×${editing.child_w}"` : '—']]
                  .map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                      <div className="truncate text-sm font-bold text-slate-800" title={String(v)}>{v}</div>
                    </div>))}
              </div>
            </section>
            {/* Artwork VERIFIES ink; Planning owns it. So this panel reads out
                the whole build and says when the job has drifted from the
                master — and changes neither. */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">
                <span>Printing colour &amp; process</span>
                <span className="normal-case tracking-normal text-slate-400">from the Product Master</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <ColourBadge row={editing} />
                <ProcessBadge row={editing} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {colourDetailLines(editing).map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className="truncate text-sm font-bold text-slate-800" title={String(v)}>{v}</div>
                  </div>))}
                {colourDetailLines(editing).length === 0 && (
                  <div className="col-span-2 text-xs text-slate-400 sm:col-span-4">No printing colour recorded on the master yet.</div>
                )}
              </div>
              {colourMismatch(editing).length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <b>This job differs from the Product Master:</b>
                  <ul className="mt-1 list-inside list-disc">
                    {colourMismatch(editing).map(m => (
                      <li key={m.label}>{m.label} — job <b>{m.job || '—'}</b>, master <b>{m.master || '—'}</b></li>
                    ))}
                  </ul>
                  <div className="mt-1 text-amber-700">
                    Shown for checking only. Nothing here overwrites either — change it in Planning if the job is right.
                  </div>
                </div>
              )}
              {artworkColourWarnings.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] text-amber-800">
                  {artworkColourWarnings.map(w => <div key={w.code}>{w.message}</div>)}
                </div>
              )}
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Line details</span><span>{fmt.title(editing.status)}</span></div>
              <div className="ci-form-grid">
                <Field label="Planned Date">
                  <Input type="date" value={form.planned_date || ''} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, planned_date: e.target.value })} />
                </Field>
                <Field label="Quantity">
                  <Input type="number" min="1" value={form.qty} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, qty: e.target.value })} />
                </Field>
                <Field label="Product">
                  <Input value={editing.product_name || ''} disabled readOnly />
                </Field>
                <Field label="Customer">
                  <Input value={editing.customer_name || ''} disabled readOnly />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Notes">
                  <Textarea value={form.notes} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Artwork or planning notes" />
                </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* ── Gang Artwork panel — the gang is ONE product: one approval, one
             action set, opened from the unified row. Per-carton code editing
             opens the same single form on top. ── */}
      <Modal open={!!gangOpen && gangMembers.length > 0} onClose={() => setGangOpen(null)} wide
        title={gangMembers[0] ? `Gang Artwork — ${gangMembers[0].gang_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setGangOpen(null)}>Close</Button>
          {canPush && <Button variant="secondary" onClick={() => pushGangTooling(gangMembers)}><Hammer size={14} /> Push all to Tooling</Button>}
          {canEditPlanning && gangMembers.length > 0 && gangMembers.every(m => m.artwork_locked) && !gangMembers.some(m => m.jc_number) &&
            <Button onClick={() => gangToJobCard(gangMembers)}><GitBranch size={14} /> Send gang to Job Card</Button>}
        </>}>
        {gangMembers.length > 0 && (() => {
          const anchor = gangMembers[0];
          const allC = gangMembers.every(m => m.artwork_customer_ok);
          const allQ = gangMembers.every(m => m.artwork_qa_ok);
          const lockedN = gangMembers.filter(m => m.artwork_locked).length;
          return (
            <div className="space-y-4">
              <div className="ci-summary-panel flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1 font-bold text-violet-700"><Link2 size={13} /> {anchor.gang_number}</span>
                <span>{gangMembers.length} cartons · one press run</span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-slate-700">{anchor.board_name}</span>
                {anchor.child_l && anchor.child_w && <span className="text-slate-400">child {anchor.child_l}×{anchor.child_w}"</span>}
              </div>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Approve the whole gang</span><span>{lockedN}/{gangMembers.length} locked</span></div>
                <div className="flex flex-wrap items-center gap-2">
                  <Toggle on={allC} label="Customer" disabled={lockedN > 0} onClick={() => canApprove && setGangApproval(gangMembers, 'customer', !allC)} />
                  <Toggle on={allQ} label="QA Shade/Text" disabled={lockedN > 0} onClick={() => canApprove && setGangApproval(gangMembers, 'qa', !allQ)} />
                  <span className="ml-auto inline-flex items-center gap-2">
                    {canApprove && allC && allQ && lockedN < gangMembers.length && (
                      <Button size="sm" onClick={() => lockGang(gangMembers)}><Lock size={13} /> Lock gang artwork</Button>
                    )}
                    {canApprove && lockedN > 0 && !gangMembers.some(m => m.jc_number) && (
                      <Button size="sm" variant="secondary" onClick={() => unlockGang(gangMembers)}><LockOpen size={13} /> Unlock</Button>
                    )}
                    <span className={`inline-flex items-center gap-1 text-xs font-bold ${lockedN === gangMembers.length ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {lockedN === gangMembers.length ? <><Lock size={13} /> All artwork locked</> : <><LockOpen size={13} /> {gangMembers.length - lockedN} still open</>}
                    </span>
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">Approve both, then lock deliberately — the whole gang locks and unlocks as one sheet.</p>
              </section>
              {/* The RUN's own numbers. A gang is a new layout every time, so
                  its plate set and die are made for this run and exist for no
                  other job — they belong to the gang, not to any carton's
                  master, and once given they travel to every station. The same
                  field lives in the Planning engine and on the job card; all
                  three write the one record. A Combined Run prints one product
                  from its own master plate, so it never shows this. */}
              {canEditPlanning && anchor.run_kind !== 'merge' && (
                <section className="ci-form-panel">
                  <div className="ci-form-panel-title">
                    <span>This run's own numbers</span>
                    <span>new every gang — never from a product master</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Output No (this run)" hint="the plate/positive set made for this gang">
                      <Input value={gangNums.output_number} placeholder="e.g. OP-2207"
                        onChange={e => setGangNums(f => ({ ...f, output_number: e.target.value }))} />
                    </Field>
                    <Field label="Die No (this run)" hint="the die cut for this gang's layout">
                      <Input value={gangNums.die_number} placeholder="e.g. D-318"
                        onChange={e => setGangNums(f => ({ ...f, die_number: e.target.value }))} />
                    </Field>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400">
                      Carried by every carton of {anchor.gang_number} at every station.
                    </span>
                    <Button size="sm" disabled={!gangNumsDirty || gangNumBusy} onClick={saveGangNums}>
                      {gangNumBusy ? 'Saving…' : 'Save run numbers'}
                    </Button>
                  </div>
                </section>
              )}
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Cartons on this sheet</span><span>edit each carton's codes</span></div>
                <div className="divide-y divide-slate-100">
                  {gangMembers.map(m => (
                    <div key={m.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <ProductIdentity row={m} compact
                          meta={[m.shade_card_number ? `SC ${m.shade_card_number}` : null].filter(Boolean).join(' · ')} />
                      </div>
                      {m.artwork_locked
                        ? <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-emerald-600"><Lock size={12} /> Locked</span>
                        : <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-400"><LockOpen size={12} /> Open</span>}
                      <ToolingChip line={m} />
                      {canEditPlanning && <Button size="sm" variant="secondary" onClick={() => setEditing(m)}><Pencil size={12} /> Codes</Button>}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}
      </Modal>

      {/* ── Sync Master? — artwork code / output number changed ── */}
      <Modal open={!!syncPrompt} onClose={() => setSyncPrompt(null)} title="Sync Master?"
        footer={<>
          <Button variant="secondary" onClick={() => setSyncPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => doSave({ spec: syncPrompt.changed, update_master: false })}>This Job Only</Button>
          <Button onClick={() => doSave({ spec: syncPrompt.changed, update_master: true })}>Update Carton Product Master</Button>
        </>}>
        {syncPrompt && editing && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Do you want to update this updated {Object.keys(syncPrompt.changed).map(k => CODE_LABELS[k] || fmt.title(k)).join(' and ')} back
              to the <b>Carton Product Master</b> for future auto-population? (Applicable for single items — gang runs
              generate their own set numbers.)
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              {Object.entries(syncPrompt.changed).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="shrink-0 font-semibold text-slate-700">{CODE_LABELS[k] || fmt.title(k)}</span>
                  <span className="min-w-0 text-right text-slate-500">
                    <span className="line-through">{editing[k] || '—'}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{v || '—'}</b>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              “This Job Only” keeps the change as a job-level override; the master keeps its current codes.
            </p>
          </div>
        )}
      </Modal>

      <PushToToolingModal key={pushLine?.id ?? 'none'} line={pushLine} onClose={() => setPushLine(null)} onDone={load} />
    </div>
  );
}
