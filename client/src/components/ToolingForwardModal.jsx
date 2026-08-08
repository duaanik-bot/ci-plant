import { useEffect, useState } from 'react';
import { CheckCircle2, Layers3, Loader2, Printer, Square, Stamp } from 'lucide-react';
import { api } from '../api.js';
import { Button, Checkbox, Modal, useToast } from './ui.jsx';

const FAMILY_UI = {
  plate: { label: 'Plates', icon: Printer, tone: 'bg-sky-50 text-sky-700' },
  die: { label: 'Dies', icon: Square, tone: 'bg-rose-50 text-rose-700' },
  block: { label: 'Blocks', icon: Stamp, tone: 'bg-amber-50 text-amber-700' },
  shade_card: { label: 'Shade Cards', icon: Layers3, tone: 'bg-emerald-50 text-emerald-700' },
};

export default function ToolingForwardModal({ jobCard, onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
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
      const result = await api.post(`/job-cards/${jobCard.id}/tooling-requirements`, { families: selected });
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
            <p className="text-[11px] text-slate-400">
              The selections are suggested from the Job Card route. You can override every checkbox before sending.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
