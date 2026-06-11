import React from 'react'
import { Document, Page, View, Text, StyleSheet, Image } from '@react-pdf/renderer'

const ink = '#111827'
const muted = '#64748b'
const faint = '#94a3b8'
const paper = '#f8fafc'
const card = '#ffffff'
const line = '#dbe3ef'
const navy = '#1e3a8a'
const blue = '#2563eb'
const green = '#047857'
const amber = '#b45309'
const red = '#b91c1c'

const styles = StyleSheet.create({
  page: {
    padding: 14,
    fontSize: 7.2,
    backgroundColor: paper,
    color: ink,
    fontFamily: 'Helvetica',
  },
  shell: {
    borderWidth: 1,
    borderColor: line,
    backgroundColor: card,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 9,
    padding: 8,
    backgroundColor: '#eff6ff',
    borderBottomWidth: 1,
    borderBottomColor: '#bfdbfe',
  },
  eyebrow: {
    fontSize: 7,
    color: navy,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: 'bold',
  },
  title: {
    marginTop: 2,
    fontSize: 13.5,
    lineHeight: 1.1,
    color: '#0f172a',
    fontWeight: 'bold',
  },
  subtitle: {
    marginTop: 3,
    fontSize: 7,
    color: muted,
    lineHeight: 1.25,
  },
  qrBox: {
    width: 54,
    alignItems: 'center',
  },
  qr: {
    width: 42,
    height: 42,
    padding: 2,
    backgroundColor: '#ffffff',
  },
  qrLabel: {
    marginTop: 2,
    fontSize: 5,
    color: muted,
    textAlign: 'center',
  },
  statusBand: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: line,
  },
  statusCell: {
    flex: 1,
    paddingVertical: 4.5,
    paddingHorizontal: 7,
    borderRightWidth: 1,
    borderRightColor: line,
  },
  statusCellLast: {
    flex: 1,
    paddingVertical: 4.5,
    paddingHorizontal: 7,
  },
  label: {
    fontSize: 5.7,
    color: faint,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontWeight: 'bold',
  },
  value: {
    marginTop: 1.5,
    fontSize: 8,
    color: ink,
    fontWeight: 'bold',
    lineHeight: 1.2,
  },
  smallValue: {
    marginTop: 2,
    fontSize: 8,
    color: ink,
    lineHeight: 1.2,
  },
  grid: {
    flexDirection: 'row',
    gap: 6,
    padding: 6,
  },
  col: {
    flex: 1,
    gap: 5,
  },
  panel: {
    borderWidth: 1,
    borderColor: line,
    backgroundColor: '#ffffff',
    padding: 5,
  },
  panelTitle: {
    fontSize: 7.2,
    color: navy,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 1.8,
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f7',
  },
  rowLast: {
    flexDirection: 'row',
    paddingVertical: 1.8,
  },
  rowLabel: {
    width: '36%',
    color: muted,
    fontSize: 6.2,
  },
  rowValue: {
    flex: 1,
    color: ink,
    fontSize: 6.6,
    fontWeight: 'bold',
    lineHeight: 1.2,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 5,
    fontSize: 6,
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  badgeGreen: {
    backgroundColor: '#d1fae5',
    color: green,
  },
  badgeAmber: {
    backgroundColor: '#fef3c7',
    color: amber,
  },
  badgeRed: {
    backgroundColor: '#fee2e2',
    color: red,
  },
  table: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: line,
  },
  tableHead: {
    flexDirection: 'row',
    backgroundColor: '#eef2ff',
    borderBottomWidth: 1,
    borderBottomColor: line,
  },
  th: {
    padding: 5,
    fontSize: 6.7,
    color: navy,
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f7',
  },
  td: {
    padding: 5,
    fontSize: 7.2,
    color: ink,
    lineHeight: 1.15,
  },
  footer: {
    marginTop: 0,
    padding: 5,
    borderTopWidth: 1,
    borderTopColor: line,
    backgroundColor: '#f8fafc',
    color: muted,
    fontSize: 5.7,
    lineHeight: 1.12,
  },
  watermarkLayer: {
    position: 'absolute',
    top: 315,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  watermarkText: {
    fontSize: 32,
    color: '#ef4444',
    opacity: 0.12,
    fontWeight: 'bold',
  },
  section: {
    marginHorizontal: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: line,
    backgroundColor: '#ffffff',
    padding: 6,
  },
  split: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  noteBox: {
    minHeight: 42,
    marginTop: 5,
    padding: 7,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    color: ink,
    fontSize: 7.4,
    lineHeight: 1.25,
  },
  signGrid: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  signBox: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: line,
    backgroundColor: '#ffffff',
    padding: 7,
  },
  signLine: {
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    paddingTop: 4,
    color: muted,
    fontSize: 6.8,
  },
  layoutCanvas: {
    height: 240,
    borderWidth: 1.2,
    borderColor: navy,
    backgroundColor: '#f8fafc',
    padding: 6,
  },
  layoutParent: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#475569',
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  layoutPiece: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  layoutBalance: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#ffffff',
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  layoutText: {
    fontSize: 5.9,
    color: '#0f172a',
    fontWeight: 'bold',
    textAlign: 'center',
  },
})

