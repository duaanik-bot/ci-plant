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

export type JobSpecPdfModel = {
  poNumber: string
  poDate: string
  customerName: string
  cartonName: string
  cartonSize: string | null
  quantity: number
  setNumber: string | null
  artworkCode: string | null
  backPrint: string
  rate: number | null
  gsm: number | null
  gstPct: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  remarks: string | null
  specOverrides?: { totalSheets?: number; requiredSheets?: number; ups?: number; wastagePct?: number } | null
}

export function JobSpecDocument({ model }: { model: JobSpecPdfModel }) {
  const spec = model.specOverrides || {}
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>COLOUR IMPRESSIONS</Text>
          <Text style={styles.sub}>Job Spec (PO Line)</Text>
        </View>
        <Text style={styles.title}>Job Spec — {model.poNumber} · {model.cartonName}</Text>

        <View style={styles.row}>
          <Text style={styles.label}>PO Number</Text>
          <Text style={styles.value}>{model.poNumber}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>PO Date</Text>
          <Text style={styles.value}>{model.poDate}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Customer</Text>
          <Text style={styles.value}>{model.customerName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Carton</Text>
          <Text style={styles.value}>{model.cartonName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Size (L×W×H)</Text>
          <Text style={styles.value}>{model.cartonSize ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Quantity</Text>
          <Text style={styles.value}>{String(model.quantity)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Set #</Text>
          <Text style={styles.value}>{model.setNumber ?? '—'}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.title}>Print &amp; specs</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Artwork code</Text>
            <Text style={styles.value}>{model.artworkCode ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Back print</Text>
            <Text style={styles.value}>{model.backPrint}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Paper type</Text>
            <Text style={styles.value}>{model.paperType ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>GSM</Text>
            <Text style={styles.value}>{model.gsm != null ? String(model.gsm) : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Coating</Text>
            <Text style={styles.value}>{model.coatingType ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Emboss / Leaf</Text>
            <Text style={styles.value}>{model.embossingLeafing ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Rate (₹/1000)</Text>
            <Text style={styles.value}>{model.rate != null ? String(model.rate) : '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>GST %</Text>
            <Text style={styles.value}>{String(model.gstPct)}</Text>
          </View>
        </View>

        {(spec.ups != null || spec.requiredSheets != null || spec.totalSheets != null) && (
          <View style={styles.section}>
            <Text style={styles.title}>Sheets</Text>
            {spec.ups != null && (
              <View style={styles.row}>
                <Text style={styles.label}>UPS</Text>
                <Text style={styles.value}>{String(spec.ups)}</Text>
              </View>
            )}
            {spec.requiredSheets != null && (
              <View style={styles.row}>
                <Text style={styles.label}>Required sheets</Text>
                <Text style={styles.value}>{String(spec.requiredSheets)}</Text>
              </View>
            )}
            {spec.totalSheets != null && (
              <View style={styles.row}>
                <Text style={styles.label}>Total sheets</Text>
                <Text style={styles.value}>{String(spec.totalSheets)}</Text>
              </View>
            )}
            {spec.wastagePct != null && (
              <View style={styles.row}>
                <Text style={styles.label}>Wastage %</Text>
                <Text style={styles.value}>{String(spec.wastagePct)}</Text>
              </View>
            )}
          </View>
        )}

        {model.remarks && (
          <View style={styles.section}>
            <Text style={styles.label}>Remarks</Text>
            <Text style={styles.value}>{model.remarks}</Text>
          </View>
        )}
      </Page>
    </Document>
  )
}
