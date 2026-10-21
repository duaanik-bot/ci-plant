// LedgerForm: adding a ledger, or editing one (spec §6.4, §8.1). Props:
//   { book, groups, ledger, groupId, isAdmin, onClose, onSaved, onFailed }
//
// ledger null is a new one (groupId, when given, is the group it was added from). The accountant (capability `ledger`) adds a ledger
// and changes its name, code, Tally name and notes; the admin alone changes where an existing ledger sits, whether it is switched
// on, whether hand-typed vouchers may use it ("system-only" is manual_entry off), and which customer or vendor it stands for. What
// the login cannot change is SHOWN as text, not offered and then refused (finLedgerFields says which is which). A built-in ledger
// (Cash, Profit & Loss A/c) can be neither moved nor switched off, for anyone.
//
// POST /finance/ledgers · PUT /finance/ledgers/:id. An admin's edit sends the whole form; anyone else's sends only the text they may
// change (finLedgerEditBody, final review M-7). The server compares only the fields it is given, so an admin's change made while the
// form was open is neither refused nor undone, and nothing is read again at save time.
//
// The party link is picked from the ERP's own customers or vendors (GET /customers, GET /vendors), which are read only once a kind is
// chosen. A party that has since been switched off stays on offer when it is the one linked (a former customer can have a balance).
// A ledger keeps the name it had in Tally, so its name and its party's may differ: that is said, and never refused.
//
// The save button hands back the promise of the write, so the shared Button holds it to one press; a refusal leaves the form open with
// what was typed, and the server's sentence under the field it names (useFormWrite).
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast } from '../ui.jsx';
import { FieldError, ReadOnlyFact } from './SetupParts.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { groupOptions, renderGroupOption } from './GroupForm.jsx';
import useFormWrite from './useFormWrite.js';
import useParties from './useParties.js';
import {
  FIN_PARTY_KINDS, finGroupChoices, finLedgerCreateBody, finLedgerEditBody, finLedgerFields, finLedgerFormOf, finPartyOptions, finPartyText,
} from '../../lib/finance/setup.js';

