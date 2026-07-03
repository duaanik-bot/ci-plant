// Print Planning — the CI-Production press kanban. Drag job cards from
// Triage onto a press lane and order them top-to-bottom; that order IS the
// live printing queue on the floor. Native HTML5 drag & drop, no library.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { PageHeader } from '../components/ui.jsx';
import { Inbox, Printer, GripVertical, Radio } from 'lucide-react';

const TRIAGE = 'triage';
const canPlan = () => ['admin', 'planner'].includes(auth.user?.role);

function Card({ card, draggable, onDragStart, onDragOverCard, onDropOnCard }) {
  const running = card.printing_status === 'in_progress';
  const held = card.printing_status === 'hold';
  return (
    <div draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOverCard}
      onDrop={onDropOnCard}
      className={`group rounded-xl border bg-white px-3 py-2.5 shadow-sm transition-shadow ${
        running ? 'border-amber-300 ring-1 ring-amber-200' : held ? 'border-red-200' : 'border-slate-200'}
        ${draggable ? 'cursor-grab active:cursor-grabbing hover:shadow-lift' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-extrabold text-slate-900">
          {draggable && <GripVertical size={12} className="text-slate-300 group-hover:text-slate-400" />}
          {card.jc_number}
        </span>
        {running && <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600"><span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />PRINTING</span>}
        {held && <span className="text-[10px] font-bold text-red-500">ON HOLD</span>}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-slate-500">{card.product_name}</div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
        <span className="truncate">{card.customer_name}</span>
        <span className="shrink-0 tabular-nums">{fmt.num(card.sheets_issued)} sh · {fmt.date(card.delivery_date)}</span>
      </div>
    </div>
  );
}

export default function PrintPlanning() {
  const [cards, setCards] = useState([]);
  const [presses, setPresses] = useState([]);
  const [dragOverLane, setDragOverLane] = useState(null);
  const dragId = useRef(null);
  const dropBeforeId = useRef(null);

  const load = () => api.get('/print-planning').then(d => { setCards(d.cards); setPresses(d.presses); });
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

  const moveCard = async (laneKey, beforeId) => {
    const id = +dragId.current;
    if (!id) return;
    const machine_id = laneKey === TRIAGE ? null : +laneKey;
    // Build the destination lane order locally (optimistic).
    const dest = lanes[laneKey].filter(c => c.id !== id).map(c => c.id);
    const insertAt = beforeId ? dest.indexOf(+beforeId) : dest.length;
    dest.splice(insertAt < 0 ? dest.length : insertAt, 0, id);
    setCards(cs => cs.map(c => (c.id === id ? { ...c, machine_id } : c)));
    try {
      await api.post('/print-planning/assign', { job_card_id: id, machine_id, ordered_ids: machine_id ? dest : [] });
      load();
    } catch { load(); }
    dragId.current = null; dropBeforeId.current = null; setDragOverLane(null);
  };

  const laneProps = laneKey => ({
    onDragOver: e => { e.preventDefault(); setDragOverLane(laneKey); },
    onDragLeave: () => setDragOverLane(l => (l === laneKey ? null : l)),
    onDrop: e => { e.preventDefault(); moveCard(laneKey, dropBeforeId.current); },
  });

  const cardProps = (card, laneKey) => ({
    draggable: canPlan(),
    onDragStart: e => { dragId.current = card.id; e.dataTransfer.effectAllowed = 'move'; },
    onDragOverCard: e => { e.preventDefault(); dropBeforeId.current = card.id; setDragOverLane(laneKey); },
    onDropOnCard: e => { e.preventDefault(); e.stopPropagation(); moveCard(laneKey, card.id); },
  });

  const laneShell = active =>
    `flex min-h-[280px] flex-col gap-1.5 rounded-2xl border p-2.5 transition-colors ${
      active ? 'border-brand-300 bg-brand-50/50 ring-2 ring-brand-200' : 'border-slate-200/80 bg-white shadow-card'}`;

  return (
    <div>
      <PageHeader title="Print Planning"
        subtitle="Drag job cards onto a press — top to bottom is the live printing queue"
        actions={<Link to="/floor/printing" className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-600 shadow-sm hover:text-indigo-700">
          <Radio size={14} /> Live Printing
        </Link>} />

      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${presses.length + 1}, minmax(0, 1fr))` }}>
        {/* Triage */}
        <div>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="flex items-center gap-1.5 text-sm font-extrabold text-slate-900"><Inbox size={14} className="text-slate-400" /> Triage</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{lanes[TRIAGE].length}</span>
          </div>
          <div className={laneShell(dragOverLane === TRIAGE)} {...laneProps(TRIAGE)}>
            {lanes[TRIAGE].map(c => <Card key={c.id} card={c} {...cardProps(c, TRIAGE)} />)}
            {lanes[TRIAGE].length === 0 && <p className="py-10 text-center text-xs text-slate-300">Nothing unassigned</p>}
          </div>
        </div>

        {/* Press lanes */}
        {presses.map(p => {
          const lane = lanes[p.id] || [];
          const sheets = lane.reduce((s, c) => s + c.sheets_issued, 0);
          return (
            <div key={p.id}>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-extrabold text-slate-900">
                  <Printer size={14} className="text-sky-500" /> {p.name}
                </span>
                <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">
                  {lane.length} · {fmt.num(sheets)} sh
                </span>
              </div>
              <div className={laneShell(dragOverLane === p.id)} {...laneProps(p.id)}>
                {lane.map((c, i) => (
                  <div key={c.id} className="flex items-start gap-1.5">
                    <span className="mt-2.5 w-4 shrink-0 text-right text-[10px] font-bold text-slate-300">{i + 1}</span>
                    <div className="min-w-0 flex-1"><Card card={c} {...cardProps(c, p.id)} /></div>
                  </div>
                ))}
                {lane.length === 0 && <p className="py-10 text-center text-xs text-slate-300">Drop jobs here</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
