export const dynamic = 'force-dynamic'

import dynamicImport from 'next/dynamic'

const DashboardClient = dynamicImport(() => import('./DashboardClient'), { ssr: false })

export default function DashboardPage() {
  return <DashboardClient />
}
