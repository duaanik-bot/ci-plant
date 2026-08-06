// Batch job-card print — every card a planner ticked on the register, stacked
// into ONE print run, one A4 per card.
//
// The plant used to open a card, print it, go back, open the next, print it.
// Ten jobs was ten trips through the print dialog. This is one trip: the
// selection arrives as ?ids=, each card's full record is fetched, and every
// traveler renders into a single document that either goes straight to the
// printer or saves as one intact PDF.
//
// The sheets are components/JobCardSheet.jsx — the SAME component
// /production/jobcard/:id renders. There is no batch layout: a card printed
// here is byte-for-byte the card printed on its own.
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import JobCardSheet from '../components/JobCardSheet.jsx';
import { Printer, ArrowLeft, AlertTriangle } from 'lucide-react';

// The full record per card — /job-cards/:id, not the register row: the traveler
// needs board_mix, tools, issues and the live shade card, and only the singular
// GET attaches them. Fetched in a small parallel wave rather than all at once,
// so ticking forty cards does not open forty sockets at the pooler.
const WAVE = 6;
async function loadCards(ids, onProgress) {
  const out = [];
  const missed = [];
  for (let i = 0; i < ids.length; i += WAVE) {
    const wave = await Promise.all(ids.slice(i, i + WAVE).map(id =>
      api.get(`/job-cards/${id}`).catch(() => ({ __failed: id }))));
    for (const r of wave) (r.__failed ? missed : out).push(r);
    onProgress(out.length + missed.length);
  }
  return { cards: out, missed: missed.map(m => m.__failed) };
}

export default function JobCardBatchPrint() {
  const [params] = useSearchParams();
  // Order is the planner's — the register hands its ids over in the order the
  // cards are listed, so the printed stack matches the screen he ticked them on.
  const ids = (params.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
  const [cards, setCards] = useState(null);
  const [missed, setMissed] = useState([]);
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!ids.length) { setCards([]); return; }
    let live = true;
    loadCards(ids, n => { if (live) setDone(n); }).then(r => {
      if (!live) return;
      setCards(r.cards);
      setMissed(r.missed);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('ids')]);

  // Deliberately NOT auto-firing window.print(): the dialog would open over a
  // page the planner has not seen yet, and a mis-tick would already be at the
  // printer. He looks at the stack, then prints it.
  if (cards === null) {
    return (
      <div className="mx-auto max-w-3xl py-20 text-center">
        <div className="text-sm font-semibold text-slate-600">
          Preparing {ids.length} job card{ids.length === 1 ? '' : 's'}…
        </div>
        <div className="mt-2 text-xs text-slate-400 tabular-nums">{done} of {ids.length} loaded</div>
      </div>
    );
  }

  if (!cards.length) {
    return (
      <div className="mx-auto max-w-3xl py-20 text-center">
        <p className="text-sm text-slate-500">No job cards to print.</p>
        <Link to="/production" className="mt-4 inline-block"><Button variant="secondary"><ArrowLeft size={14} /> Back to Job Cards</Button></Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/production"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <div className="text-xs text-slate-500">
          <b className="text-slate-800">{cards.length} job card{cards.length === 1 ? '' : 's'}</b> · one A4 page each
          <span className="ml-2 text-slate-400">choose your printer, or “Save as PDF” for one file</span>
        </div>
        <Button onClick={() => window.print()}><Printer size={14} /> Print / Save as PDF</Button>
      </div>

      {/* A card that could not be loaded is NAMED. Printing 9 of 10 silently is
          the one outcome worse than failing — the missing traveler is the job
          that then runs without paper. */}
      {missed.length > 0 && (
        <div className="no-print mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>
            {missed.length} job card{missed.length === 1 ? '' : 's'} could not be loaded and {missed.length === 1 ? 'is' : 'are'} not
            in this stack. Print {missed.length === 1 ? 'it' : 'them'} individually from the register.
          </span>
        </div>
      )}

      {/* The stack. Every sheet but the last breaks the page after it, so each
          card starts at the top of its own A4 — a traveler that runs long
          (a big gang) simply takes the pages it needs and the next card still
          starts clean. On screen the same rule reads as spacing between cards. */}
      <div className="space-y-6 print:space-y-0">
        {cards.map((jc, i) => (
          <div key={jc.id} className={i < cards.length - 1 ? 'print-page-break' : undefined}>
            {/* Screen-only spine so a long scroll stays legible; the paper
                already says which card it is in the sheet's own header. */}
            <div className="no-print mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {i + 1} of {cards.length} · {jc.jc_number}
              {jc.planned_date ? ` · plan ${fmt.date(jc.planned_date)}` : ''}
            </div>
            <JobCardSheet jc={jc} />
          </div>
        ))}
      </div>
    </div>
  );
}
