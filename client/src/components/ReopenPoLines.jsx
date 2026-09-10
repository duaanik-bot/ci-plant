// Reopen closed-short PO lines — the form behind every way back.
//
// A waiver is undone deliberately: the buyer sees exactly which lines return,
// how much of each comes back as owed, why each was closed and by whom — and
// says why it is being reopened, the same discipline as the close. One form for
// every register: the board's Purchase Orders → Closed lines, and the close
// modal on board, plate, die and block orders. Each maps its lines into
// { id, po_number?, title, sub?, qty, received_qty, unit?, waived,
//   closed_reason?, closed_by?, closed_at?, warning? }.
import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { fmt } from '../api.js';
import { unitLabel } from '../lib/closedPoLines.js';
import { Button, Field, Modal, Textarea, useToast } from './ui.jsx';

export default function ReopenPoLinesModal({
  lines = [], unitWord = 'nos', note = null,
  // Ticked on arrival when the buyer already chose the lines (a selection, a
  // row's own button); unticked when the form is opened to REVIEW an order's
  // closed lines, so nothing comes back that was not asked for.
  preselected = true,
  layer, onReopen, onClose, onDone,
}) {
  const toast = useToast();
  const [picked, setPicked] = useState(() => new Set(preselected ? lines.map(line => line.id) : []));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = id => setPicked(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const back = lines.filter(line => picked.has(line.id)).reduce((sum, line) => sum + (Number(line.waived) || 0), 0);
  const orders = [...new Set(lines.map(line => line.po_number).filter(Boolean))];

  const submit = async () => {
    if (!picked.size || !reason.trim()) return;
    setBusy(true);
    try {
      const result = await onReopen([...picked], reason.trim());
      const reopened = result?.reopened ?? picked.size;
      const kept = (result?.orders || []).reduce((sum, order) => sum + (order.kept_closed || 0), 0);
      // Tooling reopens put back what the close took — say how much.
      const reattached = result?.reattached_plates || 0;
      const relinked = result?.relinked_requirements || 0;
      toast.success(`${reopened} line${reopened === 1 ? '' : 's'} reopened — back in Pendency and open for receipts`
        + (kept ? ` · ${kept} other line${kept === 1 ? '' : 's'} of a closed order kept closed` : '')
        + (reattached ? ` · ${reattached} plate${reattached === 1 ? '' : 's'} back on their set` : '')
        + (relinked ? ` · ${relinked} requirement${relinked === 1 ? '' : 's'} back on its order` : ''));
      await onDone?.();
      onClose();
    } catch (error) { toast.error(error.message || 'Could not reopen the selected lines'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} wide layer={layer}
      title={orders.length === 1 ? `Reopen closed lines · ${orders[0]}` : 'Reopen closed lines'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !picked.size || !reason.trim()} onClick={submit}>
          <RotateCcw size={14} /> Reopen {picked.size || ''} line{picked.size === 1 ? '' : 's'} — receipts allowed again
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Reopening puts a line's waived balance back on its order: it returns to Pendency and every
          on-order figure, and receipts against it are accepted again. The order's status follows its lines.
          {note ? <span className="mt-1 block font-semibold text-slate-600">{note}</span> : null}
        </p>

        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Closed short</span><span>tick what is coming after all</span></div>
          <div className="space-y-1.5">
            {lines.map(line => (
              <label key={line.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${picked.has(line.id) ? 'border-brand-200 bg-brand-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                  checked={picked.has(line.id)} onChange={() => toggle(line.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800">{line.title}</span>
                  {line.sub && <span className="block truncate text-[11px] text-slate-400">{line.sub}</span>}
                  {(line.closed_reason || line.closed_by) && (
                    <span className="block text-[11px] italic text-slate-500">
                      Closed{line.closed_reason ? `: “${line.closed_reason}”` : ''}
                      {line.closed_by ? ` — ${line.closed_by}` : ''}{line.closed_at ? `, ${fmt.date(line.closed_at)}` : ''}
                    </span>
                  )}
                  {line.warning && (
                    <span className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-amber-700">
                      <AlertTriangle size={12} className="mt-px shrink-0" /> {line.warning}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <b className="text-amber-600">{fmt.num(line.waived)}</b>
                  <span className="text-slate-400"> {unitLabel(line.waived, line.unit || unitWord)} back to pending</span>
                  <span className="block text-[10px] text-slate-400">{fmt.num(line.received_qty)} of {fmt.num(line.qty)} received</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <Field label="Why reopen?" required>
          <Textarea value={reason} onChange={event => setReason(event.target.value)}
            placeholder="Vendor is shipping the balance after all / closed by mistake…" />
        </Field>
        {picked.size > 0 && (
          <p className="text-[11px] font-semibold text-slate-500">
            {fmt.num(back)} {unitLabel(back, unitWord)} {back === 1 ? 'goes' : 'go'} back to Pendency across {picked.size} line{picked.size === 1 ? '' : 's'}.
          </p>
        )}
      </div>
    </Modal>
  );
}