export type ProductionJobCardPdfModel = {
  jobCardNumber: number
  customerName: string
  productName?: string | null
  poNumber?: string | null
  poDate?: string | null
  deliveryDate?: string | null
  cartonSize?: string | null
  artworkCode?: string | null
  boardType?: string | null
  gsm?: number | null
  sheetSize?: string | null
  ups?: number | null
  setNumber: string | null
  batchNumber: string | null
  jobDate?: string | null
  designerName?: string | null
  machineName?: string | null
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  reservedSheets?: number | null
  availableStock?: number | null
  shortageSheets?: number | null
  incomingQty?: number | null
  status: string
  artworkApproved: boolean
  firstArticlePass: boolean
  finalQcPass: boolean
  qaReleased: boolean
  stages: { stageName: string; status: string; operator: string | null; counter: number | null }[]
  qrDataUrl?: string | null
  verifyUrl?: string | null
  materialPendingWatermark?: boolean
  boardMaterialFooter?: string | null
  inventoryHandshakeFooter?: string | null
  orderQty?: number | null
  fgStockUsed?: number | null
  fgNetToProduce?: number | null
  materialSignal?: string | null
  printProcess?: string | null
  colourSpec?: string | null
  coating?: string | null
  lamination?: string | null
  foil?: string | null
  embossing?: string | null
  pastingStyle?: string | null
  grainDirection?: string | null
  dieCode?: string | null
  plateCode?: string | null
  embossBlockCode?: string | null
  shadeCardCode?: string | null
  productionRemarks?: string | null
  prePressRemarks?: string | null
  specialInstructions?: string | null
  planningLayoutType?: string | null
  planningParentSheet?: string | null
  planningChildSize?: string | null
  planningCutType?: number | null
  planningUnitsPerSheet?: number | null
  planningBaseSheets?: number | null
  planningWastageSheets?: number | null
  planningTotalRequired?: number | null
  planningBalanceSize?: string | null
  planningYieldPct?: number | null
  planningCutDirection?: 'length' | 'width' | null
  planningChildPieces?: Array<{ label: string; qty: number; size: string }>
}

function text(value: unknown, fallback = '-'): string {
  if (value == null) return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-IN') : fallback
  const s = String(value).trim()
  return s || fallback
}

function dateText(value: string | Date | null | undefined): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return text(value)
  return d.toLocaleDateString('en-GB')
}

function statusTone(status: string | null | undefined) {
  const s = String(status ?? '').toLowerCase()
  if (s.includes('not') || s.includes('short') || s.includes('out')) return [styles.badge, styles.badgeRed]
  if (s.includes('wait') || s.includes('pending') || s.includes('order')) return [styles.badge, styles.badgeAmber]
  return [styles.badge, styles.badgeGreen]
}

function specText(...values: unknown[]): string {
  for (const value of values) {
    const s = text(value, '').trim()
    if (s) return s
  }
  return '-'
}

