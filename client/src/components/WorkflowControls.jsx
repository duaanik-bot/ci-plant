import { useMemo, useState } from 'react';
import { ArrowLeftRight, CornerDownLeft, GitBranch, RotateCcw, Send, Trash2, Undo2 } from 'lucide-react';
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
      title={mode?.includes('reverse') ? `Reverse workflow — ${label}` : `Push workflow — ${label}`}
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

      {mode === 'reversePlan' && (
        <div className="space-y-3">
          <div className="ci-summary-panel">
            Move {bulkCount > 1 ? `${bulkCount} selected products` : 'this product'} back to <b>To Plan</b>. The locked cut plan — sheets, board position and any leftover booking — is cleared and artwork approvals reset, so the plan can be reworked from scratch. Material and spec edits are kept.
          </div>
        </div>
      )}

      {mode === 'createJob' && (
        <div className="space-y-3">
          <div className="ci-summary-panel">
            {bulkCount > 1 ? `${bulkCount} job cards` : 'The job card'} will be created and sent to the <b>Job Card</b> station. Choose where the work should appear — Print Planning and/or Cutting — once it’s finalised there.
          </div>
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

function DangerModal({ open, mode, label, busy, blockers, note, setNote, onClose, onConfirm }) {
  const isDelete = mode === 'delete';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDelete ? `Delete entirely — ${label}` : `Roll back to Sales Order — ${label}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={isDelete ? 'danger' : 'primary'} disabled={busy || blockers.length > 0} onClick={onConfirm}>
          {isDelete ? 'Delete Everywhere' : 'Roll Back'}
        </Button>
      </>}
    >
      <div className="space-y-3">
        {blockers.length > 0 ? (
          <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            <b>Can’t {isDelete ? 'delete' : 'roll back'} yet:</b>
            <ul className="mt-1 list-disc pl-5">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
        ) : (
          <div className="ci-summary-panel">
            {isDelete
              ? <><b>{label}</b> and everything derived from it — job card, stages, print-queue slot, any board requisition, tooling & artwork approvals — will be removed, and the item deleted from the sales order. This cannot be undone.</>
              : <><b>{label}</b> returns to the sales order as a fresh Pending item. All planning, artwork, tooling, job card and print-queue work on it is cleared.</>}
          </div>
        )}
        <textarea
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          rows={2} placeholder="Reason (optional — recorded in the timeline)"
          value={note} onChange={e => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// The rollback/delete pair, split from the "⋯" that used to be welded to it.
// A row that also had workflow actions stood up TWO identical ellipsis buttons
// side by side — same icon, same "More actions" tooltip — and nothing on screen
// said which one held what. Handing the items out lets a caller fold them into
// the single menu the row already has; the modal comes back with them because
// the confirm step owns state (blockers, note) that has to live with them.
export function useDangerActions({ line, jobCard, onDone }) {
  const toast = useToast();
  const lineId = line?.id || jobCard?.order_line_id;
  const label = line?.product_name || jobCard?.product_name || 'this item';
  const [mode, setMode] = useState(null);          // 'rollback' | 'delete' | null
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState([]);
  const [note, setNote] = useState('');
  const allowed = canPlan() && !!lineId;

  const open = m => { setBlockers([]); setNote(''); setMode(m); };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/order-lines/${lineId}/rollback`, { mode, note: note || undefined });
      toast.success(r.message || 'Done');
      setMode(null);
      onDone?.();
    } catch (e) {
      if (e.data?.blockers) setBlockers(e.data.blockers);
      else toast.error(e.message || 'Action failed');
    } finally { setBusy(false); }
  };

  const items = allowed ? [
    { key: 'rollback', label: 'Roll back to Sales Order', icon: RotateCcw, tone: 'danger', onClick: () => open('rollback') },
    { key: 'delete', label: 'Delete entirely', icon: Trash2, tone: 'danger', onClick: () => open('delete') },
  ] : [];

  const modal = (
    <DangerModal open={!!mode} mode={mode} label={label} busy={busy} blockers={blockers}
      note={note} setNote={setNote} onClose={() => setMode(null)} onConfirm={run} />
  );

  return { items, modal, allowed, open };
}

export function DangerZone({ line, jobCard, onDone, asMenu = false }) {
  const { items, modal, allowed, open } = useDangerActions({ line, jobCard, onDone });
  if (!allowed) return null;

  return (
    <>
      {asMenu ? (
        <span onClick={e => e.stopPropagation()}><ActionMenu items={items} /></span>
      ) : (
        <div className="flex flex-wrap justify-end gap-1.5" onClick={e => e.stopPropagation()}>
          <Button size="sm" variant="ghost" title="Roll back to Sales Order"
            className="min-h-0 rounded-lg border border-amber-200 bg-amber-50/60 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-100"
            onClick={() => open('rollback')}><RotateCcw size={10} /> Rollback</Button>
          <Button size="sm" variant="ghost" title="Delete entirely from all stations"
            className="min-h-0 rounded-lg border border-red-200 bg-red-50/60 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-100"
            onClick={() => open('delete')}><Trash2 size={10} /> Delete</Button>
        </div>
      )}
      {modal}
    </>
  );
}

