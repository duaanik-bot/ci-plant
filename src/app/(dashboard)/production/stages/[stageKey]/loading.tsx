export default function StageKeyLoading() {
  return (
    <div className="min-h-screen bg-background px-2 py-3 sm:px-3 md:px-4 space-y-3 pb-24">
      {/* Header */}
      <div className="h-6 w-48 animate-pulse rounded-ds-md bg-ds-elevated" />
      <div className="h-3.5 w-72 animate-pulse rounded bg-ds-elevated/60" />

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-8">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-ds-md bg-ds-elevated/50"
          />
        ))}
      </div>

      {/* Tab strip */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 w-24 animate-pulse rounded-full bg-ds-elevated/60" />
        ))}
      </div>

      {/* Table skeleton */}
      <div className="overflow-hidden rounded-ds-md shadow-ds-depth-sm">
        {/* Head */}
        <div className="flex gap-4 bg-ds-elevated/60 px-3 py-2">
          {[8, 28, 40, 20, 20, 24, 16].map((w, i) => (
            <div key={i} className={`h-3 w-${w} animate-pulse rounded bg-ds-elevated`} />
          ))}
        </div>
        {/* Rows */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-3 py-3"
            style={{ opacity: 1 - i * 0.09 }}
          >
            <div className="h-3.5 w-8 animate-pulse rounded bg-ds-elevated/70" />
            <div className="h-3.5 w-28 animate-pulse rounded bg-ds-elevated/70" />
            <div className="h-3.5 flex-1 animate-pulse rounded bg-ds-elevated/50" />
            <div className="h-3.5 w-20 animate-pulse rounded bg-ds-elevated/60" />
            <div className="h-3.5 w-20 animate-pulse rounded bg-ds-elevated/60" />
            <div className="h-3.5 w-24 animate-pulse rounded bg-ds-elevated/50" />
            <div className="h-6 w-16 animate-pulse rounded-ds-sm bg-ds-elevated/60" />
          </div>
        ))}
      </div>
    </div>
  )
}
