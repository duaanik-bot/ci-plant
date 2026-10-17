// HR → People: the register of everyone on the payroll — one row per person with their
// current pay setup — and the door to the person drawer (details, pay-setup history, bank,
// aliases, ERP-operator link, money). Spec §6–§7. Like every HR tab it takes { level }.
//
// A viewer reads the register and opens a drawer that cannot edit; an operator also gets
// "Add person" and an editable drawer. The server enforces the same; this only hides buttons.
//
// The list never carries a bank account: the register shows bank_last4 only (the full number
// reaches an operator's drawer, nowhere else). Pay figures are formatted here, never summed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button, DataTable, ResetFilters, rowMatches, useFilterReset } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, levelAtLeast } from '../../lib/hr.js';
import PersonDrawer, { PERSON_STATUS, StatusPill, WORKER_TYPE, baseText, holidayText, numText } from './PersonDrawer.jsx';

// The "channel" chip for people with no pay channel at all. A string no real code can be.
const NO_CHANNEL = '\u0000none';

// FilterGroup keeps its chips on one line (shrink-0); on a phone a department rail of a dozen
// chips then runs off the screen. Letting the group shrink lets them wrap inside the rail.
const WRAP = '!shrink min-w-0';

// [[value, count], …] for one axis of the rail, by value.
function tally(rows, pick) {
  const counts = new Map();
  for (const r of rows) {
    const k = pick(r);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

export default function People({ level }) {
  const canEdit = levelAtLeast(level, 'operator');
  const [rows, setRows] = useState(null); // null until the first answer
  const [channels, setChannels] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [dept, setDept] = useState('');
  const [channel, setChannel] = useState('');
  const [noSetup, setNoSetup] = useState(false);
  const [drawer, setDrawer] = useState(null); // { id, seed, key } — id null = a new person
  const drawerKey = useRef(0);

  // The pay channels ride along only to turn a code into its label; if they cannot be read the
  // register still works and shows codes.
  const load = useCallback(async () => {
    try {
      const [people, chans] = await Promise.all([hrApi.people(), hrApi.payChannels().catch(() => null)]);
      setRows(Array.isArray(people) ? people : []);
      if (Array.isArray(chans)) setChannels(chans);
      setLoadError(false);
    } catch {
      setLoadError(true); // the central toast has the reason; the last list stays on screen
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const labelOf = useMemo(() => {
    const byCode = new Map(channels.map(c => [c.code, c.label || c.code]));
    return code => (code ? (byCode.get(code) || code) : '');
  }, [channels]);

  const all = useMemo(() => rows || [], [rows]);
  const searched = useMemo(() => (q.trim()
    ? all.filter(r => rowMatches(r, q, `${labelOf(r.pay_channel)} ${holidayText(r.current_setup)}`))
    : all), [all, q, labelOf]);
  const filtered = useMemo(() => searched.filter(r => (!status || r.status === status)
    && (!dept || (r.department || '') === dept)
    && (!channel || (channel === NO_CHANNEL ? !r.pay_channel : r.pay_channel === channel))
    && (!noSetup || !r.current_setup)), [searched, status, dept, channel, noSetup]);

  const filters = useFilterReset([
    [q, setQ, '', 'search'],
    [status, setStatus, '', 'status'],
    [dept, setDept, '', 'department'],
    [channel, setChannel, '', 'channel'],
    [noSetup, setNoSetup, false, 'no pay setup'],
  ]);

  const statusCounts = useMemo(() => {
    const c = {};
    for (const r of all) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [all]);
  const depts = useMemo(() => tally(all, r => (r.department || '').trim()), [all]);
  const chans = useMemo(() => tally(all, r => r.pay_channel), [all]);
  const unchannelled = useMemo(() => all.filter(r => !r.pay_channel).length, [all]);
  const unset = useMemo(() => all.filter(r => !r.current_setup).length, [all]);

  const openPerson = useCallback(r => setDrawer({ id: r.id, seed: r, key: ++drawerKey.current }), []);
  const addPerson = () => setDrawer({ id: null, seed: null, key: ++drawerKey.current });

  const columns = useMemo(() => [
    { key: 'code', label: 'Code', card: 'subtitle',
      render: r => <span className="font-mono text-xs font-semibold text-[#515154]">{r.code}</span>, export: r => r.code },
    { key: 'name', label: 'Name', card: 'title', export: r => r.name,
      render: r => (
        <button type="button" onClick={() => openPerson(r)} className="block max-w-[240px] text-left">
          <span className="block truncate text-sm font-semibold text-[#1D1D1F] hover:text-[#007AFF]">{r.name}</span>
          {r.designation && <span className="block truncate text-[11px] text-[#86868B]">{r.designation}</span>}
        </button>
      ) },
    { key: 'department', label: 'Department', render: r => r.department || '—', export: r => r.department || '' },
    { key: 'channel', label: 'Channel', sortValue: r => labelOf(r.pay_channel),
      render: r => labelOf(r.pay_channel) || '—', export: r => labelOf(r.pay_channel) },
    { key: 'worker_type', label: 'Type', render: r => WORKER_TYPE[r.worker_type] || r.worker_type || '—',
      export: r => WORKER_TYPE[r.worker_type] || r.worker_type || '' },
    { key: 'status', label: 'Status', card: 'status', sortValue: r => PERSON_STATUS[r.status]?.label || r.status,
      render: r => <StatusPill status={r.status} />, export: r => PERSON_STATUS[r.status]?.label || r.status || '' },
    { key: 'base', label: 'Current base', align: 'right', card: 'metric',
      sortValue: r => (r.current_setup && r.current_setup.pay_basis !== 'contract' ? r.current_setup.base : null),
      render: r => (r.current_setup
        ? <span className="whitespace-nowrap">{baseText(r.current_setup)}</span>
        : <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">No pay setup</span>),
      export: r => (r.current_setup ? baseText(r.current_setup) : 'No pay setup') },
    { key: 'ot', label: 'OT h/day', align: 'right', card: 'metric',
      sortValue: r => r.current_setup?.ot_hours_per_day ?? null,
      render: r => numText(r.current_setup?.ot_hours_per_day), export: r => numText(r.current_setup?.ot_hours_per_day) },
    { key: 'holiday', label: 'Holiday', card: 'detail', sortValue: r => holidayText(r.current_setup),
      render: r => <span className="whitespace-nowrap">{holidayText(r.current_setup)}</span>, export: r => holidayText(r.current_setup) },
    { key: 'bank_last4', label: 'Bank', card: 'detail',
      render: r => (r.bank_last4 ? <span className="whitespace-nowrap font-mono text-xs">•••• {r.bank_last4}</span> : '—'),
      export: r => (r.bank_last4 ? `****${r.bank_last4}` : '') },
  ], [labelOf, openPerson]);

  const empty = loadError && rows == null ? 'The people list could not be loaded.'
    : all.length === 0 ? 'No people yet.' : 'No one matches these filters.';

  return (
    <div>
      <FilterRail className="mb-2">
        <FilterGroup label="Status" divider={false} className={WRAP}>
          <FilterChip label="All" count={all.length} on={!status} onClick={() => setStatus('')} />
          {Object.entries(PERSON_STATUS).map(([key, meta]) => (
            <FilterChip key={key} label={meta.label} count={statusCounts[key] || 0} on={status === key}
              onClick={() => setStatus(cur => (cur === key ? '' : key))} />
          ))}
        </FilterGroup>
        {depts.length > 0 && (
          <FilterGroup label="Department" className={WRAP}>
            {depts.map(([name, n]) => (
              <FilterChip key={name} label={name} count={n} on={dept === name}
                onClick={() => setDept(cur => (cur === name ? '' : name))} />
            ))}
          </FilterGroup>
        )}
        {(chans.length > 0 || unchannelled > 0) && (
          <FilterGroup label="Channel" className={WRAP}>
            {chans.map(([code, n]) => (
              <FilterChip key={code} label={labelOf(code)} count={n} on={channel === code}
                onClick={() => setChannel(cur => (cur === code ? '' : code))} />
            ))}
            {unchannelled > 0 && (
              <FilterChip label="No channel" count={unchannelled} on={channel === NO_CHANNEL}
                onClick={() => setChannel(cur => (cur === NO_CHANNEL ? '' : NO_CHANNEL))} />
            )}
          </FilterGroup>
        )}
        <FilterGroup label="Only" className={WRAP}>
          <FilterChip label="No pay setup" icon={AlertTriangle} count={unset} on={noSetup}
            tone="border-amber-300 bg-amber-100 text-amber-800" countTone="bg-white/70"
            title="People a payroll run cannot be submitted for until they have a pay setup"
            onClick={() => setNoSetup(v => !v)} />
        </FilterGroup>
        <div className="ml-auto flex items-center gap-2">
          <ResetFilters filters={filters} shown={filtered.length} total={all.length} />
          {canEdit && <Button size="sm" onClick={addPerson}><Plus size={14} /> Add person</Button>}
        </div>
      </FilterRail>

      {loadError && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Couldn’t reach the server — {rows ? 'showing the last list loaded.' : 'the people list can’t load.'}
          </span>
          <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
        </div>
      )}

      {rows == null && !loadError ? (
        <div className="p-8 text-sm text-slate-400">Loading people…</div>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          empty={empty}
          searchValue={q}
          onSearchChange={setQ}
          searchPlaceholder="Search name, code, department, designation…"
          defaultSort={{ key: 'name', dir: 'asc' }}
          onRowClick={openPerson}
          exportName="HR People"
          exportSubtitle="HR & Payroll · People register"
          exportMeta={() => [
            status && `Status: ${PERSON_STATUS[status]?.label || status}`,
            dept && `Department: ${dept}`,
            channel && `Channel: ${channel === NO_CHANNEL ? 'none' : labelOf(channel)}`,
            noSetup && 'Only people without a pay setup',
          ]}
        />
      )}

      {drawer && (
        <PersonDrawer key={drawer.key} id={drawer.id} seed={drawer.seed} level={level} channels={channels}
          onClose={() => setDrawer(null)} onChanged={load} />
      )}
    </div>
  );
}
