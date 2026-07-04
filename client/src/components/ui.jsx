// ─── Design system primitives (macOS Tahoe / Liquid Glass theme) ────────────
import { Children, useEffect, useRef, useState, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, AlertTriangle, CheckCircle2, Info, Inbox, Check, ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal } from 'lucide-react';

// Button
export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const variants = {
    primary: 'btn-brand',
    secondary: 'border border-white/75 bg-white/65 text-[#1D1D1F] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] hover:bg-white/90 hover:text-[#007AFF] disabled:opacity-50 disabled:shadow-none',
    ghost: 'text-[#515154] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F] disabled:opacity-50',
    danger: 'border border-[#B81F16]/30 bg-gradient-to-b from-[#FF6961] to-[#FF3B30] text-white shadow-[0_8px_20px_rgba(255,59,48,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(145,25,18,0.25)] hover:brightness-105 disabled:opacity-50 disabled:shadow-none',
    success: 'border border-[#19813A]/30 bg-gradient-to-b from-[#57CB75] to-[#34C759] text-white shadow-[0_8px_20px_rgba(52,199,89,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(20,101,48,0.25)] hover:brightness-105 disabled:opacity-50 disabled:shadow-none',
  };
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
  return (
    <button
      className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full font-semibold leading-snug transition-all duration-200 ease-apple active:scale-[0.97]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// Form fields
export function Field({ label, children, hint, required }) {
  return (
    <label className="block">
      <span className="mb-1 block max-w-full break-words text-xs font-medium leading-snug text-slate-600">
        {label} {required && <span className="text-brand-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-[#1D1D1F]/[0.10] bg-white/75 px-3 py-2 text-sm font-medium leading-5 text-[#1D1D1F] placeholder-[#86868B] backdrop-blur-md ' +
  'shadow-[inset_0_1px_2px_rgba(29,29,31,0.04)] outline-none transition duration-200 ease-apple ' +
  'hover:border-[#1D1D1F]/[0.18] hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3.5px] focus:ring-[#0A84FF]/20 disabled:bg-[#1D1D1F]/[0.04] disabled:text-[#86868B]';

export function Input({ className = '', ...props }) { return <input className={`${inputCls} h-10 ${className}`} {...props} />; }
export function Textarea({ className = '', ...props }) { return <textarea rows={2} className={`${inputCls} min-h-[72px] ${className}`} {...props} />; }
function optionText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join(' ');
  return optionText(node.props?.children);
}

export function SearchableSelect({
  children,
  options,
  value = '',
  onChange,
  placeholder = 'Select...',
  disabled,
  className = '',
  name,
  required,
  ...props
}) {
  const items = options || Children.toArray(children).map(child => ({
    value: child?.props?.value ?? '',
    label: optionText(child?.props?.children),
    disabled: child?.props?.disabled,
  }));
  const emptyOption = items.find(i => String(i.value) === '');
  const displayPlaceholder = placeholder === 'Select...' && emptyOption?.label ? emptyOption.label : placeholder;
  const selected = value === '' || value == null ? null : items.find(i => String(i.value) === String(value));
  const [query, setQuery] = useState(selected?.label || '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [rect, setRect] = useState(null);

  useEffect(() => { setQuery(selected?.label || ''); }, [selected?.label, value]);
  useEffect(() => {
    if (!open) return;
    const close = e => {
      if (ref.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
      setQuery(selected?.label || '');
    };
    const update = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 10;
      const above = r.top - 10;
      const maxHeight = Math.max(160, Math.min(280, Math.max(below, above)));
      setRect({ left: r.left, width: r.width, top: below < 210 && above > below ? r.top - maxHeight - 6 : r.bottom + 6, maxHeight });
    };
    update();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, selected?.label]);

  const needle = query.trim().toLowerCase();
  const filtered = (needle
    ? items.filter(i => `${i.label} ${i.value}`.toLowerCase().includes(needle))
    : items
  ).filter(i => !i.disabled && String(i.value) !== '').slice(0, 80);
  const emit = next => onChange?.({ target: { name, value: next }, currentTarget: { name, value: next } });
  const choose = item => {
    emit(item.value);
    setQuery(item.label);
    setOpen(false);
    setActive(0);
  };

  return (
    <div className="relative" ref={ref}>
      <input type="hidden" name={name} value={value ?? ''} readOnly required={required} />
      <input
        className={`${inputCls} h-10 pr-16 ${className}`}
        value={query}
        disabled={disabled}
        placeholder={displayPlaceholder}
        autoComplete="off"
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onBlur={() => window.setTimeout(() => { if (!open) setQuery(selected?.label || ''); }, 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(filtered.length - 1, 0))); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          if (e.key === 'Escape') { setOpen(false); setQuery(selected?.label || ''); }
          if (e.key === 'Enter' && open && filtered[active]) { e.preventDefault(); choose(filtered[active]); }
        }}
        {...props}
      />
      <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-slate-400">
        {value && !disabled && (
          <button type="button" tabIndex={-1} onMouseDown={e => { e.preventDefault(); emit(''); setQuery(''); }}
            className="pointer-events-auto rounded p-0.5 hover:bg-slate-100 hover:text-slate-700">
            <X size={14} />
          </button>
        )}
        <ChevronDown size={14} />
      </div>
      {open && !disabled && rect && createPortal((
        <div ref={menuRef} className="glass fixed z-[200] overflow-auto rounded-2xl py-1 shadow-modal"
          style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}>
          {filtered.length ? filtered.map((item, i) => (
            <button key={`${item.value}-${i}`} type="button" onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-100 ${i === active ? 'bg-[#0A84FF]/[0.10] text-[#0064D2]' : 'text-[#1D1D1F] hover:bg-white/70'}`}>
              <span className="min-w-0 break-words">{item.label}</span>
              {String(item.value) === String(value) && <Check size={14} className="shrink-0" />}
            </button>
          )) : <div className="px-3 py-3 text-sm text-slate-500">No results found</div>}
        </div>
      ), document.body)}
    </div>
  );
}

export function Select(props) {
  return <SearchableSelect {...props} />;
}

export function Checkbox({ label, ...props }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30" {...props} />
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
      <div className="absolute inset-0 bg-[#1D1D1F]/30 backdrop-blur-[6px]" onClick={onClose} />
      <div className={`relative flex max-h-[92vh] w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} animate-scaleIn flex-col overflow-hidden rounded-[28px] border border-white/75 bg-white/80 shadow-modal backdrop-blur-2xl`}>
        <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-4">
          <h3 className="min-w-0 break-words text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors duration-150 hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-3.5">{footer}</div>}
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
  dispatched: 'bg-[#1D1D1F] text-white',
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

// Action menu — a "⋯" trigger with a portal dropdown, for overflow row actions.
// Portal + fixed positioning so it escapes the table's overflow-x-auto clipping.
export function ActionMenu({ items = [], label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
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

  if (!items.length) return null;

  const toggle = () => {
    setRect(btnRef.current.getBoundingClientRect());
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={label}
        aria-label={label}
        onClick={toggle}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition duration-200 ease-apple ${
          open ? 'bg-[#1D1D1F]/[0.07] text-[#1D1D1F]' : 'text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]'
        }`}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[190px] rounded-2xl border border-white/75 bg-white/95 p-1.5 shadow-lift backdrop-blur-xl"
          style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }}
        >
          {items.map(item => (
            <button
              key={item.key || item.label}
              type="button"
              onClick={() => { setOpen(false); item.onClick?.(); }}
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold transition duration-150 ${
                item.tone === 'danger'
                  ? 'text-red-600 hover:bg-red-50'
                  : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
              }`}
            >
              {item.icon && <item.icon size={13} className={item.tone === 'danger' ? 'text-red-400' : 'text-slate-400'} />}
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// KPI card — icon sits in a tinted chip; value carries the accent.
export function KpiCard({ label, value, sub, accent = 'text-slate-900', icon: Icon, chip = 'bg-brand-50 text-brand-600' }) {
  return (
    <div className="glass rounded-[22px] p-4 transition-shadow duration-300 ease-apple hover:shadow-lift">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">{label}</span>
        {Icon && <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${chip}`}><Icon size={14} /></span>}
      </div>
      <div className={`mt-1 text-2xl font-bold tracking-[-0.02em] ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[#6E6E73]">{sub}</div>}
    </div>
  );
}

// Page header
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="module-page-title max-w-full">{title}</h1>
        {subtitle && <p className="module-page-subtitle max-w-full">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
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
        className="w-60 rounded-full border border-[#1D1D1F]/[0.10] bg-white/75 py-2 pl-8 pr-3 text-sm font-medium text-[#1D1D1F] shadow-[inset_0_1px_2px_rgba(29,29,31,0.04)] backdrop-blur-md outline-none transition duration-200 ease-apple hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3.5px] focus:ring-[#0A84FF]/20"
      />
    </div>
  );
}

function normalizeSortValue(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  const numeric = Number(text.replace(/[₹,\s]/g, ''));
  if (Number.isFinite(numeric) && /\d/.test(text)) return numeric;
  const date = Date.parse(text);
  if (Number.isFinite(date) && /[-/]|[A-Za-z]{3}/.test(text)) return date;
  return text.toLowerCase();
}

// DataTable — search + sort + selectable rows.
export function DataTable({
  columns,
  rows,
  onRowClick,
  empty = 'Nothing here yet',
  searchable,
  selectable = false,
  selectedIds = [],
  onToggleRow,
  onToggleAll,
  getRowId = r => r.id,
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(() => {
    const first = columns.find(c => c.sortable !== false && c.key && c.label && !String(c.key).startsWith('_'));
    return first ? { key: first.key, dir: 'asc' } : null;
  });
  const filtered = q
    ? rows.filter(r => JSON.stringify(Object.values(r)).toLowerCase().includes(q.toLowerCase()))
    : rows;
  const sorted = sort
    ? [...filtered].sort((a, b) => {
      const col = columns.find(c => c.key === sort.key);
      const av = normalizeSortValue(col?.sortValue ? col.sortValue(a) : a[sort.key]);
      const bv = normalizeSortValue(col?.sortValue ? col.sortValue(b) : b[sort.key]);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    })
    : filtered;
  const selectedSet = new Set(selectedIds.map(String));
  const visibleIds = sorted.map(getRowId).filter(id => id != null).map(String);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedSet.has(id));
  const toggleSort = key => setSort(current => ({
    key,
    dir: current?.key === key && current.dir === 'asc' ? 'desc' : 'asc',
  }));
  return (
    <div className="ci-data-panel">
      {searchable && (
        <div className="border-b border-[#1D1D1F]/[0.05] bg-white/30 p-3">
          <SearchInput value={q} onChange={setQ} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="ci-table-head">
              {selectable && (
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30"
                    checked={allVisibleSelected}
                    onChange={e => onToggleAll?.(sorted, e.target.checked)}
                  />
                </th>
              )}
              {columns.map(c => (
                <th key={c.key} className={`px-4 py-2.5 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.sortable === false || !c.key || !c.label ? (
                    c.label
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={`inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 transition hover:bg-white hover:text-indigo-700 ${c.align === 'right' ? 'ml-auto' : ''}`}
                    >
                      {c.label}
                      {sort?.key === c.key
                        ? sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                        : <ArrowUpDown size={12} className="text-slate-300" />}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={columns.length + (selectable ? 1 : 0)} className="px-4 py-10 text-center text-sm text-gray-400">
                <Inbox className="mx-auto mb-2 text-gray-300" size={22} />{empty}
              </td></tr>
            )}
            {sorted.map((r, i) => {
              const rowId = getRowId(r);
              const checked = selectedSet.has(String(rowId));
              return (
              <tr key={r.id ?? i}
                onClick={onRowClick ? e => {
                  // Bubbling guard — clicks on interactive cells must not fire row navigation.
                  if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
                  onRowClick(r);
                } : undefined}
                className={`ci-table-row ${checked ? 'bg-indigo-50/55' : i % 2 ? 'bg-slate-50/35' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}>
                {selectable && (
                  <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30"
                      checked={checked}
                      onChange={e => onToggleRow?.(r, e.target.checked)}
                    />
                  </td>
                )}
                {columns.map(c => (
                  <td key={c.key} className={`px-4 py-2.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {c.render ? c.render(r) : r[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tabs
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 shadow-[inset_0_1px_2px_rgba(29,29,31,0.05)] backdrop-blur-xl scrollbar-none">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all duration-200 ease-apple
            ${active === t.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
          {t.label}{t.count != null && <span className={`ml-1.5 rounded-full px-1.5 text-xs ${active === t.key ? 'bg-[#E1EFFF] text-[#0064D2]' : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>{t.count}</span>}
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
  const colors = { success: 'text-[#19813A]', error: 'text-[#B81F16]', info: 'text-[#0064D2]' };
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map(t => {
          const I = icons[t.type];
          return (
            <div key={t.id} className={`glass flex animate-slideUp items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold shadow-lift ${colors[t.type]}`}>
              <I size={16} /> <span className="text-[#1D1D1F]">{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