export default function LedgerForm({ book, groups, ledger = null, groupId = null, isAdmin, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const [form, setForm] = useState(() => finLedgerFormOf(ledger, { group_id: groupId }));
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const fields = finLedgerFields(ledger, { isAdmin });
  const parties = useParties(fields.party ? form.party_type : '');

  const groupChoices = useMemo(() => groupOptions(finGroupChoices(groups)), [groups]);
  const partyOptions = useMemo(() => finPartyOptions(form.party_type, parties.list, ledger), [form.party_type, parties.list, ledger]);
  const kindLabel = FIN_PARTY_KINDS.find(k => k.key === form.party_type)?.label ?? '';

  const linkMissing = fields.party && form.party_type !== '' && form.party_id === '';
  const ready = form.name.trim() !== '' && form.group_id != null && form.group_id !== '' && !linkMissing;

  const save = async () => {
    const done = await attempt(
      async () => {
        if (!ledger) return api.post('/finance/ledgers', finLedgerCreateBody(form, book.id));
        return api.put(`/finance/ledgers/${ledger.id}`, finLedgerEditBody(form, { isAdmin }));
      },
      { onFail: onFailed });
    if (!done) return;
    toast.success(ledger ? 'Ledger saved' : 'Ledger added');
    await onSaved();
  };

  return (
    <Modal open onClose={onClose} title={ledger ? `Edit ${ledger.name}` : 'Add a ledger'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready}>{ledger ? 'Save' : 'Add ledger'}</Button>
      </>}>
      <div className="space-y-3">
        {ledger?.is_system && (
          <p className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-sm text-slate-600">
            This ledger is built in. It can be renamed, but it can't be moved or switched off.
          </p>
        )}
        {ledger?.name_differs && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This ledger is called “{ledger.name}”, but its {ledger.party_type} is called “{ledger.party_name}” in the ERP. That is allowed: a ledger keeps the name it had in Tally.
          </p>
        )}

        <Field label="Name" required>
          <Input autoFocus value={form.name} maxLength={255} onChange={e => set({ name: e.target.value })} />
          <FieldError>{problems.name}</FieldError>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input value={form.code} maxLength={50} onChange={e => set({ code: e.target.value })} />
            <FieldError>{problems.code}</FieldError>
          </Field>
          <Field label="Tally name" hint="What Tally calls it, if that is different. The parallel run matches on it.">
            <Input value={form.tally_name} maxLength={255} onChange={e => set({ tally_name: e.target.value })} />
            <FieldError>{problems.tally_name}</FieldError>
          </Field>
        </div>

        {fields.group ? (
          <Field label="Group" required>
            <Select options={groupChoices} value={form.group_id ?? ''} placeholder="Choose a group…" renderOption={renderGroupOption}
              onChange={e => set({ group_id: e.target.value === '' ? null : Number(e.target.value) })} />
            <FieldError>{problems.group_id}</FieldError>
          </Field>
        ) : null}

        {fields.party && (
          <div>
            <span className="mb-1 block text-xs font-medium leading-snug text-slate-600">Linked to an ERP customer or vendor</span>
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="Linked to" className="inline-flex rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-0.5">
                {FIN_PARTY_KINDS.map(kind => (
                  <button key={kind.key || 'none'} type="button" role="radio" aria-checked={form.party_type === kind.key}
                    onClick={() => { if (form.party_type !== kind.key) set({ party_type: kind.key, party_id: '' }); }}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition touch:min-h-[36px] ${form.party_type === kind.key
                      ? 'bg-white text-[#1D1D1F] shadow-[0_1px_4px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
                    {kind.label}
                  </button>
                ))}
              </div>
              {form.party_type !== '' && (
                <div className="min-w-[14rem] flex-1">
                  <Select options={partyOptions} value={form.party_id} disabled={parties.list == null}
                    placeholder={parties.list == null ? `Loading ${kindLabel.toLowerCase()}s…` : `Choose a ${kindLabel.toLowerCase()}…`}
                    renderOption={item => (
                      <span className="flex min-w-0 items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-medium">{item.label}</span>
                        <span className="shrink-0 text-[11px] font-normal text-slate-400">{item.hint}</span>
                      </span>
                    )}
                    onChange={e => set({ party_id: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
              )}
            </div>
            <LoadNotice failed={parties.failed} shown={false} what={`the ${kindLabel.toLowerCase()}s, so none can be picked`} onRetry={parties.retry} />
            <FieldError>{problems.party_id || problems.party_type}</FieldError>
          </div>
        )}

        <Field label="Notes">
          <Textarea value={form.notes} maxLength={2000} onChange={e => set({ notes: e.target.value })} />
          <FieldError>{problems.notes}</FieldError>
        </Field>

        {fields.active && (
          <div className="space-y-2">
            <Checkbox label="Active: it can be used in vouchers" checked={form.active} onChange={e => set({ active: e.target.checked })} />
            <FieldError>{problems.active}</FieldError>
          </div>
        )}
        {fields.systemOnly && (
          <div className="space-y-2">
            <Checkbox label="System-only: hand-typed vouchers can't use it" checked={!form.manual_entry} onChange={e => set({ manual_entry: !e.target.checked })} />
            <FieldError>{problems.manual_entry}</FieldError>
          </div>
        )}

        <FieldError>{problems.form}</FieldError>

        {ledger && (!fields.group || !fields.party || !fields.active || !fields.systemOnly) && (
          <div className="rounded-xl bg-[#1D1D1F]/[0.03] px-3 py-3">
            <div className="mb-2 text-xs font-semibold text-slate-500">{isAdmin ? "Built in, so these can't be changed" : 'Only an Admin can change these'}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {!fields.group && <ReadOnlyFact label="Group">{ledger.group_name}</ReadOnlyFact>}
              {!fields.party && <ReadOnlyFact label="Linked to">{finPartyText(ledger)}</ReadOnlyFact>}
              {!fields.active && <ReadOnlyFact label="Status">{ledger.active ? 'Active' : 'Switched off'}</ReadOnlyFact>}
              {!fields.systemOnly && <ReadOnlyFact label="System-only">{ledger.manual_entry ? 'No' : 'Yes'}</ReadOnlyFact>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
