// src/lib/rbac.test.ts
import { describe, it, expect } from 'vitest'
import { ROLE_SLUGS, ROLE_LABELS, hasModuleAccess, roleHasFullSystem } from './rbac'

describe('rbac', () => {
  it('defines exactly the five roles', () => {
    expect([...ROLE_SLUGS].sort()).toEqual(
      ['accounts', 'admin', 'design_planning', 'plant_head', 'production'].sort(),
    )
  })

  it('admin and plant_head have full system access', () => {
    expect(roleHasFullSystem('admin')).toBe(true)
    expect(roleHasFullSystem('plant_head')).toBe(true)
    expect(roleHasFullSystem('accounts')).toBe(false)
    expect(hasModuleAccess('admin', 'reports')).toBe(true)
    expect(hasModuleAccess('plant_head', 'masters')).toBe(true)
  })

  it('accounts sees only customer_po and paper_warehouse', () => {
    expect(hasModuleAccess('accounts', 'customer_po')).toBe(true)
    expect(hasModuleAccess('accounts', 'paper_warehouse')).toBe(true)
    expect(hasModuleAccess('accounts', 'planning')).toBe(false)
    expect(hasModuleAccess('accounts', 'reports')).toBe(false)
  })

  it('design_planning sees its six modules but not paper_warehouse', () => {
    for (const m of ['customer_po', 'planning', 'artwork_queue', 'job_cards', 'cutting', 'printing'] as const) {
      expect(hasModuleAccess('design_planning', m)).toBe(true)
    }
    expect(hasModuleAccess('design_planning', 'paper_warehouse')).toBe(false)
    expect(hasModuleAccess('design_planning', 'reports')).toBe(false)
  })

  it('production sees only cutting and printing', () => {
    expect(hasModuleAccess('production', 'cutting')).toBe(true)
    expect(hasModuleAccess('production', 'printing')).toBe(true)
    expect(hasModuleAccess('production', 'job_cards')).toBe(false)
  })

  it('is case-insensitive and safe on unknown roles', () => {
    expect(hasModuleAccess('ADMIN', 'reports')).toBe(true)
    expect(hasModuleAccess(undefined, 'reports')).toBe(false)
    expect(hasModuleAccess('legacy_md', 'reports')).toBe(false)
  })

  it('has a label for every role', () => {
    expect(ROLE_LABELS.admin).toBe('Admin')
    expect(ROLE_LABELS.plant_head).toBe('Plant Head')
    expect(ROLE_LABELS.design_planning).toBe('Design & Planning')
  })
})
