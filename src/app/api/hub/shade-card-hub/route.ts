import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import {
  loadPriorityPoLineContext,
  poLineMatchesShadeCard,
  rowMatchesSearchTokens,
} from '@/lib/hub-po-tooling-priority'
import { shadeCardAgeMonthsExact } from '@/lib/shade-card-age'
import { parseSpectroScanLog } from '@/lib/shade-card-spectro-log'

export const dynamic = 'force-dynamic'

const FADE_DAYS = 180

function daysSince(d: Date | null): number | null {
  if (!d) return null
  return Math.floor((Date.now() - d.getTime()) / 86_400_000)
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const tokens = q.split(/\s+/).filter(Boolean)

  const [priorityLines, cards] = await Promise.all([
    loadPriorityPoLineContext(db),
    db.shadeCard.findMany({
      where: { isActive: true },
      include: {
        customer: { select: { id: true, name: true } },
        product: {
          select: {
            id: true,
            cartonName: true,
            artworkCode: true,
            customer: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { shadeCode: 'asc' },
    }),
  ])

  const rows = cards
    .map((c) => {
      const industrialPriority = poLineMatchesShadeCard(priorityLines, {
        customerId: c.customerId,
        productMaster: c.productMaster,
        inkComponent: c.inkComponent,
      })
      const lastV = c.lastVerifiedAt ?? c.approvalDate
      const days = lastV ? daysSince(lastV) : null
      const validUntil =
        c.validUntil?.toISOString().slice(0, 10) ??
        (lastV
          ? new Date(lastV.getTime() + FADE_DAYS * 86_400_000).toISOString().slice(0, 10)
          : null)
      const fadeAlert =
        (c.validUntil != null && c.validUntil.getTime() < Date.now()) ||
        (days != null && days > FADE_DAYS)
      const deltaE = c.deltaEReading != null ? Number(c.deltaEReading) : null
      const deltaEAlert = deltaE != null && deltaE >= 2

      const hay = [
        c.shadeCode,
        c.productMaster,
        c.masterArtworkRef,
        c.inkComponent,
        c.remarks,
        c.customer?.name,
        c.productId,
        c.product?.cartonName,
        c.product?.customer?.name,
      ]
      if (!rowMatchesSearchTokens(tokens, hay)) return null

      const mfg = c.mfgDate
      const exact = shadeCardAgeMonthsExact(mfg)
      const currentAgeMonths = exact != null ? Math.round(exact * 10_000) / 10_000 : null
      return {
        id: c.id,
        shadeCode: c.shadeCode,
        productId: c.productId,
        product: c.product,
        productMaster: c.productMaster,
        masterArtworkRef: c.masterArtworkRef,
        substrateType: c.substrateType,
        labL: c.labL != null ? Number(c.labL) : null,
        labA: c.labA != null ? Number(c.labA) : null,
        labB: c.labB != null ? Number(c.labB) : null,
        inkRecipeNotes: c.inkRecipeNotes,
        spectroScanLog: parseSpectroScanLog(c.spectroScanLog),
        mfgDate: mfg?.toISOString().slice(0, 10) ?? null,
        currentAgeMonths,
        customer: c.customer,
        lastVerifiedAt: c.lastVerifiedAt?.toISOString().slice(0, 10) ?? null,
        approvalDate: c.approvalDate?.toISOString().slice(0, 10) ?? null,
        deltaEReading: deltaE,
        approvalAttachmentUrl: c.approvalAttachmentUrl,
        inkRecipeLink: c.inkRecipeLink,
        customerApprovalDoc: c.customerApprovalDoc,
        validUntil,
        spectroReportSummary: c.spectroReportSummary,
        colorSwatchHex: c.colorSwatchHex,
        custodyStatus: c.custodyStatus,
        industrialPriority,
        fadeAlert,
        deltaEAlert,
        daysSinceVerified: days,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)

  rows.sort((a, b) => {
    const pa = a.industrialPriority ? 1 : 0
    const pb = b.industrialPriority ? 1 : 0
    if (pa !== pb) return pb - pa
    return a.shadeCode.localeCompare(b.shadeCode)
  })

  return NextResponse.json({ rows })
}
