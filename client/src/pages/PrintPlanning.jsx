// Print Planning — the CI-Production press kanban. Drag job cards from
// Triage onto a press lane and order them top-to-bottom; that order IS the
// live printing queue on the floor. Native HTML5 drag & drop, no library.
// Gang runs (jobs that print together) travel as ONE card stack — dropping a
// gang on a press assigns every job in it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, ExportMenu, PageHeader } from '../components/ui.jsx';
import { Inbox, Printer, GripVertical, Radio, Link2, AlertTriangle, User, MousePointer2, CheckCircle2, ArrowDown, LayoutGrid, RotateCcw, X, Pencil, FileText } from 'lucide-react';
import { DangerZone } from '../components/WorkflowControls.jsx';

const TRIAGE = 'triage';
const canPlan = () => ['admin', 'planner'].includes(auth.user?.role);

// Per-machine colour identity. Each press lane gets its own hue so the board
// reads at a glance on the floor — matching the coloured top-rail, header icon,
// count badge and the left edge of every card queued on that press. Hues are
// drawn from the app's Apple system palette (systemBlue / Green / Purple / Teal)
// — amber and red are deliberately left out, reserved for the printing/hold
// status signals. Triage sits neutral (slate) so real machines pop. Full class
// strings live here literally so Tailwind's JIT never purges them.
const TRIAGE_THEME = {
  icon: 'text-slate-400',
  badge: 'bg-slate-200/70 text-slate-600',
  edge: 'border-l-slate-300',
  dot: 'bg-slate-300',
  chip: 'bg-slate-100 text-slate-500',
  queue: 'bg-slate-100 text-slate-500',
  shell: 'border-slate-200/70 border-t-[3px] border-t-slate-300 bg-slate-50/50 backdrop-blur-xl',
  active: 'border-slate-300 border-t-[3px] border-t-slate-400 bg-slate-100/70 ring-2 ring-slate-200',
};
const PALETTE = [
  { icon: 'text-blue-500',    badge: 'bg-blue-100 text-blue-700',       edge: 'border-l-blue-500',
    dot: 'bg-blue-500',    chip: 'bg-blue-50 text-blue-700',       queue: 'bg-blue-100 text-blue-700',
    shell: 'border-blue-200/60 border-t-[3px] border-t-blue-400 bg-blue-50/45 backdrop-blur-xl',
    active: 'border-blue-300 border-t-[3px] border-t-blue-500 bg-blue-50/80 ring-2 ring-blue-200' },
  { icon: 'text-emerald-500', badge: 'bg-emerald-100 text-emerald-700', edge: 'border-l-emerald-500',
    dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700', queue: 'bg-emerald-100 text-emerald-700',
    shell: 'border-emerald-200/60 border-t-[3px] border-t-emerald-400 bg-emerald-50/45 backdrop-blur-xl',
    active: 'border-emerald-300 border-t-[3px] border-t-emerald-500 bg-emerald-50/80 ring-2 ring-emerald-200' },
  { icon: 'text-violet-500',  badge: 'bg-violet-100 text-violet-700',   edge: 'border-l-violet-500',
    dot: 'bg-violet-500',  chip: 'bg-violet-50 text-violet-700',   queue: 'bg-violet-100 text-violet-700',
    shell: 'border-violet-200/60 border-t-[3px] border-t-violet-400 bg-violet-50/45 backdrop-blur-xl',
    active: 'border-violet-300 border-t-[3px] border-t-violet-500 bg-violet-50/80 ring-2 ring-violet-200' },
  { icon: 'text-teal-500',    badge: 'bg-teal-100 text-teal-700',       edge: 'border-l-teal-500',
    dot: 'bg-teal-500',    chip: 'bg-teal-50 text-teal-700',       queue: 'bg-teal-100 text-teal-700',
    shell: 'border-teal-200/60 border-t-[3px] border-t-teal-400 bg-teal-50/45 backdrop-blur-xl',
    active: 'border-teal-300 border-t-[3px] border-t-teal-500 bg-teal-50/80 ring-2 ring-teal-200' },
];
const pressTheme = i => PALETTE[i % PALETTE.length];

