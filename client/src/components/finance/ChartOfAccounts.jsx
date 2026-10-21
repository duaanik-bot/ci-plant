// ChartOfAccounts: Setup's first tab (spec §6.3, §6.4, §10). Props: { book, can }.
//
// The book's groups and ledgers as one tree, every group open, with each one's closing balance as at today. Three reads, side by side:
//   GET /finance/reports/trial-balance?book&to=<today>&all=1   the closings, and the tree itself (finTbRows, as the Trial Balance draws it:
//                                                              the same order, the same figures, ledgers with no figures included)
//   GET /finance/books/:id/groups                              is_system, nature, ledger_count: what a group row may offer
//   GET /finance/books/:id/ledgers?include_inactive=1          code, Tally name, party link, name_differs, active, notes: the ledger rows
// all through useReport (the newest answer for the very request, a refresh when another login changes a Finance table, a failure said
// and never drawn as an empty chart). A row is joined to its group or its ledger by id; a row whose group or ledger has not come yet
// is drawn without its extras and offers nothing.
//
// What a login is offered follows its capabilities, and nothing is shown only to be refused:
//   Add group            admin                        under any group; it takes that group's nature
//   Add ledger           ledger (accountant, admin)   in any group, or from a group's own menu
//   Edit ledger          ledger                       the accountant's text; the admin's group, flags and party link are LedgerForm's
//   Edit / Delete group  admin, and ONLY a group that is not built in (ruling R19: a built-in group is never renamed or moved), and
//                        Delete only an empty one (finGroupActions says each, from the group's `is_system` and what is in it)
// The chips on a ledger say what is unusual about it: built in, switched off (the row is dimmed, not hidden: it keeps its history),
// system-only, and, in amber, that its name is no longer its customer's or vendor's.
//
// The search is the screen's own (controlled, over the same rowMatches the table would use, deferred so typing stays smooth on a long
// chart), so a search that finds nothing says "No groups or ledgers match this search." and never "This book has no groups yet."
// (finSearchEmpty, as the Task 16 lists do).
//
// The tree keeps its own order, so no column sorts (finUnsorted). A write that fails reloads all three reads (another login may have
// changed the chart), and a delete that the server refuses because the group is already gone closes its dialog: the reload shows it gone.
import { useDeferredValue, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api.js';
import { ActionMenu, Button, ConfirmDialog, DataTable, rowMatches, useToast } from '../ui.jsx';
import GroupForm from './GroupForm.jsx';
import LedgerForm from './LedgerForm.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip } from './SetupParts.jsx';
import useNoAnswer from './useNoAnswer.js';
import useReport from './useReport.js';
import { dayOf } from '../../lib/dayOf.js';
import { finSearchEmpty } from '../../lib/finance/page.js';
import { finTbCells, finTbExpandable, finTbHolding, finTbRows } from '../../lib/finance/tb.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finUnsorted } from '../../lib/finance/reports.js';
import { finGroupActions, finLedgerChips, finPartyText, finSetupEmpty } from '../../lib/finance/setup.js';

export default function ChartOfAccounts({ book, can }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const today = dayOf(new Date());
  const tbRead = useReport(`/finance/reports/trial-balance?${new URLSearchParams({ book: String(book.id), to: today, all: '1' })}`);
  const groupsRead = useReport(`/finance/books/${book.id}/groups`);
  const ledgersRead = useReport(`/finance/books/${book.id}/ledgers?include_inactive=1`);

  const [ledgerForm, setLedgerForm] = useState(null);   // { ledger } to edit, { groupId } to add (either may be empty)
  const [groupForm, setGroupForm] = useState(null);     // { group } to edit, { parentId } to add
  const [deleting, setDeleting] = useState(null);       // a group
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);

  const tb = tbRead.data;
  const groups = groupsRead.data?.groups ?? null;
  const ledgers = ledgersRead.data?.ledgers ?? null;
  const known = Boolean(tb && groups && ledgers);
  const failed = tbRead.failed || groupsRead.failed || ledgersRead.failed;
  const reload = () => Promise.all([tbRead.reload(), groupsRead.reload(), ledgersRead.reload()]);

  const holding = useMemo(() => (tb ? finTbHolding(tb) : new Set()), [tb]);
  // Drawn only once all three have answered: a chart of the trial balance's rows without its ledgers would look whole, and have no buttons.
  const rows = useMemo(() => {
    if (!tb || !groups || !ledgers) return [];
    const groupById = new Map(groups.map(g => [g.id, g]));
    const ledgerById = new Map(ledgers.map(l => [l.id, l]));
    return finTbRows(tb, finTbExpandable(tb), { hideEmpty: false }).map(r => ({
      ...r,
      group: r.kind === 'group' ? groupById.get(r.id) ?? null : null,
      ledger: r.kind === 'ledger' ? ledgerById.get(r.id) ?? null : null,
    }));
  }, [tb, groups, ledgers]);

  // The search is held here and not by the table, so the empty line below can tell a search that hid every row from a book with none.
  const shown = useMemo(() => (query.trim() ? rows.filter(r => rowMatches(r, query)) : rows), [rows, query]);

  // A write that fails says so when nothing answered, and shows the truth: another login may have changed what the form was built from.
  const afterSave = async () => { setLedgerForm(null); setGroupForm(null); await reload(); };

  const removeGroup = async () => {
    const group = deleting;
    try {
      await api.del(`/finance/groups/${group.id}`);
    } catch (e) {
      noAnswer(e);
      await reload();
      // A group someone else has already deleted answers 403 or 404 (finRequireRow cannot tell a missing row from another book's), and
      // the reload has just shown it gone: nothing is left to ask. Any other refusal (it has ledgers now) leaves the dialog for the person.
      if (e?.status === 403 || e?.status === 404) return;
      throw e;
    }
    toast.success('Group deleted');
    await reload();
  };

  const nameCell = r => {
    const indent = { paddingLeft: `${r.depth * 1.25}rem` };
    if (r.kind === 'group') return <span className="block break-words" style={indent}>{r.name}</span>;
    const chips = finLedgerChips(r.ledger);
    return (
      <span className="flex flex-wrap items-center gap-1.5" style={indent}>
        <span className="min-w-0 break-words">{r.name}</span>
        {chips.map(chip => (
          <Chip key={chip.key} tone={chip.tone}
            title={chip.key === 'name-differs' ? `This ledger is called “${r.ledger.name}”, but its ${r.ledger.party_type} is called “${r.ledger.party_name}” in the ERP.` : undefined}>
            {chip.label}
          </Chip>
        ))}
      </span>
    );
  };

  const actionsCell = r => {
    if (r.kind === 'ledger') {
      if (!r.ledger || !can('ledger')) return null;
      return <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => setLedgerForm({ ledger: r.ledger })}>Edit</Button></div>;
    }
    if (!r.group) return null;
    const allowed = finGroupActions(r.group, groups, can);
    const items = [
      allowed.addLedger && { key: 'add-ledger', label: 'Add a ledger here', onClick: () => setLedgerForm({ groupId: r.group.id }) },
      allowed.addGroup && { key: 'add-group', label: 'Add a sub-group', onClick: () => setGroupForm({ parentId: r.group.id }) },
      allowed.edit && { key: 'edit-group', label: 'Rename or move', onClick: () => setGroupForm({ group: r.group }) },
      allowed.remove && { key: 'delete-group', label: 'Delete group', tone: 'danger', onClick: () => setDeleting(r.group) },
    ].filter(Boolean);
    return <div className="flex justify-end"><ActionMenu items={items} label={`Actions for ${r.name}`} /></div>;
  };

  const cells = r => finTbCells(r, r.kind === 'group' && holding.has(r.id));
  const columns = finUnsorted([
    { key: 'name', label: 'Name', card: 'title', render: nameCell },
    { key: 'code', label: 'Code', card: 'detail', render: r => r.ledger?.code || '' },
    { key: 'tally_name', label: 'Tally name', card: 'detail', render: r => r.ledger?.tally_name || '' },
    { key: 'party', label: 'Linked to', card: 'subtitle', render: r => finPartyText(r.ledger) },
    { key: 'closing_paise', label: 'Closing', align: 'right', card: 'metric', render: r => <span className="whitespace-nowrap tabular-nums">{cells(r).closing}</span> },
    { key: '_actions', label: '', card: 'actions', render: actionsCell },
  ]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Every group, open, with each ledger under it. Closing balances are as at {finDateText(today)}.</p>
        <div className="flex flex-wrap gap-2">
          {can('admin') && <Button variant="secondary" disabled={!known} onClick={() => setGroupForm({})}><Plus size={14} /> Add group</Button>}
          {can('ledger') && <Button disabled={!known} onClick={() => setLedgerForm({})}><Plus size={14} /> Add ledger</Button>}
        </div>
      </div>

      <LoadNotice failed={failed} shown={known} what="the chart of accounts" onRetry={reload} />

      <DataTable rows={shown} columns={columns} getRowId={r => `${r.kind}-${r.id}`} serialNumber={false}
        searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search a group, ledger, code or party…"
        rowClass={r => `${r.kind === 'group' ? 'font-semibold' : ''} ${r.ledger?.active === false ? 'opacity-60' : ''}`}
        empty={finSetupEmpty({
          known, failed,
          none: finSearchEmpty({ searching: query.trim() !== '', total: rows.length, none: 'This book has no groups yet.', noun: 'groups or ledgers' }),
        })} />

      {ledgerForm && (
        <LedgerForm book={book} groups={groups ?? []} ledger={ledgerForm.ledger ?? null} groupId={ledgerForm.groupId ?? null}
          isAdmin={can('admin')} onClose={() => setLedgerForm(null)} onSaved={afterSave} onFailed={reload} />
      )}
      {groupForm && (
        <GroupForm book={book} groups={groups ?? []} group={groupForm.group ?? null} parentId={groupForm.parentId ?? null}
          onClose={() => setGroupForm(null)} onSaved={afterSave} onFailed={reload} />
      )}
      <ConfirmDialog open={deleting != null} onClose={() => setDeleting(null)} onConfirm={removeGroup} danger
        title={`Delete ${deleting?.name ?? 'this group'}?`} message="The group goes. It has no ledgers and no sub-groups, so nothing else changes." confirmLabel="Delete group" />
    </div>
  );
}
