import Link from 'next/link'

export default function ReportsDashboardPage() {
  return (
    <section className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">MD Dashboard</h1>
      <p className="text-sm text-ds-ink-muted">
        Executive summary reports are being aligned. Use the live dashboard in the meantime.
      </p>
      <Link href="/orders/purchase-orders" className="text-blue-400 hover:underline text-sm">
        Open Customer POs →
      </Link>
    </section>
  )
}
