import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

export type PlateLabelModel = {
  plateSetCode: string
  cartonName: string
  artworkVersion: string
  customerName: string
  colours: string
  ctpDate: string
  rack: string
  slot: string
}

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 11 },
  card: { borderWidth: 1, borderColor: '#111827', padding: 12 },
  h1: { fontSize: 14, marginBottom: 8 },
  line: { marginBottom: 4 },
})

export function PlateLabelDocument({ model }: { model: PlateLabelModel }) {
  return (
    <Document>
      <Page size="A6" style={styles.page}>
        <View style={styles.card}>
          <Text style={styles.h1}>COLOUR IMPRESSIONS - PLATE STORE</Text>
          <Text style={styles.line}>{model.plateSetCode}</Text>
          <Text style={styles.line}>Carton: {model.cartonName}</Text>
          <Text style={styles.line}>Artwork: {model.artworkVersion} | Client: {model.customerName}</Text>
          <Text style={styles.line}>Colours: {model.colours}</Text>
          <Text style={styles.line}>CTP Date: {model.ctpDate}</Text>
          <Text style={styles.line}>Rack: {model.rack} | Slot: {model.slot}</Text>
        </View>
      </Page>
    </Document>
  )
}
