// HR · Import → a new person straight from a sheet row (owner's request 2026-11-14: "for the new entries, give an
// option to create master, ask the relevant details there itself while creating, keep the seamless experience").
//
// Opens inside the row card for a row nobody matches. Everything is filled in from the sheet where it can be:
//   name        the sheet's spelling, in title case (the sheet's own spelling is remembered as an alias by the server)
//   code        the sheet's code, else the next free number after the highest numeric code
//   department  the sheet's department column, else a known department named in the row's name ("… PASTING HELPER")
//   pay channel the sheet's pay channel / trans mode, matched to a channel by code or label
//   base pay    from the remark: "SALARY 13K" → 13000, "SALARY 9500" → 9500
//   OT          from the remark: "OT-8HOUR", "OT 8 HOUR" → 8 hours a day; else 6 (most people's)
//   holiday pay on, base ÷ 30.5 × 1.5 (most people's)
// Create sends POST /hr/imports/:id/rows/:rowId/new-person: the person, their pay setup from the 1st of the month and
// the row matched to them, in one go. Accounts and up.
import { useEffect, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button, Checkbox, Input, Select } from '../../components/ui.jsx';
import { hrApi } from '../../lib/hr.js';
import { refusalText } from './PersonDrawer.jsx';

const titleCase = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\s+/g, ' ').trim();
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export function salaryFromRemark(remark) {
  const t = String(remark || '').toUpperCase();
  const k = /SALARY\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*K\b/.exec(t) || /\b(\d+(?:\.\d+)?)\s*K\b/.exec(t);
  if (k) return String(Math.round(Number(k[1]) * 1000));
  const plain = /SALARY\s*[:=-]?\s*(\d{3,6})\b/.exec(t);
  return plain ? plain[1] : '';
}
export function otFromRemark(remark) {
  const m = /OT\s*[-:]?\s*(\d+(?:\.\d+)?)\s*-?\s*H(?:OU)?RS?\b/.exec(String(remark || '').toUpperCase());
  return m ? m[1] : '';
}

const Label = ({ children }) => <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-[0.06em] text-[#86868B]">{children}</span>;

export default function NewPersonFromRow({ batchId, row, people, onCreated, onCancel }) {
  const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
  const [channels, setChannels] = useState([]);
  useEffect(() => { hrApi.payChannels().then(c => setChannels(Array.isArray(c) ? c : []), () => {}); }, []);
  const departments = useMemo(() => [...new Set(people.map(p => p.department).filter(Boolean).map(String))].sort(), [people]);
  const nextCode = useMemo(() => {
    const nums = people.map(p => Number(p.code)).filter(n => Number.isInteger(n));
    return nums.length ? String(Math.max(...nums) + 1) : '';
  }, [people]);
  const guessDept = () => {
    if (f.department) return String(f.department).toUpperCase();
    const words = new Set(norm(f.name).split(' '));
    return departments.find(d => words.has(norm(d))) || '';
  };
  const [v, setV] = useState(() => ({
    name: titleCase(f.name),
    code: f.code ? String(f.code) : nextCode,
    department: guessDept(),
    channel: '',
    worker_type: 'employee',
    pay_basis: 'monthly',
    base: salaryFromRemark(f.remarks),
    ot: otFromRemark(f.remarks) || '6',
    holiday: true,
    joined_on: '',
  }));
  const set = (k, val) => setV(x => ({ ...x, [k]: val }));
  useEffect(() => { if (!v.code && nextCode) set('code', nextCode); }, [nextCode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The sheet's channel, once the channels are read.
  useEffect(() => {
    if (v.channel || !channels.length) return;
    const want = norm(f.pay_channel);
    const hit = want && channels.find(c => norm(c.code) === want || norm(c.label) === want);
    if (hit) set('channel', hit.code);
  }, [channels]); // eslint-disable-line react-hooks/exhaustive-deps

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problems = [
    !v.name.trim() && 'Enter the name.',
    !v.code.trim() && 'Enter the payroll code.',
    v.pay_basis !== 'contract' && !/^\d+(\.\d{1,2})?$/.test(v.base.trim()) && 'Enter the monthly salary (₹).',
    !/^\d+(\.\d{1,4})?$/.test(String(v.ot).trim()) && 'OT hours a day must be a number (0 for no overtime).',
  ].filter(Boolean);

  const create = async () => {
    setBusy(true); setError('');
    try {
      const made = await hrApi.newPersonFromRow(batchId, row.id, {
        person: {
          name: v.name.trim(), code: v.code.trim(), department: v.department.trim() || null,
          pay_channel: v.channel || null, worker_type: v.worker_type, joined_on: v.joined_on || null,
        },
        setup: {
          pay_basis: v.pay_basis, base: v.pay_basis === 'contract' ? (v.base.trim() || null) : v.base.trim(),
          ot_hours_per_day: String(v.ot).trim(),
          ...(v.holiday ? { holiday_mode: 'formula', holiday_divisor: '30.5', holiday_multiplier: '1.5' } : { holiday_mode: 'none' }),
        },
      });
      await onCreated(made);
    } catch (e) {
      setError(refusalText(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2.5 rounded-xl border border-[#0A84FF]/30 bg-[#E1EFFF]/40 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-[#0064D2]"><UserPlus size={13} /> New person from this row — check and create</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block"><Label>Name</Label><Input value={v.name} onChange={e => set('name', e.target.value)} /></label>
        <label className="block"><Label>Payroll code</Label><Input value={v.code} onChange={e => set('code', e.target.value)} /></label>
        <label className="block"><Label>Department</Label>
          <Input list={`depts-${row.id}`} value={v.department} onChange={e => set('department', e.target.value.toUpperCase())} />
          <datalist id={`depts-${row.id}`}>{departments.map(d => <option key={d} value={d} />)}</datalist>
        </label>
        <label className="block"><Label>Pay channel</Label>
          <Select value={v.channel} placeholder="Choose" options={channels.map(c => ({ value: c.code, label: c.label || c.code }))}
            onChange={e => set('channel', e.target.value || '')} />
        </label>
        <label className="block"><Label>Type</Label>
          <Select value={v.worker_type} options={[{ value: 'employee', label: 'Employee' }, { value: 'contractor', label: 'Contractor' }]}
            onChange={e => { const t = e.target.value || 'employee'; set('worker_type', t); set('pay_basis', t === 'contractor' ? 'contract' : 'monthly'); }} />
        </label>
        <label className="block"><Label>{v.pay_basis === 'contract' ? 'Base (optional, contract)' : 'Monthly salary ₹'}</Label>
          <Input inputMode="decimal" value={v.base} onChange={e => set('base', e.target.value)} /></label>
        <label className="block"><Label>OT hours a day (0 = no OT)</Label>
          <Input inputMode="decimal" value={v.ot} onChange={e => set('ot', e.target.value)} /></label>
        <label className="block"><Label>Joined on (optional)</Label>
          <Input type="date" value={v.joined_on} onChange={e => set('joined_on', e.target.value)} /></label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Checkbox label="Holiday pay (base ÷ 30.5 × 1.5)" checked={v.holiday} onChange={e => set('holiday', e.target.checked)} />
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={create} disabled={busy || problems.length > 0}>{busy ? 'Creating…' : 'Create and match this row'}</Button>
        </span>
      </div>
      {problems.length > 0 && <p className="mt-1 text-[11px] text-[#86868B]">{problems[0]}</p>}
      {error && <p role="alert" className="mt-1 text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}
