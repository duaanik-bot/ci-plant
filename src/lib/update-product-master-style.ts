import type { PoManualPastingStyle } from '@/lib/pasting-style'
import { syncPastingStyleToMaster } from '@/app/actions/sync-pasting-style-to-master'

/**
 * Client helper: sync pasting to Product Master + linked Die (server action).
 */
export async function updateProductMasterStyle(
  productId: string,
  newStyle: PoManualPastingStyle,
  opts?: { actorLabel?: string },
): Promise<{ ok: true; cartonName?: string } | { ok: false; error: string }> {
  return syncPastingStyleToMaster(productId, newStyle, opts)
}
