// HR → Payroll → Entry sheet (owner's request 2026-11-14): "when we come to a new payroll month we should have the
// list of employees, so that if there is no sheet we can take manual entries in bulk, or edit the entries; give the
// provision to save and lock it as is, and unlock it."
//
// One row per person — everyone active, plus anyone already in the month — and one column per input a sheet would
// carry, as September's payroll used them (absent days, OT hours, misc, advance, contractors' bill, remarks, in month). Type straight into the cells; Enter or ↓ moves down the column, ↑ up. Save sends only what changed
// (PUT /hr/runs/:month/inputs); in a month with no payroll yet it saves everyone listed, which starts the month.
// Lock keeps the entries as they are (input edits, imports and recalculation wait) until someone unlocks them.
// Editable by an operator in a draft month that is not locked; otherwise read-only, with the reason shown.
import { useMemo, useRef, useState } from 'react';
import { Lock, LockOpen, Save, Search, Undo2 } from 'lucide-react';
import { Button, Input, useToast } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { refusalText } from './PersonDrawer.jsx';

// The columns September 2026's payroll actually used (owner's request 2026-11-14: "keep only relevant columns").
// Paid leave, deduction, bonus and the overrides were never used, so they are not here; one person's
// "paid separately" stays on their line in the drawer.
const COLS = [
  { key: 'absent_days', label: 'Absent days', num: true },
  { key: 'ot_hours', label: 'OT hours', num: true },
  { key: 'misc_earning', label: 'Misc ₹', num: true },
  { key: 'advance_given', label: 'Advance ₹', num: true },
  { key: 'bill_amount', label: 'Bill ₹ (contractors)', num: true },
  { key: 'remarks', label: 'Remarks', num: false, wide: true },
];
const NUM_RE = /^\d*(\.\d{0,4})?$/;

// A stored value as the cell shows it: '2.0000' → '2', null → ''.
const shown = v => {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /^-?\d+\.\d+$/.test(t) ? t.replace(/\.?0+$/, '') : t;
};

