// The two soft alarms that stand between an operator and a printing run, in
// one place so the three pages that start a stage (Section, Floor, Production)
// cannot word them differently.
//
// Both are SOFT by design. Board stock is physics — issue it twice and the
// sheets are gone — but a shade card's date and a plate's rack status are
// paperwork, and refusing the start renews neither. It only stops the press
// while someone chases a record. So each alarm names exactly what the office
// thinks is wrong, and lets the man who can see the machine overrule it. Every
// override is audited server-side against the card it doubts.
//
// Both arrive as structured 409s, which api.js deliberately keeps quiet so the
// caller can draw a proper dialog. A page that imports neither this component
// nor its own gets a Start button that silently does nothing — which is how
// PLATES_NOT_READY stopped three jobs at Offset 3 without saying a word.
import { ConfirmDialog } from './ui.jsx';

// A fresh start attempt has answered nothing yet. Acks accumulate across
// retries: the shade gate throws before the plate gate, so answering only the
// plate alarm on the retry would re-raise the shade one and bounce the operator
// between two dialogs for ever.
export const NO_ACKS = { shade: false, plates: false };

const plateMessage = plates => {
  const missing = (plates.missing || []).map(row => row.component_label || row.status).join(', ');
  const on = plates.request_numbers?.length ? ` on ${plates.request_numbers.join(', ')}` : '';
  return `${plates.ready} of ${plates.required} plates are confirmed in the rack${on}. `
    + `Still showing as not ready: ${missing || '—'}. `
    + 'Start the run anyway? This is recorded against the job.';
};

// `alarm` is null, or { kind: 'shade' | 'plates', shade?, plates? }.
// onAcknowledge(kind) re-submits the start with that ack added.
export default function StartAlarmDialog({ alarm, onClose, onAcknowledge }) {
  const shade = alarm?.kind === 'shade' ? alarm.shade : null;
  const plates = alarm?.kind === 'plates' ? alarm.plates : null;
  return (
    <>
      <ConfirmDialog open={!!shade} onClose={onClose} danger
        title="Shade card approval pending"
        message={shade
          ? `${shade.reason}. Proceed with printing anyway? This acknowledgement is recorded against ${shade.sc_number}.`
          : ''}
        confirmLabel="Acknowledge & start"
        onConfirm={() => onAcknowledge('shade')} />

      <ConfirmDialog open={!!plates} onClose={onClose} danger
        title="Plates not confirmed in the rack"
        message={plates ? plateMessage(plates) : ''}
        confirmLabel="Plates are on the press — start"
        onConfirm={() => onAcknowledge('plates')} />
    </>
  );
}
