// OpeningMatch: the Opening Balances wizard's second step (spec §11.2 step 2, rulings R32, R33). Props:
//   { book, view, groups, ledgers, touched, setTouched, onConfirmed, reload }
//
// Every ledger of the Tally List of Accounts, one row each, with what Finance will do with it:
//   Match to a ledger        one of the book's ledgers (the Tally name, then the name, found it; the person confirms it)
//   Create a new ledger      under a group of the book, and, under Sundry Debtors or Sundry Creditors (or a group below either), linked
//                            to the ERP customer or vendor it stands for (found by GSTIN, else by name, and always the person's to change)
//   Not decided yet          the Check step will say it stops the build
// Nothing is matched silently (ruling R33). The server proposed every row; the person looks through them, changes what is wrong, and
// presses Confirm, which sends EVERY row once: PUT /finance/imports/:id/matches. That, and only that, makes the import `matched`.
//
// What is on screen is the server's rows with the person's edits laid over them (`touched`, row id → decision, held by the wizard so a
// refresh underneath never wipes an edit and the stepper knows there are edits not yet confirmed). The decisions are opening.js's:
// which rows are in conflict (two on one ledger, one party on two ledgers), which are half made, what the confirmation is. The server
// refuses the same things, with sentences naming the rows; this says them first, on the rows.
//
// Whether the group of a new ledger is a party group is the server's word (finGroupKinds, ruling R23): for the group the server proposed,
// the view's fresh `is_party`; for a group the person chose, the groups read's. This screen works out nothing of its own. A party is picked
// from the ERP's customers and vendors (useParties), the customers first; one the lists do not hold is still shown as what it is.
//
// The filters (All · Needs a decision · Matched · New ledgers) show the rows as they stood when the filter was chosen: a row you have just
// decided does not slide out from under the pointer, and choosing the filter again refreshes it. The counts are always live. The table's
// window is not reset by an edit (its rows do not change), and the search is the screen's own so that an empty result says "no match".
// The columns never sort (the rows keep the order of the file).
//
// The step is drawn only once the book's groups and ledgers have come (the wizard waits for them): half a picker is worse than none.
//
// Confirm is in a bar at the foot of the step that stays in view while the rows scroll past (above the phone's tab bar), with how many rows
// stop it and how many changes are not yet confirmed, and a way back to what the server holds (Discard changes). The write is useFormWrite's
// and Confirm hands back its promise, so the shared Button holds it to one press. A refusal is shown above the table in the server's words,
// with the row it names marked (the field it names is `matches[3].ledger_id`, the fourth entry sent), for as long as nothing has been
// changed since; a write that got no answer at all is said by useNoAnswer; the view is read again either way.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, DataTable, Select, SubTabs, rowMatches } from '../ui.jsx';
import LedgerPicker from './LedgerPicker.jsx';
import { groupOptions, renderGroupOption } from './GroupForm.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip } from './SetupParts.jsx';
import useFormWrite from './useFormWrite.js';
import useParties from './useParties.js';
import { finSearchEmpty } from '../../lib/finance/page.js';
import { finUnsorted } from '../../lib/finance/reports.js';
import { finGroupChoices } from '../../lib/finance/setup.js';
import { finFormatINR } from '../../lib/finance/money.js';
import {
  FIN_MATCH_ACTIONS, FIN_MATCH_FILTERS, finChangedRows, finDecisionOf, finEditDecision, finFilterRows, finMatchView, finPartyChoiceOf, finPartyChoices,
  finPartyOfChoice, finRefusedRowId, finRowIsParty,
} from '../../lib/finance/opening.js';

// What each filter says when it shows nothing.
const FILTER_NONE = {
  all: 'The import has no rows.',
  attention: 'Every row has a decision.',
  match: 'No row is matched to a ledger.',
  create: 'No ledger is to be made.',
};

const STATUS_CHIP = { match: { tone: 'good', label: 'Matched' }, create: { tone: 'info', label: 'New ledger' } };

