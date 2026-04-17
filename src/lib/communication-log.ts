import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type CommunicationLogInput = {
  channel: 'email' | 'whatsapp' | 'system'
  subject?: string | null
  bodyPreview?: string | null
  toAddress?: string | null
  status: 'sent' | 'failed' | 'skipped'
  errorMessage?: string | null
  metadata?: Record<string, unknown>
  relatedTable?: string
  relatedId?: string
  actorLabel?: string
  userId?: string
}

export async function logCommunication(entry: CommunicationLogInput): Promise<void> {
  try {
    await db.communicationLog.create({
      data: {
        channel: entry.channel,
        direction: 'outbound',
        subject: entry.subject ?? null,
        bodyPreview: entry.bodyPreview ?? null,
        toAddress: entry.toAddress ?? null,
        status: entry.status,
        errorMessage: entry.errorMessage ?? null,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        relatedTable: entry.relatedTable ?? null,
        relatedId: entry.relatedId ?? null,
        actorLabel: entry.actorLabel ?? 'Anik Dua',
        userId: entry.userId ?? null,
      },
    })
  } catch (e) {
    console.error('[communication_log] persist failed:', e)
  }
}