// Job card — roomier than v1, with a status-coloured left edge so the board
// reads at a glance: amber = printing now, red = on hold, on-press = its
// machine's hue, grey = still in triage. Status always wins over machine hue.
function Card({ card, grip, onPress, theme, onDone }) {
  const running = card.printing_status === 'in_progress';
  const held = card.printing_status === 'hold';
  // Status always wins over machine hue: amber = printing, red = hold. A queued
  // card wears its press colour; a triage card stays neutral slate.
  const edge = running ? 'border-l-amber-500' : held ? 'border-l-red-500'
    : onPress ? (theme?.edge || 'border-l-[#007AFF]') : 'border-l-slate-300';
  const dot = running ? 'bg-amber-500' : held ? 'bg-red-500' : (theme?.dot || 'bg-slate-300');
  const chip = running ? 'bg-amber-50 text-amber-700' : held ? 'bg-red-50 text-red-600'
    : (onPress ? (theme?.chip || 'bg-slate-100 text-slate-500') : 'bg-slate-100 text-slate-500');
  return (
    <div className={`group rounded-xl border border-l-[5px] bg-white px-3.5 py-2.5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${edge} ${
      running ? 'border-amber-300 ring-1 ring-amber-200' : held ? 'border-red-200' : 'border-slate-200'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-extrabold tracking-tight text-slate-900">
          {grip && <GripVertical size={13} className="shrink-0 text-slate-300 group-hover:text-slate-400" />}
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${running ? 'animate-pulseSoft' : ''}`} />
          <span className="truncate">{card.jc_number}</span>
        </span>
        {running && <span className="shrink-0 text-[10px] font-bold text-amber-600">PRINTING</span>}
        {held && <span className="shrink-0 text-[10px] font-bold text-red-500">ON HOLD</span>}
        {!running && !held && card.board_pending && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600"
            title="Board still to come — stock is short for this job's sheets">
            <AlertTriangle size={11} /> BOARD
          </span>
        )}
        <span className="ml-auto shrink-0" onClick={e => e.stopPropagation()}>
          <DangerZone jobCard={card} onDone={onDone} asMenu />
        </span>
      </div>
      <div className="mt-1 truncate text-xs font-semibold text-slate-700">{card.product_name}</div>
      <div className="mt-0.5 truncate text-xs text-slate-500">{card.customer_name}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-semibold tabular-nums ${chip}`}>
          {fmt.num(card.sheets_issued)} sh · {card.colors} col
        </span>
        <span className="shrink-0 font-semibold tabular-nums text-slate-400">{fmt.date(card.delivery_date)}</span>
      </div>
      {card.printing_operator && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-slate-500">
          <User size={11} className="text-slate-400" /> {card.printing_operator}
        </div>
      )}
    </div>
  );
}

// One draggable unit in a lane: a single job card, or a whole gang stack.
function groupLane(cards) {
  const groups = [];
  const byGang = new Map();
  for (const c of cards) {
    if (c.gang_run_id) {
      if (byGang.has(c.gang_run_id)) { byGang.get(c.gang_run_id).cards.push(c); continue; }
      const g = { key: `gang-${c.gang_run_id}`, gang_number: c.gang_number, cards: [c] };
      byGang.set(c.gang_run_id, g);
      groups.push(g);
    } else {
      groups.push({ key: `card-${c.id}`, gang_number: null, cards: [c] });
    }
  }
  return groups;
}

// A printed run — a light emerald-tinted glass card that matches the board's
// Apple aesthetic: soft green gradient, a green left edge, a filled check and a
// saturated "Printed" pill for the pop. Reads clearly as done, yet stays
// distinct from a plain queued card (no tint, no check, no pill). Non-draggable;
// clicking opens the chooser.
function PrintedCard({ card, onClick }) {
  return (
    <div onClick={onClick}
      className="group cursor-pointer rounded-xl border border-l-[5px] border-emerald-200/80 border-l-emerald-500 bg-gradient-to-br from-emerald-50/90 to-white px-3.5 py-2.5 shadow-sm ring-1 ring-emerald-500/[0.06] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-emerald-500/20">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-extrabold tracking-tight text-slate-900">
          <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
          <span className="truncate">{card.jc_number}</span>
        </span>
        <span className="shrink-0 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">Printed</span>
      </div>
      <div className="mt-1 truncate text-xs font-semibold text-slate-700">{card.product_name}</div>
      <div className="mt-0.5 truncate text-xs text-slate-500">{card.customer_name}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold tabular-nums text-emerald-700">
          {fmt.num(card.printed_sheets ?? card.sheets_issued)} sh printed
        </span>
        <span className="shrink-0 font-semibold tabular-nums text-slate-400">{fmt.date(card.completed_at)}</span>
      </div>
      {card.printing_operator && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-slate-500">
          <User size={11} className="text-emerald-400" /> {card.printing_operator}
        </div>
      )}
    </div>
  );
}

// Edit a queued run in place — quantity, sheets, operator, press + position,
// and dates. Backed by PUT /print-planning/:id. Press change is sent as
// machine_id + the destination lane's new ordered_ids (this card appended).
function EditQueueForm({ card, presses, lanes, onClose, onSaved, onClash }) {
  const [form, setForm] = useState({
    qty_planned: card.qty_planned ?? '',
    sheets_issued: card.sheets_issued ?? '',
    operator: card.printing_operator ?? '',
    machine_id: card.machine_id ?? '',
    planned_date: card.planned_date ? String(card.planned_date).slice(0, 10) : '',
    delivery_date: card.delivery_date ? String(card.delivery_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    const body = {
      qty_planned: Number(form.qty_planned),
      sheets_issued: Number(form.sheets_issued),
      operator: form.operator || null,
      planned_date: form.planned_date || null,
      delivery_date: form.delivery_date || null,
    };
    const newMachine = form.machine_id ? Number(form.machine_id) : null;
    if (newMachine !== (card.machine_id ?? null)) {
      body.machine_id = newMachine;
      // Destination lane order: existing lane ids (minus this card) + this card.
      const dest = (lanes[newMachine] || []).map(c => c.id).filter(i => i !== card.id);
      body.ordered_ids = newMachine ? [...dest, card.id] : [];
    }
    try { await api.put(`/print-planning/${card.id}`, body); onSaved(); }
    catch (e) {
      if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
        onClash(e.data.collision, async () => {
          await api.put(`/print-planning/${card.id}`, { ...body, confirm_collision: true });
          onSaved();
        });
      } else alert(e?.message || 'Could not save changes');
    }
    finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-extrabold text-slate-900">Edit — {card.jc_number}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-slate-500">Planned qty
            <input type="number" className={field} value={form.qty_planned} onChange={e => set('qty_planned', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Sheets issued
            <input type="number" className={field} value={form.sheets_issued} onChange={e => set('sheets_issued', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Operator
            <input className={field} value={form.operator} onChange={e => set('operator', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Press
            <select className={field} value={form.machine_id} onChange={e => set('machine_id', e.target.value)}>
              <option value="">Triage (unassigned)</option>
              {presses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-500">Planned date
            <input type="date" className={field} value={form.planned_date} onChange={e => set('planned_date', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Delivery date
            <input type="date" className={field} value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-amber-600">Delivery date changes the whole order, not just this line.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PrintPlanning() {
  const [cards, setCards] = useState([]);
  const [presses, setPresses] = useState([]);
  const [dragOverLane, setDragOverLane] = useState(null);
  const [completed, setCompleted] = useState([]);
  const [tab, setTab] = useState('board');        // 'board' | 'completed'
  const [chooser, setChooser] = useState(null);   // { card, done } | null
  const [editCard, setEditCard] = useState(null); // card being edited | null
  const [clashPrompt, setClashPrompt] = useState(null); // { collision, confirm } strength mix-up alarm
  const navigate = useNavigate();
  const dragIds = useRef([]);        // all job-card ids moving together
  const dropBeforeId = useRef(null); // first card id of the group dropped onto

  const load = () => api.get('/print-planning').then(d => { setCards(d.cards); setPresses(d.presses); setCompleted(d.completed || []); });
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  const lanes = useMemo(() => {
    const byLane = { [TRIAGE]: [] };
    for (const p of presses) byLane[p.id] = [];
    for (const c of cards) {
      const lane = c.machine_id && byLane[c.machine_id] ? c.machine_id : TRIAGE;
      byLane[lane].push(c);
    }
    return byLane;
  }, [cards, presses]);

  const isToday = ts => ts && new Date(ts).toDateString() === new Date().toDateString();
  // Completed runs grouped by the press they printed on (unassigned bucket last).
  const completedByPress = useMemo(() => {
    const by = { unassigned: [] };
    for (const p of presses) by[p.id] = [];
    for (const c of completed) {
      const k = c.machine_id && by[c.machine_id] ? c.machine_id : 'unassigned';
      by[k].push(c);
    }
    return by;
  }, [completed, presses]);
  // Runs printed TODAY, pinned green at the foot of their live press lane.
  const printedToday = useMemo(() => {
    const by = {};
    for (const p of presses) by[p.id] = completed.filter(c => c.machine_id === p.id && isToday(c.completed_at));
    return by;
  }, [completed, presses]);

  const openJobCard = card => { setChooser(null); navigate(`/production/jobcard/${card.id}`); };
  const reverseRun = async card => {
    const reason = window.prompt('Reason for reversing this printed run back to Triage?');
    if (!reason) return;
    try { await api.post('/print-planning/reverse', { job_card_id: card.id, reason }); setChooser(null); load(); }
    catch (e) { alert(e?.message || 'Could not reverse this run'); }
  };

  const moveGroup = async (laneKey, beforeId) => {
    const ids = dragIds.current.map(Number).filter(Boolean);
    if (!ids.length) return;
    const machine_id = laneKey === TRIAGE ? null : +laneKey;
    // Destination lane order (optimistic): existing cards minus the moving
    // group, with the whole group inserted at the drop point.
    const dest = lanes[laneKey].filter(c => !ids.includes(c.id)).map(c => c.id);
    const insertAt = beforeId ? dest.indexOf(+beforeId) : dest.length;
    dest.splice(insertAt < 0 ? dest.length : insertAt, 0, ...ids);
    setCards(cs => cs.map(c => (ids.includes(c.id) ? { ...c, machine_id } : c)));
    const payload = { job_card_id: ids[0], machine_id, ordered_ids: machine_id ? dest : [] };
    try {
      // One call — the server assigns the press to every job in the gang.
      await api.post('/print-planning/assign', payload);
      load();
    } catch (e) {
      // Soft strength mix-up alarm — hold the optimistic move, ask, then re-send.
      if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
        setClashPrompt({
          collision: e.data.collision,
          confirm: () => api.post('/print-planning/assign', { ...payload, confirm_collision: true }),
        });
      } else load();
    }
    dragIds.current = []; dropBeforeId.current = null; setDragOverLane(null);
  };

  const laneProps = laneKey => ({
    onDragOver: e => { e.preventDefault(); setDragOverLane(laneKey); },
    onDragLeave: () => setDragOverLane(l => (l === laneKey ? null : l)),
    onDrop: e => { e.preventDefault(); moveGroup(laneKey, dropBeforeId.current); },
  });

  const groupProps = (group, laneKey) => ({
    draggable: canPlan(),
    onDragStart: e => { dragIds.current = group.cards.map(c => c.id); e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: e => { e.preventDefault(); dropBeforeId.current = group.cards[0].id; setDragOverLane(laneKey); },
    onDrop: e => { e.preventDefault(); e.stopPropagation(); moveGroup(laneKey, group.cards[0].id); },
  });

  const renderGroup = (group, laneKey, theme) => {
    const draggable = canPlan();
    const onPress = laneKey !== TRIAGE;
    if (!group.gang_number) {
      return (
        <div key={group.key} {...groupProps(group, laneKey)}
          onClick={() => setChooser({ card: group.cards[0], done: false })}
          className={draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}>
          <Card card={group.cards[0]} grip={draggable} onPress={onPress} theme={theme} onDone={load} />
        </div>
      );
    }
    const sheets = group.cards.reduce((s, c) => s + c.sheets_issued, 0);
    return (
      <div key={group.key} {...groupProps(group, laneKey)}
        className={`rounded-2xl border border-dashed border-violet-300 bg-violet-50/60 p-1.5 ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
        <div className="mb-1 flex items-center justify-between px-1.5 pt-0.5">
          <span className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide text-violet-700">
            {draggable && <GripVertical size={11} className="text-violet-300" />}
            <Link2 size={10} /> {group.gang_number} · prints together
          </span>
          <span className="text-[10px] font-bold tabular-nums text-violet-500">{fmt.num(sheets)} sh</span>
        </div>
        <div className="space-y-1">
          {group.cards.map(c => <Card key={c.id} card={c} onPress={onPress} theme={theme} onDone={load} />)}
        </div>
      </div>
    );
  };

  const laneShell = (theme, active) =>
    `flex min-h-[300px] flex-1 flex-col gap-1.5 rounded-2xl border p-2.5 transition-colors ${
      active ? theme.active : `${theme.shell} shadow-card`}`;

  return (
    <div>
      <PageHeader title="Print Planning"
        subtitle="Drag job cards onto a press — top to bottom is the live printing queue · gangs move as one"
        actions={<>
          <ExportMenu build={() => {
            const laneColumns = [
              { key: 'queue', label: '#', align: 'right', export: c => c._pos },
              { key: 'jc_number', label: 'Job Card' },
              { key: 'gang_number', label: 'Gang', export: c => c.gang_number || '—' },
              { key: 'product_name', label: 'Product' },
              { key: 'customer_name', label: 'Customer' },
              { key: 'sheets_issued', label: 'Sheets', align: 'right', export: c => fmt.num(c.sheets_issued) },
              { key: 'planned_date', label: 'Planned', export: c => (c.planned_date ? fmt.date(c.planned_date) : '—') },
              { key: 'delivery_date', label: 'Delivery', export: c => (c.delivery_date ? fmt.date(c.delivery_date) : '—') },
            ];
            const withPos = list => list.map((c, i) => ({ ...c, _pos: i + 1 }));
            return {
              name: 'Print Planning Board',
              title: 'Print Planning Board',
              subtitle: 'Press queues top-to-bottom — the live printing order',
              summary: [
                { label: 'In triage', value: lanes[TRIAGE].length },
                { label: 'Assigned', value: cards.length - lanes[TRIAGE].length },
                { label: 'Presses', value: presses.length },
              ],
              sections: [
                { heading: 'Triage — Unassigned', columns: laneColumns, rows: withPos(lanes[TRIAGE]) },
                ...presses.map(p => ({
                  heading: `${p.name} — ${fmt.num((lanes[p.id] || []).reduce((s, c) => s + c.sheets_issued, 0))} sheets queued`,
                  columns: laneColumns,
                  rows: withPos(lanes[p.id] || []),
                })),
              ],
            };
          }} />
          <Link to="/floor/printing" className="inline-flex items-center gap-1.5 rounded-full border border-white/75 bg-white/65 px-4 py-2 text-sm font-semibold text-[#1D1D1F] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] backdrop-blur-xl transition-all duration-200 ease-apple hover:bg-white/90 hover:text-[#007AFF]">
          <Radio size={14} /> Live Printing
        </Link></>} />

      {/* Board / Completed tab switch */}
      <div className="mb-4 inline-flex rounded-full border border-white/70 bg-white/60 p-1 shadow-card backdrop-blur-xl">
        {[['board', 'Board', LayoutGrid], ['completed', 'Completed', CheckCircle2]].map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
              tab === key ? 'bg-white text-[#007AFF] shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={14} /> {label}
            {key === 'completed' && completed.length > 0 && (
              <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-700">{completed.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'board' && (<>
      {/* How-to + colour key — orients first-time planners at a glance:
          what the colours mean and how the drag-to-queue interaction works. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-2xl border border-white/70 bg-white/60 px-4 py-2.5 shadow-card backdrop-blur-xl">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          {canPlan()
            ? <><MousePointer2 size={14} className="shrink-0 text-slate-400" />
                Drag a job from <b className="text-slate-700">Triage</b> onto a press — the top of each lane
                <span className="inline-flex items-center gap-0.5 text-slate-700"><ArrowDown size={11} /> prints first</span>.</>
            : <><Radio size={14} className="shrink-0 text-slate-400" />
                Live printing queue — the top of each lane prints first.</>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 animate-pulseSoft rounded-full bg-amber-500" /> Printing now</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" /> On hold</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" /> Queued on a press</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-300" /> In triage</span>
          <span className="flex items-center gap-1.5 text-amber-600"><AlertTriangle size={11} /> Board pending</span>
        </div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${presses.length + 1}, minmax(0, 1fr))` }}>
        {/* Triage — neutral by design so the coloured presses stand out */}
        <div className="flex flex-col">
          <div className="mb-2 flex min-h-[3.25rem] items-start justify-between gap-2 px-1">
            <span className="flex items-center gap-1.5 pt-0.5 text-sm font-extrabold text-slate-900">
              <Inbox size={14} className={TRIAGE_THEME.icon} /> Triage
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TRIAGE_THEME.badge}`}>{lanes[TRIAGE].length}</span>
          </div>
          <div className={laneShell(TRIAGE_THEME, dragOverLane === TRIAGE)} {...laneProps(TRIAGE)}>
            {groupLane(lanes[TRIAGE]).map(g => renderGroup(g, TRIAGE, TRIAGE_THEME))}
            {lanes[TRIAGE].length === 0 && (
              <div className="flex flex-col items-center gap-1.5 py-12 text-center text-slate-300">
                <CheckCircle2 size={22} className="text-emerald-300" />
                <span className="text-xs font-semibold text-slate-400">All jobs assigned</span>
                <span className="text-[10px]">Nothing waiting in triage</span>
              </div>
            )}
          </div>
        </div>

        {/* Press lanes — one hue each, headers a fixed height so every lane body
            lines up on the same baseline */}
        {presses.map((p, idx) => {
          const lane = lanes[p.id] || [];
          const sheets = lane.reduce((s, c) => s + c.sheets_issued, 0);
          const theme = pressTheme(idx);
          return (
            <div key={p.id} className="flex flex-col">
              <div className="mb-2 flex min-h-[3.25rem] items-start justify-between gap-2 px-1">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate text-sm font-extrabold text-slate-900">
                    <Printer size={14} className={theme.icon} /> {p.name}
                  </span>
                  {/* Press designation + who runs it, stacked so neither truncates */}
                  {p.model && (
                    <div className="mt-0.5 truncate pl-[22px] text-[11px] font-semibold text-slate-400">{p.model}</div>
                  )}
                  {p.operators?.length > 0 && (
                    <div className="mt-0.5 flex items-center gap-1 truncate pl-[22px] text-[11px] font-bold text-slate-600">
                      <User size={10} className="text-slate-400" />
                      {p.operators.map(o => o.name).join(', ')}
                    </div>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${theme.badge}`}>
                  {lane.length} · {fmt.num(sheets)} sh
                </span>
              </div>
              <div className={laneShell(theme, dragOverLane === p.id)} {...laneProps(p.id)}>
                {groupLane(lane).map((g, i) => (
                  <div key={g.key} className="flex items-start gap-1.5">
                    <span className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold tabular-nums ${theme.queue}`}>{i + 1}</span>
                    <div className="min-w-0 flex-1">{renderGroup(g, p.id, theme)}</div>
                  </div>
                ))}
                {lane.length === 0 && printedToday[p.id]?.length === 0 && (
                  <div className="flex flex-col items-center gap-1.5 py-12 text-center text-slate-300">
                    <ArrowDown size={20} className={dragOverLane === p.id ? theme.icon : 'text-slate-300'} />
                    <span className="text-xs font-semibold text-slate-400">Drag jobs here</span>
                    <span className="text-[10px]">They queue top-to-bottom</span>
                  </div>
                )}
                {printedToday[p.id]?.length > 0 && (
                  <div className="mt-1 border-t border-dashed border-emerald-200 pt-1.5">
                    {printedToday[p.id].map(c => (
                      <div key={`done-${c.id}`} className="mb-1.5">
                        <PrintedCard card={c} onClick={() => setChooser({ card: c, done: true })} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </>)}

      {tab === 'completed' && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${presses.length}, minmax(0, 1fr))` }}>
          {presses.map((p, idx) => {
            const list = completedByPress[p.id] || [];
            const theme = pressTheme(idx);
            return (
              <div key={p.id} className="flex flex-col">
                <div className="mb-2 flex min-h-[3.25rem] items-start justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 truncate text-sm font-extrabold text-slate-900">
                    <Printer size={14} className={theme.icon} /> {p.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700">
                    {list.length} printed
                  </span>
                </div>
                <div className="flex min-h-[300px] flex-1 flex-col gap-1.5 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-2.5 shadow-card">
                  {list.map(c => <PrintedCard key={c.id} card={c} onClick={() => setChooser({ card: c, done: true })} />)}
                  {list.length === 0 && (
                    <div className="flex flex-col items-center gap-1.5 py-12 text-center text-slate-300">
                      <CheckCircle2 size={20} className="text-emerald-200" />
                      <span className="text-xs font-semibold text-slate-400">No printed runs</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {chooser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setChooser(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-extrabold text-slate-900">{chooser.card.jc_number}</span>
              <button onClick={() => setChooser(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="mb-4 truncate text-xs text-slate-500">{chooser.card.product_name} · {chooser.card.customer_name}</div>
            <div className="flex flex-col gap-2">
              <button onClick={() => openJobCard(chooser.card)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <FileText size={15} className="text-slate-400" /> View Job Card
              </button>
              {!chooser.done && canPlan() && (
                <button onClick={() => { setEditCard(chooser.card); setChooser(null); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-100">
                  <Pencil size={15} /> Printing Queue — Edit
                </button>
              )}
              {chooser.done && canPlan() && (
                <button onClick={() => reverseRun(chooser.card)}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-100">
                  <RotateCcw size={15} /> Reverse to Triage
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {editCard && (
        <EditQueueForm card={editCard} presses={presses} lanes={lanes}
          onClose={() => setEditCard(null)}
          onSaved={() => { setEditCard(null); load(); }}
          onClash={(collision, confirm) => setClashPrompt({ collision, confirm })} />
      )}

      {clashPrompt && (
        <StrengthClashModal
          collision={clashPrompt.collision}
          onCancel={() => { setClashPrompt(null); load(); }}
          onConfirm={async () => {
            try { await clashPrompt.confirm(); } catch { /* central toast */ }
            setClashPrompt(null); setEditCard(null); load();
          }} />
      )}
    </div>
  );
}

// Soft strength mix-up alarm — same brand, different strength somewhere in the
// plan. Never blocks: "Plan Anyway" proceeds (and is audited), "Cancel" reverts.
function StrengthClashModal({ collision, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-100 p-2 text-amber-600"><AlertTriangle size={22} /></div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">Strength mix-up check</h3>
            <p className="text-sm text-slate-500">Same brand, different strength is already in the plan.</p>
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You're planning <b>{collision.this.product_name}</b>
          {collision.this.strength && <> (strength <b>{collision.this.strength}</b>)</>}.
          <div className="mt-2 space-y-1">
            {collision.others.map((o, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                <span>Already planned:</span>
                <b>{o.product_name}</b>
                {o.strength && <span className="rounded bg-amber-200/70 px-1.5 font-semibold">{o.strength}</span>}
                <span className="text-amber-700">
                  · {o.location}{o.planned_date ? ` · ${fmt.date(o.planned_date)}` : ''}{o.jc_number ? ` · ${o.jc_number}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">Different strengths of the same product can get swapped. Sure you want to plan this one too?</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>Plan Anyway</Button>
        </div>
      </div>
    </div>
  );
}
