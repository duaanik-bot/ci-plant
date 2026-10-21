// ParallelUpload: the Parallel Run tab's "Upload Tally TB" (spec §11.3). Props: { book, onUploaded }
//
// At each month end of the parallel run the accountant exports Tally's Trial Balance with ledgers shown, as at that day, and uploads it
// here. It is the same upload as the opening balances' (TallyUpload, the same header finding and column mapping, the same preview), but
// nothing is matched by hand and no voucher is made: every row is matched to a ledger of the book (or left unmatched) by the server, and
// the Parallel Run report sets the file beside Finance's own closings.
//
// "As at" is a month-end picker limited to the book's years (opening.js finMonthEnds: the last day of each month that ends on or after the
// day the books begin; ruling R34 and M9 are the server's own checks of the same day). It starts on the latest month end that has come.
// POST /finance/imports { book_id, purpose: 'parallel_tb', as_at, file_names, tb } answers the import; the Parallel Run tab then reloads its
// uploads and opens the new one (`onUploaded(id)`).
//
// The write is useFormWrite's, and the upload button hands back its promise, so the shared Button holds it to one press. A refusal stays in
// the dialog in the server's words (under "As at" when that is what it names, else at the foot) and the file stays chosen; a write that got
// no answer is said by useNoAnswer. A login that cannot import never sees the button (the page decides: capability `import`).
import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Field, Modal, Select, useToast } from '../ui.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { FieldError } from './SetupParts.jsx';
import TallyUpload from './TallyUpload.jsx';
import useFormWrite from './useFormWrite.js';
import useReport from './useReport.js';
import { dayOf } from '../../lib/dayOf.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finDefaultMonthEnd, finMonthEnds, finParallelBody } from '../../lib/finance/opening.js';

function UploadDialog({ book, onClose, onUploaded }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const years = useReport(`/finance/books/${book.id}/years`);
  const ends = useMemo(() => finMonthEnds(years.data?.years, book.books_begin), [years.data, book.books_begin]);
  const [picked, setPicked] = useState('');
  const asAt = ends.some(e => e.value === picked) ? picked : finDefaultMonthEnd(ends, dayOf(new Date()));
  const [tb, setTb] = useState(null);                   // { rows, fileName } once the file has been read
  const [uploading, setUploading] = useState(false);    // the write is on its way: the file in it is not to be changed
  // What is on screen as ONE value that is a new value whenever the day or the file changes: a refusal is about what was sent, so it is shown
  // only while that is still what is on screen (useFormWrite keeps it until the next attempt).
  const sent = useMemo(() => ({ asAt, tb }), [asAt, tb]);
  const [refusedFor, setRefusedFor] = useState(null);

  const upload = async () => {
    setUploading(true);
    let id = null;
    const done = await attempt(async () => {
      id = (await api.post('/finance/imports', finParallelBody({ bookId: book.id, asAt, tb }))).import.id;
    });
    setUploading(false);
    if (!done) { setRefusedFor(sent); return; }
    toast.success(`Tally trial balance as at ${finDateText(asAt)} uploaded`);
    onClose();
    await onUploaded(id);
  };
  const said = refusedFor === sent ? problems : {};
  // Under "As at" when that is the field the server names; anything else (the file's rows, the form as a whole) at the foot.
  const elsewhere = Object.entries(said).find(([field]) => field !== 'as_at')?.[1];

  return (
    <Modal open onClose={onClose} title="Upload a Tally trial balance"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={upload} disabled={!asAt || !tb}>Upload</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Tally's Trial Balance with ledgers shown, as at the last day of a month. Finance sets it beside its own figures, ledger by ledger; nothing is posted.
        </p>

        <LoadNotice failed={years.failed} shown={Boolean(years.data)} what="the months of this book" onRetry={years.reload} />
        <Field label="As at" required>
          <Select options={ends.map(e => ({ value: e.value, label: e.label, search: `${e.label} ${e.hint}` }))} value={asAt}
            disabled={ends.length === 0}
            placeholder={years.data ? 'No month end to choose' : 'Loading…'}
            renderOption={item => (
              <span className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{item.label}</span>
                <span className="shrink-0 text-[11px] font-normal text-slate-400">{ends.find(e => e.value === item.value)?.hint}</span>
              </span>
            )}
            onChange={e => setPicked(e.target.value)} />
          <FieldError>{said.as_at}</FieldError>
        </Field>
        {years.data && ends.length === 0 && (
          <p className="text-sm text-amber-700">This book has no month end from {finDateText(book.books_begin)}, the day its books begin, to upload a trial balance for. Add the year in Setup, under Months &amp; Years.</p>
        )}

        <TallyUpload kind="tb" label="Trial Balance" hint="Tally's Trial Balance with ledgers shown, as Excel."
          disabled={uploading} onRows={(rows, info) => setTb(rows ? { rows, fileName: info?.fileName ?? '' } : null)} />
        {elsewhere && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{elsewhere}</p>}
      </div>
    </Modal>
  );
}

export default function ParallelUpload({ book, onUploaded }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Upload size={14} /> Upload Tally TB</Button>
      {open && <UploadDialog book={book} onClose={() => setOpen(false)} onUploaded={onUploaded} />}
    </>
  );
}
