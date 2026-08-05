// The mill sent a different GSM. Received inside the Create GRN modal, as a
// panel under the PO line it belongs to — the storekeeper never leaves the
// receipt to fix it.
//
// Every figure and every consequence rendered here comes from
// /grns/substitution-preview, which builds them with the SAME pure planner the
// commit runs. Nothing is computed locally, so the list approved cannot differ
// from the list executed.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, SearchableSelect, useToast } from './ui.jsx';
import { AlertTriangle, ArrowRight, Lock } from 'lucide-react';

const sheets = n => `${fmt.num(n)} sheets`;
const pkt = n => (n == null ? null : `${fmt.num(Math.round(n * 100) / 100)} pkt`);
const money = n => (n == null ? '—' : `₹${fmt.num(Math.round(n * 100) / 100)}`);

export default function GrnSubstitutionPanel({ line, meta = {}, onCancel, onDone }) {
  const toast = useToast();
  const [candidates, setCandidates] = useState([]);
  const [materialId, setMaterialId] = useState('');
  const [qty, setQty] = useState(String(line.qty - line.received_qty || ''));
  const [batchNo, setBatchNo] = useState('');
  const [picks, setPicks] = useState(null);   // null = not yet seeded from the preview
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/grns/substitution-candidates?po_line_id=${line.id}`)
      .then(r => setCandidates(r.candidates || []))
      .catch(() => setCandidates([]));
  }, [line.id]);

  const load = useCallback(async () => {
    if (!materialId || !(+qty > 0)) { setPreview(null); return; }
    const qs = new URLSearchParams({
      po_line_id: line.id, material_id: materialId, qty,
      picks: (picks || []).join(','),
    });
    try { setPreview(await api.get(`/grns/substitution-preview?${qs}`)); }
    catch (e) { setPreview(null); toast.error(e.message || 'Could not read the substitution'); }
  }, [line.id, materialId, qty, picks, toast]);

  useEffect(() => { load(); }, [load]);

  // Jobs this PO was actually buying for start ticked; everything else is
  // offered but never assumed. Seeded once, then the storekeeper owns it.
  useEffect(() => {
    if (picks !== null || !preview?.claims) return;
    setPicks(preview.claims.filter(c => c.bought && c.eligible).map(c => c.id));
  }, [preview, picks]);

  const toggle = id => setPicks(p => (p || []).includes(id)
    ? (p || []).filter(x => x !== id)
    : [...(p || []), id]);

  const { ordered, received, blockers = [], balance } = preview || {};
  const claims = preview?.claims || [];
  const bought = claims.filter(c => c.bought);
  const others = claims.filter(c => !c.bought);
  const rateDelta = ordered?.rate != null && received?.rate != null
    ? (received.rate - ordered.rate) * (+qty || 0) : null;

  const submit = async () => {
    setBusy(true);
    try {
      const out = await api.post('/grns/substitute', {
        po_line_id: line.id, material_id: +materialId, qty: +qty,
        picks: picks || [], batch_no: batchNo || undefined, ...meta,
      });
      const moved = out.effects.filter(e => e.kind === 'reboard').length;
      const freed = out.effects.filter(e => e.kind === 'alloc_release').length;
      toast.success(`Received as ${received?.name || 'the board that arrived'}`
        + (moved ? ` — ${moved} job${moved > 1 ? 's' : ''} moved onto it` : '')
        + (freed ? `, ${freed} back to short` : ''));
      onDone?.();
    } catch (e) { toast.error(e.message || 'Could not record the substitution'); }
    finally { setBusy(false); }
  };

  // Checkbox from ui.jsx renders its OWN <label>; nesting it inside this row's
  // label is invalid markup and the click toggles twice. Raw input here.
  const Row = c => (
    <label key={c.id}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${
        c.eligible ? 'cursor-pointer hover:bg-white' : 'cursor-not-allowed opacity-55'}`}>
      {c.eligible
        ? <input type="checkbox" checked={(picks || []).includes(c.id)} onChange={() => toggle(c.id)}
            className="h-4 w-4 shrink-0 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30" />
        : <Lock size={13} className="shrink-0 text-gray-400" />}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{c.product_name}</span>
        {c.customer_name && <span className="text-gray-500"> · {c.customer_name}</span>}
        {c.gang_number && <span className="text-gray-400"> · {c.gang_number}</span>}
      </span>
      <span className="shrink-0 tabular-nums text-gray-500">{fmt.num(c.parent_sheets_required)}</span>
      {!c.eligible && <span className="shrink-0 text-[11px] text-gray-500">{c.reason}</span>}
    </label>
  );

  return (
    <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <div className="flex items-start gap-2 text-xs text-amber-800">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <p>
          Receiving a different board against <span className="font-semibold">{line.material_name}</span>.
          Only the same grade and sheet size at another GSM can be received here — a different
          grade or size changes the cut plan and belongs in Planning.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Board actually received" required>
          <SearchableSelect value={materialId} onChange={e => setMaterialId(e.target.value)}
            placeholder={candidates.length ? 'Pick the board that arrived…' : 'No other GSM on file for this board'}
            options={candidates.map(c => ({ value: String(c.id), label: `${c.name}${c.code ? ` · ${c.code}` : ''}` }))} />
        </Field>
        <Field label="Quantity received" required
          hint={received ? pkt(received.packets) : 'in sheets'}>
          <Input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} />
        </Field>
        <Field label="Batch No"><Input value={batchNo} placeholder="auto if blank"
          onChange={e => setBatchNo(e.target.value)} /></Field>
      </div>

      {preview && received && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white px-3 py-2 text-sm">
            <span className="text-gray-500">{ordered.name}</span>
            <span className="tabular-nums text-gray-500">{sheets(ordered.qty ?? preview.po_line.qty)}</span>
            <ArrowRight size={14} className="text-gray-400" />
            <span className="font-semibold">{received.name}</span>
            <span className="tabular-nums font-semibold">{sheets(qty)}</span>
            {received.packets != null && <span className="text-gray-500">({pkt(received.packets)})</span>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-gray-600">
            <span>Rate {money(ordered.rate)}/sh → {money(received.rate)}/sh</span>
            {rateDelta != null && (
              <span className={rateDelta < 0 ? 'text-emerald-700' : 'text-amber-700'}>
                {rateDelta < 0 ? 'Worth' : 'Worth'} {money(Math.abs(rateDelta))} {rateDelta < 0 ? 'less' : 'more'} than the PO says — settle it on the invoice
              </span>
            )}
            {balance && (
              <span className={balance.closes ? 'text-gray-600' : 'text-amber-700'}>
                {balance.closes ? 'Settles the PO line' : `${sheets(balance.remaining)} still due on the PO line`}
              </span>
            )}
          </div>

          {bought.length > 0 && (
            <div className="rounded-lg bg-white/70 p-1.5">
              <p className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Bought for these jobs
              </p>
              {bought.map(Row)}
            </div>
          )}

          {others.length > 0 && (
            <div className="rounded-lg bg-white/70 p-1.5">
              <p className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Other jobs waiting on {ordered.name}
              </p>
              {others.map(Row)}
            </div>
          )}

          {balance?.closes && bought.some(c => !(picks || []).includes(c.id)) && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
              The jobs left unticked above go back to reading <span className="font-semibold">short</span> —
              this receipt settles the PO line, so the board they were waiting for is no longer coming.
            </p>
          )}

          {blockers.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
        </>
      )}

      <div className="flex justify-end gap-2 pt-0.5">
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={submit}
          disabled={busy || !preview?.ok}>
          {busy ? 'Receiving…' : 'Receive this board'}
        </Button>
      </div>
    </div>
  );
}
