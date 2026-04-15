'use client'

import Link from 'next/link'
import type { HubToolType } from '@/lib/hub-types'

const LINKS: { id: HubToolType; label: string }[] = [
  { id: 'plates', label: 'Plates' },
  { id: 'dies', label: 'Dies' },
  { id: 'blocks', label: 'Embossing Blocks' },
  { id: 'shade_cards', label: 'Shade Cards' },
]

export function HubCategoryNav({ active }: { active: HubToolType }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Tooling category">
      {LINKS.map(({ id, label }) => (
        <Link
          key={id}
          href={`/hub/${id}`}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
            active === id
              ? 'bg-amber-600 border-amber-500 text-white'
              : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}
