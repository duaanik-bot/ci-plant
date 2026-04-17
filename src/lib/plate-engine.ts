import type { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

/** DB or interactive transaction client (same delegates for our usage). */
export type DbOrTx = typeof db | Prisma.TransactionClient

export type PlateColour = {
  name: string
  type?: 'process' | 'pantone' | string
  status?: 'new' | 'old' | 'issued' | 'returned' | 'destroyed' | string
  rackLocation?: string | null
  condition?: string
  slotNumber?: string | null
  destroyedAt?: string
  destroyReason?: string
}

export type ColourNeed = { name: string }

export type PlateAvailabilityResult = {
  status: 'all_new' | 'all_available' | 'partial'
  newNeeded: number
  oldAvailable: number
  plateSetCode: string | null
  rackLocation?: string | null
  message: string
  action: 'trigger_ctp' | 'issue_from_rack' | 'partial_issue_plus_ctp'
  missingColours?: string[]
  availableColours?: string[]
}

function parseColours(input: unknown): PlateColour[] {
  if (!Array.isArray(input)) return []
  return input.filter((c): c is PlateColour => {
    if (!c || typeof c !== 'object') return false
    const v = c as Record<string, unknown>
    return typeof v.name === 'string'
  })
}

function normaliseArtworkVersion(v: string): string {
  const t = v.trim()
  if (!t) return 'R0'
  return t.toUpperCase().startsWith('R') ? t.toUpperCase() : `R${t}`
}

export async function generateRequirementCode(client: DbOrTx = db): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PR-${year}-`
  const last = await client.plateRequirement.findFirst({
    where: { requirementCode: { startsWith: prefix } },
    orderBy: { requirementCode: 'desc' },
    select: { requirementCode: true },
  })
  const lastSeq = last ? Number(last.requirementCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

function buildColoursNeeded(
  colourBreakdown: ColourNeed[],
  availableColours: string[],
): { name: string; isNew: boolean }[] {
  return colourBreakdown.map((c) => ({
    name: c.name,
    isNew: !availableColours.includes(c.name),
  }))
}

async function createCtpNotification(
  requirementCode: string,
  jobCardId: string,
  message: string,
): Promise<void> {
  await db.auditLog.create({
    data: {
      action: 'INSERT',
      tableName: 'plate_requirements',
      recordId: requirementCode,
      newValue: {
        jobCardId,
        message,
      },
    },
  })
}

export async function checkPlateAvailability(
  cartonId: string,
  artworkCode: string,
  artworkVersion: string,
  numberOfColours: number,
  colourBreakdown: ColourNeed[],
): Promise<PlateAvailabilityResult> {
  const existingPlates = await db.plateStore.findFirst({
    where: {
      cartonId: cartonId || undefined,
      artworkCode: artworkCode || undefined,
      artworkVersion: normaliseArtworkVersion(artworkVersion),
      status: { in: ['ready', 'returned'] },
    },
  })

  if (!existingPlates) {
    return {
      status: 'all_new',
      newNeeded: numberOfColours,
      oldAvailable: 0,
      plateSetCode: null,
      message: `All ${numberOfColours} plates need to be made new`,
      action: 'trigger_ctp',
    }
  }

  const colours = parseColours(existingPlates.colours)
  const availableOld = colours.filter((c) => c.status === 'old' || c.status === 'returned')
  const missingColours = colourBreakdown.filter(
    (needed) => !availableOld.find((old) => old.name === needed.name),
  )

  if (missingColours.length === 0) {
    return {
      status: 'all_available',
      newNeeded: 0,
      oldAvailable: numberOfColours,
      plateSetCode: existingPlates.plateSetCode,
      rackLocation: existingPlates.rackLocation,
      message: 'All plates available in rack',
      action: 'issue_from_rack',
    }
  }

  return {
    status: 'partial',
    newNeeded: missingColours.length,
    oldAvailable: availableOld.length,
    missingColours: missingColours.map((c) => c.name),
    availableColours: availableOld.map((c) => c.name),
    plateSetCode: existingPlates.plateSetCode,
    message: `${availableOld.length} old plates available, ${missingColours.length} new plates needed`,
    action: 'partial_issue_plus_ctp',
  }
}

export async function onArtworkApproved(
  artworkApprovalId: string,
  jobCardId: string,
  userId: string,
): Promise<void> {
  const approval = await db.artworkApproval.findUnique({
    where: { id: artworkApprovalId },
    include: { artwork: true },
  })
  if (!approval) return

  const artwork = approval.artwork
  const carton = await db.carton.findFirst({
    where: {
      OR: [
        { artworkCode: artwork.filename },
        { cartonName: { contains: artwork.jobId, mode: 'insensitive' } },
      ],
    },
  })

  const colourBreakdown = parseColours(carton?.colourBreakdown).map((c) => ({ name: c.name }))
  const availability = await checkPlateAvailability(
    carton?.id ?? '',
    artwork.filename,
    `R${artwork.versionNumber}`,
    carton?.numberOfColours ?? 4,
    colourBreakdown.length ? colourBreakdown : [{ name: 'C' }, { name: 'M' }, { name: 'Y' }, { name: 'K' }],
  )

  const createdReq = await db.$transaction(async (tx) => {
    const requirementCode = await generateRequirementCode(tx)
    const row = await tx.plateRequirement.create({
      data: {
        requirementCode,
        jobCardId,
        cartonName: carton?.cartonName ?? artwork.filename,
        artworkCode: artwork.filename,
        artworkVersion: `R${artwork.versionNumber}`,
        customerId: carton?.customerId ?? null,
        numberOfColours: carton?.numberOfColours ?? 4,
        coloursNeeded: buildColoursNeeded(
          colourBreakdown.length ? colourBreakdown : [{ name: 'C' }, { name: 'M' }, { name: 'Y' }, { name: 'K' }],
          availability.availableColours ?? [],
        ),
        newPlatesNeeded: availability.newNeeded,
        oldPlatesAvailable: availability.oldAvailable,
        status: availability.newNeeded > 0 ? 'ctp_notified' : 'plates_ready',
        createdBy: userId,
        ctpTriggeredAt: availability.newNeeded > 0 ? new Date() : null,
        plateSize: carton?.plateSize ?? null,
      },
    })
    await createPlateHubEvent(tx, {
      plateRequirementId: row.id,
      actionType: PLATE_HUB_ACTION.PREPRESS_FINALIZE,
      fromZone: HUB_ZONE.OTHER,
      toZone: HUB_ZONE.INCOMING_TRIAGE,
      details: {
        source: 'artwork_approved',
        requirementCode: row.requirementCode,
        jobCardId,
        message: availability.message,
      },
    })
    return row
  })

  if (availability.newNeeded > 0) {
    await createCtpNotification(createdReq.requirementCode, jobCardId, availability.message)
  }

  if (availability.plateSetCode) {
    await db.plateStore.update({
      where: { plateSetCode: availability.plateSetCode },
      data: { artworkId: artwork.id },
    })
  }
}

/** Queue a plate check for a PO line from Pre-Press (no job card yet). */
export async function createPlateRequirementFromPoLine(
  poLineId: string,
  userId: string,
  client: DbOrTx = db,
): Promise<{ requirementCode: string }> {
  const line = await client.poLineItem.findUnique({
    where: { id: poLineId },
    include: { po: true },
  })
  if (!line) throw new Error('PO line not found')

  const artworkCode = (line.artworkCode || '').trim()
  if (!artworkCode) throw new Error('Artwork code is required')

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const artworkVersionRaw =
    typeof spec.artworkVersion === 'string' && spec.artworkVersion.trim()
      ? spec.artworkVersion.trim()
      : 'R0'
  const numberOfColours =
    typeof spec.numberOfColours === 'number' && spec.numberOfColours > 0
      ? spec.numberOfColours
      : 4

  const carton = line.cartonId
    ? await client.carton.findUnique({ where: { id: line.cartonId } })
    : null

  const colourBreakdown = parseColours(carton?.colourBreakdown).map((c) => ({ name: c.name }))
  const defaultCmyk: ColourNeed[] = [
    { name: 'C' },
    { name: 'M' },
    { name: 'Y' },
    { name: 'K' },
  ]
  const breakdown = colourBreakdown.length ? colourBreakdown : defaultCmyk

  const availability = await checkPlateAvailability(
    line.cartonId ?? '',
    artworkCode,
    artworkVersionRaw,
    numberOfColours,
    breakdown,
  )

  const requirementCode = await generateRequirementCode(client)
  const cartonLabel = `${line.cartonName} · ${line.po.poNumber} · PO line ${poLineId}`

  const created = await client.plateRequirement.create({
    data: {
      requirementCode,
      jobCardId: null,
      poLineId,
      dieMasterId: line.dieMasterId ?? carton?.dieMasterId ?? null,
      cartonName: cartonLabel,
      artworkCode,
      artworkVersion: normaliseArtworkVersion(artworkVersionRaw),
      customerId: line.po.customerId,
      numberOfColours,
      coloursNeeded: buildColoursNeeded(
        breakdown,
        availability.availableColours ?? [],
      ),
      newPlatesNeeded: availability.newNeeded,
      oldPlatesAvailable: availability.oldAvailable,
      status: availability.newNeeded > 0 ? 'ctp_notified' : 'plates_ready',
      createdBy: userId,
      ctpTriggeredAt: availability.newNeeded > 0 ? new Date() : null,
      plateSize: carton?.plateSize ?? null,
    },
  })

  await createPlateHubEvent(client, {
    plateRequirementId: created.id,
    actionType: PLATE_HUB_ACTION.PREPRESS_FINALIZE,
    fromZone: HUB_ZONE.OTHER,
    toZone: HUB_ZONE.INCOMING_TRIAGE,
    details: {
      poLineId,
      requirementCode: created.requirementCode,
      message: availability.message,
      source: 'pre_press_finalize',
    },
  })

  await client.auditLog.create({
    data: {
      userId,
      action: 'INSERT',
      tableName: 'plate_requirements',
      recordId: requirementCode,
      newValue: {
        poLineId,
        message: availability.message,
        source: 'pre_press_finalize',
      },
    },
  })

  return { requirementCode }
}

export type PlateIssueRef = { id: string }

export async function issuePlates(
  plateStoreId: string,
  jobCardId: string,
  jobCardNumber: number,
  issuedTo: string,
  issuedBy: string,
  coloursToIssue: string[],
  opts?: { purpose?: 'production' | 'reprint' | 'sample' | 'proof' },
): Promise<PlateIssueRef> {
  const issueId = randomUUID()
  return db.$transaction(async (tx) => {
    const plate = await tx.plateStore.findUnique({ where: { id: plateStoreId } })
    if (!plate) throw new Error('Plate set not found')

    const colours = parseColours(plate.colours)
    const updatedColours = colours.map((c) => ({
      ...c,
      status: coloursToIssue.includes(c.name) ? 'issued' : c.status,
    }))

    await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        colours: updatedColours,
        status: 'issued',
        jobCardId,
        issuedTo,
        issuedAt: new Date(),
        lastUsedDate: new Date(),
      },
    })

    await tx.auditLog.create({
      data: {
        userId: issuedBy,
        action: 'INSERT',
        tableName: 'plate_store_issue',
        recordId: issueId,
        newValue: {
          plateStoreId,
          plateSetCode: plate.plateSetCode,
          jobCardId,
          jobCardNumber,
          cartonName: plate.cartonName,
          artworkCode: plate.artworkCode,
          issuedTo,
          issuedBy,
          coloursIssued: coloursToIssue,
          status: 'issued',
          purpose:
            opts?.purpose && opts.purpose !== 'production' ? opts.purpose : undefined,
        },
      },
    })

    await tx.auditLog.create({
      data: {
        userId: issuedBy,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: plateStoreId,
        newValue: {
          plateEvent: 'issued',
          issueId,
          jobCardId,
          jobCardNumber,
          coloursIssued: coloursToIssue,
        },
      },
    })

    return { id: issueId }
  })
}

export async function returnPlates(
  plateIssueRecordId: string,
  returnedBy: string,
  colourConditions: { name: string; condition: string; action: 'store' | 'destroy' }[],
  returnNotes: string,
  rackLocation: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const issueLog = await tx.auditLog.findFirst({
      where: { tableName: 'plate_store_issue', recordId: plateIssueRecordId },
    })
    if (!issueLog?.newValue || typeof issueLog.newValue !== 'object') {
      throw new Error('Issue record not found')
    }
    const meta = issueLog.newValue as Record<string, unknown>
    const plateStoreId = String(meta.plateStoreId ?? '')
    if (!plateStoreId) throw new Error('Issue record not found')

    const plate = await tx.plateStore.findUnique({ where: { id: plateStoreId } })
    if (!plate) throw new Error('Plate set not found')

    const colours = parseColours(plate.colours)

    const destroyedColours: string[] = []
    const storedColours: string[] = []

    const updatedColours = colours.map((c) => {
      const condition = colourConditions.find((cc) => cc.name === c.name)
      if (!condition) return c
      if (condition.action === 'destroy') {
        destroyedColours.push(c.name)
        return { ...c, status: 'destroyed', destroyedAt: new Date().toISOString() }
      }
      storedColours.push(c.name)
      return { ...c, status: 'returned', condition: condition.condition, rackLocation }
    })

    const allDestroyed = updatedColours.every((c) => c.status === 'destroyed')
    const someDestroyed = updatedColours.some((c) => c.status === 'destroyed')

    await tx.plateStore.update({
      where: { id: plate.id },
      data: {
        colours: updatedColours,
        status: allDestroyed ? 'destroyed' : someDestroyed ? 'partially_destroyed' : 'returned',
        returnedBy,
        returnedAt: new Date(),
        rackLocation,
        jobCardId: null,
        issuedTo: null,
        issuedAt: null,
      },
    })

    await tx.auditLog.create({
      data: {
        userId: returnedBy,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: plate.id,
        newValue: {
          plateEvent: 'returned',
          issueId: plateIssueRecordId,
          storedColours,
          destroyedColours,
          rackLocation,
          returnNotes,
          colourConditions,
        },
      },
    })
  })
}

export async function destroyColour(
  plateStoreId: string,
  colourName: string,
  reason: string,
  destroyedBy: string,
): Promise<void> {
  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) throw new Error('Plate set not found')
  const colours = parseColours(plate.colours)

  const updatedColours = colours.map((c) =>
    c.name === colourName
      ? { ...c, status: 'destroyed', destroyedAt: new Date().toISOString(), destroyReason: reason }
      : c,
  )

  const allDestroyed = updatedColours.every((c) => c.status === 'destroyed')

  await db.$transaction(async (tx) => {
    await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        colours: updatedColours,
        status: allDestroyed ? 'destroyed' : 'partially_destroyed',
        destroyedReason: reason,
        destroyedBy,
        destroyedAt: new Date(),
      },
    })
    await tx.auditLog.create({
      data: {
        userId: destroyedBy,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: plateStoreId,
        newValue: {
          plateEvent: 'colour_destroyed',
          colourName,
          reason,
        },
      },
    })
  })
}
