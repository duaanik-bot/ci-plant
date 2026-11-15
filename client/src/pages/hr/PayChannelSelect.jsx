// HR · a person's pay channel as a dropdown (owner's request 2026-11-15: "give options to enter or change the pay
// channel — a dropdown in payroll itself, in People, and at master creation while importing"). Choosing sends
// POST /hr/people/:id/pay-channel at once, no questions; the person's unpaid lines in open months move with it.
// The channels are read once per page load and shared by every dropdown on screen.
import { useEffect, useState } from 'react';
import { useToast } from '../../components/ui.jsx';
import { hrApi } from '../../lib/hr.js';

let cache = null;
const loadChannels = () => {
  if (!cache) cache = hrApi.payChannels().then(c => (Array.isArray(c) ? c : []), () => { cache = null; return []; });
  return cache;
};

export default function PayChannelSelect({ personId, name = '', value, channels: given = null, onChanged, className = '' }) {
  const toast = useToast();
  const [channels, setChannels] = useState(given || []);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(value || '');
  useEffect(() => { setShown(value || ''); }, [value]);
  useEffect(() => {
    if (given) { setChannels(given); return undefined; }
    let live = true;
    loadChannels().then(c => { if (live) setChannels(c); });
    return () => { live = false; };
  }, [given]);
  const usable = channels.filter(c => c && (c.active !== false || c.code === value));
  const change = async e => {
    const code = e.target.value;
    if (code === (value || '')) return;
    setShown(code);
    setBusy(true);
    try {
      const res = await hrApi.setPayChannel(personId, code);
      const label = code ? (usable.find(c => c.code === code)?.label || code) : 'no pay channel';
      const moved = Array.isArray(res?.lines_moved) ? res.lines_moved.length : 0;
      toast.success(`${name || 'Pay channel'}: ${label}${moved ? ` — ${moved} open month${moved === 1 ? '' : 's'} moved too` : ''}`);
      await onChanged?.(code, res);
    } catch {
      setShown(value || ''); // refused — the central toast says why
    } finally { setBusy(false); }
  };
  return (
    <select aria-label={`Pay channel${name ? ` for ${name}` : ''}`} value={shown} disabled={busy}
      onClick={e => e.stopPropagation()} onChange={change}
      className={`max-w-[11rem] rounded-lg border border-[#1D1D1F]/15 bg-white px-1.5 py-1 text-xs font-medium text-[#1D1D1F] disabled:opacity-50 ${shown ? '' : 'text-amber-700'} ${className}`}>
      <option value="">No channel</option>
      {usable.map(c => <option key={c.code} value={c.code}>{c.label || c.code}</option>)}
    </select>
  );
}
