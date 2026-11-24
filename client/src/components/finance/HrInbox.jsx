// HrInbox: HR's staff money in this book, the Cash & Bank page's "HR entries" tab (spec §5's header line, §7.5, §7.7). Props:
//   { book, mayEnter, hrAccess, status, statusFailed, onRetryStatus, onChanged }
//
// Staff money is entered in HR only, and reaches the books by itself after each HR save (§7.1, §7.7). This tab is the safety net:
//   • HR entries waiting: the page's count (GET /finance/hr/status, count-only), and "Bring in from HR" for a login that can enter,
//     POST /finance/hr/bring-in. It posts what waits, retries the exceptions and repairs what was missed, each event once, and answers
//     { posted, submitted, skipped, exceptions, more }; a press that ran out of time says "More to bring in: press Bring in again".
//   • Exceptions, GET /finance/hr/exceptions?book=, newest first (the server's order, so no column sorts): each event's kind and HR
//     document number, the server's reason, when it was first seen and last tried, and the fix in words (finHrFixText: map the channel,
//     reopen the month, or ask the MD). Retry, POST /finance/hr/exceptions/:id/retry, answers the exception as it now stands.
//   • The control check (§7.5): Staff Advances, Staff Loans and Salary Payable in the books against HR's totals, as at today. Its
//     drill-down (ruling R51) is HR's own per-person balances, the Loans & Advances screen, linked for a login with HR access only:
//     Finance holds no per-person figure, and shows none.
// Privacy (§7.4): counts, totals, HR's document numbers and the server's sentences. Never a person, a code or a per-person amount.
// Bring in and Retry are one press at a time (ruling R57): one write of the tab's is on the wire at once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Inbox } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, useToast } from '../ui.jsx';
import useNoAnswer from './useNoAnswer.js';
import { LoadNotice } from './ReportParts.jsx';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { FIN_BRING_IN_MORE, finBringInText, finControlText, finHrEventText, finHrFixText } from '../../lib/finance/cash.js';

const CONTROL_ROWS = [['advances', 'Staff Advances'], ['loans', 'Staff Loans'], ['salary_payable', 'Salary Payable']];

