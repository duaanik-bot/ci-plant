/** Customer PO line — board/paper procurement (floating footer + row icon). */
export function paperSupplyIconMeta(status: string | undefined): {
  title: string
  iconClassName: string
} {
  const s = (status || 'not_calculated').toLowerCase()
  if (s === 'received') {
    return {
      title: 'Material received at factory gate',
      iconClassName: 'text-emerald-400',
    }
  }
  if (s === 'on_order' || s === 'dispatched' || s === 'paper_ordered') {
    return {
      title: 'Board / paper on order (vendor PO dispatched)',
      iconClassName: 'text-sky-400',
    }
  }
  return {
    title: 'Not yet ordered',
    iconClassName: 'text-ds-ink-faint',
  }
}