function FieldRows({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <View>
      {rows.map(([label, value], index) => (
        <View key={label} style={index === rows.length - 1 ? styles.rowLast : styles.row}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowValue}>{text(value)}</Text>
        </View>
      ))}
    </View>
  )
}

function LayoutDiagram({ model }: { model: ProductionJobCardPdfModel }) {
  const pieces = model.planningChildPieces?.length
    ? model.planningChildPieces
    : [{
        label: model.planningChildSize || 'Child',
        qty: Math.max(1, Number(model.planningCutType || model.planningUnitsPerSheet || 1)),
        size: model.planningChildSize || '-',
      }]
  const totalQty = Math.max(1, pieces.reduce((sum, p) => sum + Math.max(0, Number(p.qty || 0)), 0))
  const hasBalance = !!model.planningBalanceSize && model.planningBalanceSize !== '-'
  const direction = model.planningCutDirection === 'width' ? 'column' : 'row'
  const pieceNodes: React.ReactNode[] = []
  const pieceColours = ['#bfdbfe', '#bbf7d0', '#fde68a', '#ddd6fe', '#fecaca', '#bae6fd']
  pieces.forEach((piece, pieceIndex) => {
    const qty = Math.max(1, Math.floor(Number(piece.qty || 1)))
    for (let i = 0; i < qty; i++) {
      pieceNodes.push(
        <View
          key={`${piece.label}-${pieceIndex}-${i}`}
          style={[
            styles.layoutPiece,
            { backgroundColor: pieceColours[pieceIndex % pieceColours.length] },
            direction === 'row'
              ? { width: `${Math.max(7, 100 / (totalQty + (hasBalance ? 1 : 0)))}%`, height: '100%' }
              : { height: `${Math.max(7, 100 / (totalQty + (hasBalance ? 1 : 0)))}%`, width: '100%' },
          ]}
        >
          <Text style={styles.layoutText}>{piece.label}</Text>
          <Text style={styles.layoutText}>{piece.size}</Text>
        </View>,
      )
    }
  })
  if (hasBalance) {
    pieceNodes.push(
      <View
        key="balance"
        style={[
          styles.layoutBalance,
          direction === 'row' ? { flex: 1, height: '100%' } : { flex: 1, width: '100%' },
        ]}
      >
        <Text style={styles.layoutText}>Balance</Text>
        <Text style={styles.layoutText}>{model.planningBalanceSize}</Text>
      </View>,
    )
  }

  return (
    <View style={styles.layoutCanvas}>
      <View style={[styles.layoutParent, { flexDirection: direction }]}>
        {pieceNodes}
      </View>
    </View>
  )
}

