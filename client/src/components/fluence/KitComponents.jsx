// A Fluence inner product's carton size, where it is known. The kit list itself
// is shown and edited with its prescription (PrescriptionView.jsx's RxLinesTable
// and KitRxEditor.jsx).
import { formatDims } from '../../lib/fluence.js';

export function DimsCell({ item }) {
  const dims = formatDims(item);
  if (dims) return <span className="tabular-nums">{dims}</span>;
  const some = [item?.carton_l, item?.carton_w, item?.carton_h].some(x => x != null);
  return <span className="text-[11px] font-medium text-amber-700">{some ? 'Incomplete' : 'Not known yet'}</span>;
}
