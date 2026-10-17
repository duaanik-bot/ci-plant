// HR → Settings (admin only — HR.jsx does not show the tab to anyone else, and this file
// checks again). Spec §6, §7, §15. Five panels behind a pill switcher:
//
//   Policy             the payroll policy keys (rounding, warning thresholds, strict separation,
//                      which blank cells of the monthly sheet count as zero)
//   Pay channels       how people are paid: bank allocations and cash
//   Access             who may open HR & Payroll, and at which level
//   Column maps        the monthly-sheet column maps the system has remembered, with delete
//   Load from workbook the one-time go-live loader (WorkbookLoader.jsx)
//
// A panel mounts the first time it is opened and then stays mounted (hidden when another is
// showing): its data is read only when someone looks at it, and a half-typed policy form or a
// previewed workbook is not thrown away by a glance at another panel.
//
// A server refusal (LAST_ADMIN, CODE_EXISTS, a validation message …) reaches the central error
// toast, and wherever it was raised from a dialog it is ALSO said inline in that dialog, in the
// server's own words (refusalText), because the toast is brief and a dialog can stand over it.
// Every handler here catches, says it, returns, and leaves the form exactly as it was typed.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Columns3, FileSpreadsheet, Landmark, Pencil, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { fmt } from '../../api.js';
import {
  Button, Checkbox, ConfirmDialog, DataTable, Field, Input, Modal, Select, SubTabs, useToast,
} from '../../components/ui.jsx';
import { HR_LEVELS, HR_LEVEL_LABELS, hrApi, levelAtLeast } from '../../lib/hr.js';
import { InlineError, parseNum, refusalText } from './PersonDrawer.jsx';
import WorkbookLoader from './WorkbookLoader.jsx';

const ErrText = ({ children }) => <span className="font-semibold text-red-600">{children}</span>;
const Loading = ({ children = 'Loading…' }) => <div className="p-8 text-sm text-slate-400">{children}</div>;
const PanelTitle = ({ icon: Icon, children }) => (
  <div className="ci-form-panel-title"><span className="flex items-center gap-1.5"><Icon size={13} /> {children}</span></div>
);
const last4Of = v => String(v ?? '').replace(/\s+/g, '').slice(-4);

// ── Policy ──────────────────────────────────────────────────────────────────
// The keys are hr.settings' (seeded in the HR migration). A number is typed as plain text and
// sent as a number; only keys that changed are sent.

const POLICY_NUMBERS = [
  { key: 'ot_high_hours', label: 'High-OT warning above', unit: 'hours a month', dp: 2,
    hint: 'A line with more overtime than this is flagged for a look.' },
  { key: 'deduction_warn_pct', label: 'Deductions warning above', unit: '% of gross pay', dp: 2, max: 100,
    hint: 'Loans plus other deductions above this share of gross are flagged. Advances are left out — they are wages already paid.' },
  { key: 'variance_warn_pct', label: 'Change-on-last-month warning above', unit: '%', dp: 2,
    hint: 'A line whose pay moved by more than this since last month needs an explanation.' },
  { key: 'holiday_divisor_default', label: 'Holiday divisor, default', unit: 'days', dp: 4, positive: true,
    hint: 'Offered when a pay revision uses the holiday formula (base ÷ divisor × multiplier).' },
];
const BLANK_ZERO_COLUMNS = [
  ['ot_hours', 'OT hours'], ['absent_days', 'Absent days'], ['misc_earning', 'Misc'],
  ['advance_given', 'Advance'], ['bill_amount', 'Bill amount'],
];

function policyForm(s) {
  const t = v => (v == null ? '' : String(v));
  return {
    rounding: s?.rounding === 'paise' ? 'paise' : 'rupee',
    ot_high_hours: t(s?.ot_high_hours),
    deduction_warn_pct: t(s?.deduction_warn_pct),
    variance_warn_pct: t(s?.variance_warn_pct),
    holiday_divisor_default: t(s?.holiday_divisor_default),
    strict_separation: s?.strict_separation === true,
    // Keys this screen does not know are carried through untouched.
    blank_zero: {
      ...(s?.blank_zero && typeof s.blank_zero === 'object' ? s.blank_zero : {}),
      ...Object.fromEntries(BLANK_ZERO_COLUMNS.map(([k]) => [k, s?.blank_zero?.[k] === true])),
    },
  };
}

