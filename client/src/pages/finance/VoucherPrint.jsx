// VoucherPrint: one voucher, print = PDF (spec §10). Route: /finance/vouchers/:id/print. Props: { me, book, can, setBook }.
//
// The pattern is POPrint's: a `no-print` toolbar (Back, Print) over a `.print-fit` sheet that the browser keeps whole on one page. That
// is for a short voucher (finPrintFits). A long one (the Opening voucher can have thousands of lines, final review M-9) flows across as
// many A4 pages as it takes: no sheet kept whole, a table that is no scroll box on paper (a scroll box prints as one clipped page),
// its header row repeated on every page, and the signatures kept together.
// The sheet carries the voucher's OWN book name, read from the voucher's book_id in me.books, never the shell's current book: the print
// route can be opened straight from a link while the other book is the one the shell remembers. A login that does not hold the
// voucher's book gets no voucher (the server answers 404), and this says so in one line. A read that failed any other way says it could
// not load, with a Retry: a dropped connection is not "not available to you".
//
// An entry that is not posted yet prints too, and says so across its head (a draft has no number and is not in the books).
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '../../api.js';
import { Button } from '../../components/ui.jsx';
import { finBookOf } from '../../lib/finance/book.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finAmountWords, finDateText, finNumberText, finPrintFits, finStatusOf, finTypeLabel } from '../../lib/finance/voucher.js';

export default function VoucherPrint({ me }) {
  const { id } = useParams();
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(null);          // 'gone' (a 404) or 'trouble' (anything else)
  const [attempt, setAttempt] = useState(0);           // Retry asks again by moving it on

  useEffect(() => {
    let live = true;
    setView(null);
    setFailed(null);
    api.get(`/finance/vouchers/${id}`)
      .then(answer => { if (live) setView(answer); })
      .catch(e => { if (live) setFailed(e?.status === 404 ? 'gone' : 'trouble'); });
    return () => { live = false; };
  }, [id, attempt]);

  const voucher = view?.voucher;
  const own = voucher ? finBookOf(me?.books, voucher.book_id) : null;

  // Chrome and Safari seed the print-to-PDF filename from document.title, so the title IS the filename: the number and the book.
  // Put back on the way out, or every other page's print would carry it for the rest of the session.
  useEffect(() => {
    if (!voucher) return undefined;
    const previous = document.title;
    document.title = [finNumberText(voucher), own?.name].filter(Boolean).join(' ');
    return () => { document.title = previous; };
  }, [voucher, own]);

  if (failed) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center text-sm text-gray-500">
        {failed === 'gone' ? <p>This voucher isn't available to you.</p> : (
          <div className="flex flex-col items-center gap-3">
            <p className="text-red-600">Couldn't load this voucher.</p>
            <Button size="sm" variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry</Button>
          </div>
        )}
        <Link to="/finance" className="mt-3 inline-block font-semibold text-brand-600 hover:underline">Back to Vouchers</Link>
      </div>
    );
  }
  if (!view) return <div className="py-20 text-center text-sm text-gray-400">Loading…</div>;

  const lines = view.lines;
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_paise, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_paise, 0);
  const status = finStatusOf(voucher);
  const posted = status.key === 'posted' || status.key === 'reversed';
  const fits = finPrintFits(lines);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to={`/finance?voucher=${voucher.id}`}><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print</Button>
      </div>

      <div className={`${fits ? 'print-fit ' : ''}rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:p-0 print:shadow-none`}>
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">{(own?.name ?? 'Finance').toUpperCase()}</h1>
            <p className="text-xs text-gray-500">Books of account{own?.code ? ` · ${own.code}` : ''}</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-extrabold uppercase text-brand-600">{finTypeLabel(voucher.voucher_type)} Voucher</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{finNumberText(voucher)}</b></div>
            <div className="text-xs text-gray-600">Date: <b>{finDateText(voucher.voucher_date)}</b></div>
            {!posted && (
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600">{status.label} · not in the books</div>
            )}
            {status.key === 'reversed' && voucher.reversed_by_number && (
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600">Reversed by {voucher.reversed_by_number}</div>
            )}
            {voucher.reversal_of_number && (
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">Reversal of {voucher.reversal_of_number}</div>
            )}
          </div>
        </div>

        {voucher.reference && (
          <div className="mt-3 rounded-lg bg-gray-50 px-4 py-2 text-xs">
            <span className="font-bold uppercase tracking-wide text-gray-400">Reference: </span>
            <span className="text-gray-800">{voucher.reference}</span>
          </div>
        )}

        <div className="mt-5 overflow-x-auto print:overflow-visible">
          <table className="w-full text-sm">
            <thead className="table-header-group">
              <tr className="bg-ink-900 text-left text-[11px] font-bold uppercase tracking-wide text-white">
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">Particulars</th>
                <th className="px-2 py-2 text-right">Debit</th>
                <th className="px-2 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.id} className="border-b border-gray-100 align-top">
                  <td className="px-2 py-2 text-gray-500">{l.line_no}</td>
                  <td className="px-2 py-2">
                    <div className="font-semibold">{l.ledger_name}</div>
                    {l.narration && <div className="text-[11px] text-gray-500">{l.narration}</div>}
                    {(l.bill_ref || l.bill_date || l.due_date) && (
                      <div className="text-[11px] text-gray-500">
                        Bill {l.bill_ref || '—'}{l.bill_date ? ` · ${finDateText(l.bill_date)}` : ''}{l.due_date ? ` · due ${finDateText(l.due_date)}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.debit_paise > 0 ? finFormatINR(l.debit_paise) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.credit_paise > 0 ? finFormatINR(l.credit_paise) : ''}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-900 text-ink-900">
                <td className="px-2 py-2" colSpan={2}><span className="text-xs font-extrabold uppercase tracking-wide">Total</span></td>
                <td className="px-2 py-2 text-right font-extrabold tabular-nums">{finFormatINR(totalDebit)}</td>
                <td className="px-2 py-2 text-right font-extrabold tabular-nums">{finFormatINR(totalCredit)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-3 rounded-lg border border-gray-200 px-4 py-2 text-xs">
          <span className="font-bold uppercase tracking-wide text-gray-400">Amount in words: </span>
          <span className="text-gray-800">{finAmountWords(voucher.total_paise)}</span>
        </div>

        {voucher.narration && (
          <div className="mt-4 text-xs">
            <div className="font-bold uppercase tracking-wide text-gray-400">Narration</div>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{voucher.narration}</p>
          </div>
        )}

        <div className="mt-12 grid grid-cols-2 gap-8 text-center text-xs text-gray-500 print:mt-8 print:break-inside-avoid">
          <div className="border-t border-gray-300 pt-2">
            Prepared by
            {voucher.created_by ? <div className="text-[10px] text-gray-400">{voucher.created_by}</div> : null}
          </div>
          <div className="border-t border-gray-300 pt-2">
            Approved by
            {voucher.approved_by
              ? <div className="text-[10px] text-gray-400">{voucher.approved_by}{voucher.self_approved ? ' (self-approved)' : ''}</div>
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}