export function ProductionJobCardDocument({ model }: { model: ProductionJobCardPdfModel }) {
  const materialSignal =
    model.materialSignal ||
    (model.materialPendingWatermark ? 'Board not available' : 'Board available')

  return (
    <Document title={`Job Card ${model.jobCardNumber}`}>
      <Page size="A4" style={styles.page}>
        {model.materialPendingWatermark ? (
          <View style={styles.watermarkLayer}>
            <Text style={styles.watermarkText}>BOARD NOT AVAILABLE</Text>
          </View>
        ) : null}

        <View style={styles.shell}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>Colour Impressions Production</Text>
              <Text style={styles.title}>Job Card JC-{model.jobCardNumber}</Text>
              <Text style={styles.subtitle}>
                {text(model.productName)} | PO {text(model.poNumber)} | {text(model.customerName)}
              </Text>
            </View>
            <View style={styles.qrBox}>
              {model.qrDataUrl ? <Image src={model.qrDataUrl} style={styles.qr} /> : null}
              <Text style={styles.qrLabel}>Scan to verify live card</Text>
            </View>
          </View>

          <View style={styles.statusBand}>
            <View style={styles.statusCell}>
              <Text style={styles.label}>Status</Text>
              <Text style={styles.value}>{text(model.status)}</Text>
            </View>
            <View style={styles.statusCell}>
              <Text style={styles.label}>Material</Text>
              <Text style={statusTone(materialSignal)}>{materialSignal}</Text>
            </View>
            <View style={styles.statusCell}>
              <Text style={styles.label}>Required Sheets</Text>
              <Text style={styles.value}>{text(model.requiredSheets)}</Text>
            </View>
            <View style={styles.statusCellLast}>
              <Text style={styles.label}>Total Sheets</Text>
              <Text style={styles.value}>{text(model.totalSheets)}</Text>
            </View>
          </View>

          <View style={styles.grid}>
            <View style={styles.col}>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Customer & Order</Text>
                <FieldRows
                  rows={[
                    ['Customer', model.customerName],
                    ['Product', model.productName],
                    ['PO Number', model.poNumber],
                    ['Delivery Date', dateText(model.deliveryDate)],
                    ['Job Date', dateText(model.jobDate)],
                    ['Set Number', model.setNumber],
                    ['Batch', model.batchNumber],
                  ]}
                />
              </View>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Board & Dimensions</Text>
                <FieldRows
                  rows={[
                    ['Artwork Code', model.artworkCode],
                    ['Carton Size', model.cartonSize],
                    ['Board', model.boardType],
                    ['GSM', model.gsm],
                    ['Parent Sheet', model.planningParentSheet || model.sheetSize],
                    ['Child Size', model.planningChildSize],
                    ['Units / Sheet', model.planningUnitsPerSheet ?? model.ups],
                    ['Grain', model.grainDirection],
                  ]}
                />
              </View>
            </View>

            <View style={styles.col}>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Sheet Calculation</Text>
                <FieldRows
                  rows={[
                    ['Order Qty', model.orderQty ? `${text(model.orderQty)} pcs` : '-'],
                    ['Base Sheets', `${text(model.planningBaseSheets ?? model.requiredSheets)} sh`],
                    ['Wastage', `${text(model.planningWastageSheets ?? model.wastageSheets)} sh`],
                    ['Total Required', `${text(model.planningTotalRequired ?? model.totalSheets)} sh`],
                    ['Cut Type', model.planningCutType ? `${model.planningCutType}-cut` : '-'],
                    ['Layout', model.planningLayoutType],
                    ['Yield', model.planningYieldPct != null ? `${model.planningYieldPct}%` : '-'],
                    ['Shortage', `${text(model.shortageSheets ?? 0)} sh`],
                  ]}
                />
              </View>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Cutting Decision</Text>
                <FieldRows
                  rows={[
                    ['Cut Direction', model.planningCutDirection],
                    ['Balance Size', model.planningBalanceSize],
                    ['Material Signal', materialSignal],
                    ['Print / Colour', specText(model.printProcess, model.colourSpec)],
                    ['Coating / Lamination', specText(model.coating, model.lamination)],
                    ['Die / Shade', specText(model.dieCode, model.shadeCardCode)],
                    ['Instruction', specText(model.specialInstructions, model.productionRemarks)],
                  ]}
                />
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.panelTitle}>Colored Planning Engine Layout Diagram</Text>
            <LayoutDiagram model={model} />
            <Text style={{ marginTop: 4, color: muted, fontSize: 6.2 }}>
              Parent sheet: {text(model.planningParentSheet || model.sheetSize)} | Child: {text(model.planningChildSize)} | Units per sheet: {text(model.planningUnitsPerSheet ?? model.ups)} | Total required: {text(model.planningTotalRequired ?? model.totalSheets)} sheets
            </Text>
          </View>

          {model.fgStockUsed != null && model.fgStockUsed > 0 ? (
            <View style={{ marginHorizontal: 6, marginBottom: 4, padding: 4, backgroundColor: '#ecfdf5', borderWidth: 1, borderColor: '#bbf7d0' }}>
              <Text style={{ color: green, fontWeight: 'bold', fontSize: 6.4 }}>
                FG stock used: {text(model.fgStockUsed)} pcs | Net to produce: {text(model.fgNetToProduce)} pcs
              </Text>
            </View>
          ) : null}

          <View style={styles.footer}>
            {model.boardMaterialFooter ? <Text>{model.boardMaterialFooter}</Text> : null}
            <Text>Verify: {text(model.verifyUrl)} | Generated: {new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
