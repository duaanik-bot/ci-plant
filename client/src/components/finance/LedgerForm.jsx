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
//
// Cash & Bank (spec §5.4; plan Task 15):
//   • A ledger under Cash-in-Hand (the chosen group's is_cash, the groups read's word) may be held by a person: the holder's name and an
//     optional float, typed in rupees (setup.js finHolderFloat, money.js finToPaiseTyped), are offered there and nowhere else, to whoever
//     may save the form (the holder is the accountant's as much as the admin's). Never on the book's built-in Cash, though: that is office
//     cash, the CASH channel's default, and a holder is always a ledger of its own (ruling R61, finHolderShown). A holder left on a ledger
//     moved out of Cash-in-Hand is the server's to refuse (FIN_HOLDER_NOT_CASH), and its sentence is shown where the group is. A float
//     that does not read holds the save only while it is shown (ruling R62: no field the form does not show stops a save).
//   • A ledger that holds a staff role in HR & payroll setup (GET /finance/hr-setup's roles, read only where the group can be changed),
//     moved to a bank, cash or party group, is warned of (finRefiledStaffWarning): such a ledger can't hold that role (ruling R20a). It is
//     a warning only and never stops the save.
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast } from '../ui.jsx';
import { FieldError, ReadOnlyFact } from './SetupParts.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { groupOptions, renderGroupOption } from './GroupForm.jsx';
import useFormWrite from './useFormWrite.js';
import useParties from './useParties.js';
import useReport from './useReport.js';
import {
  FIN_PARTY_KINDS, finGroupChoices, finHolderFloat, finHolderFormOf, finHolderShown, finLedgerCreateBody, finLedgerEditBody, finLedgerFields,
  finLedgerFormOf, finPartyOptions, finPartyText, finRefiledStaffWarning,
} from '../../lib/finance/setup.js';

export default function LedgerForm({ book, groups, ledger = null, groupId = null, isAdmin, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const [form, setForm] = useState(() => ({ ...finLedgerFormOf(ledger, { group_id: groupId }), ...finHolderFormOf(ledger) }));
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const fields = finLedgerFields(ledger, { isAdmin });
  const parties = useParties(fields.party ? form.party_type : '');
  // A cash holder, under Cash-in-Hand only and never on the built-in Cash (ruling R61); and the staff roles, for a ledger an Admin may move.
  const chosenGroup = groups.find(g => String(g.id) === String(form.group_id)) ?? null;
  const holderShown = finHolderShown({ ledger, group: chosenGroup });
  const floatRead = finHolderFloat(form.float_text);
  const rolesRead = useReport(ledger && fields.group ? `/finance/hr-setup?book=${book.id}` : null);
  const refiled = finRefiledStaffWarning({ ledger, groupId: form.group_id, groups, roles: rolesRead.data?.roles ?? null });

  const groupChoices = useMemo(() => groupOptions(finGroupChoices(groups)), [groups]);
  const partyOptions = useMemo(() => finPartyOptions(form.party_type, parties.list, ledger), [form.party_type, parties.list, ledger]);
  const kindLabel = FIN_PARTY_KINDS.find(k => k.key === form.party_type)?.label ?? '';

  const linkMissing = fields.party && form.party_type !== '' && form.party_id === '';
  const ready = form.name.trim() !== '' && form.group_id != null && form.group_id !== '' && !linkMissing && !(holderShown && floatRead.error);

  const save = async () => {
    const done = await attempt(
      async () => {
        if (!ledger) return api.post('/finance/ledgers', finLedgerCreateBody(form, book.id, { holder: holderShown }));
        return api.put(`/finance/ledgers/${ledger.id}`, finLedgerEditBody(form, { isAdmin, holder: holderShown }));
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
            {!holderShown && <FieldError>{problems.holder_name || problems.float_paise}</FieldError>}
          </Field>
        ) : null}
        {refiled && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{refiled}</p>}

        {ledger?.is_system && chosenGroup?.is_cash === true && (
          <p className="text-xs text-slate-500">This is the book&apos;s office cash, so it has no holder: a holder&apos;s cash is a ledger of its own.</p>
        )}
        {holderShown && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Held by" hint="The person who keeps this cash. It stays the company's cash, never an advance to them.">
              <Input value={form.holder_name} maxLength={255} placeholder="No holder" onChange={e => set({ holder_name: e.target.value })} />
              <FieldError>{problems.holder_name}</FieldError>
            </Field>
            <Field label="Float, in rupees" hint="What the holder is meant to keep; Cash & Bank offers a top-up to it.">
              <Input value={form.float_text} inputMode="decimal" placeholder="No float" className="tabular-nums"
                onChange={e => set({ float_text: e.target.value })} />
              {floatRead.error && <FieldError>{floatRead.error}</FieldError>}
              <FieldError>{problems.float_paise}</FieldError>
            </Field>
          </div>
        )}

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
