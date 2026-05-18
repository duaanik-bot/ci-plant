import { describe, it, expect } from 'vitest'
import { computeWastageMatrix, computeWastageOverall, type WasteInput, type ReconInput } from './wastage'

const waste: WasteInput[] = [
  { stage: 'Printing', wasteType: 'makeready', qty: 100, unitCost: 5 },
  { stage: 'Printing', wasteType: 'run_waste', qty: 50, unitCost: 5 },
  { stage: 'Punching', wasteType: 'substrate_trim', qty: 30, unitCost: 4 },
]

describe('computeWastageMatrix', () => {
  const r = computeWastageMatrix(waste)
  it('builds a stage x type matrix with qty and value', () => {
    const printing = r.rows.find((x) => x.stage === 'Printing')!
    expect(printing.makeready_qty).toBe(100)
    expect(printing.run_waste_qty).toBe(50)
    expect(printing.makeready_val).toBe(500)
  })
  it('summary reports total waste value and worst stage', () => {
    expect(r.summary.find((s) => s.label === 'Total Waste ₹')!.value).toContain('870')
    expect(r.summary.find((s) => s.label === 'Worst Stage')!.value).toContain('Printing')
  })
})

describe('computeWastageOverall', () => {
  it('reconciles three sources and flags discrepancy', () => {
    const recon: ReconInput = {
      totalInput: 1000, goodOutput: 820,
      wasteRecordQty: 180, weightReconWaste: 175, yieldImpliedWaste: 200,
    }
    const r = computeWastageOverall(recon)
    const wastePct = r.summary.find((s) => s.label === 'Overall Waste %')!
    expect(wastePct.value).toBe('18.00%')
    expect(r.rows.some((x) => x.source === 'WasteRecord' && x.qty === 180)).toBe(true)
    expect(r.summary.find((s) => s.label === 'Reconciliation')!.tone).toBe('bad')
  })
})
