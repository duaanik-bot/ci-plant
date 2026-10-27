import { Clock3 } from 'lucide-react';
import { IDLE_DAYS } from '../lib/idleCards.js';

// "12 job cards idle 14+ days · Show" — the one place a screen says it is
// holding cards back, so a badge that counts them and a list that does not
// never disagree silently. Renders nothing when nothing is idle.
export default function IdleCardsChip({ count, showing, onToggle, noun = 'job card' }) {
  if (!count) return null;
  const n = `${count} ${noun}${count === 1 ? '' : 's'}`;
  return (
    <button type="button" onClick={onToggle} aria-pressed={showing}
      title={`Cards with no stage started, finished or counted for ${IDLE_DAYS} days, and nothing on a machine or on hold.`}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors touch:min-h-[40px]
        ${showing ? 'bg-amber-50 text-amber-800 ring-amber-200 hover:bg-amber-100' : 'bg-white/60 text-[#6E6E73] ring-white/70 hover:text-[#1D1D1F]'}`}>
      <Clock3 size={13} />
      {showing ? <>Showing {n} idle {IDLE_DAYS}+ days · <span className="underline">Hide</span></>
        : <>{n} idle {IDLE_DAYS}+ days hidden · <span className="underline">Show</span></>}
    </button>
  );
}
