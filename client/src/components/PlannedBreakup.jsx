// "As planned" cutting breakup — a read-only recap shown above the counter in
// a cutting-completion dialog, so the operator checks output against the same
// board/cut structure Planning (or the floor's own board issue) already
// locked in — never a surprise the counter alone can't show.
//
// Shared by Section.jsx (the per-station Cutting workspace) and Floor.jsx
// (the unified Live Floor board, which can also complete a cutting stage —
// see Floor.jsx's own openComplete comment for why it fetches unconditionally
// while Section.jsx's row often already has everything it needs).
//
// Mixed job: `rows` is the job card's own board_mix, already enriched
// server-side with cut geometry (production.js's attachBoardMix). Single-
// board job (rows empty): `single` is a plain { board_name, count, sheets }
// object the CALLER builds — from data already on hand when the caller's own
// row carries it (Section.jsx's STAGE_VIEW row), or from the same GET when it
// doesn't (Floor.jsx's plain /floor row has no board_name/sheet size at all).
//
// Compact by design — Board | No. of Cuts | Sheets, no arrangement/rotated
// detail. This is a modal an operator glances at mid-shift, not the printed
// traveler (JobCardPrint.jsx carries the full "count (across × down)" detail).
import { fmt } from '../api.js';
import { pktText } from '../lib/boardUsed.js';
import { packets } from '../lib/boardMath.js';

export default function PlannedBreakup({ status, rows = [], phase, single }) {
  if (!status || status === 'idle') return null;
  if (status === 'error') {
    return (
      <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
        Couldn't load the planned breakup — completing this stage still works below.
      </p>
    );
  }
  if (status !== 'loaded') return null; // 'loading' — a beat before the table appears
  const mixed = rows.length > 0;
  if (!mixed && !single) return null;
  // The same three counts the traveler prints — packets (how the store holds
  // it), parent sheets (what went on the guillotine) and child sheets (what
  // should come off) — so the operator checks output against the same numbers
  // the paper in their hand shows, not a subset of them.
  const withCounts = r => {
    const count = r.count ?? r.cut?.count ?? r.ups;
    const parent = Number(r.sheets || 0);
    return {
      board_name: r.board_name,
      count,
      sheets: r.sheets,
      packets: packets({ sheets_per_packet: r.sheets_per_packet }, r.sheets),
      child: count > 0 ? Math.round(parent * count) : null,
    };
  };
  const displayRows = (mixed ? rows : [single]).map(withCounts);
  const totalParent = displayRows.reduce((s, r) => s + Number(r.sheets || 0), 0);
  const totalChild = displayRows.reduce((s, r) => s + Number(r.child || 0), 0);
  const totalPackets = displayRows.every(r => r.packets != null)
    ? displayRows.reduce((s, r) => s + r.packets, 0)
    : null;
  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title">
        <span>As planned</span>
        <span>{mixed ? `${phase === 'plan' ? 'As Planned' : 'As Issued'} · ${rows.length} boards` : 'Single board'}</span>
      </div>
      <table className="w-full text-xs">
        <thead><tr className="border-b border-slate-200 text-left text-[10px] font-bold uppercase text-slate-400">
          <th className="py-1">Board</th>
          <th className="py-1 text-right">Cuts</th>
          <th className="py-1 text-right">Pkt</th>
          <th className="py-1 text-right">Parent</th>
          <th className="py-1 text-right">Child</th>
        </tr></thead>
        <tbody>
          {displayRows.map((r, i) => (
            <tr key={i} className="border-b border-slate-50 last:border-0">
              <td className="py-1 font-semibold text-slate-700">{r.board_name || '—'}</td>
              <td className="py-1 text-right tabular-nums text-slate-600">{fmt.num(r.count)}</td>
              <td className="py-1 text-right tabular-nums text-slate-600">{pktText(r.packets) ?? '—'}</td>
              <td className="py-1 text-right font-semibold tabular-nums text-slate-700">{fmt.num(r.sheets)}</td>
              <td className="py-1 text-right tabular-nums text-slate-600">{r.child != null ? fmt.num(r.child) : '—'}</td>
            </tr>
          ))}
        </tbody>
        {displayRows.length > 1 && (
          <tfoot>
            <tr className="border-t border-slate-200 font-bold">
              <td className="py-1 text-slate-500" colSpan={2}>Total</td>
              <td className="py-1 text-right tabular-nums text-slate-700">{pktText(totalPackets) ?? '—'}</td>
              <td className="py-1 text-right tabular-nums text-slate-800">{fmt.num(totalParent)}</td>
              <td className="py-1 text-right tabular-nums text-slate-700">{fmt.num(totalChild)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </section>
  );
}
