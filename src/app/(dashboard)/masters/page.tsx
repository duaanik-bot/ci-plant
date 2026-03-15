import Link from 'next/link'

const cards = [
  { href: '/masters/customers', label: 'Customer', description: 'Company name, GST, contact, credit limit, artwork approval' },
  { href: '/masters/suppliers', label: 'Supplier', description: 'Suppliers, material types, lead time, payment terms' },
  { href: '/masters/materials', label: 'Material', description: 'Material codes, units, reorder point, supplier' },
  { href: '/masters/machines', label: 'Machine', description: 'CI-01 to CI-12, capacity, waste %, PM dates' },
  { href: '/masters/instruments', label: 'QC Instruments', description: 'Calibration due dates, certificates' },
  { href: '/masters/users', label: 'Users', description: 'Name, email, role, PIN, machine access' },
]

export default function MastersHomePage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="block p-5 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium text-amber-400">{c.label}</span>
          <span className="block text-sm text-slate-400 mt-1">{c.description}</span>
        </Link>
      ))}
    </div>
  )
}
