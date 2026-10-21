// TallyUpload: one of Tally's Excel exports, read in the browser (spec §11.2 step 1). Props: { kind, label, hint, optional, removable, disabled, onRows, onRemove }
//
//   kind      'tb' (the Trial Balance with ledgers shown), 'accounts' (the List of Accounts) or 'bills' (Bills Receivable / Payable)
//   onRows    onRows(rows, { fileName }) once the file is read to rows the import takes (finRowsFromSheet), and onRows(null) whenever the page
//             must forget what it was given: as soon as another file is chosen, and whenever the file in hand cannot be read to rows. The
//             page therefore never holds the rows of a file the screen no longer shows.
//   onRemove  when given, a Remove button takes the file off: it is called, and the page drops this upload (it is the page's to decide whether the
//             place itself goes, or is emptied). Offered while a file is in hand, or was turned back; `removable` offers it with no file too, for a
//             place the page may drop (a second bills file that was added and is not wanted).
//
// What it does, in this order:
//   1. An .xlsx is taken; an .xls is turned back with the way out ("Save the Tally export as .xlsx and upload that."). ExcelJS is loaded
//      HERE, on the pick, by a dynamic import (the lib/exporter.js pattern), never at the top of any file: a static import would put it
//      into the first download of every plant tablet (startup-entry-lean.test.js).
//   2. The first worksheet becomes arrays of cell values (tally.js finSheetRows): rich text is its text, a formula its saved result, a
//      date stays a Date. A formula the file never calculated is refused when it is read as a figure, not read as blank. A workbook of
//      several sheets says which one it read (a Tally export has one, so a second is a file somebody has been working in).
//   3. The header row is found below Tally's title block (finFindHeaderRow). If there is none, the column selects are offered at once,
//      filled in with the best guess (finGuessLayout), because a layout nobody could place is a layout a person has to say.
//   4. The first 10 rows as the import will take them are shown, with the count, and the page is handed all of them. A cell that cannot be
//      read is refused in a sentence that names its ledger; nothing is guessed at.
// The columns can be changed even where the header was found ("Change columns"): the preview is the check.
//
// It holds the file's rows only as long as the screen shows them. Nothing here talks to the server.
import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, FileUp, Loader2 } from 'lucide-react';
import { Field, Input, Select } from '../ui.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import {
  finCellShown, finColumnLetter, finFindHeaderRow, finGuessLayout, finReadSheet, finSheetRows, finTallyColumns, finTallyFileProblem,
} from '../../lib/finance/tally.js';

// How many rows of the file's own sheet the layout grid shows, and how many of the rows as read the preview shows.
const GRID_ROWS = 12;
const GRID_COLUMNS = 12;
const PREVIEW_ROWS = 10;
const MAX_COLUMNS = 60;

const money = paise => (paise > 0 ? finFormatINR(paise) : '—');
const day = value => (value ? finDateText(value) : '—');
// A kind's preview: the headings, and a cell for each. Money is right-aligned.
const PREVIEWS = {
  tb: [
    { label: 'Ledger', cell: r => r.tally_name },
    { label: 'Debit', right: true, cell: r => money(r.debit_paise) },
    { label: 'Credit', right: true, cell: r => money(r.credit_paise) },
  ],
  accounts: [
    { label: 'Ledger', cell: r => r.tally_name },
    { label: 'Group', cell: r => r.tally_group ?? '—' },
    { label: 'GSTIN', cell: r => r.gstin ?? '', when: layout => Number.isInteger(layout.mapping.gstin) },
  ],
  bills: [
    { label: 'Party', cell: r => r.tally_ledger_name },
    { label: 'Reference', cell: r => r.bill_ref ?? '—' },
    { label: 'Bill date', cell: r => day(r.bill_date) },
    { label: 'Due', cell: r => day(r.due_date) },
    { label: 'Amount', right: true, cell: r => (r.side ? `${finFormatINR(Math.abs(r.amount_paise))} ${r.side === 'dr' ? 'Dr' : 'Cr'}` : '—') },
  ],
};

// The reader's own error is a library's and means nothing to a person, so a workbook that cannot be opened is said in one sentence of ours.
const UNREADABLE = "That file couldn't be read as an Excel workbook. Open it in Excel, save it as .xlsx, and upload that.";

// The columns of the sheet, for the selects: "Column B · Debit", the hint being what the row above the figures says there.
function columnOptions(sheet, first) {
  const width = Math.min(MAX_COLUMNS, sheet.slice(0, 50).reduce((most, row) => Math.max(most, row.length), 0));
  const above = sheet[first - 1] ?? [];
  return Array.from({ length: width }, (_, i) => {
    const said = finCellShown(above[i]);
    return { value: i, label: `Column ${finColumnLetter(i)}${said ? ` · ${said}` : ''}`, search: `${finColumnLetter(i)} ${said}` };
  });
}

