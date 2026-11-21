// A right-side drawer — the HR person drawer's shell (pages/hr/PersonDrawer.jsx, LoansAdvances.jsx), shared: a glass panel
// over a dimmed page, the title and a status beside it, an actions bar, and a body that scrolls. Escape closes it unless
// another overlay is on top. Used where a row opens into its detail and a modal is too tight (the enquiry desk,
// 21 Nov 2026: "an openable drawer once we click it … like we have in HR when we click into the person").
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function SideDrawer({ open = true, title, sub, badge, icon = null, actions, onClose, width = 'max-w-[min(1240px,96vw)]', children }) {
  const rootRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const h = e => {
      if (e.key !== 'Escape') return;
      if ([...document.querySelectorAll('[data-ci-overlay]')].some(el => el !== rootRef.current && rootRef.current && !rootRef.current.contains(el))) return;
      e.stopPropagation(); e.preventDefault(); closeRef.current?.();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div ref={rootRef} data-ci-overlay className="no-print fixed inset-0 z-[45]">
      <div className="absolute inset-0 animate-fadeIn bg-[#1D1D1F]/25 backdrop-blur-[3px]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'} className={`absolute inset-y-0 right-0 flex w-full ${width} p-0 sm:p-3`}>
        <div className="glass flex h-full w-full animate-scaleIn flex-col overflow-hidden rounded-none sm:rounded-[26px]">
          <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            {icon && <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,113,240,0.35)]">{icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2"><p className="truncate text-[15px] font-bold text-[#1D1D1F]">{title}</p>{badge}</div>
              {sub && <p className="truncate text-[11px] text-[#6E6E73]">{sub}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] hover:bg-[#1D1D1F]/[0.10]"><X size={16} /></button>
          </div>
          {actions && <div className="flex flex-wrap gap-2 border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2">{actions}</div>}
          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-4 py-3">{children}</div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
