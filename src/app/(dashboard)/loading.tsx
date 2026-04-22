export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-ds-card p-4 md:p-6">
      <div className="mb-6 h-10 w-56 animate-pulse rounded-lg bg-ds-elevated" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="h-48 animate-pulse rounded-xl border border-ds-line/40 bg-ds-card/70" />
        <div className="h-48 animate-pulse rounded-xl border border-ds-line/40 bg-ds-card/70" />
        <div className="h-48 animate-pulse rounded-xl border border-ds-line/40 bg-ds-card/70" />
      </div>
    </div>
  )
}
