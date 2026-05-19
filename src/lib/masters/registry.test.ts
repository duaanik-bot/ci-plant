import { describe, it, expect } from 'vitest'
import { MASTER, MASTER_KEYS } from './registry'

describe('MASTER registry', () => {
  it('exposes the 7 day-one category codes', () => {
    expect(MASTER).toEqual({
      UNIT: 'UNIT',
      BOARD_TYPE: 'BOARD_TYPE',
      BOARD_COLOUR: 'BOARD_COLOUR',
      COATING: 'COATING',
      FOIL: 'FOIL',
      EMBOSS: 'EMBOSS',
      PASTING: 'PASTING',
    })
  })
  it('each key maps to itself (stable category code)', () => {
    for (const k of MASTER_KEYS) expect(MASTER[k]).toBe(k)
  })
})