// What the layout in force says, in a line.
function layoutText(kind, layout) {
  const named = finTallyColumns(kind).filter(c => Number.isInteger(layout.mapping[c.key])).map(c => `${c.label} = ${finColumnLetter(layout.mapping[c.key])}`);
  return `${layout.found ? `Header found on row ${layout.first}` : 'Columns chosen by hand'}${named.length ? `: ${named.join(' · ')}` : ''}. Figures start on row ${layout.first + 1}.`;
}

function ColumnChoices({ kind, sheet, layout, onLayout }) {
  const columns = finTallyColumns(kind);
  const options = columnOptions(sheet, layout.first);
  const [firstText, setFirstText] = useState(String(layout.first + 1));
  const shownRows = sheet.slice(0, GRID_ROWS);
  const width = Math.min(GRID_COLUMNS, options.length);
  return (
    <div className="mt-3 space-y-3 rounded-2xl bg-[#1D1D1F]/[0.03] p-3">
      <p className="text-xs text-slate-500">Choose the column that holds each thing, and the row where the figures start. The first rows of the sheet are shown for reference.</p>
      <div className="max-h-48 overflow-auto rounded-xl border border-[#1D1D1F]/10 bg-white/70">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="sticky top-0 bg-slate-100 text-slate-500">
              <th className="px-2 py-1 text-right font-semibold">Row</th>
              {Array.from({ length: width }, (_, i) => <th key={i} className="px-2 py-1 text-left font-semibold">{finColumnLetter(i)}</th>)}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row, r) => (
              <tr key={r} className={r + 1 === layout.first ? 'bg-blue-50' : r >= layout.first ? '' : 'text-slate-400'}>
                <td className="px-2 py-0.5 text-right tabular-nums text-slate-400">{r + 1}</td>
                {Array.from({ length: width }, (_, i) => <td key={i} className="max-w-[10rem] truncate px-2 py-0.5">{finCellShown(row[i])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {columns.map(c => (
          <Field key={c.key} label={c.label} required={c.required}>
            <Select options={options} value={layout.mapping[c.key] ?? ''} placeholder={c.required ? 'Choose a column…' : 'None'}
              onChange={e => {
                const mapping = { ...layout.mapping };
                if (e.target.value === '' || e.target.value == null) delete mapping[c.key]; else mapping[c.key] = Number(e.target.value);
                onLayout({ ...layout, mapping, found: false });
              }} />
          </Field>
        ))}
        <Field label="Figures start on row" required>
          <Input inputMode="numeric" value={firstText} className="max-w-[8rem] tabular-nums"
            onChange={e => {
              setFirstText(e.target.value);
              const n = Number(e.target.value);
              if (/^\d+$/.test(e.target.value.trim()) && n >= 1 && n <= sheet.length) onLayout({ ...layout, first: n - 1, found: false });
            }}
            onBlur={() => setFirstText(String(layout.first + 1))} />
        </Field>
      </div>
    </div>
  );
}

export default function TallyUpload({ kind, label, hint, optional = false, removable = false, disabled = false, onRows, onRemove }) {
  const [phase, setPhase] = useState('empty');          // empty · reading · ready
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState('');           // why the file itself was turned back
  const [sheet, setSheet] = useState(null);             // the first worksheet, as arrays of cell values
  const [layout, setLayout] = useState(null);           // { mapping, first, found }: found says a header row was found
  const [changing, setChanging] = useState(false);      // the column selects are open
  const [read, setRead] = useState(null);               // finReadSheet's answer for the sheet under the layout
  const [sheetNote, setSheetNote] = useState('');       // which sheet was read, when the workbook has more than one
  const picks = useRef(0);                              // the file in hand: a read that comes back for an older pick is dropped
  const inputId = useRef(`tally-${kind}-${Math.random().toString(36).slice(2, 8)}`);
  // Taken off the screen while a file is being read: that read comes back for a file nobody has any more, and is dropped like any older pick.
  useEffect(() => () => { picks.current += 1; }, []);

  const forget = () => { setSheet(null); setLayout(null); setRead(null); setChanging(false); setSheetNote(''); };

  // The rows under a layout, shown and handed to the page. A header with nothing under it holds no ledgers: that is said, not sent.
  const apply = (rows, next, name) => {
    let out = finReadSheet(rows, kind, next);
    if (out.rows && out.rows.length === 0) {
      out = { error: 'No rows were found under the header. Check the columns, and the row where the figures start.' };
    }
    setLayout(next);
    setRead(out);
    onRows(out.rows ?? null, { fileName: name });
  };

  const choose = async picked => {
    if (!picked) return;
    const mine = ++picks.current;
    onRows(null);
    forget();
    setFileName(picked.name);
    const wrong = finTallyFileProblem(picked.name);
    if (wrong) { setProblem(wrong); setPhase('empty'); return; }
    setProblem('');
    setPhase('reading');
    // Turned back: said once, and the file is forgotten. A newer pick has already moved on, and what it finds is its own to say.
    const turnBack = sentence => { if (mine === picks.current) { setProblem(sentence); setPhase('empty'); } };
    let book;
    try {
      const ExcelJS = (await import('exceljs')).default;
      book = new ExcelJS.Workbook();
      await book.xlsx.load(await picked.arrayBuffer());
    } catch {
      turnBack(UNREADABLE);
      return;
    }
    if (mine !== picks.current) return;
    const first = book.worksheets[0];
    if (!first) { turnBack('That workbook has no sheet in it.'); return; }
    let rows;
    try { rows = finSheetRows(first); } catch (e) { turnBack(e.message); return; }
    const found = finFindHeaderRow(rows, kind);
    const next = found ? { mapping: found.mapping, first: found.index + 1, found: true } : { ...finGuessLayout(rows, kind), found: false };
    setSheetNote(book.worksheets.length > 1 ? `The workbook has ${book.worksheets.length} sheets; the first, “${first.name}”, is the one read. ` : '');
    setSheet(rows);
    setChanging(!found);
    setPhase('ready');
    apply(rows, next, picked.name);
  };

  const onInput = e => { choose(e.target.files?.[0]); e.target.value = ''; };
  const rows = read?.rows ?? null;
  const columns = PREVIEWS[kind].filter(c => !c.when || (layout && c.when(layout)));
  const canRemove = Boolean(onRemove) && (removable || phase !== 'empty' || Boolean(problem));

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={inputId.current} className="text-xs font-medium leading-snug text-slate-600">{label}</label>
        <span className="flex items-baseline gap-3">
          {optional && <span className="text-[11px] text-slate-400">optional</span>}
          {canRemove && (
            <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Remove ${label}`}
              className="text-xs font-semibold text-[#007AFF] hover:underline disabled:pointer-events-none disabled:opacity-60">Remove</button>
          )}
        </span>
      </div>

      {phase !== 'ready' ? (
        <label className={`flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/60 px-4 py-4 hover:border-blue-300 hover:bg-blue-50/40 ${disabled ? 'pointer-events-none opacity-60' : ''}`}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (!disabled) choose(e.dataTransfer.files?.[0]); }}>
          {phase === 'reading' ? <Loader2 size={22} className="shrink-0 animate-spin text-blue-500" /> : <FileUp size={22} className="shrink-0 text-slate-400" />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-600">
              {phase === 'reading' ? `Reading ${fileName}…` : 'Choose the Excel file, or drop it here'}
            </span>
            {hint && phase !== 'reading' && <span className="block text-xs text-slate-400">{hint}</span>}
          </span>
          <input id={inputId.current} type="file" accept=".xlsx,.xls" className="hidden" disabled={disabled} onChange={onInput} />
        </label>
      ) : (
        <div className="rounded-2xl border border-white/70 bg-white/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <div className="flex flex-wrap items-center gap-2">
            <FileSpreadsheet size={18} className="shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1D1D1F]" title={fileName}>{fileName}</span>
            {rows && <span className="text-xs font-semibold text-emerald-700">{rows.length.toLocaleString('en-IN')} {rows.length === 1 ? 'row' : 'rows'} read</span>}
            <label className={`cursor-pointer text-xs font-semibold text-[#007AFF] hover:underline ${disabled ? 'pointer-events-none opacity-60' : ''}`}>
              Choose another file
              <input id={inputId.current} type="file" accept=".xlsx,.xls" className="hidden" disabled={disabled} onChange={onInput} />
            </label>
          </div>

          <p className="mt-1.5 text-xs text-slate-500">
            {sheetNote}{layoutText(kind, layout)}{' '}
            <button type="button" className="font-semibold text-[#007AFF] hover:underline" onClick={() => setChanging(open => !open)}>
              {changing ? 'Hide the columns' : 'Change columns'}
            </button>
          </p>
          {changing && <ColumnChoices kind={kind} sheet={sheet} layout={layout} onLayout={next => apply(sheet, next, fileName)} />}

          {read?.pending && <p className="mt-2 text-sm font-medium text-amber-700">{read.pending}</p>}
          {read?.error && <p className="mt-2 text-sm font-medium text-red-600">{read.error}</p>}
          {rows && (
            <div className="mt-2 overflow-x-auto rounded-xl border border-[#1D1D1F]/10 bg-white/70">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-500">
                    {columns.map(c => <th key={c.label} className={`px-2 py-1 font-semibold ${c.right ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={i} className="border-t border-[#1D1D1F]/[0.05]">
                      {columns.map(c => <td key={c.label} className={`max-w-[16rem] truncate px-2 py-1 ${c.right ? 'text-right tabular-nums' : ''}`}>{c.cell(r)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > PREVIEW_ROWS && (
                <p className="border-t border-[#1D1D1F]/[0.05] px-2 py-1 text-[11px] text-slate-400">
                  The first {PREVIEW_ROWS} of {rows.length.toLocaleString('en-IN')} rows.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {problem && <p className="mt-1.5 text-sm font-medium text-red-600">{problem}</p>}
    </div>
  );
}
