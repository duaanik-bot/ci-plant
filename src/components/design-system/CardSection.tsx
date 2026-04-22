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
        'space-y-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/30 p-4 shadow-[0_2px_16px_rgba(0,0,0,0.15)] transition-colors duration-200',
        className,
      )}
    >
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ds-ink-muted">{title}</h3>
      {children}
    </section>
  )
}
