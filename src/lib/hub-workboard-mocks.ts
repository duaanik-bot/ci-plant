/** Demo rows for hubs until wired to live shopfloor / custody APIs. */

export type HubCustodyFloorRow = {
  id: string
  toolCode: string
  machineId: string
  operator: string
  /** ISO 8601 — time tool left stores / went to floor */
  timeOutAt: string
}

export function getHubCustodyDemoRows(toolType: 'dies' | 'blocks' | 'shade_cards'): HubCustodyFloorRow[] {
  if (toolType === 'shade_cards') {
    return [
      {
        id: 'sc-cust-1',
        toolCode: 'SC-DEMO-1',
        machineId: 'INK-LAB',
        operator: 'P. Mehta',
        timeOutAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      },
      {
        id: 'sc-cust-2',
        toolCode: 'SC-DEMO-2',
        machineId: 'M-04',
        operator: 'S. Rao',
        timeOutAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
    ]
  }
  return [
    {
      id: 'hub-cust-1',
      toolCode: toolType === 'dies' ? 'DIE-1042-A' : 'EB-08-14',
      machineId: 'M-04',
      operator: 'R. Singh',
      timeOutAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    },
  ]
}
