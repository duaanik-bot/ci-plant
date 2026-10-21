// OpeningCheck: the Opening Balances wizard's third step (spec §11.2 steps 3 and 4, rulings R36, R38, R43). Props:
//   { view, onBack, onNext, reload }
//
// The import's tie-out, as the server worked it out just now from the matches it holds (GET /finance/imports/:id; the build works the
// same figures out again, in its own transaction, so what is said here is what the build will find):
//   Problems (red)   stop the build: the trial balance does not balance, a row is undecided, a party's bills do not add up to its
//                    balance, bills name no ledger, a trial balance row is in no List of Accounts, the voucher would be too long
//   Warnings (amber) do not: a party with a balance and no bills goes in as one line, bills on a ledger that is not a party's are left
//                    out, rows read as groups' totals that may have been ledgers
//   The two sides    Debit and Credit, and how far apart they are
// What was LEFT OUT is shown, because a gap in the trial balance is found by it (ruling R43): the rows read as a group's total that carried
// an amount, the trial balance rows that are in no List of Accounts (ruling R36), the bills of nothing (ruling R38).
//
// Continuing to the Build step waits for a tie-out with no problem. "Check again" reads the import again: the groups and ledgers of the
// book are shared, and a change made in Chart of Accounts since the matches were confirmed changes what the tie-out finds.
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Scale } from 'lucide-react';
import { Button, KpiCard, KpiRow } from '../ui.jsx';
import { Chip } from './SetupParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { finFiguresText, finTotalsGap } from '../../lib/finance/opening.js';

// A list of sentences under a heading, in one colour. `rows` are { key, text, code }. A book of thousands of ledgers can have hundreds of
// the same warning (a debtor with no bills goes in as one line), so only the first few are drawn until the person asks for the rest; the
// count in the heading is the whole list's.
const NOTES_SHOWN = 12;
function Notes({ tone, title, rows }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const palette = tone === 'red'
    ? { box: 'border-red-200 bg-red-50', head: 'text-red-700', text: 'text-red-800' }
    : { box: 'border-amber-200 bg-amber-50', head: 'text-amber-800', text: 'text-amber-900' };
  const shown = all ? rows : rows.slice(0, NOTES_SHOWN);
  return (
    <section className={`mb-3 rounded-xl border px-4 py-3 ${palette.box}`} role={tone === 'red' ? 'alert' : undefined}>
      <h3 className={`mb-1.5 flex items-center gap-1.5 text-sm font-bold ${palette.head}`}>
        <AlertTriangle size={15} className="shrink-0" /> {title} <span className="font-semibold opacity-70">({rows.length.toLocaleString('en-IN')})</span>
      </h3>
      <ul className="space-y-1.5">
        {shown.map(r => (
          <li key={r.key} className={`flex flex-wrap items-baseline gap-x-2 text-sm ${palette.text}`}>
            <span className="min-w-0 break-words">{r.text}</span>
            {r.code && <span className="text-[10px] font-semibold uppercase tracking-wide opacity-60">{r.code}</span>}
          </li>
        ))}
      </ul>
      {rows.length > NOTES_SHOWN && (
        <button type="button" className={`mt-2 text-xs font-semibold underline ${palette.head}`} onClick={() => setAll(open => !open)}>
          {all ? 'Show fewer' : `Show all ${rows.length.toLocaleString('en-IN')}`}
        </button>
      )}
    </section>
  );
}

