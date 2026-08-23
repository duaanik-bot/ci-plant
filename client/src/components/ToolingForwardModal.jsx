import { useEffect, useState } from 'react';
import { CheckCircle2, Layers3, Loader2, Minus, Plus, Printer, Square, Stamp } from 'lucide-react';
import { api } from '../api.js';
import { Button, Checkbox, Input, Modal, useToast } from './ui.jsx';
import { DRIPOFF_LABEL, isDripOff } from '../lib/plateInks.js';

const FAMILY_UI = {
  plate: { label: 'Plates', icon: Printer, tone: 'bg-sky-50 text-sky-700' },
  die: { label: 'Dies', icon: Square, tone: 'bg-rose-50 text-rose-700' },
  block: { label: 'Blocks', icon: Stamp, tone: 'bg-amber-50 text-amber-700' },
  shade_card: { label: 'Shade Cards', icon: Layers3, tone: 'bg-emerald-50 text-emerald-700' },
};

// One plate line in the fire dialog: what it is, and how many of it.
//
// A stepper rather than a tick, because the answer is not always one — a job may
// run two blacks — and 0 is how a colour is dropped. The same shape the Plate PR
// form uses, in a smaller frame.
function PlateQty({ row, onChange }) {
  const qty = Math.max(0, Number(row.qty) || 0);
  return (
    <div className="flex h-8 w-[104px] shrink-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button type="button" aria-label={`Fewer ${row.component_label}`} disabled={qty === 0}
        onClick={() => onChange(Math.max(0, qty - 1))}
        className="flex h-full w-7 shrink-0 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-30">
        <Minus size={12} />
      </button>
      <Input type="number" min="0" max="99" value={qty} aria-label={`${row.component_label} quantity`}
        onChange={e => onChange(Math.max(0, Math.min(99, Math.trunc(Number(e.target.value) || 0))))}
        className="h-full min-w-0 flex-1 rounded-none border-0 px-1 text-center text-xs tabular-nums shadow-none" />
      <button type="button" aria-label={`More ${row.component_label}`} disabled={qty >= 99}
        onClick={() => onChange(Math.min(99, qty + 1))}
        className="flex h-full w-7 shrink-0 items-center justify-center text-blue-600 hover:bg-blue-50 disabled:opacity-30">
        <Plus size={12} />
      </button>
    </div>
  );
}

