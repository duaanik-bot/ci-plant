import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 28, fontSize: 10 },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 'bold' },
  sub: { fontSize: 9, color: '#666', marginTop: 2 },
  title: { fontSize: 12, fontWeight: 'bold', marginTop: 10, marginBottom: 8 },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 140, fontWeight: 'bold' },
  value: { flex: 1 },
  section: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
})

export type RfqPdfModel = {
  rfqNumber: string
  customerName: string
  productName: string
  packType: string
  createdAt: string
  feasibility: {
    boardSpec?: string | null
    printProcess?: string | null
    estimatedCostPer1000?: number | null
    toolingCost?: number | null
    moq?: number | null
  }
  quotation?: {
    quotationNumber?: string | null
    unitPrice?: number | null
    tooling?: number | null
    paymentTerms?: string | null
    validity?: string | null
    notes?: string | null
  }
}

export function FeasibilityDocument({ model }: { model: RfqPdfModel }) {
  const f = model.feasibility
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>COLOUR IMPRESSIONS</Text>
          <Text style={styles.sub}>Feasibility Report (CI Letterhead)</Text>
        </View>
        <Text style={styles.title}>Feasibility — {model.rfqNumber}</Text>

        <View style={styles.row}>
          <Text style={styles.label}>Customer</Text>
          <Text style={styles.value}>{model.customerName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Product</Text>
          <Text style={styles.value}>{model.productName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Pack type</Text>
          <Text style={styles.value}>{model.packType}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Created</Text>
          <Text style={styles.value}>{model.createdAt}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Board spec</Text>
            <Text style={styles.value}>{f.boardSpec ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Print process</Text>
            <Text style={styles.value}>{f.printProcess ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Estimated cost / 1000</Text>
            <Text style={styles.value}>{f.estimatedCostPer1000 != null ? `₹${f.estimatedCostPer1000}` : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Tooling cost</Text>
            <Text style={styles.value}>{f.toolingCost != null ? `₹${f.toolingCost}` : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>MOQ</Text>
            <Text style={styles.value}>{f.moq != null ? String(f.moq) : '—'}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}

export function QuotationDocument({ model }: { model: RfqPdfModel }) {
  const q = model.quotation ?? {}
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>COLOUR IMPRESSIONS</Text>
          <Text style={styles.sub}>Quotation (CI Letterhead)</Text>
        </View>
        <Text style={styles.title}>Quotation — {q.quotationNumber ?? model.rfqNumber}</Text>

        <View style={styles.row}>
          <Text style={styles.label}>Customer</Text>
          <Text style={styles.value}>{model.customerName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Product</Text>
          <Text style={styles.value}>{model.productName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Pack type</Text>
          <Text style={styles.value}>{model.packType}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Created</Text>
          <Text style={styles.value}>{model.createdAt}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Unit price</Text>
            <Text style={styles.value}>{q.unitPrice != null ? `₹${q.unitPrice}` : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Tooling</Text>
            <Text style={styles.value}>{q.tooling != null ? `₹${q.tooling}` : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Payment terms</Text>
            <Text style={styles.value}>{q.paymentTerms ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Validity</Text>
            <Text style={styles.value}>{q.validity ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Notes</Text>
            <Text style={styles.value}>{q.notes ?? '—'}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}

