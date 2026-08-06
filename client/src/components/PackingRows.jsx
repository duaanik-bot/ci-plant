// The packing manifest grid — one implementation, three places.
//
// The closing run, the day count, and CORRECTING a day count in the run log all
// meet the same three boxes. Three copies of a grid that computes a line total
// is three chances for them to disagree about what a box is.
import { Button, Input } from './ui.jsx';
import { Trash2, Plus } from 'lucide-react';

export const emptyPack = () => ({ boxes: '', qty_per_box: '', loose_qty: '' });
export const packLineTotal = pl =>
  Math.max(0, (+pl.boxes || 0) * (+pl.qty_per_box || 0)) + Math.max(0, +pl.loose_qty || 0);
export const packTotalOf = ls => (ls || []).reduce((n, pl) => n + packLineTotal(pl), 0);
const fmtNum = n => (n || 0).toLocaleString('en-IN');

// The packing manifest grid. Shared by the day count and the closing run so the
// operator meets the same three boxes wherever he records packing — the only
// difference is which set of lines it is writing into.
export function PackingRows({ lines, setLines }) {
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_1fr_1fr_90px_30px] gap-2 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
        <span>Boxes</span><span>Qty / box</span><span>Loose pcs</span><span className="text-right">Line total</span><span />
      </div>
      {lines.map((pl, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_90px_30px] items-center gap-2">
          <Input type="number" min="0" placeholder="0" value={pl.boxes} onChange={e => setLines(p => p.map((x, j) => j === i ? { ...x, boxes: e.target.value } : x))} />
          <Input type="number" min="0" placeholder="0" value={pl.qty_per_box} onChange={e => setLines(p => p.map((x, j) => j === i ? { ...x, qty_per_box: e.target.value } : x))} />
          <Input type="number" min="0" placeholder="0" value={pl.loose_qty} onChange={e => setLines(p => p.map((x, j) => j === i ? { ...x, loose_qty: e.target.value } : x))} />
          <div className="rounded-lg bg-slate-50 px-2 py-2 text-right text-xs font-bold tabular-nums text-slate-600">{packLineTotal(pl) ? fmtNum(packLineTotal(pl)) : '—'}</div>
          <button type="button" title="Remove line" disabled={lines.length === 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
            onClick={() => setLines(p => p.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setLines(p => [...p, emptyPack()])}><Plus size={13} /> Add line</Button>
    </div>
  );
}

