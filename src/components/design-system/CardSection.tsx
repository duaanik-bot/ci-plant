import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type CardSectionProps = {
  title: string
  id?: string
  children: ReactNode
  className?: string
}

export function CardSection({ title, id, children, className }: CardSectionProps) {
  return (
    <section
      id={id}
      className={cn(
        'space-y-4 rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] p-4 md:p-5 shadow-ds-depth-sm transition-[border-color,box-shadow] duration-200 ease-out',
        className,
      )}
    >
      <h3 className="ds-typo-label mb-1.5 font-semibold uppercase tracking-wider text-ds-ink-faint">{title}</h3>
      {children}
    </section>
  )
}
