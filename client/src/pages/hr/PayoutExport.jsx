// HR → a month's payout list as PDF, Excel or print (owner, 2026-11-18: "my main purpose is to bifurcate between
// what is pending in cash and what is pending in the bank … and if I want to have all, the whole list should come").
//
// Four lists: pending in cash, pending in the bank (every bank channel), pending in both (cash first, then each
// bank channel), and everyone in the month (paid and pending). "Pending" = a line with something to pay that is
// not paid yet: unpaid, on hold, failed or reversed — the status says which.
//
// It loads the month itself (run, people, pay channels), so it works the same on Payroll and on Overview, and for
// a restricted login it holds only what the server already sent that login: hidden people never reach it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, FileText, Loader2, Printer, ChevronDown } from 'lucide-react';
import { Button, useToast } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { APPROVAL_STATUS, PAYMENT_STATUS, approvalOf, paiseOf, plural, sumPaise } from './RunLineDrawer.jsx';

const owes = l => (paiseOf(l?.payable) ?? 0n) > 0n;
const statusOf = l => (PAYMENT_STATUS[l?.payment_status] ? l.payment_status : 'pending');
const isPending = l => owes(l) && statusOf(l) !== 'paid';

export const SCOPES = [
  { key: 'cash', label: 'Pending — Cash', sub: 'Still to pay in cash' },
  { key: 'bank', label: 'Pending — Bank', sub: 'Still to pay by bank, each channel' },
  { key: 'pending', label: 'Pending — Cash and Bank', sub: 'Both, cash first, with totals' },
  { key: 'all', label: 'Everyone this month', sub: 'The whole list, paid and pending' },
];
const FORMATS = [
  { kind: 'pdf', icon: FileText, label: 'PDF' },
  { kind: 'xlsx', icon: FileSpreadsheet, label: 'Excel' },
  { kind: 'print', icon: Printer, label: 'Print' },
];

// rows: [{ name, code, department, channel, channelLabel, kind, bank_last4, line }] → the exporter's spec.
export function payoutSpec({ month, scope, rows }) {
  const kindName = k => (k === 'cash' ? 'Cash' : k === 'bank' ? 'Bank' : 'No pay channel');
  const want = rows.filter(r => (scope === 'all' ? true : isPending(r.line)) && (scope === 'cash' ? r.kind === 'cash'
    : scope === 'bank' ? r.kind === 'bank' : true));
  const sum = rs => sumPaise(rs.map(r => r.line.payable));
  const cols = [
    { key: 'name', label: 'Name', export: r => r.name, pdfWeight: 2 },
    { key: 'code', label: 'Code', export: r => r.code ?? '' },
    { key: 'department', label: 'Department', export: r => r.department ?? '' },
    { key: 'channel', label: 'Pay channel', export: r => r.channelLabel },
    ...(scope === 'cash' ? [] : [{ key: 'bank', label: 'Bank a/c (last 4)', export: r => (r.kind === 'bank' && r.bank_last4 ? `…${r.bank_last4}` : '') }]),
    { key: 'payable', label: 'Payable', align: 'right', export: r => inr2(r.line.payable) },
    { key: 'status', label: 'Payment', export: r => (owes(r.line) || statusOf(r.line) !== 'pending' ? PAYMENT_STATUS[statusOf(r.line)].label : 'Nothing to pay') },
    { key: 'approval', label: 'Approval', export: r => APPROVAL_STATUS[approvalOf(r.line)].label },
    ...(scope === 'all' ? [
      { key: 'paid_on', label: 'Paid on', export: r => r.line.paid_on || '' },
      { key: 'ref', label: 'Reference', export: r => r.line.paid_ref || '' },
    ] : []),
  ];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  // One section per channel, cash channels first, then bank, then lines with no channel.
  const order = { cash: 0, bank: 1, none: 2 };
  const groups = new Map();
  for (const r of want) {
    const k = r.channel ?? '';
    if (!groups.has(k)) groups.set(k, { label: r.channelLabel, kind: r.kind, rows: [] });
    groups.get(k).rows.push(r);
  }
  const sections = [...groups.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || String(a.label).localeCompare(String(b.label)))
    .map(g => {
      const rs = g.rows.sort(byName);
      const pend = rs.filter(r => isPending(r.line));
      return {
        heading: g.label === kindName(g.kind) ? g.label : `${g.label} (${kindName(g.kind)})`,
        columns: cols,
        rows: rs,
        summary: scope === 'all'
          ? [{ label: 'People', value: rs.length }, { label: 'Payable', value: inr2(sum(rs)) },
            { label: 'Pending', value: `${inr2(sum(pend))} · ${pend.length}` }]
          : [{ label: 'People', value: rs.length }, { label: 'Pending', value: inr2(sum(rs)) }],
      };
    });
  const pend = want.filter(r => isPending(r.line));
  const cash = pend.filter(r => r.kind === 'cash');
  const bank = pend.filter(r => r.kind === 'bank');
  const none = pend.filter(r => r.kind === 'none');
  const summary = [
    ...(scope !== 'bank' ? [{ label: 'Pending in cash', value: `${inr2(sum(cash))} · ${plural(cash.length, 'person', 'people')}` }] : []),
    ...(scope !== 'cash' ? [{ label: 'Pending in bank', value: `${inr2(sum(bank))} · ${plural(bank.length, 'person', 'people')}` }] : []),
    ...(none.length ? [{ label: 'Pending, no channel', value: `${inr2(sum(none))} · ${plural(none.length, 'person', 'people')}` }] : []),
    ...(scope === 'pending' || scope === 'all' ? [{ label: 'Total pending', value: inr2(sum(pend)) }] : []),
    ...(scope === 'all' ? [{ label: 'Paid', value: inr2(sum(want.filter(r => statusOf(r.line) === 'paid'))) },
      { label: 'Payable (everyone)', value: inr2(sum(want)) }] : []),
  ];
  const what = SCOPES.find(s => s.key === scope)?.label ?? scope;
  return {
    name: `HR payouts ${month} ${what.replace(/[^A-Za-z]+/g, ' ').trim()}`,
    title: `Salary payouts — ${monthLabel(month)}`,
    subtitle: what,
    meta: [`${plural(want.length, 'person', 'people')}`, scope === 'all' ? 'Paid and pending' : 'Pending = unpaid, on hold, failed or reversed'],
    summary,
    sections,
  };
}

