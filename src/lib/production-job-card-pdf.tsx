import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 10 },
  title: { fontSize: 14, marginBottom: 8, fontWeight: 'bold' },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 120, fontWeight: 'bold' },
  value: { flex: 1 },
  section: { marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  stageRow: { flexDirection: 'row', marginBottom: 2, fontSize: 9 },
  check: { marginRight: 6 },
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
}

export function ProductionJobCardDocument({ model }: { model: ProductionJobCardPdfModel }) {
  return (
    <Document>
      <Page size="A5" style={styles.page}>
        <Text style={styles.title}>Colour Impressions — Production Job Card</Text>
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
          <Text style={styles.title}>Sheet calc</Text>
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
          <Text style={styles.title}>Compliance</Text>
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
          <Text style={styles.title}>Stages</Text>
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
      </Page>
    </Document>
  )
}
