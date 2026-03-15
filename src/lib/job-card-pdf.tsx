import React from 'react'
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  Font,
} from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 10 },
  title: { fontSize: 16, marginBottom: 8, fontWeight: 'bold' },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 120, fontWeight: 'bold' },
  value: { flex: 1 },
  qrWrap: { marginTop: 16, alignItems: 'center' },
  qr: { width: 120, height: 120 },
  footer: { marginTop: 24, fontSize: 8, color: '#666' },
})

type JobForPdf = {
  id: string
  jobNumber: string
  productName: string
  qtyOrdered: number
  imposition: number
  dueDate: string
  status: string
  customer?: { name: string }
}

export function JobCardDocument({
  job,
  qrDataUrl,
}: {
  job: JobForPdf
  qrDataUrl: string
}) {
  return (
    <Document>
      <Page size="A5" style={styles.page}>
        <Text style={styles.title}>Colour Impressions — Job Card</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Job #</Text>
          <Text style={styles.value}>{job.jobNumber}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Product</Text>
          <Text style={styles.value}>{job.productName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Customer</Text>
          <Text style={styles.value}>{job.customer?.name ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Qty ordered</Text>
          <Text style={styles.value}>{job.qtyOrdered}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Imposition</Text>
          <Text style={styles.value}>{job.imposition}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Due date</Text>
          <Text style={styles.value}>{job.dueDate}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.value}>{job.status}</Text>
        </View>
        <View style={styles.qrWrap}>
          <Image src={qrDataUrl} style={styles.qr} />
          <Text style={styles.footer}>Scan for stores & shopfloor</Text>
        </View>
      </Page>
    </Document>
  )
}
