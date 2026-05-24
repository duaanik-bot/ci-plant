// src/lib/production-terminal-rules.test.ts
import { describe, it, expect } from 'vitest'
import { getTerminalRule, resolvePrintingMachine } from './production-terminal-rules'

describe('production-terminal-rules', () => {
  it('cutting fixes machine to CUT-01 and does not require operator', () => {
    const r = getTerminalRule('cutting')
    expect(r.fixedMachineCode).toBe('CUT-01')
    expect(r.machineSelectable).toBe(false)
    expect(r.operatorRequired).toBe(false)
  })

  it('printing auto-fills machine from operator, no machine select, operator required', () => {
    const r = getTerminalRule('printing')
    expect(r.machineSelectable).toBe(false)
    expect(r.machineAutoFromOperator).toBe(true)
    expect(r.operatorRequired).toBe(true)
    expect(resolvePrintingMachine('Modi')).toBe('PRN-02')
    expect(resolvePrintingMachine('Dileep Printing')).toBe('PRN-01')
    expect(resolvePrintingMachine('Shiv')).toBe('PRN-03')
    expect(resolvePrintingMachine('Unknown')).toBeNull()
  })

  it('coating / dye_cutting / pasting require both operator and machine', () => {
    for (const k of ['chemical_coating', 'dye_cutting', 'pasting'] as const) {
      const r = getTerminalRule(k)
      expect(r.operatorRequired).toBe(true)
      expect(r.machineSelectable).toBe(true)
      expect(r.machineRequired).toBe(true)
    }
  })

  it('returns a permissive default for stages without a terminal', () => {
    const r = getTerminalRule('lamination')
    expect(r.machineSelectable).toBe(true)
    expect(r.operatorRequired).toBe(false)
  })
})
