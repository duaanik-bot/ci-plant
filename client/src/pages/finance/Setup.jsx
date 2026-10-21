// Setup: the chart of accounts, the months and years, the opening balances, the approval rules, who has access, and the activity log
// (spec §10). Props: { me, book, can, setBook, reloadMe }.
//
//   /finance/setup                        the first tab this login may see (Chart of Accounts)
//   /finance/setup/:tab                   chart-of-accounts · months-years · opening-balances · approval-rules · access · activity-log
//   /finance/setup/activity-log?from&to&user&entity     the log's period and its two filters
//
// The shell routes everything under /finance/setup to this page (setup/*), and the tab is the part after it (finSetupTab). A tab whose
// capability the login lacks is not shown, and a link to one lands on the first tab it may see:
//
//   Chart of Accounts, Months & Years, Activity Log   view
//   Opening Balances                                  import
//   Approval Rules, Access                            admin
//
// What each tab may DO is that tab's own business and goes by the same capabilities (the screens hide what a login cannot do; the server
// refuses it regardless). The period of the Activity Log is the Reports page's (finReportRange: the financial year to date, from the day
// the books begin in their first year) and lives in the URL, with the person and the kind of change, so a link is exact and Back returns
// to it. A change to it replaces the history entry, and moving to another tab adds one.
//
// The page is drawn afresh when the book changes (the key on Routes in the shell), so nothing one book showed sits under another's name.
// Opening Balances is the wizard that turns Tally's balances into the Opening voucher (OpeningBalances: upload, match, check, build); it
// keeps its place on the server between visits, so it is drawn whole whenever the tab is opened.
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs } from '../../components/ui.jsx';
import ActivityLog from '../../components/finance/ActivityLog.jsx';
import ApprovalRules from '../../components/finance/ApprovalRules.jsx';
import ChartOfAccounts from '../../components/finance/ChartOfAccounts.jsx';
import FinanceAccess from '../../components/finance/FinanceAccess.jsx';
import MonthsYears from '../../components/finance/MonthsYears.jsx';
import OpeningBalances from './OpeningBalances.jsx';
import { dayOf } from '../../lib/dayOf.js';
import { finQueryWith } from '../../lib/finance/page.js';
import { finReportRange } from '../../lib/finance/reports.js';
import { FIN_ENTITY_CHOICES, finSetupTab, finSetupTabMove, finSetupTabs } from '../../lib/finance/setup.js';

export default function Setup({ me, book, can, reloadMe }) {
  const navigate = useNavigate();
  const tabs = finSetupTabs(can);
  const tab = finSetupTab(useParams()['*'], can);
  const [query, setQuery] = useSearchParams();
  const { from, to } = finReportRange(query, dayOf(new Date()), book.books_begin);
  const user = query.get('user') ?? '';
  const entity = FIN_ENTITY_CHOICES.some(c => c.key === query.get('entity')) ? query.get('entity') : '';

  const change = updates => setQuery(previous => finQueryWith(previous, updates), { replace: true });
  // A click on the tab you are on goes nowhere (finSetupTabMove): it would only add a history entry for a page that did not change.
  const goTab = key => {
    const path = finSetupTabMove(tab, key);
    if (path) navigate(path);
  };

  return (
    <div>
      <PageHeader title="Setup" subtitle={`${book.name} · the chart of accounts, months, approval rules, access and the activity log`} />
      {tab === null ? (
        <p className="py-12 text-center text-sm text-slate-500">Nothing in Setup is open to this login.</p>
      ) : (
        <>
          <Tabs tabs={tabs} active={tab} onChange={goTab} />
          {tab === 'chart-of-accounts' && <ChartOfAccounts book={book} can={can} />}
          {tab === 'months-years' && <MonthsYears book={book} can={can} />}
          {tab === 'opening-balances' && <OpeningBalances me={me} book={book} can={can} />}
          {tab === 'approval-rules' && <ApprovalRules book={book} can={can} />}
          {tab === 'access' && <FinanceAccess me={me} book={book} reloadMe={reloadMe} />}
          {tab === 'activity-log' && <ActivityLog book={book} from={from} to={to} user={user} entity={entity} onPeriod={change} onFilters={change} />}
        </>
      )}
    </div>
  );
}
