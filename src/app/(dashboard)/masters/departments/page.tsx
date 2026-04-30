import Link from 'next/link'

export default function MastersDepartmentsPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Department Master</h2>
        <button
          type="button"
          disabled
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground opacity-50"
          title="Department add flow is pending setup"
        >
          Add department
        </button>
      </div>
      <p className="text-sm text-ds-ink-faint">
        Department module is pending setup. Use <Link href="/masters/users" className="text-blue-600 hover:underline">Users</Link> and role mapping for now.
      </p>
    </div>
  )
}