export async function loadRows(month) {
  const [run, people, channels] = await Promise.all([hrApi.run(month), hrApi.people(), hrApi.payChannels()]);
  const byId = new Map((Array.isArray(people) ? people : []).map(p => [String(p.id), p]));
  const chan = new Map((Array.isArray(channels) ? channels : []).map(c => [c.code, c]));
  const lines = Array.isArray(run?.lines) ? run.lines : [];
  return lines.map(l => {
    const p = byId.get(String(l.person_id)) || {};
    const c = l.pay_channel ? chan.get(l.pay_channel) : null;
    return {
      name: p.name || `#${l.person_id}`, code: p.code, department: p.department, bank_last4: p.bank_last4,
      channel: l.pay_channel ?? null,
      channelLabel: l.pay_channel ? (c?.label || l.pay_channel) : 'No pay channel',
      kind: !l.pay_channel ? 'none' : c?.kind === 'cash' ? 'cash' : 'bank',
      line: l,
    };
  });
}

export default function PayoutExport({ month, label = 'Payout list', size = 'sm', variant = 'secondary' }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (!btnRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false); };
    const onKey = e => e.key === 'Escape' && setOpen(false);
    const onScroll = e => { if (!menuRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const run = async kind => {
    setOpen(false);
    // The print tab is opened now, on the click itself — opened after the data loads, a pop-up blocker would stop it.
    const printWindow = kind === 'print' ? window.open('', '_blank') : null;
    setBusy(true);
    try {
      const [{ exportPDF, exportXLSX, specRowCount }, rows] = await Promise.all([import('../../lib/exporter.js'), loadRows(month)]);
      const spec = payoutSpec({ month, scope, rows });
      if (!specRowCount(spec)) { printWindow?.close(); toast?.info(`Nobody ${scope === 'all' ? 'in this month' : 'pending'} in this list`); return; }
      if (kind === 'xlsx') await exportXLSX(spec);
      else await exportPDF(spec, printWindow ? { printWindow } : {});
      if (kind !== 'print') toast?.success(`${kind === 'pdf' ? 'PDF' : 'Excel'} downloaded`);
    } catch (e) {
      printWindow?.close();
      console.error('Payout export failed', e);
      toast?.error(`Export failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span ref={btnRef} className="inline-flex">
        <Button type="button" size={size} variant={variant} disabled={busy}
          onClick={() => { setRect(btnRef.current.getBoundingClientRect()); setOpen(o => !o); }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {label}
          <ChevronDown size={13} className="opacity-60" />
        </Button>
      </span>
      {open && rect && createPortal(
        <div data-ci-overlay ref={menuRef} role="dialog" aria-label="Payout list"
          className="fixed z-[120] w-72 animate-scaleIn rounded-2xl border border-white/75 bg-white/95 p-2 shadow-lift backdrop-blur-xl"
          style={{
            // Opens upward when the space under the button is too short for the menu (about 330 px).
            ...(rect.bottom + 340 > window.innerHeight && rect.top > 340
              ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
            right: Math.max(8, window.innerWidth - rect.right),
          }}>
          <p className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">{monthLabel(month)} · which list</p>
          {SCOPES.map(s => (
            <button key={s.key} type="button" onClick={() => setScope(s.key)} aria-pressed={scope === s.key}
              className={`flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition ${scope === s.key ? 'bg-[#0A84FF]/[0.1]' : 'hover:bg-[#1D1D1F]/[0.04]'}`}>
              <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${scope === s.key ? 'border-[#0A84FF] bg-[#0A84FF]' : 'border-[#C7C7CC]'}`} />
              <span>
                <span className="block text-xs font-bold text-[#1D1D1F]">{s.label}</span>
                <span className="block text-[11px] text-[#86868B]">{s.sub}</span>
              </span>
            </button>
          ))}
          <div className="mt-1.5 grid grid-cols-3 gap-1.5 border-t border-[#1D1D1F]/[0.06] pt-2">
            {FORMATS.map(f => (
              <button key={f.kind} type="button" onClick={() => run(f.kind)}
                className="flex flex-col items-center gap-1 rounded-xl bg-[#E1EFFF] px-2 py-2 text-[11px] font-bold text-[#0064D2] transition hover:bg-[#cfe4ff]">
                <f.icon size={15} />{f.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