// Rows the import left aside, with the figures each carried (the first few, as Notes does).
function LeftOut({ title, note, rows }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, NOTES_SHOWN);
  return (
    <section className="mb-3 rounded-xl border border-[#1D1D1F]/10 bg-white/60 px-4 py-3">
      <h3 className="text-sm font-bold text-[#1D1D1F]">{title} <span className="font-semibold text-slate-400">({rows.length.toLocaleString('en-IN')})</span></h3>
      <p className="mb-1.5 text-xs text-slate-500">{note}</p>
      <ul className="space-y-0.5">
        {shown.map((r, i) => (
          <li key={`${r.tally_name}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words">{r.tally_name}</span>
            <span className="whitespace-nowrap tabular-nums text-slate-600">{finFiguresText(r)}</span>
          </li>
        ))}
      </ul>
      {rows.length > NOTES_SHOWN && (
        <button type="button" className="mt-2 text-xs font-semibold text-[#007AFF] underline" onClick={() => setAll(open => !open)}>
          {all ? 'Show fewer' : `Show all ${rows.length.toLocaleString('en-IN')}`}
        </button>
      )}
    </section>
  );
}

export default function OpeningCheck({ view, onBack, onNext, reload }) {
  const tie = view.tie_out;                       // null for an import that is no opening one: read with ?., said, never read through
  const totals = tie?.totals;
  const ties = tie?.ok === true;
  const summary = view.import.summary ?? {};
  const gap = finTotalsGap(totals);
  const problems = (tie?.problems ?? []).map((p, i) => ({ key: `${p.code}-${i}`, text: p.message, code: p.code }));
  const warnings = (tie?.warnings ?? []).map((text, i) => ({ key: `w-${i}`, text }));
  const unknown = Array.isArray(summary.unknown) ? summary.unknown : [];
  const ignored = Array.isArray(summary.ignored_with_amounts) ? summary.ignored_with_amounts : [];
  // What was read, in a line. The two that are only worth a word when there are some (a bill of nothing, a row left out) say nothing at zero.
  const facts = [
    [summary.ledger_rows, 'ledgers in the List of Accounts', true],
    [summary.bill_rows, 'bills', true],
    [summary.zero_bills, 'bills of nothing, left out', false],
    [summary.ignored_rows, 'rows left out as groups’ totals', false],
  ].filter(([n, , always]) => typeof n === 'number' && (always || n > 0));

  if (!tie) {
    return (
      <div>
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          The tie-out of this import could not be read. Check again, or go back to the matches.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onBack}>Back to the matches</Button>
          <Button variant="secondary" onClick={reload}>Check again</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <KpiRow cols={4}>
        <KpiCard compact icon={Scale} label="Debits" value={finFormatINR(totals.dr)} />
        <KpiCard compact icon={Scale} label="Credits" value={finFormatINR(totals.cr)} />
        <KpiCard compact icon={gap ? AlertTriangle : CheckCircle2} tone={gap ? 'bad' : 'good'} label="Difference" value={finFormatINR(gap)}
          sub={gap ? 'The two sides must be equal' : 'The two sides are equal'} />
        <KpiCard compact icon={ties ? CheckCircle2 : AlertTriangle} tone={ties ? 'good' : 'bad'} label="Problems" value={String(problems.length)}
          sub={warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : 'no warnings'} />
      </KpiRow>

      {ties && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>It ties out: the two sides are equal, every row is matched or to be made, and each party's bills add up to its balance.</span>
        </div>
      )}
      <Notes tone="red" title="Problems: the Opening voucher cannot be built until these are fixed" rows={problems} />
      <Notes tone="amber" title="Warnings: these do not stop the build" rows={warnings} />

      <LeftOut title="Left out as groups' totals, though they carried figures"
        note="These rows are named like a group of the chart, so they were read as that group's total and not as a ledger. If one of them is a ledger, its figure is what is missing."
        rows={ignored} />
      <LeftOut title="In the trial balance, but not in the List of Accounts"
        note="These have no ledger to go to. One with a balance stops the build." rows={unknown} />

      {facts.length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          {facts.map(([n, what]) => <span key={what}><strong className="tabular-nums text-slate-700">{n.toLocaleString('en-IN')}</strong> {what}</span>)}
          <Chip tone={ties ? 'good' : 'bad'}>{ties ? 'Ties out' : 'Does not tie out'}</Chip>
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBack}>Back to the matches</Button>
        <Button variant="secondary" onClick={reload}>Check again</Button>
        <Button onClick={onNext} disabled={!ties}>Continue to build</Button>
      </div>
    </div>
  );
}
