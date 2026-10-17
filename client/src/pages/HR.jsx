// HR & Payroll — the page. Before it shows anything it asks two things of the server:
// may this login open it at all, and at which HR level (GET /hr/me). Then it draws the
// tabs that level may see. Spec: docs/superpowers/specs/2026-10-16-hr-payroll-design.md §5–§6.
//
//   Month     Overview · Payroll
//   Records   People · Loans & Advances
//   Output    Reports
//   Admin     Settings                    (admin only)
//
// The shape is Fluence's: `?tab=` picks the tab (default Overview) and GroupedTabs draws
// the rail. A tab's body is one file under pages/hr/ and takes { level } — the HR access
// level this login holds. The tabs use it to decide what to OFFER; the server is what
// enforces it.
//
// All of it is private. A login that is not on the HR access list is refused by the
// server (403), and sees one card saying so: no tab, no figure, no hint of what is inside.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Button, GroupedTabs, PageHeader } from '../components/ui.jsx';
import { HR_LEVELS, HR_LEVEL_LABELS, HR_TABS, hrApi, levelAtLeast } from '../lib/hr.js';
import Overview from './hr/Overview.jsx';
import Payroll from './hr/Payroll.jsx';
import People from './hr/People.jsx';
import LoansAdvances from './hr/LoansAdvances.jsx';
import Reports from './hr/Reports.jsx';
import Settings from './hr/Settings.jsx';

// Tab key → its body (pages/hr/<Name>.jsx).
const BODY = {
  overview: Overview, payroll: Payroll, people: People,
  loans: LoansAdvances, reports: Reports, settings: Settings,
};
// The rail's captions, in the order the tabs first name them.
const GROUPS = [...new Set(HR_TABS.map(t => t.group))];

const CARD = 'glass mx-auto mt-6 max-w-lg rounded-[22px] border p-8 text-center shadow-card sm:mt-10';

// The whole page for a login that is not on the HR access list.
function PrivateCard() {
  return (
    <div className={`${CARD} border-white/70`}>
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#1D1D1F]/[0.06] text-[#515154]">
        <Lock size={20} />
      </span>
      <p className="text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">HR &amp; Payroll is private. Ask Anik for access.</p>
    </div>
  );
}

// The server could not be asked (offline, a 5xx, a build that does not have HR yet). That
// is not the same as "no access", so it does not wear the private card.
function UnreachableCard({ message, onRetry }) {
  return (
    <div role="alert" className={`${CARD} border-amber-200/60 bg-amber-50/60`}>
      <p className="text-base font-bold tracking-[-0.01em] text-amber-900">HR &amp; Payroll could not be reached.</p>
      <p className="mt-1 text-xs text-amber-800">Check the connection and try again.</p>
      {message && <p className="mt-1 text-[11px] text-amber-700/80">{message}</p>}
      <Button className="mt-4" variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export default function HR() {
  const [params, setParams] = useSearchParams();
  // { state: 'loading' } → { state: 'ready', level } | { state: 'private' } | { state: 'error', message }
  const [access, setAccess] = useState({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setAccess(a => (a.state === 'loading' ? a : { state: 'loading' }));
    hrApi.me().then(
      me => {
        if (!live) return;
        // A level this build does not know is no access: never guess upward.
        setAccess(HR_LEVELS.includes(me?.level) ? { state: 'ready', level: me.level } : { state: 'private' });
      },
      err => {
        if (!live) return;
        setAccess(err?.status === 403 ? { state: 'private' } : { state: 'error', message: err?.message || '' });
      },
    );
    return () => { live = false; };
  }, [attempt]);

  const level = access.state === 'ready' ? access.level : null;
  // The tabs this level may see, in rail order — a link to one it may not open lands on Overview.
  const tabs = useMemo(() => HR_TABS.filter(t => levelAtLeast(level, t.min)), [level]);
  const asked = params.get('tab');
  const tab = tabs.some(t => t.key === asked) ? asked : (tabs[0]?.key ?? null);
  // Switching tab starts that tab clean: the only thing carried across is the month, which
  // Overview, Payroll and Reports share (the payroll notifications link to ?tab=payroll&month=).
  const setTab = useCallback(key => setParams(p => {
    const next = new URLSearchParams({ tab: key });
    if (p.get('month')) next.set('month', p.get('month'));
    return next;
  }, { replace: true }), [setParams]);

  if (access.state === 'loading') return <div className="p-8 text-sm text-slate-400">Loading…</div>;
  if (access.state === 'private') return <PrivateCard />;
  if (access.state === 'error') return <UnreachableCard message={access.message} onRetry={() => setAttempt(n => n + 1)} />;

  const Body = BODY[tab];
  const groups = GROUPS
    .map(g => ({ label: g, items: tabs.filter(t => t.group === g).map(({ key, label }) => ({ key, label })) }))
    .filter(g => g.items.length);

  return (
    <div>
      <PageHeader title="HR & Payroll"
        subtitle="Monthly payroll, people, loans and advances — private to the logins on the HR access list"
        actions={(
          <span title="Your HR & Payroll access level"
            className="rounded-full border border-white/70 bg-white/65 px-3 py-1.5 text-xs font-bold text-[#515154] backdrop-blur-xl">
            {HR_LEVEL_LABELS[level]} access
          </span>
        )} />
      <GroupedTabs groups={groups} active={tab} onChange={setTab} />
      {Body && <Body level={level} />}
    </div>
  );
}
