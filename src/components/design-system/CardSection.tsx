import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type CardSectionProps = {
  title?: string
  id?: string
  children: ReactNode
  className?: string
  /** Optional right-aligned slot in the header (actions, badges) */
  action?: ReactNode
}

export function CardSection({ title, id, children, className, action }: CardSectionProps) {
  return (
    <section
      id={id}
      className={cn(
        'space-y-4 rounded-ds-card border border-[var(--border)] bg-[var(--bg-card)] p-4 md:p-5 shadow-ds-depth-sm transition-[border-color,box-shadow] duration-200 ease-out',
        className,
      )}
    >
      {title || action ? (
        <div className="flex items-center justify-between gap-3">
          {title ? <SectionLabel>{title}</SectionLabel> : <span />}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

type SectionLabelProps = {
  children: ReactNode
  /** Use brand accent color instead of muted ink */
  accent?: boolean
  className?: string
}

export function SectionLabel({ children, accent, className }: SectionLabelProps) {
  return (
    <p
      className={cn(
        'text-[11px] font-semibold uppercase tracking-widest',
        accent ? 'text-[var(--brand-primary)]' : 'text-ds-ink-faint',
        className,
      )}
    >
      {children}
    </p>
  )
}
