import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    poLineItem: { findUnique: vi.fn() },
    productionJobCard: { findFirst: vi.fn() },
    inventory: { findUnique: vi.fn() },
    stockMovement: { findMany: vi.fn() },
    materialShortage: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/material-readiness-service', () => ({
  calculateRequirement: vi.fn(),
  createShortage: vi.fn(),
  reserveMaterial: vi.fn(),
  reserveMaterialForPlanning: vi.fn(),
  ShortagePrRecoveryError: class ShortagePrRecoveryError extends Error {
    shortageId: string
    constructor(shortageId: string, message: string) {
      super(message)
      this.shortageId = shortageId
    }
  },
}))

// Mock all the heavy production-os-resolvers to avoid pulling in full Prisma
vi.mock('@/lib/production-os-resolvers', () => ({
  resolveBoardReadiness: vi.fn(() => 'Shortage'),
  resolveMaterial: vi.fn(() => ({ materialId: null })),
  resolveSheetSize: vi.fn(() => null),
  resolveRequirementFromLine: vi.fn(() => ({
    qty: 1000,
    ups: 1,
    wastageSheets: 150,
    baseSheets: 1000,
    requiredSheets: 1150,
    makeReadySheets: 0,
  })),
  resolveReservationState: vi.fn(() => ({ freeStock: 0, reserveQty: 0 })),
  resolveShortageState: vi.fn(() => ({ shortageSheets: 1150 })),
}))
vi.mock('@/lib/planning-sheet-size', () => ({
  parseSheetSizeToPair: vi.fn(() => null),
}))
vi.mock('@/lib/material-cut-fit', () => ({
  buildMaterialCutFitOptions: vi.fn(() => []),
}))

import { POST } from './route'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createShortage } from '@/lib/material-readiness-service'

// Minimal PoLineItem returned by resolvePlanningContext
const mockLine = {
  id: 'line-1',
  quantity: 1000,
  jobCardNumber: null,
  specOverrides: null,
  paperType: null,
  gsm: null,
  carton: null,
  materialQueue: null,
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/planning/po-lines/line-1/reserve-material', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(db.poLineItem.findUnique).mockReset()
  vi.mocked(db.productionJobCard.findFirst).mockReset()
  vi.mocked(db.inventory.findUnique).mockReset()
  vi.mocked(db.stockMovement.findMany).mockReset()
  vi.mocked(createShortage).mockReset()
})

describe('POST /api/planning/po-lines/[id]/reserve-material — ensure_shortage branch', () => {
  it('returns 401 when auth fails', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: new Response('no', { status: 401 }) } as never)
    const res = await POST(makeRequest({ actionType: 'ensure_shortage' }) as never, {
      params: Promise.resolve({ id: 'line-1' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns shortageId when deficit > 0', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.poLineItem.findUnique).mockResolvedValue(mockLine as never)
    vi.mocked(db.productionJobCard.findFirst).mockResolvedValue(null as never)
    // First call: materialId pick-check (select: { id: true }) → confirms material exists
    // Second call: stock-level check in ensure_shortage branch
    vi.mocked(db.inventory.findUnique)
      .mockResolvedValueOnce({ id: 'mat-1' } as never)       // pick-check
      .mockResolvedValueOnce({ qtyAvailable: 0 } as never)   // stock check
    // No existing stock movements (nothing reserved for line)
    vi.mocked(db.stockMovement.findMany).mockResolvedValue([] as never)
    vi.mocked(createShortage).mockResolvedValue({ id: 'shortage-abc' } as never)

    const res = await POST(
      makeRequest({
        actionType: 'ensure_shortage',
        materialId: 'mat-1',
        requiredSheets: 1150,
      }) as never,
      { params: Promise.resolve({ id: 'line-1' }) },
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.shortageId).toBe('shortage-abc')
    expect(json.deficit).toBeGreaterThan(0)
    // Must NOT have reserved any stock
    expect(vi.mocked(createShortage)).toHaveBeenCalledTimes(1)
  })

  it('returns shortageId: null when stock covers requirement (no shortage)', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.poLineItem.findUnique).mockResolvedValue(mockLine as never)
    vi.mocked(db.productionJobCard.findFirst).mockResolvedValue(null as never)
    // First call: materialId pick-check; second call: stock-level check (plenty available)
    vi.mocked(db.inventory.findUnique)
      .mockResolvedValueOnce({ id: 'mat-1' } as never)         // pick-check
      .mockResolvedValueOnce({ qtyAvailable: 9999 } as never)  // stock check
    vi.mocked(db.stockMovement.findMany).mockResolvedValue([] as never)

    const res = await POST(
      makeRequest({
        actionType: 'ensure_shortage',
        materialId: 'mat-1',
        requiredSheets: 100,
      }) as never,
      { params: Promise.resolve({ id: 'line-1' }) },
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.shortageId).toBeNull()
    expect(json.deficit).toBe(0)
    expect(vi.mocked(createShortage)).not.toHaveBeenCalled()
  })

  it('returns 400 NO_MATERIAL when no material can be resolved', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.poLineItem.findUnique).mockResolvedValue(mockLine as never)
    vi.mocked(db.productionJobCard.findFirst).mockResolvedValue(null as never)
    // No materialId in body, auto resolves to null (mock already returns null)
    vi.mocked(db.inventory.findUnique).mockResolvedValue(null as never)

    const res = await POST(
      makeRequest({ actionType: 'ensure_shortage', requiredSheets: 500 }) as never,
      { params: Promise.resolve({ id: 'line-1' }) },
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.errorCode).toBe('NO_MATERIAL')
  })
})
