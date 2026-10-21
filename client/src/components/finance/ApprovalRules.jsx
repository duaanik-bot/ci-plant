// ApprovalRules: Setup's fourth tab (spec §6.8, §7.3, §10). Props: { book, can }.
//
// The book's ten rules, one for each kind of entry and one for reversals: when an Approver is needed before an entry posts.
//   Always         every entry of the kind waits for an Approver
//   Above a limit  only an entry whose total is more than the limit waits
//   Never          an entry of the kind posts as soon as it is submitted
// An entry made by an Approver posts at once whatever the rule (it is marked self-approved), and a month that is closing always needs
// an Approver; the rules say the rest. GET /finance/approval-rules?book=<id> lists them, with each limit in paise. Editing one is the
// admin's (capability `admin`): PUT /finance/approval-rules/:id { mode, limit_paise }. The limit is TYPED in rupees and goes through
// money.js's finToPaiseTyped (finRuleBody: at most two decimals, Indian or Western grouping, nothing rounded or guessed at) and is sent
// only with "Above a limit", the one mode that has a limit. The list keeps the order the rules were made in, which is the spec's.
//
// The form's Save is the shared Button and hands back the promise of the write, so a second press does nothing; a refusal leaves the
// form open with what was typed, the server's sentence under the field it names, and a write that got no answer is said (useFormWrite).
import { useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, Input, Modal, useToast } from '../ui.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { FieldError } from './SetupParts.jsx';
import useFormWrite from './useFormWrite.js';
import useReport from './useReport.js';
import { finUnsorted } from '../../lib/finance/reports.js';
import { FIN_RULE_MODES, finRuleBody, finRuleChanged, finRuleFormOf, finRuleLabel, finRuleText, finSetupEmpty } from '../../lib/finance/setup.js';

function RuleForm({ rule, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const [form, setForm] = useState(() => finRuleFormOf(rule));
  const result = finRuleBody(form);
  const typing = form.mode === 'above_limit' && form.limitText.trim() !== '';
  const ready = result.ok && finRuleChanged(rule, result.body);

  const save = async () => {
    const done = await attempt(() => api.put(`/finance/approval-rules/${rule.id}`, result.body), { onFail: onFailed });
    if (!done) return;
    toast.success(`${finRuleLabel(rule.rule_key)} rule saved`);
    await onSaved();
  };

  return (
    <Modal open onClose={onClose} title={`${finRuleLabel(rule.rule_key)}: when is an Approver needed?`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready}>Save</Button>
      </>}>
      <div role="radiogroup" aria-label="When an Approver is needed" className="space-y-2">
        {FIN_RULE_MODES.map(mode => (
          <label key={mode.key}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2.5 transition ${form.mode === mode.key
              ? 'border-[#0A84FF]/50 bg-[#E1EFFF]/50' : 'border-[#1D1D1F]/10 bg-white/50 hover:bg-white/80'}`}>
            <input type="radio" name="rule-mode" className="mt-1 h-4 w-4 accent-[#007AFF]" checked={form.mode === mode.key}
              onChange={() => setForm(f => ({ ...f, mode: mode.key }))} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-[#1D1D1F]">{mode.label}</span>
              <span className="block text-xs text-slate-500">{mode.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {form.mode === 'above_limit' && (
        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium leading-snug text-slate-600">Limit, in rupees <span className="text-brand-500">*</span></span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-500">₹</span>
            <Input autoFocus inputMode="decimal" value={form.limitText} placeholder="1,00,000" className="max-w-[14rem] tabular-nums"
              onChange={e => setForm(f => ({ ...f, limitText: e.target.value }))} />
          </div>
          <span className="mt-1 block text-xs text-gray-400">An entry for more than this waits for an Approver. Up to two decimals.</span>
          {typing && !result.ok && <FieldError>{result.error}</FieldError>}
          <FieldError>{problems.limit_paise}</FieldError>
        </label>
      )}
      <FieldError>{problems.mode}</FieldError>
      <FieldError>{problems.form}</FieldError>
    </Modal>
  );
}

export default function ApprovalRules({ book, can }) {
  const { data, failed, reload } = useReport(`/finance/approval-rules?${new URLSearchParams({ book: String(book.id) })}`);
  const [editing, setEditing] = useState(null);
  const rules = data?.rules ?? null;
  const mayEdit = can('admin');

  const columns = finUnsorted([
    { key: 'rule_key', label: 'Entry', card: 'title', render: r => <span className="font-semibold">{finRuleLabel(r.rule_key)}</span> },
    { key: 'mode', label: 'An Approver is needed', card: 'metric', render: r => finRuleText(r) },
    { key: 'updated_by', label: 'Last changed', card: 'detail', render: r => (r.updated_by ? `${r.updated_by} · ${fmt.dt(r.updated_at)}` : '') },
    { key: '_actions', label: '', card: 'actions', render: r => (mayEdit
      ? <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Edit</Button></div> : null) },
  ]);

  return (
    <div>
      <p className="mb-3 max-w-3xl text-xs text-slate-500">
        An entry waits for an Approver when its rule says so. An entry an Approver makes posts at once, marked self-approved, and an entry dated in a month that is closing always needs an Approver.
      </p>
      <LoadNotice failed={failed} shown={Boolean(rules)} what="the approval rules" onRetry={reload} />
      <DataTable rows={rules ?? []} columns={columns} getRowId={r => r.id} serialNumber={false}
        empty={finSetupEmpty({ known: Boolean(rules), failed, none: 'This book has no approval rules.' })} />
      {editing && <RuleForm rule={editing} onClose={() => setEditing(null)} onFailed={reload} onSaved={async () => { setEditing(null); await reload(); }} />}
    </div>
  );
}