export default function ToolingForwardModal({ jobCard, onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  // The colours this fire will raise, per target. Seeded from the product
  // master's own build (the server's plate_plan) and editable before anything
  // is created — the plant, not the master, has the last word on what goes on
  // a plate order.
  const [plateSel, setPlateSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!jobCard?.id) return;
    let live = true;
    setPreview(null);
    setError('');
    api.get(`/job-cards/${jobCard.id}/tooling-preview`).then(data => {
      if (!live) return;
      setPreview(data);
      setSelected(data.defaults || []);
      setPlateSel(Object.fromEntries((data.plate_plan || []).map(target => [
        target.key,
        target.requests.flatMap(request => request.components.map(row => ({
          component_type: row.component_type,
          component_label: row.component_label,
          pantone_code: row.pantone_code || null,
          qty: Number(row.qty) || 0,
        }))),
      ])));
    }).catch(e => { if (live) setError(e.message || 'Could not inspect this Job Card'); });
    return () => { live = false; };
  }, [jobCard?.id]);

  const toggle = family => setSelected(current => current.includes(family)
    ? current.filter(x => x !== family)
    : [...current, family]);

  const submit = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const result = await api.post(`/job-cards/${jobCard.id}/tooling-requirements`, {
        families: selected,
        // Only when plates are actually being sent. Omitted, the server falls
        // back to the product master's build, which is what it always did.
        ...(selected.includes('plate') ? { plate_components: plateSel } : {}),
      });
      const created = result.created?.length || 0;
      const existing = result.existing?.length || 0;
      toast.success(created
        ? `${created} tooling requirement${created === 1 ? '' : 's'} sent`
        : existing ? 'Tooling requirements were already in the queues' : 'Tooling Hub updated');
      onDone?.(result);
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!jobCard} onClose={onClose}
      title={jobCard ? `Send tooling requirements — ${jobCard.jc_number}` : 'Send tooling requirements'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Not now</Button>
        <Button onClick={submit} disabled={busy || !preview || !selected.length}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          Send selected
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="ci-summary-panel text-sm text-slate-600">
          <b className="text-slate-900">This Job Card is ready for Print Planning.</b>
          <span className="mt-1 block">Would you also like to send the required tooling requests?</span>
        </div>

        {!preview && !error && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Reading the production route…
          </div>
        )}
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {preview && (
          <>
            {preview.targets?.length > 1 && (
              <p className="text-xs font-medium text-violet-700">
                This run contains {preview.targets.length} products. One requirement will be created per product in each selected module.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {preview.options.map(option => {
                const meta = FAMILY_UI[option.family];
                const Icon = meta.icon;
                const active = selected.includes(option.family);
                return (
                  <div key={option.family} role="button" tabIndex={0}
                    onClick={() => toggle(option.family)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(option.family); } }}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${active ? 'border-brand-200 bg-brand-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.tone}`}><Icon size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-slate-900">{meta.label}</span>
                        <span onClick={e => e.stopPropagation()}>
                          <Checkbox checked={active} onChange={() => toggle(option.family)} aria-label={meta.label} />
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-500">{option.reason}</span>
                      {option.existing > 0 && (
                        <span className="mt-1 block text-[11px] font-semibold text-emerald-700">
                          {option.existing} already sent
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {/* ── Which colours, before anything is raised ──────────────────
                The Job Card route decides WHICH modules to send; this decides
                what the plate order actually contains. It is grouped by the PR
                each part becomes, because a drip-off carton raises TWO — the ink
                set and the mask are bought, approved and consumed on different
                clocks, and seeing that before firing is the point of showing it
                here rather than after. */}
            {selected.includes('plate') && (preview.plate_plan || []).map(target => {
              const rows = plateSel[target.key] || [];
              const setQty = (index, qty) => setPlateSel(current => ({
                ...current,
                [target.key]: (current[target.key] || []).map((row, i) => (i === index ? { ...row, qty } : row)),
              }));
              const inkCount = rows.filter(row => !isDripOff(row)).reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
              const dripCount = rows.filter(isDripOff).reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
              const prCount = (inkCount > 0 ? 1 : 0) + (dripCount > 0 ? 1 : 0);
              const group = (title, hint, predicate, tone) => {
                const entries = rows.map((row, index) => ({ row, index })).filter(({ row }) => predicate(row));
                if (!entries.length) return null;
                return (
                  <div className="border-t border-slate-100 pt-2 first:border-0 first:pt-0">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className={`text-[10px] font-bold uppercase tracking-wide ${tone}`}>{title}</span>
                      <span className="text-[10px] text-slate-400">{hint}</span>
                    </div>
                    {entries.map(({ row, index }) => (
                      <div key={`${row.component_type}-${row.pantone_code || ''}-${index}`}
                        className="flex items-center justify-between gap-3 py-1">
                        <span className={`min-w-0 truncate text-xs font-semibold ${Number(row.qty) > 0 ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                          {row.component_label}
                        </span>
                        <PlateQty row={row} onChange={qty => setQty(index, qty)} />
                      </div>
                    ))}
                  </div>
                );
              };
              return (
                <div key={target.key} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <b className="text-sm text-slate-900">{target.label}</b>
                    <span className="text-[11px] font-semibold text-slate-500">
                      {prCount === 0
                        ? 'No plates — nothing will be raised'
                        : `${prCount} Plate PR${prCount === 1 ? '' : 's'} · ${inkCount + dripCount} plate${inkCount + dripCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {group('Ink plates', target.plate_size || 'requirement size', row => !isDripOff(row), 'text-slate-500')}
                    {group(DRIPOFF_LABEL, 'own PR · 560 x 670 · single use',
                      isDripOff, 'text-teal-700')}
                  </div>
                  {dripCount > 0 && inkCount > 0 && (
                    <p className="mt-2 text-[11px] text-teal-700">
                      The {DRIPOFF_LABEL} plate is raised as its own Plate PR — it is issued at coating, not printing, and never returns to the rack.
                    </p>
                  )}
                </div>
              );
            })}
            <p className="text-[11px] text-slate-400">
              The selections are suggested from the Job Card route. You can override every checkbox before sending.
              Colours default to the Product Master and stay editable on the Plate PR afterwards.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
