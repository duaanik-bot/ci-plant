import Link from 'next/link'

const PROCUREMENT_MOVED_MESSAGE =
  'Procurement workflow moved to new Procurement module. New PR/PO/GRN flow will be enabled in next phase.'

export default function InventoryGrnMovedPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 text-ds-ink">
      <section className="rounded-ds-lg border border-ds-line/40 bg-background p-6 shadow-ds-depth-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Warehouse cleanup</p>
        <h1 className="mt-2 text-xl font-semibold text-[var(--brand-primary)]">GRN flow moved</h1>
        <p className="mt-3 text-sm text-ds-ink-muted">{PROCUREMENT_MOVED_MESSAGE}</p>
        <Link
          href="/inventory#paper-ledger"
          className="mt-5 inline-flex rounded-ds-md bg-[var(--brand-primary)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Open Warehouse Stock
        </Link>
      </section>
    </main>
  )
}
