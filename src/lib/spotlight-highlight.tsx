import type { ReactNode } from 'react'

const SPOTLIGHT_CLASS = 'bg-orange-500/20 text-orange-400 rounded-sm px-0.5'

/**
 * Wraps occurrences of `query` in `text` with spotlight styling (for drawer / list context).
 */
export function spotlightHighlightText(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q || !text) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: ReactNode[] = []
  let start = 0
  let i = lower.indexOf(needle, start)
  let key = 0
  while (i !== -1) {
    if (i > start) parts.push(text.slice(start, i))
    parts.push(
      <span key={key++} className={SPOTLIGHT_CLASS}>
        {text.slice(i, i + needle.length)}
      </span>,
    )
    start = i + needle.length
    i = lower.indexOf(needle, start)
  }
  if (start < text.length) parts.push(text.slice(start))
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>
}

export function spotlightHighlightClassName(): string {
  return SPOTLIGHT_CLASS
}
