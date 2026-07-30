// Client mirror of server/src/shade-flow.js presentation. The transition map is
// duplicated deliberately: the server is the authority and refuses bad moves,
// but the UI needs to know which button to light before asking.
export const STATUS_META = {
  draft:    { label: 'Draft',            cls: 'bg-slate-100 text-slate-600' },
  sent:     { label: 'Sent to Customer', cls: 'bg-violet-50 text-violet-700' },
  approved: { label: 'Approved',         cls: 'bg-emerald-50 text-emerald-700' },
  rejected: { label: 'Rejected',         cls: 'bg-red-50 text-red-700' },
};

export const scLabel = s => STATUS_META[s]?.label ?? '—';

// The seven steps of the real process, as the drawer's progress rail. Steps 5-7
// repeat per job, which is why they read from the custody log rather than status.
export const STEPS = [
  { key: 'created',  label: 'Created' },
  { key: 'sent',     label: 'Sent to customer' },
  { key: 'approved', label: 'Customer approved' },
  { key: 'recorded', label: 'Received back' },
  { key: 'issued',   label: 'Issued to printing' },
  { key: 'running',  label: 'In use at press' },
  { key: 'returned', label: 'Returned' },
];

// Which step the card is standing on right now.
export function stepIndex(card) {
  if (!card) return 0;
  if (card.with_printing) return 5;
  if (card.status === 'approved') return card.issue_count > 0 ? 6 : 4;
  if (card.status === 'sent') return 1;
  if (card.status === 'rejected') return 1;
  return 0;
}

// The ONE action available now. Never a row of six buttons to choose between.
export function nextAction(card) {
  if (!card || card.active !== 1) return null;
  if (card.with_printing) return { key: 'return', label: 'Record Return', variant: 'success' };
  if (card.status === 'draft') return { key: 'sent', label: 'Dispatch to Customer', variant: 'primary' };
  if (card.status === 'sent') return { key: 'approved', label: 'Record Approval', variant: 'success' };
  if (card.status === 'rejected') return { key: 'sent', label: 'Send Corrected Card', variant: 'primary' };
  if (card.status === 'approved')
    return card.expired_by_age
      ? { key: 'sent', label: 'Renew — Send Again', variant: 'primary' }
      : { key: 'issue', label: 'Issue to Printing', variant: 'primary' };
  return null;
}

export const today = () => new Date().toISOString().slice(0, 10);