export default function EntrySheet({ month, run, people, inputs, lines, canOperate, monthClosed, onSaved }) {
  const toast = useToast();
  const [edits, setEdits] = useState(() => new Map());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const grid = useRef(null);

  const locked = Boolean(run?.inputs_locked_at);
  const draft = !run || run.status === 'draft';
  const canEdit = canOperate && draft && !locked && !monthClosed;
  const why = !canOperate ? 'Entering inputs needs HR operator access.'
    : monthClosed ? 'A later month is already finalised, so this month cannot change.'
      : !draft ? `${monthLabel(month)} is ${run.status}: change one person from their line, or send the month back to change many.`
        : locked ? `Locked${run.inputs_locked_by_name ? ` by ${run.inputs_locked_by_name}` : ''}${run.inputs_locked_at ? ` on ${String(run.inputs_locked_at).slice(0, 10)}` : ''}: unlock to change the entries.`
          : '';

  const inputBy = useMemo(() => new Map((inputs || []).map(i => [String(i.person_id), i])), [inputs]);
  const lineBy = useMemo(() => new Map((lines || []).map(l => [String(l.person_id), l])), [lines]);
  const rows = useMemo(() => {
    const ids = new Set((inputs || []).map(i => String(i.person_id)));
    const list = (people || []).filter(p => ids.has(String(p.id)) || p.status === 'active');
    const known = new Set(list.map(p => String(p.id)));
    for (const i of inputs || []) {
      if (!known.has(String(i.person_id))) list.push({ id: i.person_id, code: i.code, name: i.display_name || i.name, status: 'active' });
    }
    return list
      .map(p => ({ id: String(p.id), code: p.code || '', name: p.display_name || p.name || `Person #${p.id}`, department: p.department || '', person: p }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [people, inputs]);
  const shownRows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? rows.filter(r => `${r.name} ${r.code} ${r.department}`.toLowerCase().includes(t)) : rows;
  }, [rows, q]);

  const valueOf = (id, key) => {
    const e = edits.get(id);
    if (e && Object.hasOwn(e, key)) return e[key];
    const i = inputBy.get(id);
    if (key === 'include') return i ? i.include !== false : true;
    return i ? shown(i[key]) : '';
  };
  const setCell = (id, key, v) => {
    setEdits(m => {
      const n = new Map(m);
      const e = { ...(n.get(id) || {}) };
      const i = inputBy.get(id);
      const base = key === 'include' ? (i ? i.include !== false : true) : (i ? shown(i[key]) : '');
      if (v === base) delete e[key]; else e[key] = v;
      if (Object.keys(e).length) n.set(id, e); else n.delete(id);
      return n;
    });
  };
  const bad = useMemo(() => {
    const out = new Set();
    for (const [id, e] of edits) for (const c of COLS) if (c.num && Object.hasOwn(e, c.key) && !NUM_RE.test(String(e[c.key]).trim())) out.add(`${id}:${c.key}`);
    return out;
  }, [edits]);
  const fresh = !run;                               // no payroll yet: saving starts the month with everyone listed
  const pending = fresh ? rows.length : edits.size;

  const save = async () => {
    if (bad.size) { setError('Some cells are not numbers — they are outlined in red.'); return; }
    const send = (fresh ? rows.map(r => r.id) : [...edits.keys()]).map(id => {
      const e = edits.get(id) || {};
      const row = { person_id: Number(id) };
      for (const [k, v] of Object.entries(e)) {
        if (k === 'include') row.include = Boolean(v);
        else { const t = String(v).trim(); row[k] = t === '' ? null : t; }
      }
      if (Object.keys(row).length === 1) row.include = valueOf(id, 'include');
      return row;
    });
    if (!send.length) return;
    setBusy('save'); setError('');
    try {
      await hrApi.saveRunInputs(month, send, fresh ? 'Month entered by hand' : 'Entered by hand');
      setEdits(new Map());
      toast.success(fresh ? `${monthLabel(month)} started with ${send.length} people` : `${send.length} ${send.length === 1 ? 'person' : 'people'} saved`);
      await onSaved?.();
    } catch (e) { setError(refusalText(e)); } finally { setBusy(''); }
  };
  const lockOrUnlock = async which => {
    if (which === 'lock' && edits.size) { setError('Save or undo the changes first, then lock.'); return; }
    setBusy(which); setError('');
    try {
      await (which === 'lock' ? hrApi.lockRunInputs(month) : hrApi.unlockRunInputs(month));
      toast.success(which === 'lock' ? `${monthLabel(month)}'s entries locked` : `${monthLabel(month)}'s entries unlocked`);
      await onSaved?.();
    } catch (e) { setError(refusalText(e)); } finally { setBusy(''); }
  };

  // Enter / ↓ moves down the column, ↑ up.
  const move = (e, rowIdx, colIdx) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const to = rowIdx + (e.key === 'ArrowUp' ? -1 : 1);
    grid.current?.querySelector(`[data-cell="${to}:${colIdx}"]`)?.focus();
  };

  return (
    <section className="glass mb-3 rounded-[22px] border border-white/70 p-4 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Entry sheet — {monthLabel(month)}</h3>
        <span className="text-[11px] text-[#86868B]">{rows.length} people{edits.size ? ` · ${edits.size} changed` : ''}</span>
        {locked && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800"><Lock size={11} /> Locked</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <label className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#86868B]" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a person…" className="!h-8 !w-[200px] !pl-7 text-xs" />
          </label>
          {canEdit && edits.size > 0 && <Button size="sm" variant="ghost" onClick={() => { setEdits(new Map()); setError(''); }}><Undo2 size={13} /> Undo changes</Button>}
          {canEdit && (
            <Button size="sm" onClick={save} disabled={Boolean(busy) || (!fresh && !edits.size)}>
              <Save size={13} /> {busy === 'save' ? 'Saving…' : fresh ? `Save and start ${monthLabel(month)}` : `Save${edits.size ? ` (${edits.size})` : ''}`}
            </Button>
          )}
          {canOperate && run && draft && !monthClosed && (locked
            ? <Button size="sm" variant="secondary" onClick={() => lockOrUnlock('unlock')} disabled={Boolean(busy)}><LockOpen size={13} /> {busy === 'unlock' ? 'Unlocking…' : 'Unlock'}</Button>
            : <Button size="sm" variant="secondary" onClick={() => lockOrUnlock('lock')} disabled={Boolean(busy)} title="Keep the entries as they are until someone unlocks them"><Lock size={13} /> {busy === 'lock' ? 'Locking…' : 'Lock as is'}</Button>)}
        </span>
      </div>
      {why && <p className="mb-2 text-[11px] text-[#6E6E73]">{why}</p>}
      {fresh && canEdit && <p className="mb-2 text-[11px] text-[#6E6E73]">No sheet yet: type the month's figures here (blank counts as nothing) and save — that starts {monthLabel(month)} with everyone listed. You can still import a sheet later; it asks before replacing a typed entry.</p>}
      {error && <p role="alert" className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
      <div ref={grid} className="max-h-[70vh] overflow-auto rounded-2xl border border-white/75 bg-white/55">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-[1] bg-white/95">
            <tr className="ci-table-head">
              <th className="px-2 py-2 text-left">Person</th>
              {COLS.map(c => <th key={c.key} className={`px-1.5 py-2 ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
              <th className="px-1.5 py-2 text-center" title="In this month's payroll">In month</th>
              {run && <th className="px-2 py-2 text-right">Payable</th>}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r, ri) => {
              const changed = edits.has(r.id);
              const line = lineBy.get(r.id);
              const isNew = !inputBy.has(r.id);
              return (
                <tr key={r.id} className={`border-t border-[#1D1D1F]/[0.05] ${changed ? 'bg-[#E1EFFF]/50' : ''}`}>
                  <td className="whitespace-nowrap px-2 py-1">
                    <div className="font-semibold text-[#1D1D1F]">{r.name}</div>
                    <div className="text-[10px] text-[#86868B]">{[r.code, r.department].filter(Boolean).join(' · ')}{run && isNew ? ' · not in this month yet' : ''}</div>
                  </td>
                  {COLS.map((c, ci) => (
                    <td key={c.key} className="px-1 py-1">
                      <input data-cell={`${ri}:${ci}`} value={valueOf(r.id, c.key)} disabled={!canEdit}
                        inputMode={c.num ? 'decimal' : 'text'} autoComplete="off"
                        onChange={e => setCell(r.id, c.key, e.target.value)} onKeyDown={e => move(e, ri, ci)}
                        className={`h-7 rounded-lg border bg-white/80 px-1.5 outline-none focus:border-[#007AFF] disabled:bg-transparent disabled:text-[#515154] ${c.wide ? 'w-full min-w-[220px] text-left' : 'w-[90px] text-right tabular-nums'} ${bad.has(`${r.id}:${c.key}`) ? 'border-red-400' : 'border-[#1D1D1F]/10'}`} />
                    </td>
                  ))}
                  <td className="px-1 py-1 text-center">
                    <input type="checkbox" checked={valueOf(r.id, 'include')} disabled={!canEdit} onChange={e => setCell(r.id, 'include', e.target.checked)} />
                  </td>
                  {run && <td className="whitespace-nowrap px-2 py-1 text-right font-semibold tabular-nums">{line ? inr2(line.payable) : '—'}</td>}
                </tr>
              );
            })}
            {!shownRows.length && <tr><td colSpan={COLS.length + 3} className="px-3 py-6 text-center text-[#86868B]">{rows.length ? 'Nobody matches.' : 'No active people yet — add them in People.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
