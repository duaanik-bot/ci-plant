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
        'space-y-3 rounded-ds-md border border-ds-line/80 bg-ds-elevated/40 p-4 shadow-sm transition-colors duration-200',
        className,
      )}
    >
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ds-ink-muted">{title}</h3>
      {children}
    </section>
  )
}
