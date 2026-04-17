'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import type { PoManualPastingStyle } from '@/lib/pasting-style'
import { executeSyncPastingStyleToMaster } from '@/lib/sync-pasting-style-master-execute'

/**
 * Server action: sync pasting style to Product Master (carton) and linked Die master row(s).
 */
export async function syncPastingStyleToMaster(
  productId: string,
  style: PoManualPastingStyle,
  opts?: { actorLabel?: string },
): Promise<{ ok: true; cartonName: string } | { ok: false; error: string }> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { ok: false, error: 'Unauthorised' }
  }
  const actorLabel =
    opts?.actorLabel?.trim() || session.user.name?.trim() || 'Anik Dua'
  const result = await executeSyncPastingStyleToMaster({
    cartonId: productId,
    pastingStyle: style,
    userId: session.user.id,
    actorLabel,
  })
  if (result.ok === false) return { ok: false, error: result.error }
  return { ok: true, cartonName: result.cartonName }
}
