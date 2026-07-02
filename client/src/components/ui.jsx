// ─── Design system primitives (Pureflix IMS theme) ──────────────────────────
import { useEffect, useRef, useState, createContext, useContext } from 'react';
import { X, Search, AlertTriangle, CheckCircle2, Info, Inbox } from 'lucide-react';

// Button
export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const variants = {
    primary: 'bg-brand-500 hover:bg-brand-600 text-white shadow-sm',
    secondary: 'bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 shadow-sm',
    ghost: 'text-gray-600 hover:bg-gray-100',
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
    success: 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm',
  };
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// Form fields
export function Field({ label, children, hint, required }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label} {required && <span className="text-brand-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20';

export function Input(props) { return <input className={inputCls} {...props} />; }
export function Textarea(props) { return <textarea rows={2} className={inputCls} {...props} />; }
export function Select({ children, ...props }) {
  return <select className={inputCls} {...props}>{children}</select>;
}

export function Checkbox({ label, ...props }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500/30" {...props} />
      {label}
    </label>
  );
}

// Modal
export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose?.();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />
      <div className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} animate-slideUp rounded-xl bg-white shadow-modal`}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="text-base font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', message, confirmLabel = 'Confirm', danger }) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm text-gray-600">{message}</p>
    </Modal>
  );
}

// Status badge — one colour language across the whole app
const STATUS_COLOURS = {
  pending: 'bg-gray-100 text-gray-600',
  planned: 'bg-blue-50 text-blue-700',
  ready: 'bg-violet-50 text-violet-700',
  in_production: 'bg-amber-50 text-amber-700',
  in_progress: 'bg-amber-50 text-amber-700',
  open: 'bg-blue-50 text-blue-700',
  produced: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-emerald-50 text-emerald-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  available: 'bg-emerald-50 text-emerald-700',
  approved: 'bg-emerald-50 text-emerald-700',
  received: 'bg-emerald-50 text-emerald-700',
  dispatched: 'bg-ink-900 text-white',
  converted: 'bg-violet-50 text-violet-700',
  partially_received: 'bg-amber-50 text-amber-700',
  quarantine: 'bg-amber-50 text-amber-700',
  running: 'bg-emerald-50 text-emerald-700',
  idle: 'bg-gray-100 text-gray-600',
  maintenance: 'bg-red-50 text-red-700',
  cancelled: 'bg-red-50 text-red-600',
  rejected: 'bg-red-50 text-red-600',
  exhausted: 'bg-gray-100 text-gray-400',
};
export function StatusBadge({ status }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${STATUS_COLOURS[status] || 'bg-gray-100 text-gray-600'}`}>
      {(status || '').replace(/_/g, ' ')}
    </span>
  );
}

// KPI card
export function KpiCard({ label, value, sub, accent = 'text-gray-900', icon: Icon }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-card">
      <div className="flex items-start justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
        {Icon && <Icon size={16} className="text-gray-300" />}
      </div>
      <div className={`mt-1.5 text-2xl font-extrabold ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

// Page header
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-extrabold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

// Search input
export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-56 rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />
    </div>
  );
}

// DataTable — search + zebra + click rows. Keep it dumb and fast.
export function DataTable({ columns, rows, onRowClick, empty = 'Nothing here yet', searchable }) {
  const [q, setQ] = useState('');
  const filtered = q
    ? rows.filter(r => JSON.stringify(Object.values(r)).toLowerCase().includes(q.toLowerCase()))
    : rows;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-card">
      {searchable && (
        <div className="border-b border-gray-100 p-3">
          <SearchInput value={q} onChange={setQ} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              {columns.map(c => (
                <th key={c.key} className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-gray-500 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-gray-400">
                <Inbox className="mx-auto mb-2 text-gray-300" size={22} />{empty}
              </td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={r.id ?? i}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`border-b border-gray-50 last:border-0 ${i % 2 ? 'bg-gray-50/40' : ''} ${onRowClick ? 'cursor-pointer hover:bg-brand-50/60' : ''}`}>
                {columns.map(c => (
                  <td key={c.key} className={`px-4 py-2.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {c.render ? c.render(r) : r[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tabs
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors
            ${active === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// Toast system
const ToastCtx = createContext(null);
export function useToast() { return useContext(ToastCtx); }
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = (type, msg) => {
    const id = ++idRef.current;
    setToasts(t => [...t, { id, type, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3800);
  };
  const toast = {
    success: m => push('success', m),
    error: m => push('error', m),
    info: m => push('info', m),
  };
  const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
  const colors = { success: 'border-emerald-200 bg-emerald-50 text-emerald-800', error: 'border-red-200 bg-red-50 text-red-800', info: 'border-blue-200 bg-blue-50 text-blue-800' };
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map(t => {
          const I = icons[t.type];
          return (
            <div key={t.id} className={`flex animate-slideUp items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-card ${colors[t.type]}`}>
              <I size={16} /> {t.msg}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
