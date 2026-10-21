// OpeningBalances: Setup's third tab (spec §10, §11.2), the wizard that turns Tally's balances as at the day before the books begin into the
// Opening voucher. Props: { me, book, can }. Four steps:
//
//   Upload   the List of Accounts, the Trial Balance and the bills (OpeningUpload); "As at" is fixed (ruling R34)
//   Match    what every Tally ledger is in Finance, confirmed by the person (OpeningMatch); PUT with EVERY row (ruling R33)
//   Check    the tie-out: problems in red, warnings in amber, the two sides (OpeningCheck)
//   Build    the Opening voucher, enabled only for an import that is matched and ties out (OpeningBuild), then what became of it
//
// It can be left and resumed. The import lives on the server (fin_imports), and the wizard reads GET /finance/imports?book&purpose=opening
// and continues the newest one when it is not used (ruling R37; opening.js finResumeImport): a draft goes to Match, a matched one to
// Check, unless it holds edits on the Match step that are not confirmed, which go to Match. When the newest is a used one, the wizard reports what became of its Opening voucher (OpeningBuilt), and offers to upload the
// files again only once that voucher is gone, because a book cannot hold a second Opening voucher beside one that stands or waits.
//
// The stepper opens only the steps that make sense (opening.js finStepsOpen): Check and Build need the matches CONFIRMED, and nothing on
// the Match step left unconfirmed (the Check would be of the old matches); Upload is closed while the Opening voucher of a used import
// stands or waits, because nothing could be built from the new files. The person's edits on the Match step are held HERE (`touched`),
// above the step, so leaving it and coming back loses nothing and the stepper can tell there is something unconfirmed. They are kept in the
// tab's session as well (sessionStore, per login), so a reload, which the update bar and a tablet that discards a background tab both do,
// finds them where they were left. They belong to one import at one status (the edit scope): a new upload, a confirmation (this login's or
// another's) and a build each start an empty set, and a confirmation or a discard on this screen clears the copy.
//
// Every read is useReport (the newest answer for the very request, a refresh when another login changes a Finance table, a failure said
// with a Retry and never drawn as an empty step). A write is its step's own, reloads what it changed, and says so when nothing answered.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { OpeningBuild, OpeningBuilt } from '../../components/finance/OpeningBuild.jsx';
import OpeningCheck from '../../components/finance/OpeningCheck.jsx';
import OpeningMatch from '../../components/finance/OpeningMatch.jsx';
import OpeningUpload from '../../components/finance/OpeningUpload.jsx';
import { LoadNotice } from '../../components/finance/ReportParts.jsx';
import useReport from '../../components/finance/useReport.js';
import {
  FIN_OPENING_STEPS, finBuiltImport, finChangedRows, finEditsKey, finEditsPack, finEditsUnpack, finOpeningAsAt, finOpeningOutcome,
  finOutcomeFreesUpload, finResumeImport, finStepOfImport, finStepsOpen,
} from '../../lib/finance/opening.js';
import { finImportLabel } from '../../lib/finance/reports.js';
import { sessionStore } from '../../lib/safeStorage.js';

const Loading = () => <p className="py-12 text-center text-sm text-gray-400">Loading…</p>;
const NO_EDITS = Object.freeze({});

