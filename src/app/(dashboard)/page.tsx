export const dynamic = 'force-dynamic'

import nextDynamic from 'next/dynamic'

const DashboardClient = nextDynamic(
  () => import('./DashboardClient').then((m) => ({ default: m.DashboardClient })),
  { ssr: false }
)

export default function DashboardPage() {
  return <DashboardClient />
}
