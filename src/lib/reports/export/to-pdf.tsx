import React from 'react'
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { ReportResult } from '../types'
import { fmtCell } from '../format'
import { COMPANY } from '@/lib/company-config'

const s = StyleSheet.create({
  page: { padding: 24, fontSize: 8 },
  h1: { fontSize: 14, marginBottom: 2 },
  meta: { fontSize: 7, color: '#666', marginBottom: 8 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10, gap: 6 },
  card: { border: '1 solid #ddd', padding: 6, minWidth: 110 },
  cardLabel: { fontSize: 6, color: '#666' },
  cardValue: { fontSize: 11 },
  row: { flexDirection: 'row', borderBottom: '0.5 solid #eee' },
  th: { flex: 1, fontWeight: 700, padding: 3, backgroundColor: '#f3f3f3' },
  td: { flex: 1, padding: 3 },
})

export async function reportToPdf(title: string, result: ReportResult): Promise<Buffer> {
  const doc = (
    <Document>
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.h1}>{COMPANY.legalName} — {title}</Text>
        <Text style={s.meta}>
          Generated {result.meta.generatedAt} ·{' '}
          {Object.entries(result.meta.filtersApplied).map(([k, v]) => `${k}: ${v}`).join('  ')}
        </Text>
        <View style={s.cards}>
          {result.summary.map((c, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardLabel}>{c.label}</Text>
              <Text style={s.cardValue}>{c.value}</Text>
            </View>
          ))}
        </View>
        <View style={s.row} fixed>
          {result.columns.map((c) => (
            <Text key={c.key} style={s.th}>{c.label}</Text>
          ))}
        </View>
        {result.rows.map((r, i) => (
          <View key={i} style={s.row} wrap={false}>
            {result.columns.map((c) => (
              <Text key={c.key} style={s.td}>{fmtCell(r[c.key], c.type)}</Text>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  )
  return renderToBuffer(doc)
}
