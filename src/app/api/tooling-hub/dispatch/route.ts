import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { PastingStyle } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'
import {
  toolingHubDispatchBodySchema,
  normalizeDispatchBody,
  type NormalizedToolingHubDispatch,
} from '@/lib/tooling-hub-dispatch-schema'
import {
  buildDispatchDedupeKey,
  isRecentDuplicateDispatch,
  recordDispatchSuccess,
} from '@/lib/tooling-hub-idempotency'
import { CUSTODY_HUB_TRIAGE } from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import { dieHubZoneLabelFromCustody, embossHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'
import {
  formatDimsLwhFromDb,
  normalizeDieMake,
  parseCartonSizeToDims,
  prismaDimsFromParsed,
} from '@/lib/die-hub-dimensions'
import { masterDieTypeLabel } from '@/lib/master-die-type'
import {
  coercePastingStyleInput,
  mapLegacyPastingToEnum,
  normalizePoTriagePastingStyle,
} from '@/lib/pasting-style'

export const dynamic = 'force-dynamic'

type DbClient = typeof db | Prisma.TransactionClient

async function loadDieMasterForLine(
  tx: DbClient,
  poLineId: string | undefined,
): Promise<{
  id: string
  dyeNumber: number
  dyeType: string
  pastingStyle: PastingStyle | null
  dimLengthMm: unknown
  dimWidthMm: unknown
  dimHeightMm: unknown
} | null> {
  const pid = String(poLineId ?? '').trim()
  if (!pid) return null
  const line = await tx.poLineItem.findUnique({
    where: { id: pid },
    select: { dieMasterId: true, cartonId: true, dyeId: true },
  })
  if (!line) return null
  let masterId =
    line.dieMasterId?.trim() || line.dyeId?.trim() || null
  if (!masterId && line.cartonId) {
    const c = await tx.carton.findUnique({
      where: { id: line.cartonId },
      select: { dieMasterId: true, dyeId: true },
    })
    masterId = c?.dieMasterId?.trim() || c?.dyeId?.trim() || null
  }
  if (!masterId) return null
  const master = await tx.dye.findUnique({
    where: { id: masterId },
    select: {
      id: true,
      dyeNumber: true,
      dyeType: true,
      pastingStyle: true,
      dimLengthMm: true,
      dimWidthMm: true,
      dimHeightMm: true,
    },
  })
  return master
}

function buildDieNumber(existingMax: number | null): number {
  const year = new Date().getFullYear()
  const base = year * 1000
  if (!existingMax || existingMax < base) return base + 1
  return existingMax + 1
}

async function resolveDieTriageSpecs(
  tx: DbClient,
  data: NormalizedToolingHubDispatch,
): Promise<{
  sheetSize: string
  ups: number
  awRef: string
  cartonSize: string
  dieMake: 'local' | 'laser'
  triageDyeType: string
  sourceDieMasterId: string | null
  sourceMasterDyeNumber: number | null
  sourceMasterTypeLabel: string | null
  pastingStyle: PastingStyle
}> {
  let sheet = data.actualSheetSize.trim()
  let ups = data.ups
  let awRef = (data.awCode.trim() || data.artworkId.trim()).trim()
  let cartonSize = data.cartonSize.trim()
  let pastingStyle: PastingStyle | null = null
  let dieMake: 'local' | 'laser' = 'local'
  let triageDyeType = 'Die Hub Triage'
  let sourceDieMasterId: string | null = null
  let sourceMasterDyeNumber: number | null = null
  let sourceMasterTypeLabel: string | null = null

  const master = await loadDieMasterForLine(tx, data.poLineId)
  if (master) {
    sourceDieMasterId = master.id
    sourceMasterDyeNumber = master.dyeNumber
    triageDyeType = master.dyeType?.trim() || triageDyeType
    sourceMasterTypeLabel = masterDieTypeLabel({
      dyeType: master.dyeType,
      pastingStyle: master.pastingStyle,
    })
    if (master.pastingStyle === PastingStyle.LOCK_BOTTOM || master.pastingStyle === PastingStyle.BSO) {
      pastingStyle = master.pastingStyle
    }
    if (
      master.dimLengthMm != null &&
      master.dimWidthMm != null &&
      master.dimHeightMm != null &&
      !cartonSize
    ) {
      const lwh =
        formatDimsLwhFromDb({
          dimLengthMm: master.dimLengthMm as { toString(): string },
          dimWidthMm: master.dimWidthMm as { toString(): string },
          dimHeightMm: master.dimHeightMm as { toString(): string },
        }) ?? ''
      if (lwh.trim()) cartonSize = lwh.trim()
    }
  }

  if (data.poLineId) {
    const line = await tx.poLineItem.findUnique({
      where: { id: data.poLineId },
      select: {
        specOverrides: true,
        artworkCode: true,
        cartonSize: true,
        cartonId: true,
        lineDieType: true,
        dimLengthMm: true,
        dimWidthMm: true,
        dimHeightMm: true,
      },
    })
    if (line) {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      if (!sheet && typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()) {
        sheet = spec.actualSheetSize.trim()
      }
      if (ups == null) {
        const u = spec.ups ?? spec.numberOfUps
        if (typeof u === 'number' && Number.isFinite(u) && u >= 1) ups = Math.floor(u)
      }
      if (!awRef && line.artworkCode?.trim()) awRef = line.artworkCode.trim()
      if (!cartonSize && line.cartonSize?.trim()) cartonSize = line.cartonSize.trim()
      const specPaste =
        coercePastingStyleInput(spec.pastingType) ??
        coercePastingStyleInput(spec.pastingStyle) ??
        mapLegacyPastingToEnum(
          typeof spec.pastingType === 'string' ? spec.pastingType : undefined,
        )
      if (specPaste) pastingStyle = specPaste
      if (typeof spec.dieMake === 'string' && spec.dieMake.trim()) {
        dieMake = normalizeDieMake(spec.dieMake)
      }

      if (
        !cartonSize &&
        line.dimLengthMm != null &&
        line.dimWidthMm != null &&
        line.dimHeightMm != null
      ) {
        const lwh =
          formatDimsLwhFromDb({
            dimLengthMm: line.dimLengthMm as { toString(): string },
            dimWidthMm: line.dimWidthMm as { toString(): string },
            dimHeightMm: line.dimHeightMm as { toString(): string },
          }) ?? ''
        if (lwh.trim()) cartonSize = lwh.trim()
      }
      const linePaste =
        coercePastingStyleInput(line.lineDieType) ??
        mapLegacyPastingToEnum(line.lineDieType)
      if (!pastingStyle && linePaste) pastingStyle = linePaste

      const cid = (data.cartonId || line.cartonId || '').trim()
      if (cid) {
        const c = await tx.carton.findUnique({
          where: { id: cid },
          select: {
            finishedLength: true,
            finishedWidth: true,
            finishedHeight: true,
            pastingStyle: true,
          },
        })
        if (c) {
          if (!cartonSize) {
            const L = c.finishedLength != null ? String(c.finishedLength) : ''
            const W = c.finishedWidth != null ? String(c.finishedWidth) : ''
            const H = c.finishedHeight != null ? String(c.finishedHeight) : ''
            if (L && W && H) cartonSize = `${L}×${W}×${H}`
          }
          if (!pastingStyle && c.pastingStyle != null) pastingStyle = c.pastingStyle
        }
      }
    }
  } else if (data.cartonId.trim()) {
    const c = await tx.carton.findUnique({
      where: { id: data.cartonId.trim() },
      select: {
        finishedLength: true,
        finishedWidth: true,
        finishedHeight: true,
        pastingStyle: true,
      },
    })
    if (c) {
      if (!cartonSize) {
        const L = c.finishedLength != null ? String(c.finishedLength) : ''
        const W = c.finishedWidth != null ? String(c.finishedWidth) : ''
        const H = c.finishedHeight != null ? String(c.finishedHeight) : ''
        if (L && W && H) cartonSize = `${L}×${W}×${H}`
      }
      if (!pastingStyle && c.pastingStyle != null) pastingStyle = c.pastingStyle
    }
  }

  if (master) {
    if (master.pastingStyle === PastingStyle.LOCK_BOTTOM || master.pastingStyle === PastingStyle.BSO) {
      pastingStyle = master.pastingStyle
    }
    triageDyeType = master.dyeType?.trim() || triageDyeType
    sourceMasterTypeLabel = masterDieTypeLabel({
      dyeType: master.dyeType,
      pastingStyle: master.pastingStyle,
    })
  }

  return {
    sheetSize: sheet,
    ups: ups ?? 0,
    awRef: awRef || '—',
    cartonSize: cartonSize.trim() || '—',
    pastingStyle: normalizePoTriagePastingStyle(pastingStyle),
    dieMake,
    triageDyeType,
    sourceDieMasterId,
    sourceMasterDyeNumber,
    sourceMasterTypeLabel,
  }
}

async function resolveEmbossTriageSpecs(
  tx: DbClient,
  data: NormalizedToolingHubDispatch,
): Promise<{
  sheet: string
  awRef: string
  blockType: string
  cartonName: string
  cartonId: string | null
  customerId: string | null
}> {
  let sheet = data.actualSheetSize.trim()
  let awRef = (data.awCode.trim() || data.artworkId.trim()).trim()
  let blockType = data.blockType.trim()
  let cartonName = ''
  let cartonId: string | null = data.cartonId.trim() || null
  let customerId: string | null = null

  if (data.poLineId) {
    const line = await tx.poLineItem.findUnique({
      where: { id: data.poLineId },
      select: {
        specOverrides: true,
        artworkCode: true,
        cartonName: true,
        cartonId: true,
        embossingLeafing: true,
        po: { select: { customerId: true } },
      },
    })
    if (line) {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      if (!sheet && typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()) {
        sheet = spec.actualSheetSize.trim()
      }
      if (!awRef && line.artworkCode?.trim()) awRef = line.artworkCode.trim()
      cartonName = line.cartonName?.trim() || ''
      if (!cartonId && line.cartonId?.trim()) cartonId = line.cartonId.trim()
      customerId = line.po.customerId
      if (!blockType && line.embossingLeafing?.trim()) blockType = line.embossingLeafing.trim()
    }
  }

  if (!blockType) blockType = 'Embossing'

  return {
    sheet,
    awRef: awRef || '—',
    blockType,
    cartonName: cartonName || '—',
    cartonId,
    customerId,
  }
}

async function allocateEmbossTriageBlockCode(tx: DbClient, reference: string): Promise<string> {
  const base = `EMB-HUB-${reference.replace(/^TH-/, '')}`
  let code = base
  let n = 0
  while (
    await tx.embossBlock.findUnique({ where: { blockCode: code }, select: { id: true } })
  ) {
    n += 1
    code = `${base}-${n}`
  }
  return code
}

function dispatchArtworkFingerprint(data: NormalizedToolingHubDispatch): string {
  if (data.artworkId.trim()) return data.artworkId.trim()
  if (data.toolType === 'BLOCK') {
    return `MANUAL|${data.awCode}|${data.actualSheetSize}|${data.blockType}`
  }
  return `MANUAL|${data.awCode}|${data.actualSheetSize}|${data.ups ?? 0}`
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = toolingHubDispatchBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const errMsg = first
      ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
      : 'Validation failed'
    return NextResponse.json(
      {
        error: errMsg,
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'body', i.message]),
        ),
      },
      { status: 400 },
    )
  }

  const data = normalizeDispatchBody(parsed.data)
  const dedupeKey = buildDispatchDedupeKey(user!.id, {
    toolType: data.toolType,
    jobCardId: data.jobCardId,
    artworkId: dispatchArtworkFingerprint(data),
    setNumber: data.setNumber,
    source: data.source,
  })

  if (isRecentDuplicateDispatch(dedupeKey)) {
    return NextResponse.json({
      ok: true,
      idempotentReplay: true,
      message: 'Duplicate dispatch suppressed (within 5 seconds)',
      reference: null,
      dyeId: null,
      embossBlockId: null,
    })
  }

  const reference = `TH-${Date.now()}`

  let dieTriageSpec: Awaited<ReturnType<typeof resolveDieTriageSpecs>> | null = null
  if (data.toolType === 'DIE' && data.source === 'NEW') {
    dieTriageSpec = await resolveDieTriageSpecs(db, data)
    if (!dieTriageSpec.sheetSize || dieTriageSpec.ups < 1) {
      return NextResponse.json(
        {
          error:
            'Die triage requires actual sheet size and number of UPS (enter on the spec page or save specs first).',
        },
        { status: 400 },
      )
    }
    if (!parseCartonSizeToDims(dieTriageSpec.cartonSize)) {
      return NextResponse.json(
        {
          error:
            'Die triage requires three carton dimensions (L×W×H mm), e.g. 100×50×30.',
        },
        { status: 400 },
      )
    }
  }

  let embossTriageSpec: Awaited<ReturnType<typeof resolveEmbossTriageSpecs>> | null = null
  if (data.toolType === 'BLOCK' && data.source === 'NEW') {
    embossTriageSpec = await resolveEmbossTriageSpecs(db, data)
    if (!embossTriageSpec.sheet) {
      return NextResponse.json(
        {
          error:
            'Emboss triage requires actual sheet size (enter on the spec page or save specs first).',
        },
        { status: 400 },
      )
    }
    if (!parseCartonSizeToDims(data.cartonSize)) {
      return NextResponse.json(
        {
          error:
            'Emboss triage requires three carton dimensions (L×W×H mm) on the job line.',
        },
        { status: 400 },
      )
    }
  }

  const authorityAudit = data.authorityPush
    ? {
        directorAuthority: data.authorityPush.directorLabel,
        specialRemarks: data.authorityPush.specialRemarks ?? null,
        linkedDieMaster: data.authorityPush.linkedDieMaster ?? null,
      }
    : null

  const auditPayload = {
    ...data,
    reference,
    authorityPush: data.authorityPush,
  }

  let createdDyeId: string | null = null
  let createdEmbossBlockId: string | null = null
  const dispatchActor = user?.name?.trim() || 'Operator'

  await db.$transaction(async (tx) => {
    if (dieTriageSpec) {
      const lastDye = await tx.dye.findFirst({
        orderBy: { dyeNumber: 'desc' },
        select: { dyeNumber: true },
      })
      const dyeNumber = buildDieNumber(lastDye?.dyeNumber ?? null)
      const dims = prismaDimsFromParsed(parseCartonSizeToDims(dieTriageSpec.cartonSize))
      const dye = await tx.dye.create({
        data: {
          dyeNumber,
          dyeType: dieTriageSpec.triageDyeType,
          ups: dieTriageSpec.ups,
          sheetSize: dieTriageSpec.sheetSize,
          cartonSize: dieTriageSpec.cartonSize,
          custodyStatus: CUSTODY_HUB_TRIAGE,
          pastingStyle: dieTriageSpec.pastingStyle,
          dieMake: dieTriageSpec.dieMake,
          ...(dims ?? {}),
        },
      })
      createdDyeId = dye.id
      await createDieHubEvent(tx, {
        dyeId: dye.id,
        actionType: DIE_HUB_ACTION.PUSH_TO_TRIAGE,
        fromZone: null,
        toZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        actorName: dispatchActor,
        details: {
          DieJobId: data.jobCardId,
          awReference: dieTriageSpec.awRef,
          DieDimensions: dieTriageSpec.sheetSize,
          UpsCount: dieTriageSpec.ups,
          status: 'DIE_TRIAGE',
          poLineId: data.poLineId || null,
          artworkId: data.artworkId || null,
          setNumber: data.setNumber,
          dieMasterId: dieTriageSpec.sourceDieMasterId,
          masterDyeNumber: dieTriageSpec.sourceMasterDyeNumber,
          masterDieType: dieTriageSpec.sourceMasterTypeLabel,
          cartonLwh: dieTriageSpec.cartonSize,
          ...(authorityAudit ?? {}),
        },
      })
    }

    if (embossTriageSpec) {
      const blockCode = await allocateEmbossTriageBlockCode(tx, reference)
      const block = await tx.embossBlock.create({
        data: {
          blockCode,
          blockType: embossTriageSpec.blockType,
          blockSize: embossTriageSpec.sheet,
          cartonName: embossTriageSpec.cartonName,
          cartonId: embossTriageSpec.cartonId,
          customerId: embossTriageSpec.customerId,
          custodyStatus: CUSTODY_HUB_TRIAGE,
        },
      })
      createdEmbossBlockId = block.id
      const manualEntry = !data.artworkId.trim()
      await createEmbossHubEvent(tx, {
        blockId: block.id,
        actionType: EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE,
        fromZone: null,
        toZone: embossHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        details: {
          EmbossJobId: data.jobCardId,
          awReference: embossTriageSpec.awRef,
          BlockDimensions: embossTriageSpec.sheet,
          BlockType: embossTriageSpec.blockType,
          status: 'EMBOSS_TRIAGE',
          manualEntry,
          poLineId: data.poLineId || null,
          artworkId: data.artworkId || null,
          setNumber: data.setNumber,
          ...(authorityAudit ?? {}),
        },
      })
    }

    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'INSERT',
        tableName: 'tooling_hub_dispatch',
        recordId: data.jobCardId,
        newValue: { ...auditPayload, dyeId: createdDyeId, embossBlockId: createdEmbossBlockId } as object,
      },
    })
  })

  recordDispatchSuccess(dedupeKey)

  return NextResponse.json({
    ok: true,
    idempotentReplay: false,
    reference,
    dyeId: createdDyeId,
    embossBlockId: createdEmbossBlockId,
    ...data,
  })
}
