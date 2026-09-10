// Close individual PO lines short — "no more receipts", per item.
//
// One modal serves all four buying registers (board, plates, dies, blocks):
// each maps its own lines into { id, title, sub, qty, received_qty, unit,
// closed_short, closed_reason, closed_by, pending } and says what closing
// means in its own words. The modal itself only knows the shape of the
// decision: pick the items that will not arrive, say why once. Lines already
// closed stay out of the list, with the way back (Review & reopen — a form that
// asks why, ReopenPoLines.jsx) on the same screen, because a decision that
// can only be made in one direction gets made too carefully or not at all.
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Ban, RotateCcw } from 'lucide-react';
import { fmt } from '../api.js';
import { Button, Field, Modal, Textarea, useToast } from './ui.jsx';
import ReopenPoLinesModal from './ReopenPoLines.jsx';

export default function ClosePoLinesModal({
  poNumber, vendorName, lines = [], unitWord = 'nos', note = null,
  // What the reopen form warns about, in this register's words — what a reopen
  // does NOT undo (a released job cover, plates gone back to their requirement).
  reopenNote = null,
  // Board only: fetches the jobs whose incoming cover rides on the ticked
  // lines, so the buyer approves the close KNOWING what needs planning again —
  // and picks, per job, whether (and how much) cover to release. Never a
  // blocker: with nothing ticked the close simply releases nothing.
  loadImpact = null,
  impactEmptyText = "No job's incoming cover rides on the ticked lines — this is shelf stock only.",
  onCloseLines, onReopenLines, onClose, onDone,
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState(false);
  // Rows are offered pre-partitioned: only a line still owing something can be
  // closed, and only a closed line can be reopened. A fully received line is
  // shown in neither list — there is no decision left on it.
  const closable = useMemo(() => lines.filter(l => !l.closed_short && l.pending > 0), [lines]);
  const closed = useMemo(() => lines.filter(l => l.closed_short), [lines]);
  const [picked, setPicked] = useState(() => new Set(
    // A row-level door (Pendency) opens the modal with its line pre-ticked.
    lines.filter(l => l.preselected && !l.closed_short && l.pending > 0).map(l => l.id)));
  const toggle = id => setPicked(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // The jobs riding on the ticked lines, in the caller's own vocabulary. Each
  // impact row is normalised by the page that mounts this modal:
  //   { id, title, code?, sub?, order_line_id?, message?,
  //     selectable (has a checkbox), defaultOn, qty (editable max, or null) }
  // Board rows carry a qty (release that much cover); die/block rows carry a
  // checkbox only (return the requirement to Approved); plate rows are
  // informative — their release is not optional, so there is nothing to tick.
  // `release` holds the buyer's decision per row id: { on, qty }.
  const [impact, setImpact] = useState(null);
  const [release, setRelease] = useState({});
  const pickedKey = [...picked].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!loadImpact) return undefined;
    if (!picked.size) { setImpact([]); return undefined; }
    let live = true;
    loadImpact([...picked])
      .then(rows => {
        if (!live) return;
        setImpact(rows || []);
        setRelease(current => {
          const next = {};
          for (const row of rows || []) {
            next[row.id] = current[row.id]
              ?? { on: row.selectable ? row.defaultOn !== false : false, qty: row.qty != null ? String(row.qty) : '' };
          }
          return next;
        });
      })
      .catch(() => { if (live) setImpact([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, loadImpact]);
  const rowOn = row => {
    const state = release[row.id];
    if (!row.selectable || !state?.on) return false;
    return row.qty == null || Number(state.qty) > 0;
  };
  const releasing = (impact || []).filter(rowOn);

  const closeSelected = async () => {
    if (!picked.size || !reason.trim()) return;
    setBusy(true);
    try {
      const result = await onCloseLines([...picked], reason.trim(),
        releasing.map(row => (row.qty != null
          ? { id: row.id, qty: Number(release[row.id].qty) }
          : { id: row.id })));
      toast.success(`${picked.size} line${picked.size === 1 ? '' : 's'} closed — no more receipts`
        + (result?.released ? ` · ${result.released} job cover${result.released === 1 ? '' : 's'} released` : '')
        + (result?.released_requirements ? ` · ${result.released_requirements} requirement${result.released_requirements === 1 ? '' : 's'} back to Approved` : ''));
      await onDone?.(); onClose();
    } catch (error) { toast.error(error.message || 'Could not close the selected lines'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Close lines · ${poNumber}`} wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy || !picked.size || !reason.trim()} onClick={closeSelected}>
          <Ban size={14} /> Close {picked.size || ''} line{picked.size === 1 ? '' : 's'}
          {releasing.length > 0 ? ` · release ${releasing.length} job cover${releasing.length === 1 ? '' : 's'}` : ''} — no more receipts
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          {vendorName ? `${vendorName} · ` : ''}Closing a line waives its unreceived balance: it leaves
          Pendency and every on-order figure, and receipts against it are refused. The rest of the
          order stays receivable. A closed line leaves this list — Review &amp; reopen brings it back if the vendor ships anyway.
          {note ? <span className="mt-1 block font-semibold text-slate-600">{note}</span> : null}
        </p>

        {closable.length === 0
          ? <p className="rounded-lg bg-slate-50 py-6 text-center text-sm text-slate-400">Nothing left to close — every line is received or already closed.</p>
          : <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Still receivable</span><span>tick what will not arrive</span></div>
            <div className="space-y-1.5">
              {closable.map(line => (
                <label key={line.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${picked.has(line.id) ? 'border-red-200 bg-red-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                    checked={picked.has(line.id)} onChange={() => toggle(line.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-800">{line.title}</span>
                    {line.sub && <span className="block truncate text-[11px] text-slate-400">{line.sub}</span>}
                  </span>
                  <span className="shrink-0 text-right text-xs tabular-nums">
                    <b className="text-amber-600">{fmt.num(line.pending)}</b>
                    <span className="text-slate-400"> of {fmt.num(line.qty)} {line.unit || unitWord} still due</span>
                    <span className="block text-[10px] text-slate-400">{fmt.num(line.received_qty)} received</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3">
              <Field label="Why is no more expected?" required>
                <Textarea value={reason} onChange={event => setReason(event.target.value)}
                  placeholder="Vendor cannot supply the balance / job cancelled / covered from stock…" />
              </Field>
            </div>
          </section>}

        {/* The approval detail: which JOBS are counting on the board that will
            now never arrive. Each row is the buyer's own call — tick to
            release that job's incoming cover (it re-reads as short and gets
            planned again), edit the quantity for a partial release, untick to
            keep the claim. Purely informative when empty; never a blocker. */}
        {loadImpact && picked.size > 0 && impact !== null && (
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Jobs riding on these lines — plan again</span><span>tick what to release</span></div>
            {impact.length === 0
              ? <p className="rounded-lg bg-slate-50 py-4 text-center text-xs text-slate-400">{impactEmptyText}</p>
              : <div className="space-y-1.5">
                {impact.map(row => {
                  const state = release[row.id] || { on: false, qty: '' };
                  const on = rowOn(row);
                  return (
                    <div key={row.id} className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${on ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'}`}>
                      {row.selectable
                        ? <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600"
                            checked={state.on}
                            onChange={() => setRelease(current => ({ ...current,
                              [row.id]: { on: !state.on, qty: !state.on && row.qty != null && !(Number(state.qty) > 0) ? String(row.qty) : state.qty } }))} />
                        : <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-amber-400/80" title="Released with the close — not optional" />}
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-1.5">
                          <span className="text-sm font-semibold text-slate-800">{row.title}</span>
                          {row.code && <span className="font-mono text-[10px] text-slate-400">{row.code}</span>}
                          {row.order_line_id && <a href={`/planning?line=${row.order_line_id}`} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-[11px] font-bold text-brand-600 hover:underline"
                            onClick={event => event.stopPropagation()}>
                            Open job <ArrowUpRight size={11} />
                          </a>}
                        </span>
                        {row.sub && <span className="block text-[11px] text-slate-400">{row.sub}</span>}
                        {row.message && <span className="mt-0.5 block text-[11px] font-semibold text-amber-700">{row.message}</span>}
                        {!row.message && on && row.qty != null && <span className="mt-0.5 block text-[11px] font-semibold text-amber-700">
                          Re-reads as short once released — plan this job again.
                        </span>}
                      </span>
                      {row.qty != null && (
                        <span className="shrink-0 text-right">
                          <span className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">Release / {fmt.num(row.qty)}</span>
                          <input type="number" min="0" max={row.qty} value={state.qty}
                            onChange={event => setRelease(current => ({ ...current, [row.id]: { ...state, on: true, qty: event.target.value } }))}
                            className="mt-0.5 w-24 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-amber-400" />
                          <span className="block text-[10px] text-slate-400">sheets incoming</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>}
          </section>
        )}

        {/* Already-closed lines are counted, not listed — they are decided. The
            way back is the reopen form, which names each line and asks why.
            It portals over this modal, so it can live in its children. */}
        {closed.length > 0 && onReopenLines && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="text-xs text-slate-500">
              <b className="text-slate-700">{closed.length}</b> line{closed.length === 1 ? '' : 's'} on this order already closed short — kept out of this list.
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReopening(true)}>
              <RotateCcw size={12} /> Review &amp; reopen…
            </Button>
          </div>
        )}
        {reopening && <ReopenPoLinesModal layer="nested" preselected={false} unitWord={unitWord} note={reopenNote}
          lines={closed.map(line => ({ ...line, po_number: poNumber, waived: Math.max(0, line.qty - line.received_qty) }))}
          onReopen={onReopenLines}
          onDone={async () => { await onDone?.(); onClose(); }}
          onClose={() => setReopening(false)} />}
      </div>
    </Modal>
  );
}
