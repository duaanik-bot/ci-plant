import Link from 'next/link'

const cards = [
  {
    href: '/masters/customers',
    label: 'Customer',
    description: 'Company name, GST, contact, credit limit, artwork approval',
  },
  {
    href: '/masters/suppliers',
    label: 'Supplier',
    description: 'Suppliers, material types, lead time, payment terms',
  },
  {
    href: '/masters/materials',
    label: 'Material',
    description: 'Material codes, units, reorder point, supplier',
  },
  {
    href: '/masters/machines',
    label: 'Machine',
    description: 'CI-01 to CI-12, capacity, waste %, PM dates',
  },
  {
    href: '/masters/instruments',
    label: 'QC Instruments',
    description: 'Calibration due dates, certificates',
  },
  {
    href: '/masters/users',
    label: 'Users',
    description: 'Name, email, role, PIN, machine access',
  },
]

export default function MastersHomePage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="block rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm ring-1 ring-ring/30 transition-colors hover:border-blue-300 hover:ring-blue-200/50 dark:hover:border-blue-600/50"
        >
          <span className="font-semibold text-blue-600 dark:text-blue-400">{c.label}</span>
          <span className="mt-1 block text-sm text-slate-600 dark:text-slate-400">{c.description}</span>
        </Link>
      ))}
    </div>
  )
}
