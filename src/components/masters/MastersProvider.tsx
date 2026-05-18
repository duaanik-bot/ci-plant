'use client'

import { createContext, useContext, useCallback, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RegistryPayload } from '@/app/api/masters/registry/route'
import { FALLBACK_REGISTRY } from '@/lib/masters/fallback-snapshot'
import type { MasterKey } from '@/lib/masters/registry'

const QUERY_KEY = ['masters-registry'] as const

async function fetchRegistry(): Promise<RegistryPayload> {
  const res = await fetch('/api/masters/registry', { cache: 'no-store' })
  if (!res.ok) throw new Error(`registry ${res.status}`)
  return (await res.json()) as RegistryPayload
}

type Ctx = { registry: RegistryPayload; loading: boolean }
const MastersContext = createContext<Ctx | null>(null)

export function MastersProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchRegistry,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const registry = data ?? FALLBACK_REGISTRY
  return (
    <MastersContext.Provider value={{ registry, loading: isLoading }}>
      {children}
    </MastersContext.Provider>
  )
}

function useRegistry(): Ctx {
  const ctx = useContext(MastersContext)
  if (!ctx) throw new Error('useMaster must be used within <MastersProvider>')
  return ctx
}

export type MasterOption = { code: string; label: string }

export function useMaster(key: MasterKey): { options: MasterOption[]; loading: boolean } {
  const { registry, loading } = useRegistry()
  const cat = registry[key]
  const options = cat ? cat.values.map((v) => ({ code: v.code, label: v.label })) : []
  return { options, loading }
}

export function useMasterLabel(key: MasterKey, code: string | null | undefined): string {
  const { registry } = useRegistry()
  if (!code) return ''
  const hit = registry[key]?.values.find((v) => v.code === code)
  return hit?.label ?? code
}

export function useMastersRefresh(): () => void {
  const qc = useQueryClient()
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc])
}
