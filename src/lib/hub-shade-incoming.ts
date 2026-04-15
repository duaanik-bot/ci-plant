import type { HubIncomingUnified } from '@/lib/hub-types'
import { mapStatusToVendorStage } from '@/lib/hub-types'

export function getShadeIncomingRows(): HubIncomingUnified[] {
  return [
    {
      id: 'shade-demo-1',
      toolType: 'shade_cards',
      code: 'SC-DEMO-1',
      title: 'PMS 185 C — folding carton',
      subtitle: 'QA batch',
      newLabel: 'New card',
      vendorStage: mapStatusToVendorStage('received_triage', null),
      approvalDate: new Date().toISOString().slice(0, 10),
      masterArtworkRef: 'MA-ART-001',
      physicalSampleAwaiting: false,
      raw: {},
    },
    {
      id: 'shade-demo-2',
      toolType: 'shade_cards',
      code: 'SC-VENDOR-02',
      title: 'PMS Cool Gray 11 — litho match',
      subtitle: 'Vendor order SC-449',
      newLabel: 'Reorder',
      vendorStage: mapStatusToVendorStage('in_production', 'vendor'),
      approvalDate: null,
      masterArtworkRef: 'MA-ART-204',
      physicalSampleAwaiting: true,
      raw: {},
    },
  ]
}
