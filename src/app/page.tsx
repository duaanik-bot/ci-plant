import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="min-h-screen p-6 max-w-xl mx-auto">
      <h1 className="text-xl font-bold text-amber-400 mb-2">Colour Impressions Plant System</h1>
      <p className="text-slate-400 text-sm mb-6">Dashboard</p>

      <nav className="space-y-2">
        <Link
          href="/masters"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Masters</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Customers, suppliers, materials, machines, QC instruments, users.
          </span>
        </Link>
        <Link
          href="/jobs"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Jobs</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Active jobs board, new job, job card PDF.
          </span>
        </Link>
        <Link
          href="/inventory"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Inventory</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Stock view, GRN, QA release from quarantine.
          </span>
        </Link>
        <Link
          href="/shopfloor"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Shopfloor</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Tablet: start/complete stage, sheet remaining.
          </span>
        </Link>
        <Link
          href="/stores/issue"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Stores — Sheet issue</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Scan job QR, issue sheets. Hard stop on excess.
          </span>
        </Link>
        <Link
          href="/press/validate"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">Press — Validate plate</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Scan plate barcode before run.
          </span>
        </Link>
        <div className="p-4 rounded-lg bg-slate-800 border border-slate-700 text-slate-400">
          <span className="font-medium text-white">Artwork — 4-lock approval</span>
          <span className="block text-sm mt-0.5">
            Go to job detail → Artwork tab or /artwork/[jobId].
          </span>
        </div>
        <a
          href="/oee"
          target="_blank"
          rel="noopener noreferrer"
          className="block p-4 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/50 text-white"
        >
          <span className="font-medium">OEE Live (TV)</span>
          <span className="block text-sm text-slate-400 mt-0.5">
            Public dashboard — no login. Opens in new tab.
          </span>
        </a>
      </nav>
    </main>
  )
}
