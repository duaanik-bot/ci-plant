import Link from 'next/link'

export default function ReportsProductionPage() {
  return (
    <section className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Production Summary</h1>
      <p className="text-sm text-ds-ink-muted">
        Use Job Cards and Live Production for current production summaries.
      </p>
      <div className="flex gap-4 text-sm">
        <Link href="/production/job-cards" className="text-blue-400 hover:underline">
          Open Job Cards →
        </Link>
        <Link href="/production/stages" className="text-blue-400 hover:underline">
          Open Live Production →
        </Link>
      </div>
    </section>
  )
}
