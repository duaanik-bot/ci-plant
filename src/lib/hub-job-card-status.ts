/** Map production job card state to Plate Hub custody badges. */
export type HubJobCardStatusKey = 'planning' | 'press' | 'printed'

export type HubJobCardHubStatus = {
  key: HubJobCardStatusKey
  badgeLabel: string
}

export function hubJobCardHubStatus(jc: {
  status: string
  finalQcPass: boolean
  qaReleased: boolean
}): HubJobCardHubStatus {
  if (jc.qaReleased || jc.finalQcPass) {
    return { key: 'printed', badgeLabel: 'Printed' }
  }
  const s = String(jc.status ?? '').toLowerCase()
  if (s === 'completed' || s === 'closed' || s === 'done') {
    return { key: 'printed', badgeLabel: 'Printed' }
  }
  if (s === 'design_ready' || s === 'pending') {
    return { key: 'planning', badgeLabel: 'In Planning' }
  }
  return { key: 'press', badgeLabel: 'On Press' }
}