// What differs from the loaded settings (only that is sent), and what is wrong with it.
function policyDiff(form, loaded) {
  const was = policyForm(loaded);
  const changes = {};
  const errors = {};
  if (form.rounding !== was.rounding) changes.rounding = form.rounding;
  for (const f of POLICY_NUMBERS) {
    const r = parseNum(form[f.key], f.dp);
    if (r.blank) { errors[f.key] = 'Enter a number.'; continue; }
    if (r.error) { errors[f.key] = r.error; continue; }
    if (f.positive && r.value <= 0) { errors[f.key] = 'Must be above 0.'; continue; }
    if (f.max != null && r.value > f.max) { errors[f.key] = `At most ${f.max}.`; continue; }
    if (was[f.key] === '' || r.value !== Number(was[f.key])) changes[f.key] = r.value;
  }
  if (form.strict_separation !== was.strict_separation) changes.strict_separation = form.strict_separation;
  if (BLANK_ZERO_COLUMNS.some(([k]) => form.blank_zero[k] !== was.blank_zero[k])) changes.blank_zero = form.blank_zero;
  return { changes, errors };
}

function PolicyPanel() {
  const toast = useToast();
  const [loaded, setLoaded] = useState(null);
  const [form, setForm] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await hrApi.settings();
      setLoaded(s || {});
      setForm(policyForm(s));
    } catch {
      setLoaded(cur => cur ?? false); // the central toast has the reason
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { changes, errors } = useMemo(() => (form && loaded ? policyDiff(form, loaded) : { changes: {}, errors: {} }), [form, loaded]);
  const dirty = Object.keys(changes).length > 0;
  const invalid = Object.keys(errors).length > 0;
  const set = (key, value) => setForm(cur => ({ ...cur, [key]: value }));

  const save = async () => {
    try {
      await hrApi.saveSettings(changes);
    } catch { return; } // refused — the form keeps what was typed
    toast.success('Policy saved');
    await load();
  };

  if (loaded === false) {
    return (
      <div className="ci-form-panel">
        <PanelTitle icon={SlidersHorizontal}>Payroll policy</PanelTitle>
        <p className="text-sm text-[#515154]">The policy could not be loaded.</p>
        <div className="mt-3"><Button variant="secondary" onClick={() => { setLoaded(null); load(); }}>Try again</Button></div>
      </div>
    );
  }
  if (!form) return <Loading />;
  return (
    <div className="ci-form-panel">
      <PanelTitle icon={SlidersHorizontal}>Payroll policy</PanelTitle>
      <div className="ci-form-grid">
        <Field label="Payable amount is rounded to"
          hint="Rounding shows as its own line on the payslip; ‘paise’ turns it off.">
          <Select value={form.rounding} onChange={e => set('rounding', e.target.value)}>
            <option value="rupee">The nearest rupee</option>
            <option value="paise">Paise (no rounding)</option>
          </Select>
        </Field>
        {POLICY_NUMBERS.map(f => (
          <Field key={f.key} label={f.label} hint={errors[f.key] ? <ErrText>{errors[f.key]}</ErrText> : f.hint}>
            <div className="flex items-center gap-2">
              <Input className="max-w-[10rem]" inputMode="decimal" autoComplete="off" value={form[f.key]}
                onChange={e => set(f.key, e.target.value)} />
              <span className="shrink-0 text-xs font-semibold text-[#6E6E73]">{f.unit}</span>
            </div>
          </Field>
        ))}
      </div>
      <div className="mt-4 space-y-4">
        <div>
          <Checkbox label="Strict separation of duties — whoever submitted a run cannot approve it" checked={form.strict_separation}
            onChange={e => set('strict_separation', e.target.checked)} />
          <p className="ml-6 mt-0.5 text-xs text-gray-400">Off, an approval by the person who submitted shows a warning but is allowed.</p>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-600">A blank cell in the monthly sheet counts as 0 for</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {BLANK_ZERO_COLUMNS.map(([key, label]) => (
              <Checkbox key={key} label={label} checked={form.blank_zero[key] === true}
                onChange={e => set('blank_zero', { ...form.blank_zero, [key]: e.target.checked })} />
            ))}
          </div>
          <p className="mt-1 text-xs text-gray-400">A blank is otherwise kept as blank, never silently zero. Each saved column map can still change this per column.</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setForm(policyForm(loaded))} disabled={!dirty}>Reset</Button>
        <Button onClick={save} disabled={!dirty || invalid}>Save policy</Button>
      </div>
    </div>
  );
}

