import { describe, it, expect } from 'vitest'
import { computeReadinessFive, computeReleaseGuard } from './planningValidation'

const ok = {
  ups: 4,
  sheetLengthMm: 760,
  sheetWidthMm: 1020,
  boardType: 'FBB',
  gsm: 300,
  materialSelected: true,
  shortageSheets: 0,
  prStatus: 'not_created',
}

describe('computeReadinessFive', () => {
  it('is allReady when every gate passes and no shortage', () => {
    const r = computeReadinessFive(ok)
    expect(r.allReady).toBe(true)
    expect(r.blockers).toEqual([])
  })

  it('blocks when UPS missing', () => {
    const r = computeReadinessFive({ ...ok, ups: null })
    expect(r.allReady).toBe(false)
    expect(r.blockers).toContain('UPS not set')
  })

  it('blocks when sheet length or width missing', () => {
    expect(computeReadinessFive({ ...ok, sheetLengthMm: null }).blockers).toContain('Sheet size incomplete')
    expect(computeReadinessFive({ ...ok, sheetWidthMm: null }).blockers).toContain('Sheet size incomplete')
  })

  it('blocks when board type or GSM missing', () => {
    expect(computeReadinessFive({ ...ok, boardType: null }).blockers).toContain('Board type / GSM missing')
    expect(computeReadinessFive({ ...ok, gsm: null }).blockers).toContain('Board type / GSM missing')
  })

  it('blocks when no board allocation decision made', () => {
    expect(computeReadinessFive({ ...ok, materialSelected: false }).blockers).toContain('No board allocated')
  })

  it('blocks lock when shortage exists and no PR raised', () => {
    expect(computeReadinessFive({ ...ok, shortageSheets: 500 }).blockers).toContain('Shortage — raise PR or approval')
  })

  it('allows lock when shortage covered by a pending PR', () => {
    const r = computeReadinessFive({ ...ok, shortageSheets: 500, prStatus: 'pending' })
    expect(r.allReady).toBe(true)
  })
})

describe('computeReleaseGuard', () => {
  it('blocks Released when shortage and no PR', () => {
    expect(computeReleaseGuard({ shortageSheets: 10, prStatus: 'not_created' }).canRelease).toBe(false)
  })
  it('permits Released when no shortage', () => {
    expect(computeReleaseGuard({ shortageSheets: 0, prStatus: 'not_created' }).canRelease).toBe(true)
  })
  it('permits Released when shortage but PR approved', () => {
    expect(computeReleaseGuard({ shortageSheets: 10, prStatus: 'approved' }).canRelease).toBe(true)
  })
})
