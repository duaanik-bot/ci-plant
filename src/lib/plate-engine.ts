import type { PlateIssueRecord, Prisma } from '@prisma/client'
import { db } from '@/lib/db'

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

  const requirementCode = await generateRequirementCode(db)
  await db.plateRequirement.create({
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

  if (availability.newNeeded > 0) {
    await createCtpNotification(requirementCode, jobCardId, availability.message)
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

  await client.plateRequirement.create({
    data: {
      requirementCode,
      jobCardId: null,
      poLineId,
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

export async function issuePlates(
  plateStoreId: string,
  jobCardId: string,
  jobCardNumber: number,
  issuedTo: string,
  issuedBy: string,
  coloursToIssue: string[],
): Promise<PlateIssueRecord> {
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
        totalJobsUsed: { increment: 1 },
        lastUsedJobCard: jobCardId,
        lastUsedDate: new Date(),
      },
    })

    const issueRecord = await tx.plateIssueRecord.create({
      data: {
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
      },
    })

    await tx.plateAuditLog.create({
      data: {
        plateStoreId,
        plateSetCode: plate.plateSetCode,
        action: 'issued',
        performedBy: issuedBy,
        details: { jobCardId, jobCardNumber, coloursIssued: coloursToIssue },
      },
    })

    return issueRecord
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
    const issueRecord = await tx.plateIssueRecord.findUnique({
      where: { id: plateIssueRecordId },
      include: { plateStore: true },
    })
    if (!issueRecord) throw new Error('Issue record not found')

    const plate = issueRecord.plateStore
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
        returnCondition: colourConditions[0]?.condition,
        rackLocation,
        jobCardId: null,
        issuedTo: null,
        destroyedCount: { increment: destroyedColours.length },
      },
    })

    await tx.plateIssueRecord.update({
      where: { id: plateIssueRecordId },
      data: {
        returnedBy,
        returnedAt: new Date(),
        returnCondition: colourConditions[0]?.condition,
        coloursReturned: storedColours,
        coloursDestroyed: destroyedColours,
        returnNotes,
        status: 'returned',
      },
    })

    await tx.plateAuditLog.create({
      data: {
        plateStoreId: plate.id,
        plateSetCode: plate.plateSetCode,
        action: 'returned',
        performedBy: returnedBy,
        details: { storedColours, destroyedColours, rackLocation, returnNotes, colourConditions },
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

  await db.$transaction([
    db.plateStore.update({
      where: { id: plateStoreId },
      data: {
        colours: updatedColours,
        status: allDestroyed ? 'destroyed' : 'partially_destroyed',
        destroyedCount: { increment: 1 },
        destroyedReason: reason,
        destroyedBy,
        destroyedAt: new Date(),
      },
    }),
    db.plateAuditLog.create({
      data: {
        plateStoreId,
        plateSetCode: plate.plateSetCode,
        action: 'colour_destroyed',
        performedBy: destroyedBy,
        details: { colourName, reason },
      },
    }),
  ])
}