// ── Pay channels ────────────────────────────────────────────────────────────
// The list carries the account masked; this screen shows only its last four whatever arrives.
// The number is write-only here: the edit form never shows or sends the one on file, and a
// blank account box on an edit means "keep it".

const CHANNEL_KIND = { bank: 'Bank', cash: 'Cash' };
const BLANK_CHANNEL = { isNew: true, code: '', label: '', kind: 'bank', bank_name: '', account: '', onFile: '' };

function ChannelsPanel() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await hrApi.payChannels();
      setRows(Array.isArray(r) ? r : []);
      setFailed(false);
    } catch {
      setFailed(true);
      setRows(cur => cur ?? []);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const edit = r => setEditing({
    isNew: false, code: r.code, label: r.label || '', kind: r.kind === 'cash' ? 'cash' : 'bank',
    bank_name: r.bank_name || '', account: '', onFile: last4Of(r.account),
  });
  // `error` rides in the dialog's own state: what the server (or the form check) last said about
  // the input as it was, shown above the buttons and cleared by the next edit.
  const set = (key, value) => setEditing(cur => ({ ...cur, [key]: value, error: null }));
  const say = error => setEditing(cur => (cur ? { ...cur, error } : cur));

  const save = async () => {
    const e = editing;
    const code = e.code.trim();
    if (!code || !e.label.trim()) { say('Enter the code and the name.'); return; }
    const bank = e.kind === 'bank';
    const account = e.account.replace(/\s+/g, '');
    const body = { code, label: e.label.trim(), kind: e.kind, bank_name: bank ? (e.bank_name.trim() || null) : null };
    if (!bank) body.account = null; // a cash channel has no account
    else if (account) body.account = account; // typed: the new number
    else if (e.isNew) body.account = null; // nothing typed on an edit: keep the one on file (field left out)
    say(null);
    try {
      await (e.isNew ? hrApi.addPayChannel(body) : hrApi.savePayChannel(code, body));
    } catch (err) {
      say(refusalText(err)); // refused — said in the dialog, which stays open with what was typed
      return;
    }
    toast.success(e.isNew ? 'Pay channel added' : 'Pay channel saved');
    setEditing(null);
    await load();
  };

  const columns = useMemo(() => [
    { key: 'code', label: 'Code', render: r => <span className="font-mono text-xs font-semibold text-[#515154]">{r.code}</span> },
    { key: 'label', label: 'Name', card: 'title', render: r => <span className="font-semibold text-[#1D1D1F]">{r.label || r.code}</span> },
    { key: 'kind', label: 'Kind', render: r => CHANNEL_KIND[r.kind] || r.kind || '—' },
    { key: 'bank_name', label: 'Bank', render: r => (r.kind === 'bank' && r.bank_name ? r.bank_name : '—') },
    { key: 'account', label: 'Account', sortable: false,
      render: r => (last4Of(r.account) ? <span className="whitespace-nowrap font-mono text-xs">•••• {last4Of(r.account)}</span> : '—') },
    { key: 'active', label: 'Status', card: 'status', sortValue: r => (r.active === false ? 1 : 0),
      render: r => (r.active === false
        ? <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Inactive</span>
        : <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Active</span>) },
    { key: '_edit', label: '', card: 'actions',
      render: r => (
        <Button size="sm" variant="secondary" onClick={() => edit(r)}><Pencil size={12} /> Edit</Button>
      ) },
  ], []);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-[#515154]">
          How people are paid. A person is linked to a channel by its code, so a code is permanent.
        </p>
        <Button size="sm" onClick={() => setEditing({ ...BLANK_CHANNEL })}><Plus size={14} /> Add channel</Button>
      </div>
      {rows == null ? <Loading /> : (
        <DataTable columns={columns} rows={rows} getRowId={r => r.code} serialNumber={false}
          defaultSort={{ key: 'code', dir: 'asc' }}
          empty={failed ? 'The pay channels could not be loaded.' : 'No pay channels yet — add one, or load them with the salary workbook.'} />
      )}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)}
        title={editing?.isNew ? 'Add pay channel' : `Edit pay channel — ${editing?.code || ''}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={save}>{editing?.isNew ? 'Add channel' : 'Save'}</Button>
        </>}>
        {editing && (
          <div data-ci-form className="space-y-3">
            <Field label="Code" required hint="Short and permanent — people are linked to a channel by its code.">
              <Input value={editing.code} disabled={!editing.isNew} autoComplete="off" onChange={e => set('code', e.target.value)} />
            </Field>
            <Field label="Name" required>
              <Input value={editing.label} autoComplete="off" onChange={e => set('label', e.target.value)} />
            </Field>
            <Field label="Kind" required>
              <Select value={editing.kind} onChange={e => set('kind', e.target.value)}>
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
              </Select>
            </Field>
            {editing.kind === 'bank' && (
              <>
                <Field label="Bank name">
                  <Input value={editing.bank_name} autoComplete="off" onChange={e => set('bank_name', e.target.value)} />
                </Field>
                <Field label="Account number"
                  hint={editing.isNew ? undefined : `${editing.onFile ? `On file: •••• ${editing.onFile}. ` : 'None on file. '}Leave blank to keep it.`}>
                  <Input className="font-mono" inputMode="numeric" autoComplete="off" spellCheck={false}
                    value={editing.account} onChange={e => set('account', e.target.value)} />
                </Field>
              </>
            )}
            <InlineError message={editing.error} className="" />
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Access ──────────────────────────────────────────────────────────────────
// Every login in the ERP, and the HR level it holds (none = cannot open HR & Payroll at all).
// A change is saved the moment it is picked. The select shows the SERVER's answer: a refused
// change (the last admin cannot be removed) is reloaded away rather than left looking saved.

function AccessPanel() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const [rev, setRev] = useState(0); // bumped after every attempt so each select shows the server's level
  const [refusal, setRefusal] = useState(null); // the server's reason the last change was refused

  const load = useCallback(async () => {
    try {
      const r = await hrApi.accessList();
      setRows(Array.isArray(r) ? r : []);
      setFailed(false);
    } catch {
      setFailed(true);
      setRows(cur => cur ?? []);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const change = async (row, picked) => {
    const next = picked || 'none';
    if (next === (row.level || 'none')) { setRev(n => n + 1); return; }
    setRefusal(null);
    try {
      await hrApi.setAccess(row.user_id, next === 'none' ? '' : next);
      toast.success(next === 'none' ? `${row.name}: HR access removed` : `${row.name}: ${HR_LEVEL_LABELS[next]}`);
    } catch (e) {
      // Refused (LAST_ADMIN …): the select snaps back below; the reason stays on screen after the toast is gone.
      setRefusal(`${row.name}: ${refusalText(e)}`);
    }
    await load();
    setRev(n => n + 1);
  };

  const columns = useMemo(() => [
    { key: 'name', label: 'User', card: 'title', render: r => <span className="font-semibold text-[#1D1D1F]">{r.name}</span> },
    { key: 'email', label: 'Email', card: 'subtitle', render: r => r.email || '—' },
    { key: 'role', label: 'ERP role', render: r => (r.role ? fmt.title(r.role) : '—') },
    { key: 'level', label: 'HR access', card: 'metric', sortValue: r => HR_LEVELS.indexOf(r.level),
      render: r => (
        <div className="w-44">
          <Select key={`${r.user_id}:${r.level || 'none'}:${rev}`} value={r.level || 'none'} onChange={e => change(r, e.target.value)}>
            <option value="none">No access</option>
            {HR_LEVELS.map(l => <option key={l} value={l}>{HR_LEVEL_LABELS[l]}</option>)}
          </Select>
        </div>
      ) },
  ], [rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const withAccess = (rows || []).filter(r => r.level).length;
  return (
    <div>
      <p className="mb-3 text-sm text-[#515154]">
        Only the logins given a level here can open HR &amp; Payroll — a login&rsquo;s ERP role, even admin, gives none. The list
        is read afresh on every request, so a change takes effect at once. Keep the shared plant login off it.
        {rows && <span className="ml-1 font-semibold text-[#1D1D1F]">{withAccess} of {rows.length} logins have access.</span>}
      </p>
      <InlineError message={refusal} className="mb-3" />
      {rows == null ? <Loading /> : (
        <DataTable columns={columns} rows={rows} getRowId={r => r.user_id} serialNumber={false} searchable
          searchPlaceholder="Search logins…" defaultSort={{ key: 'name', dir: 'asc' }}
          empty={failed ? 'The access list could not be loaded.' : 'No logins.'} />
      )}
    </div>
  );
}

// ── Saved column maps ───────────────────────────────────────────────────────
// The monthly import remembers a confirmed column map by its header signature and applies it
// next month. Deleting one makes the next sheet with those headers start from the automatic
// guess again. GET /hr/column-maps → [{ id, signature, map, blank_zero, last_used }];
// DELETE /hr/column-maps/:id → { ok: true } (hrApi.columnMaps / hrApi.removeColumnMap).

function ColumnMapsPanel() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await hrApi.columnMaps();
      setRows(Array.isArray(r) ? r : []);
      setFailed(false);
    } catch {
      setFailed(true);
      setRows(cur => cur ?? []);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const askRemove = r => { setRemoveError(null); setRemoving(r); };
  // Rejects when the server refuses, which keeps the dialog open; the reason is said inside it.
  const remove = async () => {
    setRemoveError(null);
    try {
      await hrApi.removeColumnMap(removing.id);
    } catch (e) {
      setRemoveError(refusalText(e));
      throw e;
    }
    toast.success('Column map deleted');
    await load();
  };

  const columns = useMemo(() => [
    { key: 'signature', label: 'Sheet headers', card: 'title',
      render: r => {
        const sig = String(r.signature ?? '').split('|').map(s => s.trim()).filter(Boolean).join(' · ');
        return <span className="block max-w-[34rem] break-words text-xs text-[#515154]" title={sig}>{sig.length > 160 ? `${sig.slice(0, 159)}…` : sig || '—'}</span>;
      } },
    { key: 'map', label: 'Mapped columns', align: 'right', card: 'metric',
      sortValue: r => Object.keys(r.map || {}).length, render: r => Object.keys(r.map || {}).length },
    { key: 'last_used', label: 'Last used', sortValue: r => r.last_used || '',
      render: r => (r.last_used ? fmt.date(r.last_used) : 'Never') },
    { key: '_delete', label: '', card: 'actions',
      render: r => (
        <Button size="sm" variant="secondary" onClick={() => askRemove(r)}><Trash2 size={12} /> Delete</Button>
      ) },
  ], []);

  return (
    <div>
      <p className="mb-3 text-sm text-[#515154]">
        When a monthly sheet&rsquo;s columns are confirmed, the map is remembered by the sheet&rsquo;s headers and applied
        automatically next month. Delete one to make the next sheet with those headers start again from the automatic guess.
      </p>
      {rows == null ? <Loading /> : (
        <>
          {failed && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
              <span className="min-w-0 flex-1">The saved column maps could not be loaded.</span>
              <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
            </div>
          )}
          <DataTable columns={columns} rows={rows} getRowId={r => r.id} serialNumber={false}
            empty={failed ? 'The saved column maps could not be loaded.' : 'No column maps saved yet — one is saved the first time a monthly sheet is mapped.'} />
        </>
      )}
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={remove} danger
        title="Delete this column map?" confirmLabel="Delete"
        message={<>The next sheet with these headers will be mapped from scratch. Months already imported are not changed.<InlineError message={removeError} /></>} />
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

const VIEWS = [
  { key: 'policy', label: 'Policy', icon: SlidersHorizontal },
  { key: 'channels', label: 'Pay channels', icon: Landmark },
  { key: 'access', label: 'Access', icon: ShieldCheck },
  { key: 'maps', label: 'Column maps', icon: Columns3 },
  { key: 'loader', label: 'Load from workbook', icon: FileSpreadsheet },
];
const PANELS = { policy: PolicyPanel, channels: ChannelsPanel, access: AccessPanel, maps: ColumnMapsPanel, loader: WorkbookLoader };

export default function Settings({ level }) {
  const [view, setView] = useState('policy');
  const [opened, setOpened] = useState(() => new Set(['policy']));
  const pick = key => {
    setView(key);
    setOpened(cur => (cur.has(key) ? cur : new Set(cur).add(key)));
  };

  if (!levelAtLeast(level, 'admin')) {
    return (
      <div className="glass rounded-[22px] border border-white/70 p-10 text-center shadow-card">
        <p className="text-sm font-bold text-[#1D1D1F]">Settings are for HR admins.</p>
      </div>
    );
  }
  return (
    <div>
      <SubTabs views={VIEWS} active={view} onChange={pick} className="mb-4" />
      {VIEWS.filter(v => opened.has(v.key)).map(v => {
        const Panel = PANELS[v.key];
        return <div key={v.key} hidden={view !== v.key}><Panel /></div>;
      })}
    </div>
  );
}
