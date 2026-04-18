import React from 'react'
import { Document, Page, View, Text, StyleSheet, Image } from '@react-pdf/renderer'

const ink = '#ffffff'
const paper = '#000000'
const line = '#334155'
const accent = '#f59e0b'

const styles = StyleSheet.create({
  page: {
    padding: 22,
    fontSize: 10,
    backgroundColor: paper,
    color: ink,
    fontFamily: 'Helvetica',
    position: 'relative',
  },
  watermarkLayer: {
    position: 'absolute',
    top: 220,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  watermarkText: {
    fontSize: 30,
    color: 'rgba(244, 63, 94, 0.2)',
    fontWeight: 'bold',
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  title: { fontSize: 13, marginBottom: 2, fontWeight: 'bold', color: accent },
  subtitle: { fontSize: 8, color: '#94a3b8' },
  qr: { width: 72, height: 72 },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 118, fontWeight: 'bold', color: '#cbd5e1' },
  value: { flex: 1, color: ink },
  section: { marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: line },
  sectionTitle: { fontSize: 11, marginBottom: 6, fontWeight: 'bold', color: accent },
  stageRow: { flexDirection: 'row', marginBottom: 2, fontSize: 9 },
  check: { marginRight: 6, color: accent },
  footer: { marginTop: 14, paddingTop: 8, borderTopWidth: 1, borderTopColor: line, fontSize: 7, color: '#64748b' },
})

export type ProductionJobCardPdfModel = {
  jobCardNumber: number
  customerName: string
  setNumber: string | null
  batchNumber: string | null
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  status: string
  artworkApproved: boolean
  firstArticlePass: boolean
  finalQcPass: boolean
  qaReleased: boolean
  stages: { stageName: string; status: string; operator: string | null; counter: number | null }[]
  /** data:image/png;base64,... from server */
  qrDataUrl?: string | null
  verifyUrl?: string | null
  /** Planning queue paper gate: shortage / on order — print safety */
  materialPendingWatermark?: boolean
  boardMaterialFooter?: string | null
  inventoryHandshakeFooter?: string | null
}

export function ProductionJobCardDocument({ model }: { model: ProductionJobCardPdfModel }) {
  return (
    <Document>
      <Page size="A5" style={styles.page}>
        {model.materialPendingWatermark ? (
          <View style={styles.watermarkLayer}>
            <Text style={styles.watermarkText}>MATERIAL PENDING</Text>
          </View>
        ) : null}
        <View style={styles.headerRow}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={styles.title}>Colour Impressions — Production Job Card</Text>
            <Text style={styles.subtitle}>Official high-contrast card · scan to open in ERP</Text>
          </View>
          {model.qrDataUrl ? <Image src={model.qrDataUrl} style={styles.qr} /> : null}
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>JC#</Text>
          <Text style={styles.value}>{model.jobCardNumber}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Customer</Text>
          <Text style={styles.value}>{model.customerName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Set #</Text>
          <Text style={styles.value}>{model.setNumber ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Batch</Text>
          <Text style={styles.value}>{model.batchNumber ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.value}>{model.status}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sheet calc</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Required</Text>
            <Text style={styles.value}>{model.requiredSheets}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Wastage</Text>
            <Text style={styles.value}>{model.wastageSheets}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Total</Text>
            <Text style={styles.value}>{model.totalSheets}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Issued</Text>
            <Text style={styles.value}>{model.sheetsIssued}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Compliance</Text>
          <View style={styles.row}>
            <Text style={styles.check}>{model.artworkApproved ? '✓' : '—'}</Text>
            <Text style={styles.value}>Artwork approved</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.check}>{model.firstArticlePass ? '✓' : '—'}</Text>
            <Text style={styles.value}>First article pass</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.check}>{model.finalQcPass ? '✓' : '—'}</Text>
            <Text style={styles.value}>Final QC pass</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.check}>{model.qaReleased ? '✓' : '—'}</Text>
            <Text style={styles.value}>QA released</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Stages</Text>
          {model.stages.map((s, i) => (
            <View key={i} style={styles.stageRow}>
              <Text style={styles.label}>{s.stageName}</Text>
              <Text style={styles.value}>
                {s.status}
                {s.operator ? ` · ${s.operator}` : ''}
                {s.counter != null ? ` · ${s.counter}` : ''}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          {model.inventoryHandshakeFooter ? (
            <Text style={{ marginBottom: 4, color: '#94a3b8' }}>{model.inventoryHandshakeFooter}</Text>
          ) : null}
          {model.boardMaterialFooter ? (
            <Text style={{ marginBottom: 4, color: '#94a3b8' }}>{model.boardMaterialFooter}</Text>
          ) : null}
          {model.verifyUrl ? <Text>Verify: {model.verifyUrl}</Text> : null}
          <Text>Live data stream — generated {new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</Text>
        </View>
      </Page>
    </Document>
  )
}
