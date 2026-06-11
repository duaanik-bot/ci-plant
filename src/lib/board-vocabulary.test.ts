import { describe, expect, it } from 'vitest'
import {
  boardTypeLabelsMatch,
  normalizeBoardTypeForStorage,
  normalizeBoardTypeOptions,
} from '@/lib/board-vocabulary'

describe('board vocabulary normalization', () => {
  it('maps legacy SBS child color labels to board names', () => {
    expect(normalizeBoardTypeForStorage('Yellow')).toBe('FBB')
    expect(normalizeBoardTypeForStorage('COLOUR YELLOW')).toBe('FBB')
    expect(normalizeBoardTypeForStorage('White')).toBe('Saffire')
    expect(normalizeBoardTypeForStorage('Darbi White')).toBe('Saffire')
  })

  it('preserves Duplex as WB/GB variants', () => {
    expect(normalizeBoardTypeForStorage('WB')).toBe('Duplex WB')
    expect(normalizeBoardTypeForStorage('GB')).toBe('Duplex GB')
    expect(normalizeBoardTypeForStorage('Duplex WB')).toBe('Duplex WB')
    expect(normalizeBoardTypeForStorage('Duplex GB')).toBe('Duplex GB')
  })

  it('dedupes legacy and canonical options', () => {
    expect(normalizeBoardTypeOptions(['Yellow', 'FBB', 'White', 'Saffire', 'WB', 'Duplex WB'])).toEqual([
      'FBB',
      'Saffire',
      'Duplex WB',
    ])
  })

  it('matches old records against canonical requests', () => {
    expect(boardTypeLabelsMatch('FBB', 'Yellow')).toBe(true)
    expect(boardTypeLabelsMatch('Saffire', 'White')).toBe(true)
    expect(boardTypeLabelsMatch('Duplex WB', 'WB')).toBe(true)
    expect(boardTypeLabelsMatch('Duplex GB', 'Duplex WB')).toBe(false)
  })
})
