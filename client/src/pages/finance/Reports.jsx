// Reports: the trial balance, a ledger's statement, the journal register, the parallel run against Tally, and the self-approved list
// (spec §9.2, §10). Props: { me, book, can, setBook }.
//
//   /finance/reports                          Trial Balance
//   /finance/reports/ledger?ledger&from&to    Ledger
//   /finance/reports/journal-register         Journal Register
//   /finance/reports/parallel-run             Parallel Run
//   /finance/reports/self-approved            Self-approved
//   ...?voucher=<id>                          that voucher, open over the report
//
// The shell routes everything under /finance/reports to this page (reports/*), and the tab is the part after it (finReportTab). The
// period every report runs over is in the URL too (?from and ?to, each a real day, else the financial year to date, which in the books'
// first year opens on the day they begin: finPeriodStart, ruling R58), and so is the ledger
// of the Ledger tab and the open voucher: a link from the trial balance to a ledger can be shared, and Back goes where it came from.
// Changing the period or the ledger replaces the history entry; moving to another report or drilling down adds one.
//
// What is open in the trial balance is held here and not in the tab, so it is still open when Back returns from a ledger. A voucher
// changed from its detail (a reversal) moves `version`, which every report reads as "ask again". All five reports only read; each
// needs the right to view the book, which the shell has already established, and offers an export only to a book whose grant allows it.
// Reports are read on a phone too: the tables become cards, and nothing here is laid out separately for one.
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs } from '../../components/ui.jsx';
import JournalRegister, { SelfApproved } from '../../components/finance/JournalRegister.jsx';
import LedgerStatement from '../../components/finance/LedgerStatement.jsx';
import ParallelRun from '../../components/finance/ParallelRun.jsx';
import TrialBalance from '../../components/finance/TrialBalance.jsx';
import VoucherDetail from '../../components/finance/VoucherDetail.jsx';
import { dayOf } from '../../lib/dayOf.js';
import { finQueryWith } from '../../lib/finance/page.js';
import { FIN_REPORT_TABS, finLedgerPath, finReportRange, finReportTab, finTabMove } from '../../lib/finance/reports.js';

export default function Reports({ me, book, setBook }) {
  const navigate = useNavigate();
  const tab = finReportTab(useParams()['*']);
  const [query, setQuery] = useSearchParams();
  const { from, to } = finReportRange(query, dayOf(new Date()), book.books_begin);

  const idOf = name => (/^\d+$/.test(query.get(name) ?? '') ? Number(query.get(name)) : null);
  const ledgerId = idOf('ledger');
  const voucherId = idOf('voucher');

  const change = updates => setQuery(previous => finQueryWith(previous, updates), { replace: true });

  const [expanded, setExpanded] = useState(() => new Set());
  const [showEmpty, setShowEmpty] = useState(false);
  const [version, setVersion] = useState(0);

  // A click on the tab you are on goes nowhere (finTabMove): it would drop the chosen ledger and add a history entry for nothing.
  const goTab = key => {
    const path = finTabMove(tab, key, query);
    if (path) navigate(path);
  };
  // A ledger row opens the Ledger tab for the same period, unless the report names its own.
  const openLedger = (id, period = { from, to }) => navigate(finLedgerPath(id, period.from, period.to));
  const shared = { book, from, to, onPeriod: change, onVoucher: id => change({ voucher: id }), version };

  return (
    <div>
      <PageHeader title="Reports" subtitle={`${book.name} · the trial balance, ledger statements, the journal register and the Tally parallel run`} />
      <Tabs tabs={FIN_REPORT_TABS} active={tab} onChange={goTab} />

      {tab === 'trial-balance' && (
        <TrialBalance {...shared} expanded={expanded} onExpanded={setExpanded} showEmpty={showEmpty} onShowEmpty={setShowEmpty} onLedger={openLedger} />
      )}
      {tab === 'ledger' && <LedgerStatement {...shared} ledgerId={ledgerId} onPickLedger={id => change({ ledger: id })} />}
      {tab === 'journal-register' && <JournalRegister {...shared} />}
      {tab === 'parallel-run' && <ParallelRun book={book} onLedger={openLedger} version={version} />}
      {tab === 'self-approved' && <SelfApproved {...shared} />}

      {voucherId != null && (
        <VoucherDetail id={voucherId} me={me} book={book} setBook={setBook} onClose={() => change({ voucher: null })}
          onChanged={() => setVersion(n => n + 1)} onOpen={id => change({ voucher: id })} />
      )}
    </div>
  );
}
