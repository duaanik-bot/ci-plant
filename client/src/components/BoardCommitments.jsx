// The one place that explains a board: what the warehouse has, how much of it is
// held for named jobs, and which jobs are waiting. Opened from a Procurement PR
// row today; the Planning Engine and Masters 360 will share it next.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Select, useToast } from './ui.jsx';

function Tile({ label, value, accent = 'text-slate-900' }) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

export default function BoardCommitments({ open, onClose, materialId, prContext = null, onChanged }) {
  const [data, setData] = useState(null);
  const [move, setMove] = useState(null);       // { line, qty, reason }
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [repoint, setRepoint] = useState(null);   // { line_id, reason }
  const toast = useToast();

  const load = async () => {
    if (!materialId) return;
    try { setData(await api.get(`/board/${materialId}/panel`)); }
    catch { toast.error('Could not load the board position'); }
  };
  useEffect(() => { if (open) { setData(null); setMove(null); setPreview(null); load(); } }, [open, materialId]);

  const targetLineId = prContext?.order_line_id || null;
  const target = data?.lines.find(l => l.id === targetLineId) || null;

  // Re-preview whenever the quantity or the chosen row changes.
  useEffect(() => {
    if (!move || !target) { setPreview(null); return; }
    const qty = +String(move.qty).replace(/,/g, '');
    if (!(qty > 0)) { setPreview(null); return; }
    let cancelled = false;
    api.post('/board/move/preview', {
      material_id: materialId,
      from_order_line_id: move.line.id,
      to_order_line_id: target.id,
      qty,
    }).then(p => { if (!cancelled) setPreview(p); }).catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [move?.line?.id, move?.qty, target?.id, materialId]);

  const doMove = async () => {
    setBusy(true);
    try {
      const out = await api.post('/board/move', {
        material_id: materialId,
        from_order_line_id: move.line.id,
        to_order_line_id: target.id,
        qty: +String(move.qty).replace(/,/g, ''),
        reason: move.reason.trim(),
      });
      const newPr = out.raised?.[0];
      toast.success(newPr
        ? `Board moved — ${newPr.pr_number} raised for ${move.line.product_name}`
        : 'Board moved');
      setMove(null); setPreview(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e.data?.blockers?.[0] || e.message);
    } finally { setBusy(false); }
  };

  const doRepoint = async () => {
    setBusy(true);
    try {
      await api.post(`/requisitions/${prContext.id}/reassign`, {
        order_line_id: +repoint.line_id,
        reason: repoint.reason.trim(),
      });
      const picked = data.lines.find(l => l.id === +repoint.line_id);
      toast.success(`${prContext.pr_number} now buys for ${picked?.product_name || 'that job'}`);
      setRepoint(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} wide title={data?.board?.name || 'Board position'}>
        {!data ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2.5">
              <Tile label="In warehouse" value={fmt.num(data.available)} />
              {/* Same word as the PR register's board line — this panel is what
                  that line opens, and one figure must not have two names. */}
              <Tile label="Reserved" value={fmt.num(data.held)}
                accent={data.held > 0 ? 'text-amber-600' : 'text-slate-900'} />
              <Tile label="Free" value={fmt.num(data.free)}
                accent={data.free > 0 ? 'text-emerald-600' : 'text-red-600'} />
            </div>

            {prContext && (
              <div className="rounded-xl border border-brand-200 bg-brand-50/70 px-3.5 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-500">
                  {prContext.pr_number} is buying for
                </div>
                {target ? (
                  <>
                    <div className="mt-1 text-sm font-semibold text-brand-800">{target.product_name}</div>
                    <div className="text-xs text-brand-600">
                      PO {target.po_number} · needs {fmt.num(target.need)} · from stock {fmt.num(target.held)} · buying {fmt.num(target.incoming)}
                    </div>
                  </>
                ) : (
                  <p className="mt-1 flex items-start gap-2 text-xs font-semibold text-amber-700">
                    <AlertTriangle size={14} className="mt-px shrink-0" />
                    This requisition was raised before jobs were linked to PRs, so it does not name a job yet.
                  </p>
                )}
                {prContext.id && (
                  <button type="button"
                    onClick={() => setRepoint({ line_id: target?.id ? String(target.id) : '', reason: '' })}
                    className="mt-1.5 text-[11px] font-semibold text-brand-600 underline">
                    {target ? 'Change which job this PR is for' : 'Which job is this PR for?'}
                  </button>
                )}
              </div>
            )}

            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                The board in the warehouse is committed to
              </div>
              {data.lines.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
                  Nothing is planned on this board — all {fmt.num(data.available)} sheets are free.
                </p>
              ) : data.lines.map(l => (
                <div key={l.id} className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-800">
                      {l.product_name}
                      {l.gang_run_id && (
                        <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                          {l.gang_number || `gang #${l.gang_run_id}`}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-slate-400">
                      PO {l.po_number} · {l.customer_name}
                      {l.planned_date ? ` · planned ${fmt.date(l.planned_date)}` : ''}
                      {/* Listed so the board's holders are complete, marked so
                          nobody expects to be able to take it back off them. */}
                      {l.can_give_up === false && ' · on the floor'}
                    </div>
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums text-slate-700">
                    {fmt.num(l.need)}
                    {l.held > 0 && <div className="text-[11px] font-normal text-amber-600">{fmt.num(l.held)} held</div>}
                  </div>
                  {target && l.id !== target.id && (
                    <Button size="sm" variant="secondary"
                      disabled={!!l.gang_run_id || l.can_give_up === false}
                      title={l.gang_run_id
                        ? `Prints in gang ${l.gang_number || `#${l.gang_run_id}`} — move the gang's board from Planning`
                        : l.can_give_up === false
                          ? 'Already in production — its board cannot be moved'
                          : ''}
                      onClick={() => setMove({
                        line: l,
                        qty: String(Math.max(0, Math.min(l.movable ?? 0, target.holdable ?? 0))),
                        reason: '',
                      })}>
                      Move to this PR
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!move} onClose={() => { setMove(null); setPreview(null); }}
        title={target ? `Move board to ${target.product_name}` : 'Move board'}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setMove(null); setPreview(null); }}>Cancel</Button>
            <Button disabled={busy || !preview?.ok || !move?.reason.trim()} onClick={doMove}>
              {busy ? 'Moving…' : 'Move the board'}
            </Button>
          </>
        }>
        {move && (
          <div className="space-y-3.5">
            <p className="text-sm text-slate-500">
              Taking it away from <b className="text-slate-700">{move.line.product_name}</b>
            </p>

            <Field label="Sheets to move">
              <Input className="tabular-nums" value={move.qty}
                onChange={e => setMove({ ...move, qty: e.target.value })} />
            </Field>
            <p className="-mt-2 text-[11px] text-slate-400">
              All {fmt.num(move.line.movable)} of {move.line.product_name}'s board. Type less to split it.
            </p>

            {preview && (
              <div className={`rounded-xl px-3.5 py-3 ${preview.ok ? 'bg-slate-50' : 'bg-red-50'}`}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {preview.ok ? 'What will happen' : 'This move is not possible'}
                </div>
                {preview.ok ? (
                  <>
                    <ul className="space-y-1 text-sm text-slate-700">
                      {preview.effects.map((e, i) => <li key={i}>{e.text}</li>)}
                    </ul>
                    <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
                      Nothing extra is bought. Board on order stays the same.
                    </p>
                  </>
                ) : (
                  <ul className="space-y-1 text-sm font-semibold text-red-700">
                    {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                )}
              </div>
            )}

            <Field label="Why are you moving it?">
              <Input placeholder="Dispatch pulled forward"
                value={move.reason} onChange={e => setMove({ ...move, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={!!repoint} onClose={() => setRepoint(null)}
        title={`Which job is ${prContext?.pr_number || 'this PR'} buying for?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRepoint(null)}>Cancel</Button>
            <Button disabled={busy || !repoint?.line_id || !repoint?.reason.trim()} onClick={doRepoint}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }>
        {repoint && (
          <div className="space-y-3.5">
            <Field label="Job">
              <Select value={repoint.line_id}
                onChange={e => setRepoint({ ...repoint, line_id: e.target.value })}>
                <option value="">Pick a job…</option>
                {data.lines.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.product_name} — PO {l.po_number} ({fmt.num(l.need)} sheets)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Why?">
              <Input placeholder="Raised before jobs were linked to PRs"
                value={repoint.reason}
                onChange={e => setRepoint({ ...repoint, reason: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
              The incoming sheets will count as coverage for the job you pick, and stop counting for the one it was on.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
