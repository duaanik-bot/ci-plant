import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import {
  presentPlateHubAuditRow,
  type RawAuditRow,
} from '@/lib/plate-hub-audit-presentation'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const requirementId = req.nextUrl.searchParams.get('requirementId')?.trim()
  const plateStoreId = req.nextUrl.searchParams.get('plateStoreId')?.trim()

  if ((requirementId ? 1 : 0) + (plateStoreId ? 1 : 0) !== 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of requirementId or plateStoreId' },
      { status: 400 },
    )
  }

  let rows: RawAuditRow[]
  if (requirementId) {
    rows = await db.$queryRaw<RawAuditRow[]>`
      SELECT
        id,
        user_id AS "userId",
        action,
        table_name AS "tableName",
        record_id AS "recordId",
        old_value AS "oldValue",
        new_value AS "newValue",
        timestamp
      FROM audit_log
      WHERE record_id = ${requirementId}
         OR (
           new_value IS NOT NULL
           AND (new_value::jsonb->>'requirementId') = ${requirementId}
         )
      ORDER BY timestamp DESC
      LIMIT 250
    `
  } else {
    rows = await db.$queryRaw<RawAuditRow[]>`
      SELECT
        id,
        user_id AS "userId",
        action,
        table_name AS "tableName",
        record_id AS "recordId",
        old_value AS "oldValue",
        new_value AS "newValue",
        timestamp
      FROM audit_log
      WHERE record_id = ${plateStoreId!}
         OR (
           new_value IS NOT NULL
           AND (new_value::jsonb->>'plateStoreId') = ${plateStoreId!}
         )
      ORDER BY timestamp DESC
      LIMIT 250
    `
  }

  const seen = new Set<string>()
  const unique: RawAuditRow[] = []
  for (const r of rows) {
    const k = r.id.toString()
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(r)
  }
  unique.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

  const userIds = Array.from(
    new Set(unique.map((r) => r.userId).filter(Boolean)),
  ) as string[]
  const users =
    userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : []
  const nameById = new Map(users.map((u) => [u.id, u.name ?? u.id] as const))

  const entries = unique.map((r) => {
    const p = presentPlateHubAuditRow(r)
    const by = r.userId ? nameById.get(r.userId) : null
    return {
      id: r.id.toString(),
      ...p,
      performedBy: by ?? null,
    }
  })

  return new NextResponse(safeJsonStringify({ entries }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
