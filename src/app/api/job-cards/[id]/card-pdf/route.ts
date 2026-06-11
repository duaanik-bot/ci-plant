import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import QRCode from 'qrcode'
import {
  ProductionJobCardDocument,
  type ProductionJobCardPdfModel,
} from '@/lib/production-job-card-pdf'
import { computeBoardMaterialForJobCard } from '@/lib/job-card-board-material'
import { readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      shiftOperator: { select: { name: true } },
      machine: { select: { machineCode: true, name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
      allocatedPaperWarehouse: { select: { lotNumber: true } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const poLine =
    jc.jobCardNumber != null
      ? await db.poLineItem.findFirst({
          where: { jobCardNumber: jc.jobCardNumber },
          select: {
            cartonName: true,
            cartonSize: true,
            artworkCode: true,
            paperType: true,
            gsm: true,
            coatingType: true,
            otherCoating: true,
            embossingLeafing: true,
            dyeId: true,
            remarks: true,
            materialProcurementStatus: true,
            po: { select: { poNumber: true, poDate: true, deliveryRequiredBy: true } },
            carton: {
              select: {
                artworkCode: true,
                gsm: true,
                colourBreakdown: true,
                printingType: true,
                pastingStyle: true,
                coatingType: true,
                laminateType: true,
                foilType: true,
                embossingLeafing: true,
                embossBlockId: true,
              },
            },
            quantity: true,
            specOverrides: true,
            shadeCard: {
              select: {
                shadeCode: true,
                custodyStatus: true,
              },
            },
            materialQueue: {
              select: {
                totalSheets: true,
                boardType: true,
                gsm: true,
                sheetLengthMm: true,
                sheetWidthMm: true,
                ups: true,
                grainDirection: true,
              },
            },
          },
        })
      : null

  const lineSpec = (poLine?.specOverrides && typeof poLine.specOverrides === 'object'
    ? (poLine.specOverrides as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const orderQty = Number(poLine?.quantity ?? 0)
  const fgStockUsed = (() => {
    if (lineSpec.fgUseEnabled !== true) return 0
    const raw = Number(lineSpec.fgUseQty)
    const want = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    return Math.max(0, Math.min(want, Math.max(0, orderQty)))
  })()
  const fgNetToProduce = Math.max(0, orderQty - fgStockUsed)
  const asSpecText = (...vals: unknown[]) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    }
    return null
  }
  const stringifyColour = (value: unknown) => {
    if (!value) return null
    if (typeof value === 'string') return value.trim() || null
    try {
      const raw = JSON.stringify(value)
      return raw && raw !== '{}' ? raw : null
    } catch {
      return null
    }
  }
  const executionSetup =
    jc.postPressRouting && typeof jc.postPressRouting === 'object'
      ? (((jc.postPressRouting as Record<string, unknown>).executionSetup ?? {}) as Record<string, unknown>)
      : {}
  const planningCore = readPlanningCore(lineSpec)
  const planningMeta = readPlanningMeta(lineSpec)
  const asNumber = (...vals: unknown[]) => {
    for (const v of vals) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }
  const asPositiveInt = (...vals: unknown[]) => {
    const n = asNumber(...vals)
    return n != null && n > 0 ? Math.floor(n) : null
  }
  const formatDim = (value: unknown) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)
  }
  const planningUnit = planningMeta.sheetUnit === 'mm' ? 'mm' : 'inch'
  const parseSizePair = (value: unknown): { l: number; w: number; unit: 'mm' | 'inch' | null } | null => {
    if (typeof value !== 'string') return null
    const s = value.trim()
    const m = s.match(/([\d.]+)\s*[x×]\s*([\d.]+)\s*(mm|inch|in)?/i)
    if (!m) return null
    const l = Number(m[1])
    const w = Number(m[2])
    if (!Number.isFinite(l) || !Number.isFinite(w) || l <= 0 || w <= 0) return null
    const unitRaw = (m[3] || '').toLowerCase()
    return { l, w, unit: unitRaw === 'mm' ? 'mm' : unitRaw === 'in' || unitRaw === 'inch' ? 'inch' : null }
  }
  const toMm = (value: number, unit: 'mm' | 'inch') => unit === 'inch' ? value * 25.4 : value
  const fmtIn = (mm: number) => {
    const n = mm / 25.4
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
  }
  const fmtMm = (mm: number) => String(Math.round(mm))
  const formatPairInchesFirst = (lMm: unknown, wMm: unknown): string | null => {
    const l = Number(lMm)
    const w = Number(wMm)
    if (!Number.isFinite(l) || !Number.isFinite(w) || l <= 0 || w <= 0) return null
    return `${fmtIn(l)} x ${fmtIn(w)} in (${fmtMm(l)} x ${fmtMm(w)} mm)`
  }
  const formatRawPairInchesFirst = (l: unknown, w: unknown, unit: 'mm' | 'inch'): string | null => {
    const ln = Number(l)
    const wn = Number(w)
    if (!Number.isFinite(ln) || !Number.isFinite(wn) || ln <= 0 || wn <= 0) return null
    return formatPairInchesFirst(toMm(ln, unit), toMm(wn, unit))
  }
  const formatSizeTextInchesFirst = (value: unknown, fallbackUnit: 'mm' | 'inch' = 'mm'): string | null => {
    const pair = parseSizePair(value)
    if (!pair) return null
    return formatRawPairInchesFirst(pair.l, pair.w, pair.unit ?? fallbackUnit)
  }
  const childSizesRaw = Array.isArray(planningMeta.cutPlanChildSizes)
    ? planningMeta.cutPlanChildSizes
    : []
  const planningChildPieces = childSizesRaw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const qty = asPositiveInt(row.qty) ?? 1
      const size = formatPairInchesFirst(row.lMm, row.wMm) ?? 'Child'
      return { label: `Cut ${index + 1}`, qty, size }
    })
    .filter((row): row is { label: string; qty: number; size: string } => !!row)
  const childLength = asNumber(planningMeta.childInputLengthMm)
  const childWidth = asNumber(planningMeta.childInputWidthMm)
  const childFromRawMeta = formatRawPairInchesFirst(planningMeta.sheetLengthMm, planningMeta.sheetWidthMm, planningUnit)
  const childSize =
    planningChildPieces[0]?.size ??
    (childLength && childWidth
      ? formatPairInchesFirst(childLength, childWidth)
      : childFromRawMeta) ??
    (asNumber(planningMeta.sheetLengthMm) && asNumber(planningMeta.sheetWidthMm)
      ? formatRawPairInchesFirst(planningMeta.sheetLengthMm, planningMeta.sheetWidthMm, planningUnit)
      : null)
  const parentFromMeta = formatRawPairInchesFirst(planningMeta.parentSheetLengthMm, planningMeta.parentSheetWidthMm, 'mm') ??
    formatSizeTextInchesFirst(planningMeta.parentSize, planningUnit) ??
    formatSizeTextInchesFirst(planningCore.actualSheetSizeLabel, 'mm')
  const parentSize =
    parentFromMeta ??
    (poLine?.materialQueue?.sheetLengthMm != null && poLine?.materialQueue?.sheetWidthMm != null
      ? formatPairInchesFirst(poLine.materialQueue.sheetLengthMm, poLine.materialQueue.sheetWidthMm)
      : null)
  const childPieceQty = planningChildPieces.reduce((sum, piece) => sum + piece.qty, 0)
  const planningUnitsPerSheet =
    asPositiveInt(planningCore.ups, planningMeta.ups, planningMeta.selectedCutsPerSheet, planningMeta.cutsPerSheet, poLine?.materialQueue?.ups) ??
    (childPieceQty > 0 ? childPieceQty : null)
  const planningBaseSheets =
    asPositiveInt(planningMeta.baseSheets, lineSpec.baseSheets) ??
    (planningUnitsPerSheet && orderQty > 0 ? Math.ceil(orderQty / planningUnitsPerSheet) : null)
  const planningWastageSheets =
    asPositiveInt(planningMeta.wastageSheets, lineSpec.wastageSheets) ?? jc.wastageSheets
  const planningTotalRequired =
    asPositiveInt(planningMeta.totalRequired, lineSpec.totalRequired) ??
    (planningBaseSheets != null ? planningBaseSheets + planningWastageSheets : jc.totalSheets)

  const [plateRow, dyeRow, embossRow] = await Promise.all([
    jc.plateSetId
      ? db.plateStore.findUnique({
          where: { id: jc.plateSetId },
          select: { plateSetCode: true },
        })
      : Promise.resolve(null),
    poLine?.dyeId
      ? db.dye.findUnique({
          where: { id: poLine.dyeId },
          select: { dyeNumber: true },
        })
      : Promise.resolve(null),
    jc.embossBlockId || poLine?.carton?.embossBlockId
      ? db.embossBlock.findUnique({
          where: { id: jc.embossBlockId ?? poLine!.carton!.embossBlockId! },
          select: { blockCode: true },
        })
      : Promise.resolve(null),
  ])

  const boardMaterial = await computeBoardMaterialForJobCard(
    db,
    { id: jc.id, totalSheets: jc.totalSheets, sheetsIssued: jc.sheetsIssued },
    poLine
      ? {
          materialProcurementStatus: poLine.materialProcurementStatus,
          materialQueue: poLine.materialQueue,
        }
      : null,
  )

  const boardMaterialFooter = `Material Verified against Batch ${boardMaterial.batchLotNumber ?? '—'}. Board Status: ${boardMaterial.boardStatus === 'available' ? 'Available' : 'Out of stock'}.`
  const batchHandshake =
    boardMaterial.batchLotNumber ?? jc.allocatedPaperWarehouse?.lotNumber ?? '—'
  const inventoryHandshakeFooter = `Inventory Handshake Verified. Material Batch ${batchHandshake} locked for Job ${jc.jobCardNumber}.`

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const verifyUrl = host ? `${proto}://${host}/production/job-cards/${id}` : null

  let qrDataUrl: string | null = null
  if (verifyUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(verifyUrl, {
        margin: 1,
        width: 180,
        color: { dark: '#0f172a', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      })
    } catch {
      qrDataUrl = null
    }
  }

  const model: ProductionJobCardPdfModel = {
    jobCardNumber: jc.jobCardNumber,
    customerName: jc.customer.name,
    productName: poLine?.cartonName ?? null,
    poNumber: poLine?.po.poNumber ?? null,
    poDate: poLine?.po.poDate?.toISOString() ?? null,
    deliveryDate: poLine?.po.deliveryRequiredBy?.toISOString() ?? null,
    jobDate: jc.jobDate?.toISOString() ?? jc.createdAt?.toISOString() ?? null,
    cartonSize: poLine?.cartonSize ?? null,
    artworkCode: poLine?.artworkCode ?? poLine?.carton?.artworkCode ?? null,
    boardType: poLine?.materialQueue?.boardType ?? poLine?.paperType ?? null,
    gsm: poLine?.materialQueue?.gsm ?? poLine?.gsm ?? poLine?.carton?.gsm ?? null,
    sheetSize:
      poLine?.materialQueue?.sheetLengthMm != null && poLine?.materialQueue?.sheetWidthMm != null
        ? formatPairInchesFirst(poLine.materialQueue.sheetLengthMm, poLine.materialQueue.sheetWidthMm)
        : null,
    ups: poLine?.materialQueue?.ups ?? null,
    setNumber: jc.setNumber,
    batchNumber: jc.batchNumber,
    designerName: jc.shiftOperator?.name ?? jc.assignedOperator ?? null,
    machineName: jc.machine ? `${jc.machine.machineCode} ${jc.machine.name}` : null,
    requiredSheets: jc.requiredSheets,
    wastageSheets: jc.wastageSheets,
    totalSheets: jc.totalSheets,
    sheetsIssued: jc.sheetsIssued,
    status: jc.status,
    artworkApproved: jc.artworkApproved,
    firstArticlePass: jc.firstArticlePass,
    finalQcPass: jc.finalQcPass,
    qaReleased: jc.qaReleased,
    stages: jc.stages.map((s) => ({
      stageName: s.stageName,
      status: s.status,
      operator: s.operator,
      counter: s.counter,
    })),
    qrDataUrl,
    verifyUrl,
    materialPendingWatermark: boardMaterial.materialPendingWatermark,
    boardMaterialFooter,
    inventoryHandshakeFooter,
    reservedSheets: boardMaterial.reservedSheets,
    availableStock: boardMaterial.availableStock,
    shortageSheets: boardMaterial.shortageSheets,
    incomingQty: boardMaterial.incomingQty,
    orderQty,
    fgStockUsed,
    fgNetToProduce,
    materialSignal: boardMaterial.materialShortage ? 'Board not available' : 'Board available',
    printProcess: asSpecText(lineSpec.printingType, poLine?.carton?.printingType),
    colourSpec: asSpecText(lineSpec.colorSpec, lineSpec.colourSpec, lineSpec.colour, lineSpec.color, stringifyColour(poLine?.carton?.colourBreakdown)),
    coating: asSpecText(lineSpec.coatingType, poLine?.coatingType, poLine?.carton?.coatingType),
    lamination: asSpecText(lineSpec.laminateType, lineSpec.lamination, poLine?.otherCoating, poLine?.carton?.laminateType),
    foil: asSpecText(lineSpec.foilType, lineSpec.leafing, poLine?.carton?.foilType),
    embossing: asSpecText(lineSpec.embossingLeafing, poLine?.embossingLeafing, poLine?.carton?.embossingLeafing),
    pastingStyle: asSpecText(lineSpec.pastingStyle, poLine?.carton?.pastingStyle),
    grainDirection: poLine?.materialQueue?.grainDirection ?? null,
    dieCode: dyeRow?.dyeNumber != null ? `#${dyeRow.dyeNumber}` : null,
    plateCode: plateRow?.plateSetCode ?? null,
    embossBlockCode: embossRow?.blockCode ?? null,
    shadeCardCode: poLine?.shadeCard?.shadeCode ?? null,
    productionRemarks: poLine?.remarks ?? null,
    prePressRemarks: asSpecText(executionSetup.prePressRemarks),
    specialInstructions: asSpecText(lineSpec.specialInstructions, lineSpec.instructions, lineSpec.remarks),
    planningLayoutType: planningCore.layoutType === 'gang' ? 'Gang' : planningCore.layoutType === 'single' ? 'Single' : null,
    planningParentSheet: parentSize,
    planningChildSize: childSize,
    planningCutType: asPositiveInt(planningMeta.cutType),
    planningUnitsPerSheet,
    planningBaseSheets,
    planningWastageSheets,
    planningTotalRequired,
    planningBalanceSize: asSpecText(planningMeta.balanceSize, planningMeta.balanceSizeLabel),
    planningYieldPct: asNumber(planningCore.productionYieldPct, planningMeta.productionYieldPct),
    planningCutDirection: planningMeta.cuttingDirection === 'width' ? 'width' : 'length',
    planningChildPieces: planningChildPieces.length
      ? planningChildPieces
      : childSize
        ? [{ label: 'Child', qty: asPositiveInt(planningMeta.cutType, planningUnitsPerSheet) ?? 1, size: childSize }]
        : [],
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(ProductionJobCardDocument, { model }) as React.ReactElement,
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${req.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="job-card-${jc.jobCardNumber}.pdf"`,
    },
  })
}
