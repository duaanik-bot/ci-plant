import { notFound } from 'next/navigation'
import { parseHubToolType } from '@/lib/hub-types'
import HubPlatesShell from '@/components/hub/HubPlatesShell'
import HubInventoryShell from '@/components/hub/HubInventoryShell'
import HubToolingShell from '@/components/hub/HubToolingShell'

export default async function HubToolTypePage({
  params,
}: {
  params: Promise<{ toolType: string }>
}) {
  const { toolType: raw } = await params
  const toolType = parseHubToolType(raw)
  if (!toolType) notFound()

  if (toolType === 'plates') {
    return <HubPlatesShell />
  }

  if (toolType === 'dies') {
    return <HubToolingShell mode="dies" />
  }

  if (toolType === 'blocks') {
    return <HubToolingShell mode="blocks" />
  }

  return <HubInventoryShell toolType={toolType} />
}
