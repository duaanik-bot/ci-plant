'use client'

import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToastStore } from '@/store/toastStore'
import { cn } from '@/lib/cn'
import type { ToastType } from '@/store/toastStore'

/**
 * Toaster
 * ────────
 * Renders a stack of toast notifications anchored to the bottom-right.
 * Mount once inside your root layout or shell — no further config needed.
 *
 * Toast types:  success | error | info | warning
 * Left-border accent changes per type.
 * Entry animation: slide in from the right (200ms ease-out).
 *
 * Fire toasts from anywhere:
 *   import { toast } from '@/store/toastStore'
 *   toast.success('Saved!')
 *   toast.error('Something went wrong.')
 *   toast.info('Imported 12 records.')
 */

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle  size={16} className="text-ds-success shrink-0 mt-px" />,
  error:   <XCircle      size={16} className="text-ds-error   shrink-0 mt-px" />,
  info:    <Info         size={16} className="text-ds-brand   shrink-0 mt-px" />,
  warning: <AlertTriangle size={16} className="text-ds-warning shrink-0 mt-px" />,
}

const BORDERS: Record<ToastType, string> = {
  success: 'border-l-ds-success',
  error:   'border-l-ds-error',
  info:    'border-l-ds-brand',
  warning: 'border-l-ds-warning',
}

export function Toaster() {
  const toasts = useToastStore(s => s.toasts)
  const remove = useToastStore(s => s.remove)

  if (!toasts.length) return null

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 w-80 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-3',
            'bg-ds-card rounded-ds-md border border-ds-line border-l-4',
            'shadow-toast px-4 py-3',
            BORDERS[t.type] ?? BORDERS.info,
            'animate-in slide-in-from-right-4 duration-200',
          )}
        >
          {ICONS[t.type] ?? ICONS.info}
          <p className="text-sm text-ds-ink flex-1 leading-snug">{t.message}</p>
          <button
            onClick={() => remove(t.id)}
            className="text-ds-ink-faint hover:text-ds-ink-muted transition-colors mt-0.5 shrink-0"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

export default Toaster