// The four steps as a line of numbered circles. A step the wizard cannot take you to now is dimmed and does nothing.
function Stepper({ current, allDone, open, onGo }) {
  const at = FIN_OPENING_STEPS.findIndex(s => s.key === current);
  return (
    <ol className="mb-5 flex w-full max-w-3xl items-center" aria-label="Opening balances: the steps">
      {FIN_OPENING_STEPS.map((step, i) => {
        const here = step.key === current;
        const done = allDone || i < at;
        return (
          <li key={step.key} className={`flex items-center ${i < FIN_OPENING_STEPS.length - 1 ? 'flex-1' : ''}`}>
            <button type="button" disabled={!open[step.key] || here} onClick={() => onGo(step.key)} aria-current={here ? 'step' : undefined}
              className="flex items-center gap-2 rounded-full py-1 pr-2 text-sm font-semibold enabled:hover:text-[#007AFF] disabled:cursor-default">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done
                ? 'bg-emerald-500 text-white' : here ? 'bg-[#0A84FF] text-white shadow-[0_2px_8px_rgba(10,132,255,0.4)]' : 'bg-[#1D1D1F]/10 text-[#6E6E73]'}`}>
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span className={here || done ? 'text-[#1D1D1F]' : 'text-[#6E6E73]'}>{step.label}</span>
            </button>
            {i < FIN_OPENING_STEPS.length - 1 && <span className={`mx-1 h-px flex-1 ${done ? 'bg-emerald-300' : 'bg-[#1D1D1F]/10'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function OpeningBalances({ me, book, can }) {
  const asAt = finOpeningAsAt(book.books_begin);
  const list = useReport(`/finance/imports?${new URLSearchParams({ book: String(book.id), purpose: 'opening' })}`);
  const imports = list.data?.imports ?? null;

  const [chosen, setChosen] = useState(null);       // the import this visit uploaded, before the list has caught up with it
  const [step, setStep] = useState(null);           // the step the person moved to; null is wherever the import says
  const [uploading, setUploading] = useState(false);// the Upload step was asked for, though an import is in hand
  const [built, setBuilt] = useState(null);         // the Opening voucher this visit built, as the build answered it

  const resume = imports ? finResumeImport(imports) : null;
  const importId = chosen ?? resume?.id ?? null;
  const usedImport = chosen == null && imports ? finBuiltImport(imports) : null;     // the newest import, when it is a used one
  const view = useReport(importId ? `/finance/imports/${importId}` : null);
  const full = view.data;                                  // { import, ledgers, bills, tie_out }
  const imp = full?.import ?? usedImport ?? (importId ? imports?.find(i => i.id === importId) ?? null : null);
  const live = Boolean(imp) && imp.status !== 'used';

  // The Match step's edits: row id → decision (opening.js). They are of ONE import at ONE status (the scope, which says the login too), and
  // are held with the scope they are of, so a scope that changes (another upload, the import confirmed or built, by this login or another)
  // is read afresh from the session, and the edits of one import are never laid over the rows of another.
  const editScope = imp && imp.status !== 'used' ? finEditsKey(me?.user?.id, imp.id, imp.status) : null;
  const [held, setHeld] = useState({ scope: null, touched: NO_EDITS });
  if (held.scope !== editScope) setHeld({ scope: editScope, touched: editScope ? finEditsUnpack(sessionStore.getItem(editScope)) : NO_EDITS });
  const touched = held.scope === editScope ? held.touched : NO_EDITS;
  const setTouched = useCallback(update => setHeld(h => ({ scope: h.scope, touched: typeof update === 'function' ? update(h.touched) : update })), []);
  // Kept in the tab's session as they change. Between imports (no scope) the copy stays; another import, or this one at another status,
  // drops the earlier copy.
  const wrote = useRef(null);
  useEffect(() => {
    if (held.scope == null) return;
    if (wrote.current && wrote.current !== held.scope) sessionStore.removeItem(wrote.current);
    wrote.current = held.scope;
    const text = finEditsPack(held.touched);
    if (text) sessionStore.setItem(held.scope, text); else sessionStore.removeItem(held.scope);
  }, [held]);
  const groupsRead = useReport(live ? `/finance/books/${book.id}/groups` : null);
  const ledgersRead = useReport(live ? `/finance/books/${book.id}/ledgers?include_inactive=1` : null);
  const groups = groupsRead.data?.groups ?? null;
  const ledgers = ledgersRead.data?.ledgers ?? null;
  // What became of a used import's Opening voucher: read here, because it decides whether the files can be uploaded again. What the build
  // itself answered stands in until the voucher has been read; then the voucher is the truth (the MD may have decided).
  const builtImp = imp?.status === 'used' ? imp : null;
  const voucherId = builtImp?.opening_voucher_id ?? null;
  const voucherRead = useReport(voucherId ? `/finance/vouchers/${voucherId}` : null);
  const voucher = voucherRead.data?.voucher ?? (built && built.id === voucherId ? built : null);
  const outcome = finOpeningOutcome(voucher);
  const canUpload = !builtImp || finOutcomeFreesUpload(outcome);

  // Another import is another set of rows: the step the person was on is not theirs (nor are the edits: they are of an edit scope).
  useEffect(() => { setStep(null); setBuilt(null); }, [importId]);

  // Edits on the Match step that are not confirmed. Edits restored from the session count as unconfirmed until the rows and the groups
  // have come and can say whether any differs from what is confirmed (finChangedRows): the wizard then lands on Match, where they are,
  // and never on a Check of the old matches first (final wave item 14).
  const dirty = Object.keys(touched).length > 0 && (!(full && groups) || finChangedRows(full.ledgers, touched, groups).length > 0);
  const open = finStepsOpen({ imp, dirty, canUpload });
  const where = importId == null ? (usedImport ? 'build' : 'upload') : (imp ? finStepOfImport(imp, { dirty }) : null);
  const current = uploading ? 'upload' : (step && open[step] ? step : where);

  const goStep = key => {
    if (key === 'upload') { setUploading(true); return; }
    setUploading(false);
    setStep(key);
  };
  const uploaded = async id => {
    setChosen(id); setUploading(false); setStep(null); setBuilt(null);
    await list.reload();
  };
  const reloadAll = () => Promise.all([view.reload(), list.reload()]);
  const afterBuild = async voucher => { setBuilt(voucher); await reloadAll(); setStep('build'); };
  // A build that was refused: the import is read again, and if its tie-out no longer holds (the server refuses a stale one, FIN_TIE_OUT) the
  // Check step is where the problems are, so the person is taken there. Any other refusal (a second Opening voucher) stays on the Build step.
  const [recheck, setRecheck] = useState(false);
  const refused = async () => { await reloadAll(); setRecheck(true); };
  useEffect(() => {
    if (!recheck) return;
    setRecheck(false);
    if (full?.tie_out?.ok === false) setStep('check');
  }, [recheck, full]);

  const working = live && imp && !uploading ? finImportLabel(imp) : null;   // "As at 30 Sep 2026 · uploaded by …"

  if (!can('import')) return <p className="py-12 text-center text-sm text-slate-500">Importing the opening balances is for an accountant or an admin.</p>;

  let body = null;
  if (current === 'upload') {
    body = <OpeningUpload book={book} asAt={asAt} replacing={live} onUploaded={uploaded} />;
  } else if (current === 'build' && imp?.status === 'used') {
    body = <OpeningBuilt imp={imp} outcome={outcome} failed={voucherRead.failed} onRetry={voucherRead.reload} onUploadAgain={() => setUploading(true)} />;
  } else if (!full) {
    body = view.failed ? null : <Loading />;
  } else if (current === 'match') {
    body = groups && ledgers
      ? <OpeningMatch book={book} view={full} groups={groups} ledgers={ledgers} touched={touched} setTouched={setTouched}
        onConfirmed={() => { setTouched({}); setStep('check'); }} reload={view.reload} />
      : (groupsRead.failed || ledgersRead.failed ? null : <Loading />);
  } else if (current === 'check') {
    body = <OpeningCheck view={full} onBack={() => setStep('match')} onNext={() => setStep('build')} reload={view.reload} />;
  } else if (current === 'build') {
    body = <OpeningBuild book={book} view={full} onBack={() => setStep('check')} onBuilt={afterBuild} onRefused={refused} />;
  }

  return (
    <div>
      <LoadNotice failed={list.failed} shown={Boolean(imports)} what="the earlier uploads" onRetry={list.reload} />
      {imports && (
        <>
          <Stepper current={current} allDone={imp?.status === 'used' && !uploading} open={open} onGo={goStep} />
          {working && (
            <p className="mb-4 max-w-3xl text-xs text-slate-500">
              Working on the import {working.charAt(0).toLowerCase() + working.slice(1)}
              {Array.isArray(imp.file_names) && imp.file_names.length > 0 && <> ({imp.file_names.join(', ')})</>}.
            </p>
          )}
          <LoadNotice failed={view.failed} shown={Boolean(full)} what="the import" onRetry={view.reload} />
          <LoadNotice failed={groupsRead.failed || ledgersRead.failed} shown={Boolean(groups && ledgers)} what="the book's groups and ledgers"
            onRetry={() => Promise.all([groupsRead.reload(), ledgersRead.reload()])} />
          {body}
        </>
      )}
      {!imports && !list.failed && <Loading />}
    </div>
  );
}
