// OpeningUpload: the Opening Balances wizard's first step (spec §11.2 step 1). Props: { book, asAt, replacing, onUploaded }
//
// The three Tally exports for the day before the books begin: the List of Accounts (every ledger and its group), the Trial Balance with
// ledgers shown, and, if there are any, the bills outstanding bill by bill (Bills Receivable and Bills Payable). Each is read in the
// browser (TallyUpload); the bills may be several files, one slot after another, and their rows are put together in the order the files
// were chosen. A bills file can be taken off again: its slot goes, or, if it is the only one, is emptied (finRemoveBillsSlot). "As at" is fixed to the day before `books_begin` (ruling R34): it is shown, with no picker, because a trial balance from any
// other day cannot become the Opening voucher.
//
// POST /finance/imports { book_id, purpose: 'opening', as_at, file_names, accounts, tb, bills } answers the import with a proposal for every
// row; the page moves on to Match. The write is useFormWrite's (the one way a Finance form saves): a refusal (a name twice in one list, a
// date the books do not keep, more rows than an import takes) is shown under the button in the server's own words, whichever field of the
// upload it names, and the files stay chosen, so nothing is read again; a write that got no answer at all is said by useNoAnswer. The
// button hands back the promise of the write, so the shared Button holds it to one press.
//
// `replacing` says an import is already in hand: uploading starts another, and this says so.
import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api.js';
import { Button } from '../ui.jsx';
import TallyUpload from './TallyUpload.jsx';
import useFormWrite from './useFormWrite.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finBillsRead, finRemoveBillsSlot, finUploadBody, finUploadReady } from '../../lib/finance/opening.js';

export default function OpeningUpload({ book, asAt, replacing = false, onUploaded }) {
  const { problems, attempt } = useFormWrite();
  const [accounts, setAccounts] = useState(null);       // { rows, fileName } once the List of Accounts has been read
  const [tb, setTb] = useState(null);                   // the same for the Trial Balance
  const [slots, setSlots] = useState({ 1: null });      // slot key → the bills file read into it
  const [order, setOrder] = useState([1]);              // the slots, in the order they were added
  const [uploading, setUploading] = useState(false);    // the write is on its way: the files in it are not to be changed
  const next = useRef(2);

  const bills = finBillsRead(slots, order);
  const ready = finUploadReady({ accounts, tb });
  // What a TallyUpload hands over, or nothing when it takes the file back (TallyUpload: onRows(null)).
  const read = (rows, info) => (rows ? { rows, fileName: info?.fileName ?? '' } : null);
  const into = set => (rows, info) => set(read(rows, info));
  const readInto = key => into(file => setSlots(s => ({ ...s, [key]: file })));
  const addSlot = () => { const key = next.current++; setOrder(o => [...o, key]); setSlots(s => ({ ...s, [key]: null })); };
  // A bills file taken off: its slot goes (finRemoveBillsSlot), or, if it is the only one, is emptied as a new slot, which is drawn from nothing.
  const removeSlot = key => {
    const after = finRemoveBillsSlot(slots, order, key, next.current++);
    setSlots(after.slots);
    setOrder(after.order);
  };

  // The files as they stand, as ONE value that is a new value whenever any of them changes. A refusal is about the files that were sent, so
  // it is shown only while they are still the files on screen (useFormWrite keeps it until the next attempt).
  const files = useMemo(() => ({ accounts, tb, slots }), [accounts, tb, slots]);
  const [refusedFor, setRefusedFor] = useState(null);
  const upload = async () => {
    setUploading(true);
    let id = null;
    const done = await attempt(async () => {
      id = (await api.post('/finance/imports', finUploadBody({ bookId: book.id, asAt, accounts, tb, bills }))).import.id;
    });
    setUploading(false);
    if (!done) { setRefusedFor(files); return; }
    await onUploaded(id);
  };
  // A refusal names a field of the upload (accounts[3].tally_name, tb, as_at) or none; every one is about the files, so the first is said.
  const refusal = refusedFor === files ? Object.values(problems)[0] : undefined;

  return (
    <div className="space-y-4">
      <div className="ci-form-panel max-w-3xl">
        <div className="ci-form-panel-title"><span>Tally exports</span></div>
        <p className="mb-4 text-sm text-slate-600">
          The opening balances are as at <strong>{finDateText(asAt)}</strong>, the day before the books begin on {finDateText(book.books_begin)}.
          Export each of these from Tally as of that day, as Excel, and choose them here.
        </p>
        {replacing && (
          <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This starts a new import. The one you were on is kept, but from here on the wizard works on the new one.
          </p>
        )}

        <div className="space-y-4">
          <TallyUpload kind="accounts" label="List of Accounts" hint="Every ledger and the group it is under, and its GSTIN if the export has one."
            disabled={uploading} onRows={into(setAccounts)} />
          <TallyUpload kind="tb" label="Trial Balance" hint={`Tally's Trial Balance with ledgers shown, as at ${finDateText(asAt)}.`}
            disabled={uploading} onRows={into(setTb)} />
          <div className="space-y-3">
            {order.map((key, i) => (
              <TallyUpload key={key} kind="bills" optional label={order.length > 1 ? `Bills outstanding, file ${i + 1}` : 'Bills outstanding'}
                hint="Bills Receivable or Bills Payable, bill by bill. Skip this if you have none; add the other file below."
                disabled={uploading} onRows={readInto(key)} onRemove={() => removeSlot(key)} removable={order.length > 1} />
            ))}
            <Button variant="ghost" size="sm" disabled={uploading} onClick={addSlot}><Plus size={14} /> Add another bills file</Button>
          </div>
        </div>

        {refusal && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{refusal}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={upload} disabled={!ready}>Upload and match</Button>
          {!ready && <span className="text-xs text-slate-400">Choose the List of Accounts and the Trial Balance to go on.</span>}
          {ready && <span className="text-xs text-slate-500">
            {accounts.rows.length.toLocaleString('en-IN')} ledgers · {tb.rows.length.toLocaleString('en-IN')} trial balance rows
            {bills.length ? ` · ${bills.reduce((n, f) => n + f.rows.length, 0).toLocaleString('en-IN')} bills` : ' · no bills'}
          </span>}
        </div>
        <p className="mt-3 text-xs text-slate-400">The files you choose are read in this tab only. If the page is reloaded, choose them again.</p>
      </div>
    </div>
  );
}
