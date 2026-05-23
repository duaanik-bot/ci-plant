import Link from 'next/link'

const groupedCards = [
  {
    group: 'Business',
    cards: [
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
    ],
  },
  {
    group: 'Product System',
    cards: [
      {
        href: '/masters/materials',
        label: 'Material',
        description: 'Material codes, units, reorder point, supplier',
      },
      {
        href: '/masters/cartons',
        label: 'Cartons',
        description: 'Manage carton specifications, dimensions, and board grades',
      },
      {
        href: '/masters/minimasters',
        label: 'MiniMasters',
        description: 'Dynamic dropdown values and logic triggers',
      },
    ],
  },
  {
    group: 'Operations',
    cards: [
      {
        href: '/masters/machines',
        label: 'Machine',
        description: 'CUT/PRN/COT/DIE/PST machines, capacity, waste %, PM dates',
      },
      {
        href: '/masters/instruments',
        label: 'QC Instruments',
        description: 'Calibration due dates, certificates',
      },
    ],
  },
  {
    group: 'Organization',
    cards: [
      {
        href: '/masters/users',
        label: 'Users',
        description: 'Name, email, role, PIN, machine access',
      },
      {
        href: '/masters/departments',
        label: 'Department',
        description: 'Department master (setup pending)',
      },
      {
        href: '/masters/employees',
        label: 'Employee',
        description: 'Employee master (setup pending)',
      },
    ],
  },
]

export default function MastersHomePage() {
  return (
    <div className="space-y-5">
      {groupedCards.map((section) => (
        <section key={section.group} className="rounded-ds-md border border-ds-line/50 bg-card p-3">
          <h3 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-ds-ink-muted">
            {section.group}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {section.cards.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className="block rounded-ds-md border border-border bg-card p-4 text-card-foreground shadow-sm ring-1 ring-ring/30 transition-colors hover:border-[var(--info)] hover:ring-[var(--info)]/50 dark:hover:border-[var(--info)]/50"
              >
                <span className="font-semibold text-[var(--info)] dark:text-[var(--info)]">{c.label}</span>
                <span className="mt-1 block text-sm text-ds-ink-faint dark:text-ds-ink-muted">{c.description}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
