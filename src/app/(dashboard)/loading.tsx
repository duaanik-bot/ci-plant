export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-6">
      <div className="mb-6 h-10 w-56 animate-pulse rounded-lg bg-slate-800" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="h-48 animate-pulse rounded-xl border border-slate-800 bg-slate-900/70" />
        <div className="h-48 animate-pulse rounded-xl border border-slate-800 bg-slate-900/70" />
        <div className="h-48 animate-pulse rounded-xl border border-slate-800 bg-slate-900/70" />
      </div>
    </div>
  )
}