export default function HrInbox({ book, mayEnter, hrAccess, status, statusFailed, onRetryStatus, onChanged }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const [list, setList] = useState({ known: false, failed: false, rows: [] });
  const [more, setMore] = useState(false);
  const busyRef = useRef(false);
  const gate = useRef(null);
  if (!gate.current) gate.current = newestAnswerGate();

  const load = useCallback(async () => {
    const seq = gate.current.begin();
    try {
      const answer = await api.get(`/finance/hr/exceptions?book=${book.id}`);
      if (!gate.current.accept(seq)) return;
      setList({ known: true, failed: false, rows: answer.exceptions });
    } catch {
      setList(l => ({ ...l, failed: true }));
    }
  }, [book.id]);
  useEffect(() => { load(); }, [load]);
  useRealtimeRefresh(load, FINANCE_TABLES);

  const bringIn = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const answer = await api.post('/finance/hr/bring-in', { book_id: book.id });
      toast.success(finBringInText(answer));
      setMore(Boolean(answer.more));
    } catch (e) {
      noAnswer(e);
    } finally {
      busyRef.current = false;
    }
    await load();
    onChanged?.();
  };
  const retry = async row => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const { exception } = await api.post(`/finance/hr/exceptions/${row.id}/retry`);
      if (exception.resolved_at) toast.success(`${finHrEventText(exception)}: in the books now`);
      else toast.info(exception.reason);
    } catch (e) {
      noAnswer(e);
    } finally {
      busyRef.current = false;
    }
    await load();
    onChanged?.();
  };

  const columns = [
    { key: 'type', label: 'Entry', sortable: false, card: 'title', render: r => <span className="font-semibold">{finHrEventText(r)}</span> },
    { key: 'reason', label: 'Why it is not in the books', sortable: false, card: 'subtitle',
      render: r => <span className="block max-w-[26rem]">{r.reason}</span> },
    { key: 'fix', label: 'Fix', sortable: false, card: 'detail', export: r => finHrFixText(r.fix),
      render: r => <span className="block max-w-[22rem] text-[#515154]">{finHrFixText(r.fix)}</span> },
    { key: 'first_seen_at', label: 'First seen', sortable: false, card: 'metric', render: r => <span className="whitespace-nowrap">{fmt.dt(r.first_seen_at)}</span> },
    { key: 'last_tried_at', label: 'Last tried', sortable: false, card: 'metric', render: r => <span className="whitespace-nowrap">{fmt.dt(r.last_tried_at)}</span> },
    { key: '_retry', label: '', sortable: false, card: 'actions',
      render: r => (mayEnter ? <Button size="sm" variant="secondary" onClick={() => retry(r)}>Retry</Button> : null) },
  ];

  const control = status?.control ?? null;
  const summary = finControlText(control);
  return (
    <div className="space-y-4">
      <LoadNotice failed={statusFailed} shown={Boolean(status)} what="HR's figures" onRetry={onRetryStatus} />

      <section className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">HR entries waiting</div>
            <div className="text-2xl font-extrabold tabular-nums text-[#1D1D1F]">{status ? fmt.num(status.waiting) : '—'}</div>
            <div className="text-xs text-[#6E6E73]">
              Staff money HR has recorded that is not posted in {book.name} yet. HR posts each entry itself as it is saved; this catches up
              on any that missed.
            </div>
          </div>
          {mayEnter && <Button onClick={bringIn}><Inbox size={15} /> Bring in from HR</Button>}
        </div>
        {more && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{FIN_BRING_IN_MORE}</p>}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2 text-sm font-bold text-[#515154]">
          <AlertTriangle size={14} className={list.rows.length ? 'text-amber-600' : 'text-[#B8B8BD]'} />
          Exceptions{status ? ` · ${fmt.num(status.exceptions)}` : ''}
        </div>
        <LoadNotice failed={list.failed} shown={list.known} what="the exceptions" onRetry={load} />
        <DataTable rows={list.rows} columns={columns} getRowId={r => r.id} serialNumber={false}
          empty={list.known ? 'No exceptions: every HR entry that could post has posted.' : list.failed ? 'The exceptions couldn’t load.' : 'Loading…'} />
      </section>

      <section className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-bold text-[#1D1D1F]">
            Staff advances vs HR: <span className={summary.tone === 'good' ? 'text-emerald-700' : summary.tone === 'warn' ? 'text-amber-700' : 'text-[#86868B]'}>{summary.text}</span>
          </div>
          {control && <div className="text-xs text-[#6E6E73]">as at {finDateText(control.as_at)}</div>}
        </div>
        {control && (
          <table className="mt-2 w-full max-w-2xl text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-[#86868B]">
                <th className="py-1 pr-2">Ledger</th>
                <th className="py-1 pr-2 text-right">In the books</th>
                <th className="py-1 pr-2 text-right">HR&apos;s total</th>
                <th className="py-1 text-right">Gap (HR less books)</th>
              </tr>
            </thead>
            <tbody>
              {CONTROL_ROWS.filter(([key]) => control[key] != null).map(([key, label]) => (
                <tr key={key} className="border-t border-[#1D1D1F]/[0.06]">
                  <td className="py-1.5 pr-2 font-medium">{label}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{finFormatINR(control[key].finance_paise)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{finFormatINR(control[key].hr_paise)}</td>
                  <td className={`py-1.5 text-right font-semibold tabular-nums ${control[key].gap_paise === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {control[key].gap_paise === 0 ? 'none' : finFormatINR(control[key].gap_paise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {control && control.salary_payable == null && (
          <p className="mt-1 text-xs text-[#86868B]">Salary Payable is not checked: this book books the payroll month when it is paid.</p>
        )}
        {hrAccess && (
          <p className="mt-3 text-sm"><Link to="/hr?tab=loans" className="font-semibold text-[#0064D2] hover:underline">Each person&apos;s balance is in HR › Loans &amp; Advances →</Link></p>
        )}
        <p className="mt-2 text-xs text-[#86868B]">Staff advances and salaries are paid in HR. The books hold their totals only.</p>
      </section>
    </div>
  );
}
