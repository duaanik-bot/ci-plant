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
        'space-y-4 rounded-ds-md border border-ds-line/35 bg-gradient-to-b from-ds-elevated/40 to-ds-elevated/20 p-4 md:p-5 shadow-ds-depth-sm transition-all duration-150',
        className,
      )}
    >
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ds-ink-faint">{title}</h3>
      {children}
    </section>
  )
}