export default function OpeningMatch({ book, view, groups, ledgers, touched, setTouched, onConfirmed, reload }) {
  const { problems, attempt } = useFormWrite();
  const parties = useParties('both');                 // the ERP's customers and vendors (useParties.js)
  const rows = view.ledgers;
  const [filter, setFilter] = useState('all');
  const [refresh, setRefresh] = useState(0);            // moved on when the filter is chosen again: the rows are looked at afresh
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const [refusedFor, setRefusedFor] = useState(null);  // the edits the confirmation was refused for: a refusal is about what was sent
  const sentRef = useRef([]);                           // what was sent, so the entry a refusal names can be turned back into its row

  const ledgerById = useMemo(() => new Map(ledgers.map(l => [l.id, l])), [ledgers]);
  const match = useMemo(() => finMatchView(rows, touched, groups, { ledgerById }), [rows, touched, groups, ledgerById]);
  const changed = useMemo(() => finChangedRows(rows, touched, groups).length, [rows, touched, groups]);
  const groupChoices = useMemo(() => groupOptions(finGroupChoices(groups)), [groups]);

  // The rows a filter shows are looked at when it is chosen (or the rows underneath change), not on every edit, so a row that has just
  // been decided stays where it is. The edits are read from a ref for that reason.
  const edits = useRef(touched);
  useEffect(() => { edits.current = touched; }, [touched]);
  const base = useMemo(
    () => (filter === 'all' ? rows : finFilterRows(rows, finMatchView(rows, edits.current, groups, { ledgerById }), filter)),
    [rows, groups, ledgerById, filter, refresh]);
  const shown = useMemo(() => (query.trim() ? base.filter(r => rowMatches(r, query)) : base), [base, query]);

  const decide = (row, change) => setTouched(t => ({ ...t, [row.id]: finEditDecision(row, finDecisionOf(row, t), change, match.partyGroups) }));
  const choose = key => { if (key === filter) setRefresh(n => n + 1); else setFilter(key); };

  const confirm = async () => {
    const sent = match.matches;
    if (!sent) return;   // the button is off while a row stops the confirmation; this is for a press that was already on its way
    sentRef.current = sent;
    const done = await attempt(() => api.put(`/finance/imports/${view.import.id}/matches`, { matches: sent }), { onFail: reload });
    if (!done) { setRefusedFor(touched); return; }
    await reload();
    onConfirmed();
  };
  // The refusal, while it is still about what is on screen: any change made since answers it (touched is a new value at every edit).
  // useFormWrite keeps its sentence under the field the server names, or `form`: the entry it names is the row to mark.
  const [refusedField, refusal] = refusedFor === touched ? Object.entries(problems)[0] ?? [] : [];
  const refusedRow = refusedField ? finRefusedRowId({ data: { field: refusedField } }, sentRef.current) : null;

  // ── The cells ──
  // The name, the group Tally has it under, and, for a row that needs a decision, a mark that says so wherever the table is scrolled to
  // (the Status column is the last one, and a narrow screen scrolls to it).
  const nameCell = r => {
    const state = match.states.get(r.id);
    const mark = state?.kind === 'attention' ? state : null;
    return (
      <div className="min-w-[9rem]">
        <div className="flex items-start gap-1.5">
          {mark && (
            <span title={mark.note} className="mt-0.5 shrink-0">
              <AlertTriangle size={14} aria-hidden="true" className={mark.tone === 'red' ? 'text-red-500' : 'text-amber-500'} />
            </span>
          )}
          <span className="min-w-0 break-words font-semibold">{r.tally_name}</span>
        </div>
        <div className="text-xs font-normal text-slate-500">{r.tally_group || 'No group in the file'}</div>
      </div>
    );
  };
  const balanceCell = r => {
    const net = r.debit_paise - r.credit_paise;
    return <span className={`whitespace-nowrap tabular-nums ${net === 0 ? 'text-slate-400' : ''}`}>{finFormatINR(net, { drcr: true })}</span>;
  };
  // Three buttons, one of them pressed, as the ledger form's party kind is: the choices are few and are all worth seeing at once.
  const actionCell = r => {
    const current = finDecisionOf(r, touched).action;
    return (
      <div role="radiogroup" aria-label={`What to do with ${r.tally_name}`}
        className="inline-flex rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-0.5">
        {FIN_MATCH_ACTIONS.map(a => (
          <button key={a.key} type="button" role="radio" aria-checked={current === a.key} title={a.label}
            onClick={() => { if (current !== a.key) decide(r, { action: a.key }); }}
            className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition touch:min-h-[36px] ${current === a.key
              ? 'bg-white text-[#1D1D1F] shadow-[0_1px_4px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
            {a.short}
          </button>
        ))}
      </div>
    );
  };
  // The party picker, for a new ledger under a party group: the customer or vendor the ledger stands for. null anywhere else.
  const partyPicker = (r, d) => {
    if (d.action !== 'create' || !finRowIsParty(r, d, match.partyGroups)) return null;
    const current = { party_type: d.party_type, party_id: d.party_id, party_name: d.party_type === r.party_type && d.party_id === r.party_id ? r.party_name : null };
    return (
      <Select options={finPartyChoices(parties.customers, parties.vendors, current)} value={finPartyChoiceOf(d)}
        disabled={parties.customers == null}
        placeholder={parties.customers == null ? 'Loading the parties…' : 'No customer or vendor'}
        renderOption={item => (
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">{item.label}</span>
            <span className="shrink-0 text-[11px] font-normal text-slate-400">{item.hint}</span>
          </span>
        )}
        aria-label={`Customer or vendor for ${r.tally_name}`} onChange={e => decide(r, { party: finPartyOfChoice(e.target.value) })} />
    );
  };
  // What the action points at: a ledger of the book, or the group the new ledger goes under with, under a party group, the party below it.
  const targetCell = r => {
    const d = finDecisionOf(r, touched);
    if (d.action === 'match') {
      return (
        <div className="min-w-[13rem]">
          <LedgerPicker bookId={book.id} ledgers={ledgers} value={d.ledger_id} aria-label={`Finance ledger for ${r.tally_name}`}
            onChange={id => decide(r, { ledger_id: id })} />
        </div>
      );
    }
    if (d.action === 'create') {
      return (
        <div className="min-w-[13rem] space-y-1.5">
          <Select options={groupChoices} value={d.group_id ?? ''} placeholder="Choose a group…" renderOption={renderGroupOption}
            aria-label={`Group for the new ledger ${r.tally_name}`} onChange={e => decide(r, { group_id: e.target.value === '' ? null : Number(e.target.value) })} />
          {partyPicker(r, d)}
        </div>
      );
    }
    return <span className="text-slate-300">—</span>;
  };
  const statusCell = r => {
    const state = match.states.get(r.id);
    if (!state) return null;
    const chip = STATUS_CHIP[state.kind];
    return (
      <div className="flex flex-col items-start gap-1">
        {chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : <Chip tone={state.tone === 'red' ? 'bad' : 'amber'}>{state.tone === 'red' ? 'Conflict' : 'Needs a decision'}</Chip>}
        {state.note && <span className={`text-[11px] leading-snug ${state.tone === 'red' ? 'text-red-600' : 'text-amber-700'}`}>{state.note}</span>}
      </div>
    );
  };

  const columns = finUnsorted([
    { key: 'tally_name', label: 'In Tally', card: 'title', render: nameCell },
    { key: 'balance', label: 'Balance', align: 'right', card: 'metric', render: balanceCell },
    { key: 'action', label: 'In Finance', card: 'actions', render: actionCell },
    { key: 'target', label: 'Ledger, or group and party', card: 'actions', render: targetCell },
    { key: 'status', label: 'Status', card: 'status', render: statusCell },
  ]);

  const views = FIN_MATCH_FILTERS.map(f => ({ key: f.key, label: f.label, count: match.counts[f.key].toLocaleString('en-IN') }));

  return (
    <div data-ci-form>
      {/* The step is a form scope to the update bar (lib/reloadSafety.js): an automatic reload waits while edits are unsent. The one field it is
          read by is this count, which moves with every edit however it was made (an action is a button, and a picker comes and goes as the
          table scrolls: neither is a field to measure). It is not the edits' only copy: the wizard keeps them in the tab's session as well. */}
      <input type="hidden" value={String(changed)} readOnly />
      <p className="mb-3 max-w-3xl text-sm text-slate-600">
        Each Tally ledger, and what Finance will do with it. The ones Finance recognised are matched, the others are set to be made; look
        through them, change what is wrong, then confirm. Nothing is matched until you do.
      </p>

      {refusal && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{refusal}</span>
          {refusedRow != null && (
            <Button size="sm" variant="secondary" onClick={() => { setFilter('all'); setSearch(rows.find(r => r.id === refusedRow)?.tally_name ?? ''); }}>Show that row</Button>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SubTabs views={views} active={filter} onChange={choose} />
      </div>

      <LoadNotice failed={parties.failed} shown={false} what="the customers and vendors, so none can be linked" onRetry={parties.retry} />

      <div data-reload-safe>
        <DataTable rows={shown} columns={columns} getRowId={r => r.id} serialNumber={false}
          searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search a Tally ledger, group, ledger or party…"
          rowClass={r => (match.states.get(r.id)?.tone === 'red' || refusedRow === r.id ? 'ci-row-alarm-soft' : '')}
          empty={finSearchEmpty({ searching: query.trim() !== '', total: base.length, none: FILTER_NONE[filter], noun: 'rows' })} />
      </div>

      <div className="sticky bottom-[calc(68px+var(--sab))] z-30 mt-3 flex md:bottom-3 flex-wrap items-center justify-end gap-x-4 gap-y-2 rounded-2xl border border-white/70 bg-white/85 px-4 py-2.5 shadow-[0_8px_30px_rgba(29,29,31,0.15)] backdrop-blur-xl">
        {match.blocked > 0 && <span className="text-xs font-medium text-amber-700">{match.blocked} {match.blocked === 1 ? 'row needs' : 'rows need'} fixing before you can confirm</span>}
        {match.blocked === 0 && changed > 0 && <span className="text-xs font-medium text-slate-500">{changed} {changed === 1 ? 'change' : 'changes'} not confirmed yet</span>}
        {changed > 0 && <Button variant="ghost" size="sm" onClick={() => setTouched({})}>Discard changes</Button>}
        {match.blocked === 0 && changed === 0 && match.counts.attention > 0 && (
          <span className="text-xs font-medium text-slate-500">{match.counts.attention} {match.counts.attention === 1 ? 'row is' : 'rows are'} undecided: it will be confirmed as it is, and the Check will say it stops the build</span>
        )}
        <Button onClick={confirm} disabled={!match.ready}>Confirm {rows.length.toLocaleString('en-IN')} rows and check</Button>
      </div>
    </div>
  );
}
