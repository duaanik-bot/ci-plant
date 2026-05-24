import { describe, it, expect, vi, beforeEach } from 'vitest'

// The service imports `db` (used as a default client) and the resolvers module.
// We pass our own mock client into createPurchaseRequestFromShortage, so the
// real `db` is never exercised — these mocks just keep the module importable.
vi.mock('@/lib/db', () => ({
  db: {},
}))
vi.mock('@/lib/production-os-resolvers', () => ({
  resolveRequirementFromLine: vi.fn(),
}))

import { createPurchaseRequestFromShortage } from './material-readiness-service'

type Mock = ReturnType<typeof vi.fn>

function buildMockClient() {
  const purchaseRequisition = {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
  }
  const materialShortage = {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  }
  const inventory = {
    findUnique: vi.fn(),
  }
  const poLineItem = {
    findUnique: vi.fn(),
  }
  // No `$transaction` key => withTransaction calls fn(client) directly,
  // so every tx.* call resolves against these mocks.
  return { purchaseRequisition, materialShortage, inventory, poLineItem }
}

describe('createPurchaseRequestFromShortage', () => {
  let client: ReturnType<typeof buildMockClient>

  beforeEach(() => {
    client = buildMockClient()

    client.materialShortage.findUnique.mockResolvedValue({
      id: 'shortage-1',
      materialId: 'mat-1',
      jobCardId: null,
      planningId: 'line-1',
      sourcePoLineId: 'line-1',
      triggerReason: 'planning_shortage',
      shortageQty: 700,
      allocatedQty: 300,
      remainingQty: 700,
      status: 'open',
      purchaseReqId: null,
      requiredByDate: null,
    })

    client.inventory.findUnique.mockResolvedValue({
      id: 'mat-1',
      boardType: 'SBS',
      gsm: 300,
      sheetLength: 900,
      sheetWidth: 600,
      supplierId: null,
    })

    // First poLineItem.findUnique = shortagePriorityKey lookup; second = planningLine
    client.poLineItem.findUnique
      .mockResolvedValueOnce({ directorPriority: false, po: { isPriority: false } })
      .mockResolvedValueOnce({
        id: 'line-1',
        cartonName: 'Lipstick Carton 50ml',
        po: { poNumber: 'PO-9001', deliveryRequiredBy: null },
      })

    client.purchaseRequisition.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'pr-1',
      ...args.data,
    }))
  })

  it('populates customerPoNumber, productName and requiredSheets on the created PR', async () => {
    const pr = await createPurchaseRequestFromShortage(
      'shortage-1',
      client as unknown as Parameters<typeof createPurchaseRequestFromShortage>[1],
    )

    expect(client.purchaseRequisition.create).toHaveBeenCalledTimes(1)
    const createArgs = (client.purchaseRequisition.create as Mock).mock.calls[0][0] as {
      data: Record<string, unknown>
    }

    expect(createArgs.data.customerPoNumber).toBe('PO-9001')
    expect(createArgs.data.productName).toBe('Lipstick Carton 50ml')
    // requiredSheets = shortageQty (700) + allocatedQty (300) = full requirement
    expect(createArgs.data.requiredSheets).toBe(1000)

    expect(pr.id).toBe('pr-1')
  })
})
