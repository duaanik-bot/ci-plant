import { useMemo, useState } from 'react';
import { ArrowLeftRight, CornerDownLeft, GitBranch, Send, Undo2 } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { ActionMenu, Button, Checkbox, Modal, useToast } from './ui.jsx';

function canPlan() {
  return ['admin', 'planner'].includes(auth.user?.role);
}

function pendingOnly(jobCard) {
  return !jobCard || (jobCard.stages || []).every(s => s.status === 'pending');
}

function OptionCard({ active, icon: Icon, title, text, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-all ${
        active
          ? 'border-indigo-200 bg-indigo-50 text-indigo-900 shadow-[0_8px_20px_rgba(79,70,229,0.10)]'
          : 'border-white/70 bg-white/65 backdrop-blur-xl text-slate-700 hover:border-indigo-100 hover:bg-indigo-50/40'
      }`}
    >
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${active ? 'bg-white text-indigo-700' : 'bg-slate-50 text-slate-500'}`}>
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{text}</span>
      </span>
    </button>
  );
}

function WorkflowDecisionModal({
  mode,
  label,
  busy,
  destinations,
  setDestinations,
  reverseTarget,
  setReverseTarget,
  clearArtwork,
  setClearArtwork,
  canReverseJob = true,
  onClose,
  onConfirm,
  bulkCount = 1,
}) {
  const toggleDestination = key => {
    setDestinations(current => {
      const next = current.includes(key) ? current.filter(x => x !== key) : [...current, key];
      return next.length ? next : [key];
    });
  };

  return (
    <Modal
      open={!!mode}
      onClose={onClose}
      title={mode === 'reverseJob' || mode === 'reversePlanning' ? `Reverse workflow — ${label}` : `Push workflow — ${label}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          variant={mode?.includes('reverse') ? 'secondary' : 'primary'}
          disabled={busy || (mode === 'reverseJob' && !canReverseJob)}
          onClick={onConfirm}
        >
          {mode?.includes('reverse') ? 'Confirm Reverse' : 'Confirm Push'}
        </Button>
      </>}
    >
      {mode === 'artwork' && (
        <div className="space-y-3">
          <div className="ci-summary-panel">
            <b>{label}</b> will be made available in the Artwork queue. Planning details stay intact.
          </div>
        </div>
      )}

      {mode === 'reversePlanning' && (
        <div className="space-y-3">
          <div className="ci-summary-panel">
            Move {bulkCount > 1 ? `${bulkCount} selected products` : 'this product'} back to Planning so you can rework machine, dates, material, tooling, or product spec.
          </div>
          <Checkbox
            label="Clear artwork approvals and unlock artwork"
            checked={clearArtwork}
            onChange={e => setClearArtwork(e.target.checked)}
          />
        </div>
      )}

      {mode === 'jobcard' && (
        <div className="space-y-3">
          <div className="ci-summary-panel">
            Create or route {bulkCount > 1 ? `${bulkCount} job cards` : 'the job card'}, then choose where work should appear operationally.
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <OptionCard
              active={destinations.includes('print_planning') && destinations.includes('cutting')}
              icon={GitBranch}
              title="Both"
              text="Show in Print Planning and keep it ready for Cutting."
              onClick={() => setDestinations(['print_planning', 'cutting'])}
            />
            <OptionCard
              active={destinations.includes('cutting') && !destinations.includes('print_planning')}
              icon={Send}
              title="Only Cutting"
              text="Send directly to the Cutting queue."
              onClick={() => setDestinations(['cutting'])}
            />
            <OptionCard
              active={destinations.includes('print_planning') && !destinations.includes('cutting')}
              icon={ArrowLeftRight}
              title="Only Print Planning"
              text="Keep it in planning control for press sequencing."
              onClick={() => setDestinations(['print_planning'])}
            />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            <Checkbox label="Print Planning" checked={destinations.includes('print_planning')} onChange={() => toggleDestination('print_planning')} />
            <Checkbox label="Cutting" checked={destinations.includes('cutting')} onChange={() => toggleDestination('cutting')} />
          </div>
        </div>
      )}

      {mode === 'reverseJob' && (
        <div className="space-y-3">
          {!canReverseJob && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              This job card cannot be reversed because at least one stage has started, completed, or been put on hold.
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <OptionCard
              active={reverseTarget === 'planning'}
              icon={Undo2}
              title="Back to Planning"
              text="Delete the unstarted job card and clear artwork approvals."
              onClick={() => setReverseTarget('planning')}
            />
            <OptionCard
              active={reverseTarget === 'artwork'}
              icon={CornerDownLeft}
              title="Back to Artwork"
              text="Delete the unstarted job card but keep artwork approvals."
              onClick={() => setReverseTarget('artwork')}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function WorkflowControls({ line, jobCard, context = 'line', onDone, asMenu = false, extraItems = [] }) {
  const toast = useToast();
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [destinations, setDestinations] = useState(['cutting']);
  const [reverseTarget, setReverseTarget] = useState('planning');
  const [clearArtwork, setClearArtwork] = useState(true);

  const lineId = line?.id || jobCard?.order_line_id;
  const label = line?.product_name || jobCard?.product_name || 'this product';
  const roleAllowed = canPlan();
  const canReverseJob = pendingOnly(jobCard);

  const actions = useMemo(() => {
    if (!roleAllowed || !lineId) return [];
    if (context === 'planning') {
      return [
        { key: 'artwork', label: 'To AW', title: 'Push to Artwork', icon: Send, show: ['pending', 'planned', 'ready'].includes(line?.status) },
        { key: 'jobcard', label: 'To JC', title: 'Push to Job Card', icon: GitBranch, show: ['planned', 'ready'].includes(line?.status) },
      ].filter(a => a.show);
    }
    if (context === 'artwork') {
      return [
        { key: 'reversePlanning', label: 'Back', title: 'Back to Planning', icon: Undo2, show: ['planned', 'ready'].includes(line?.status) },
        { key: 'jobcard', label: 'To JC', title: 'Push to Job Card', icon: GitBranch, show: line?.artwork_locked || line?.status === 'ready' },
      ].filter(a => a.show);
    }
    if (context === 'jobcard') {
      return [
        { key: 'jobcard', label: 'Route', title: 'Route Job Card', icon: ArrowLeftRight, show: jobCard?.status !== 'closed' },
        { key: 'reverseJob', label: 'Reverse', icon: CornerDownLeft, show: jobCard?.status !== 'closed' },
      ].filter(a => a.show);
    }
    return [];
  }, [context, jobCard?.status, line?.artwork_locked, line?.status, lineId, roleAllowed]);

  if (!actions.length && !(asMenu && extraItems.length)) return null;

  const run = async () => {
    setBusy(true);
    try {
      if (mode === 'artwork') {
        await api.post(`/workflow/order-lines/${lineId}`, { action: 'push_to_artwork' });
        toast.success(`${label} pushed to Artwork`);
      }
      if (mode === 'reversePlanning') {
        await api.post(`/workflow/order-lines/${lineId}`, {
          action: 'reverse_to_planning',
          clear_artwork: clearArtwork,
        });
        toast.success(`${label} moved back to Planning`);
      }
      if (mode === 'jobcard') {
        await api.post(`/workflow/order-lines/${lineId}`, {
          action: 'push_to_job_card',
          destinations,
        });
        toast.success(`${label} routed to ${destinations.includes('print_planning') && destinations.includes('cutting') ? 'Print Planning and Cutting' : destinations.includes('print_planning') ? 'Print Planning' : 'Cutting'}`);
      }
      if (mode === 'reverseJob') {
        await api.post(`/workflow/order-lines/${lineId}`, {
          action: 'reverse_job_card',
          target: reverseTarget,
        });
        toast.success(`${label} reversed to ${fmt.title(reverseTarget)}`);
      }
      setMode(null);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  if (asMenu) {
    return (
      <>
        <span onClick={e => e.stopPropagation()}>
          <ActionMenu items={[
            ...extraItems,
            ...actions.map(a => ({ key: a.key, label: a.title || a.label, icon: a.icon, onClick: () => setMode(a.key) })),
          ]} />
        </span>
        <WorkflowDecisionModal
          mode={mode}
          label={label}
          busy={busy}
          destinations={destinations}
          setDestinations={setDestinations}
          reverseTarget={reverseTarget}
          setReverseTarget={setReverseTarget}
          clearArtwork={clearArtwork}
          setClearArtwork={setClearArtwork}
          canReverseJob={canReverseJob}
          onClose={() => setMode(null)}
          onConfirm={run}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap justify-end gap-1.5" onClick={e => e.stopPropagation()}>
        {actions.map(action => {
          const Icon = action.icon;
          return (
            <Button
              key={action.key}
              size="sm"
              title={action.title || action.label}
              variant="ghost"
              className={`min-h-0 rounded-lg border px-1.5 py-0.5 text-[10px] shadow-none ${
                action.key.includes('reverse')
                  ? 'border-white/70 bg-white/65 backdrop-blur-xl text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                  : 'border-[#D7E0EC] bg-white text-[#596E64] hover:border-[#BFCBC4] hover:bg-[#F5F8F6] hover:text-[#31443D]'
              }`}
              onClick={() => setMode(action.key)}
            >
              <Icon size={10} /> {action.label}
            </Button>
          );
        })}
      </div>

      <WorkflowDecisionModal
        mode={mode}
        label={label}
        busy={busy}
        destinations={destinations}
        setDestinations={setDestinations}
        reverseTarget={reverseTarget}
        setReverseTarget={setReverseTarget}
        clearArtwork={clearArtwork}
        setClearArtwork={setClearArtwork}
        canReverseJob={canReverseJob}
        onClose={() => setMode(null)}
        onConfirm={run}
      />
    </>
  );
}

export function BulkWorkflowControls({ lines, context, onDone, onClear }) {
  const toast = useToast();
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [destinations, setDestinations] = useState(['cutting']);
  const [reverseTarget, setReverseTarget] = useState('planning');
  const [clearArtwork, setClearArtwork] = useState(true);
  const selected = lines || [];

  if (!canPlan() || selected.length === 0) return null;

  const run = async () => {
    setBusy(true);
    try {
      for (const line of selected) {
        if (mode === 'artwork') await api.post(`/workflow/order-lines/${line.id}`, { action: 'push_to_artwork' });
        if (mode === 'reversePlanning') {
          await api.post(`/workflow/order-lines/${line.id}`, { action: 'reverse_to_planning', clear_artwork: clearArtwork });
        }
        if (mode === 'jobcard') {
          await api.post(`/workflow/order-lines/${line.id}`, { action: 'push_to_job_card', destinations });
        }
      }
      toast.success(`${selected.length} product${selected.length === 1 ? '' : 's'} updated`);
      setMode(null);
      onClear?.();
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const canSendArtwork = context === 'planning' && selected.every(l => ['pending', 'planned', 'ready'].includes(l.status));
  const canSendJob = selected.every(l => ['planned', 'ready'].includes(l.status) || l.artwork_locked);
  const canReverse = context === 'artwork' && selected.every(l => ['planned', 'ready'].includes(l.status));

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-3 py-2 shadow-[0_8px_20px_rgba(79,70,229,0.08)]">
      <div className="text-sm font-bold text-indigo-900">{selected.length} selected</div>
      <div className="flex flex-wrap gap-1.5">
        {canSendArtwork && <Button size="sm" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('artwork')}><Send size={12} /> To AW</Button>}
        {canSendJob && <Button size="sm" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('jobcard')}><GitBranch size={12} /> To JC</Button>}
        {canReverse && <Button size="sm" variant="secondary" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('reversePlanning')}><Undo2 size={12} /> Back</Button>}
        <Button size="sm" variant="ghost" className="rounded-xl px-2 py-1 text-[11px]" onClick={onClear}>Clear</Button>
      </div>
      <WorkflowDecisionModal
        mode={mode}
        label={`${selected.length} selected products`}
        busy={busy}
        destinations={destinations}
        setDestinations={setDestinations}
        reverseTarget={reverseTarget}
        setReverseTarget={setReverseTarget}
        clearArtwork={clearArtwork}
        setClearArtwork={setClearArtwork}
        onClose={() => setMode(null)}
        onConfirm={run}
        bulkCount={selected.length}
      />
    </div>
  );
}
