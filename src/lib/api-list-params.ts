export function clampListLimit(
  value: string | number | null | undefined,
  opts: { defaultLimit: number; min?: number; max: number },
): number {
  const min = opts.min ?? 1
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return opts.defaultLimit
  return Math.min(Math.max(Math.floor(parsed), min), opts.max)
}

export function parseListPage(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.floor(parsed))
}

export function isCompactRequest(searchParams: URLSearchParams): boolean {
  return searchParams.get('compact') === '1' || searchParams.get('mode') === 'compact'
}

export function isExportRequest(searchParams: URLSearchParams): boolean {
  return searchParams.get('export') === '1' || searchParams.get('export') === 'true'
}

export function shouldReturnPagedEnvelope(searchParams: URLSearchParams): boolean {
  return (
    searchParams.get('paged') === '1' ||
    searchParams.get('mode') === 'paged' ||
    isCompactRequest(searchParams)
  )
}

export function listSkip(page: number, limit: number): number {
  return Math.max(0, (page - 1) * limit)
}

export function logListPerformance(input: {
  route: string
  startedAt: number
  rowCount: number
  limit: number | null
  mode: string
  exportRequested: boolean
  slowMs?: number
}): void {
  const elapsedMs = Date.now() - input.startedAt
  const slowMs = input.slowMs ?? 500
  if (elapsedMs < slowMs && process.env.NODE_ENV === 'production') return
  console.info(
    `[perf:list] route=${input.route} elapsedMs=${elapsedMs} rows=${input.rowCount} limit=${input.limit ?? 'none'} mode=${input.mode} export=${input.exportRequested ? 'true' : 'false'}`,
  )
}
