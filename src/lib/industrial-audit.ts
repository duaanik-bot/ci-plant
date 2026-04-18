import { createAuditLog } from '@/lib/audit'

export const INDUSTRIAL_DEFAULT_OPERATOR = 'Anik Dua'

/** Director-level / system industrial actions — defaults operator label to Anik Dua when not supplied. */
export async function logIndustrialStatusChange(params: {
  userId: string
  action: string
  module: string
  recordId?: string
  operatorLabel?: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  const operator = (params.operatorLabel?.trim() || INDUSTRIAL_DEFAULT_OPERATOR).trim()
  await createAuditLog({
    userId: params.userId,
    action: 'UPDATE',
    tableName: params.module,
    recordId: params.recordId,
    newValue: {
      industrialAction: params.action,
      operator,
      operatorDefault: INDUSTRIAL_DEFAULT_OPERATOR,
      timestamp: new Date().toISOString(),
      ...params.payload,
    },
  })
}