// `includeDanger` folds the rollback/delete pair into this component's single
// "⋯" so a row never grows a second one beside it. Only meaningful with asMenu —
// the inline variants render buttons, not a menu.
export default function WorkflowControls({ line, jobCard, context = 'line', onDone, asMenu = false, iconOnly = false, extraItems = [], includeDanger = false }) {
  const toast = useToast();
  const danger = useDangerActions({ line, jobCard, onDone });
  const dangerItems = includeDanger && asMenu ? danger.items : [];
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
        { key: 'reversePlan', label: 'Reverse', title: 'Reverse Plan — back to To Plan', icon: Undo2, tone: 'danger', show: ['planned', 'ready'].includes(line?.status) },
      ].filter(a => a.show);
    }
    if (context === 'artwork') {
      return [
        { key: 'reversePlanning', label: 'Back', title: 'Back to Planning', icon: Undo2, show: ['planned', 'ready'].includes(line?.status) },
        { key: 'createJob', label: 'To JC', title: 'Send to Job Card', icon: GitBranch, show: (line?.artwork_locked || line?.status === 'ready') && !line?.jc_number },
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

  if (!actions.length && !(asMenu && (extraItems.length || dangerItems.length))) return null;

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
      if (mode === 'reversePlan') {
        await api.post(`/workflow/order-lines/${lineId}`, { action: 'reverse_plan' });
        toast.success(`${label} reversed to To Plan`);
      }
      if (mode === 'createJob') {
        await api.post(`/workflow/order-lines/${lineId}`, {
          action: 'push_to_job_card',
          destinations: [],
        });
        toast.success(`${label} sent to Job Card station`);
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
            ...actions.map(a => ({ key: a.key, label: a.title || a.label, icon: a.icon, tone: a.tone, onClick: () => setMode(a.key) })),
            ...dangerItems,
          ]} />
        </span>
        {includeDanger && asMenu && danger.modal}
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
              className={`rounded-lg border shadow-none ${
                iconOnly ? 'grid h-7 w-7 place-items-center p-0' : 'min-h-0 px-1.5 py-0.5 text-[10px]'
              } ${
                action.key.includes('reverse')
                  ? 'border-white/70 bg-white/65 backdrop-blur-xl text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                  : 'border-[#D7E0EC] bg-white text-[#596E64] hover:border-[#BFCBC4] hover:bg-[#F5F8F6] hover:text-[#31443D]'
              }`}
              onClick={() => setMode(action.key)}
            >
              <Icon size={iconOnly ? 14 : 10} />{iconOnly ? null : <> {action.label}</>}
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

export function BulkWorkflowControls({ lines, context, onDone, onClear, extra = null }) {
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
        if (mode === 'createJob') {
          await api.post(`/workflow/order-lines/${line.id}`, { action: 'push_to_job_card', destinations: [] });
        }
        if (mode === 'jobcard') {
          await api.post(`/workflow/order-lines/${line.id}`, { action: 'push_to_job_card', destinations });
        }
        if (mode === 'reversePlan') {
          await api.post(`/workflow/order-lines/${line.id}`, { action: 'reverse_plan' });
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
  const canSendJob = selected.every(l => (['planned', 'ready'].includes(l.status) || l.artwork_locked) && !l.jc_number);
  const canReverse = context === 'artwork' && selected.every(l => ['planned', 'ready'].includes(l.status));
  const canReversePlan = context === 'planning' && selected.every(l => ['planned', 'ready'].includes(l.status));

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-3 py-2 shadow-[0_8px_20px_rgba(79,70,229,0.08)]">
      <div className="text-sm font-bold text-indigo-900">{selected.length} selected</div>
      <div className="flex flex-wrap gap-1.5">
        {extra}
        {canSendArtwork && <Button size="sm" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('artwork')}><Send size={12} /> To AW</Button>}
        {canSendJob && <Button size="sm" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode(context === 'artwork' ? 'createJob' : 'jobcard')}><GitBranch size={12} /> To JC</Button>}
        {canReverse && <Button size="sm" variant="secondary" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('reversePlanning')}><Undo2 size={12} /> Back</Button>}
        {canReversePlan && <Button size="sm" variant="secondary" className="rounded-xl px-2 py-1 text-[11px]" onClick={() => setMode('reversePlan')}><Undo2 size={12} /> Reverse Plan</Button>}
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
