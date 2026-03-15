import { db } from './db'

export async function createAuditLog(params: {
  userId?: string
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT'
  tableName: string
  recordId?: string
  oldValue?: Record<string, unknown>
  newValue?: Record<string, unknown>
  ipAddress?: string
}) {
  try {
    await db.auditLog.create({
      data: {
        userId: params.userId ?? undefined,
        action: params.action,
        tableName: params.tableName,
        recordId: params.recordId ?? undefined,
        oldValue: (params.oldValue ?? undefined) as object | undefined,
        newValue: (params.newValue ?? undefined) as object | undefined,
        ipAddress: params.ipAddress ?? undefined,
      },
    })
  } catch (e) {
    console.error('[AuditLog] Failed to write:', e)
  }
}
