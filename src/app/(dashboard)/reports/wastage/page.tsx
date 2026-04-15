import Link from 'next/link'

export default function ReportsWastagePage() {
  return (
    <section className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Wastage Report</h1>
      <p className="text-sm text-slate-400">
        Wastage analytics are available on the main dashboard charts currently.
      </p>
      <Link href="/dashboard" className="text-blue-400 hover:underline text-sm">
        Open Dashboard Charts →
      </Link>
    </section>
  )
}
