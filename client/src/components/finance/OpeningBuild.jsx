// OpeningBuild: the Opening Balances wizard's last step (spec §11.2 steps 4 and 5). Two parts:
//
//   OpeningBuild  { book, view, onBack, onBuilt, onRefused }              the import is confirmed and not yet built: the button
//   OpeningBuilt  { imp, outcome, failed, onRetry, onUploadAgain }        the import is used: what became of its Opening voucher
//
// BUILD. POST /finance/imports/:id/build-opening makes the ledgers still to be made, then the Opening voucher (one line for each ledger
// with a balance, a line for each bill of a party), and submits it. The button is enabled only for an import that is `matched` and whose
// tie-out has no problem (ruling R33, `tie_out?.ok`); the server works the tie-out out again inside the build and refuses a stale one
// (409 FIN_TIE_OUT, with the problems), and refuses a second Opening voucher while one stands (409 FIN_OPENING_EXISTS, ruling R37), in
// words that name it. Building is a MINTING post (writeOnce.js), so a double-click is joined to the request on the wire, and the shared
// Button holds the press as well because the handler hands back its promise. The write is useFormWrite's: a refusal is said at the foot of
// the panel in the server's words, and a write that got no answer is said by useNoAnswer. Whatever the answer, the import is read again
// (`onRefused`), and the wizard sends a person whose tie-out no longer holds back to the Check step.
//
// BUILT. An Approver's Opening voucher posts at once and carries its number; anyone else's waits for the MD ("Waiting for MD approval"),
// and has no number until it posts. Either way the voucher is linked. What became of it (`outcome`, opening.js finOpeningOutcome) is read
// by the wizard from the voucher itself, so it follows the MD's decision: posted, or sent back to draft with a reason (spec §7.1). A used
// import is never changed (ruling R37): after a sent-back or discarded voucher the files are uploaded again, and that, only once the
// voucher is gone, is offered.
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Hourglass } from 'lucide-react';
import { api } from '../../api.js';
import { Button } from '../ui.jsx';
import { LoadNotice } from './ReportParts.jsx';
import useFormWrite from './useFormWrite.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finBuildNote, finOutcomeFreesUpload } from '../../lib/finance/opening.js';

export function OpeningBuild({ book, view, onBack, onBuilt, onRefused }) {
  const { problems, attempt } = useFormWrite();
  const imp = view.import;
  const tie = view.tie_out;
  const found = tie?.problems?.length;             // undefined when there is no tie-out to count: that is not "0 problems"
  const making = view.ledgers.filter(r => r.match_status === 'create').length;
  const canBuild = imp.status === 'matched' && tie?.ok === true;

  const build = async () => {
    let voucher = null;
    const done = await attempt(async () => { voucher = (await api.post(`/finance/imports/${imp.id}/build-opening`)).voucher; }, { onFail: onRefused });
    if (done) await onBuilt(voucher);
  };
  const refusal = Object.values(problems)[0];

  return (
    <div className="ci-form-panel max-w-3xl">
      <div className="ci-form-panel-title"><span>Build the Opening voucher</span></div>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>The voucher is dated <strong>{finDateText(imp.as_at)}</strong>, the day before the books begin on {finDateText(book.books_begin)}.</li>
        <li>
          {making > 0
            ? `${making.toLocaleString('en-IN')} new ${making === 1 ? 'ledger is' : 'ledgers are'} made first, each in the group you chose.`
            : 'Every row is matched to a ledger Finance already has, so none is made.'}
        </li>
        <li>It holds a line for each ledger with a balance, and a line for each bill of a party that has bills.</li>
        <li>{finBuildNote(book.roles)}</li>
      </ul>

      {!canBuild && (
        <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {imp.status !== 'matched'
            ? 'Confirm the matches first: every row, matched, made or left, before the Opening voucher is built.'
            : typeof found === 'number'
              ? `The Check found ${found} ${found === 1 ? 'problem' : 'problems'}. The Opening voucher can be built once they are fixed.`
              : 'The Check could not be read. Go back to the check and read it again.'}
        </p>
      )}
      {refusal && <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{refusal}</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBack}>Back to the check</Button>
        <Button onClick={build} disabled={!canBuild}>Build the Opening voucher</Button>
      </div>
    </div>
  );
}

const OUTCOME_LOOK = {
  waiting: { Icon: Hourglass, tone: 'text-amber-600' },
  posted: { Icon: CheckCircle2, tone: 'text-emerald-600' },
  reversed: { Icon: AlertTriangle, tone: 'text-amber-600' },
  returned: { Icon: AlertTriangle, tone: 'text-red-600' },
  discarded: { Icon: AlertTriangle, tone: 'text-red-600' },
  unknown: { Icon: AlertTriangle, tone: 'text-slate-500' },
};

export function OpeningBuilt({ imp, outcome, failed, onRetry, onUploadAgain }) {
  const id = imp.opening_voucher_id;
  const look = OUTCOME_LOOK[outcome?.state] ?? OUTCOME_LOOK.unknown;

  return (
    <div className="ci-form-panel max-w-3xl">
      <div className="ci-form-panel-title"><span>Opening voucher</span></div>
      <LoadNotice failed={failed} shown={Boolean(outcome)} what="the Opening voucher" onRetry={onRetry} />
      {outcome ? (
        <div className="flex items-start gap-3">
          <look.Icon size={22} className={`mt-0.5 shrink-0 ${look.tone}`} />
          <div className="min-w-0">
            <p className="break-words text-base font-bold text-[#1D1D1F]">{outcome.text}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              Built from the Tally files as at {finDateText(imp.as_at)}.{' '}
              <Link to={`/finance?voucher=${id}`} className="font-semibold text-[#007AFF] hover:underline">Open the Opening voucher</Link>
            </p>
          </div>
        </div>
      ) : !failed && <p className="text-sm text-gray-400">Loading…</p>}

      {finOutcomeFreesUpload(outcome) && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-slate-600">An import is used up by its Opening voucher. To build another, upload the Tally files again.</p>
          <Button onClick={onUploadAgain}>Upload the files again</Button>
        </div>
      )}
    </div>
  );
}
