import type { PrismaClient } from '@prisma/client'
import { embossOperationalIsRose } from '@/lib/emboss-hub-operational-status'

const FADE_MS = 180 * 86_400_000

export type KitSegmentState = {
  key: 'die' | 'block' | 'shade'
  label: string
  ok: boolean
  missing: boolean
  detail: string
  technicalId: string | null
}

function dieInRepair(condition: string, hubStatusFlag: string | null): boolean {
  const c = condition?.trim()
  if (c === 'Poor') return true
  return hubStatusFlag?.trim() === 'POOR_CONDITION'
}

function dieScrapped(active: boolean, scrappedAt: Date | null): boolean {
  return !active || scrappedAt != null
}

function effectiveShadeValidUntil(
  validUntil: Date | null,
  lastVerifiedAt: Date | null,
  approvalDate: Date | null,
): Date | null {
  if (validUntil) return validUntil
  const base = lastVerifiedAt ?? approvalDate
  if (!base) return null
  return new Date(base.getTime() + FADE_MS)
}

function shadeExpired(validUntil: Date | null): boolean {
  if (!validUntil) return true
  const end = new Date(validUntil)
  end.setHours(23, 59, 59, 999)
  return Date.now() > end.getTime()
}

function lineSuggestsEmboss(embossingLeafing: string | null | undefined): boolean {
  const v = (embossingLeafing ?? '').trim().toLowerCase()
  if (!v || v === 'no' || v === 'none') return false
  return true
}

export type ProductionKitForLine = {
  lineId: string
  cartonName: string
  segments: KitSegmentState[]
  allOk: boolean
  anyRose: boolean
}

export async function computeProductionKitForPo(
  db: PrismaClient,
  poId: string,
): Promise<{ lines: ProductionKitForLine[]; allOk: boolean; anyRose: boolean }> {
  const lines = await db.poLineItem.findMany({
    where: { poId },
    orderBy: { createdAt: 'asc' },
    include: {
      carton: {
        select: {
          id: true,
          cartonName: true,
          dieMasterId: true,
          embossBlockId: true,
          embossingLeafing: true,
          shadeCardId: true,
          dieMaster: {
            select: {
              id: true,
              dyeNumber: true,
              condition: true,
              active: true,
              scrappedAt: true,
              hubStatusFlag: true,
            },
          },
          embossBlock: {
            select: {
              id: true,
              blockCode: true,
              active: true,
              scrappedAt: true,
              condition: true,
              custodyStatus: true,
              issuedMachineId: true,
            },
          },
          shadeCard: {
            select: {
              id: true,
              shadeCode: true,
              validUntil: true,
              lastVerifiedAt: true,
              approvalDate: true,
              inkRecipeLink: true,
              customerApprovalDoc: true,
              approvalAttachmentUrl: true,
            },
          },
        },
      },
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          condition: true,
          active: true,
          scrappedAt: true,
          hubStatusFlag: true,
        },
      },
      shadeCard: {
        select: {
          id: true,
          shadeCode: true,
          validUntil: true,
          lastVerifiedAt: true,
          approvalDate: true,
          inkRecipeLink: true,
          customerApprovalDoc: true,
          approvalAttachmentUrl: true,
        },
      },
    },
  })

  const out: ProductionKitForLine[] = []

  for (const li of lines) {
    const dieId = li.dieMasterId ?? li.carton?.dieMasterId ?? null
    const die =
      li.dieMasterId && li.dieMaster
        ? li.dieMaster
        : li.carton?.dieMasterId && li.carton.dieMaster
          ? li.carton.dieMaster
          : null

    const dieMissing = !dieId || !die
    const dieOk =
      !dieMissing &&
      !dieScrapped(die!.active, die!.scrappedAt) &&
      !dieInRepair(die!.condition, die!.hubStatusFlag)

    const needsEmboss =
      Boolean(li.carton?.embossBlockId) ||
      lineSuggestsEmboss(li.embossingLeafing) ||
      lineSuggestsEmboss(li.carton?.embossingLeafing)

    const block = li.carton?.embossBlock ?? null
    const blockMissing = needsEmboss && !block
    const blockRose = block
      ? embossOperationalIsRose({
          active: block.active,
          scrappedAt: block.scrappedAt,
          condition: block.condition,
        })
      : blockMissing
    const blockOk = needsEmboss && block && !blockRose

    const shadeRow = li.shadeCard ?? li.carton?.shadeCard ?? null
    const shadeId = li.shadeCardId ?? li.carton?.shadeCardId ?? null
    const shadeMissing = !shadeId || !shadeRow

    const approvalUrl =
      shadeRow?.customerApprovalDoc?.trim() ||
      shadeRow?.approvalAttachmentUrl?.trim() ||
      ''
    const hasInkLink = Boolean(shadeRow?.inkRecipeLink?.trim())
    const vu = shadeRow
      ? effectiveShadeValidUntil(
          shadeRow.validUntil,
          shadeRow.lastVerifiedAt,
          shadeRow.approvalDate,
        )
      : null

    const shadeOk = !shadeMissing && !shadeExpired(vu) && hasInkLink && Boolean(approvalUrl)

    const segments: KitSegmentState[] = [
      {
        key: 'die',
        label: 'DIE',
        ok: dieOk,
        missing: dieMissing,
        detail: dieMissing
          ? 'No die master on line / carton'
          : !dieOk
            ? dieScrapped(die!.active, die!.scrappedAt)
              ? 'Die scrapped / inactive'
              : 'Die in repair / poor condition'
            : 'Ready',
        technicalId: die ? `DYE-${die.dyeNumber}` : null,
      },
      {
        key: 'block',
        label: 'BLOCK',
        ok: !needsEmboss || blockOk,
        missing: blockMissing,
        detail: !needsEmboss
          ? 'Emboss N/A'
          : blockMissing
            ? 'No emboss block on carton'
            : blockRose
              ? 'Block scrap / repair'
              : 'Ready',
        technicalId: block?.blockCode ?? null,
      },
      {
        key: 'shade',
        label: 'SHADE',
        ok: shadeOk,
        missing: shadeMissing,
        detail: shadeMissing
          ? 'No shade card linked'
          : !hasInkLink
            ? 'Ink recipe link missing'
            : !approvalUrl
              ? 'Customer approval doc missing'
              : shadeExpired(vu)
                ? 'Shade verification expired (>180d)'
                : 'Ready',
        technicalId: shadeRow?.shadeCode ?? null,
      },
    ]

    const anyRose = segments.some((s) => !s.ok)
    const allOk = segments.every((s) => s.ok)

    out.push({
      lineId: li.id,
      cartonName: li.cartonName,
      segments,
      allOk,
      anyRose,
    })
  }

  const allOk = out.length > 0 && out.every((r) => r.allOk)
  const anyRose = out.some((r) => r.anyRose)

  return { lines: out, allOk, anyRose }
}
