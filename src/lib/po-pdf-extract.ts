import { extractText, getDocumentProxy } from 'unpdf'

export type PdfExtractResult = {
  text: string
  pageCount: number
  /** True when the PDF has pages but almost no extractable text — likely a scan. */
  isLikelyScanned: boolean
}

/**
 * Pulls plain text from a PDF buffer using unpdf (Vercel-Fluid-safe).
 * Returns the full text with `\n--- Page N ---\n` separators so the LLM sees
 * page boundaries.
 *
 * `isLikelyScanned` is `true` when the text-per-page ratio is too low to be
 * a normal text PDF, signalling the caller to short-circuit (Phase 1 does
 * not include OCR).
 */
export async function extractPoPdfText(buffer: ArrayBuffer | Uint8Array): Promise<PdfExtractResult> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const pdf = await getDocumentProxy(bytes)
  const { text, totalPages } = await extractText(pdf, { mergePages: false })

  const pages = Array.isArray(text) ? text : [text]
  const joined = pages
    .map((pageText, idx) => `--- Page ${idx + 1} ---\n${pageText.trim()}`)
    .join('\n\n')

  const totalChars = joined.replace(/[^\S\n]/g, '').length
  const charsPerPage = totalPages > 0 ? totalChars / totalPages : 0
  const isLikelyScanned = totalPages > 0 && charsPerPage < 40

  return {
    text: joined,
    pageCount: totalPages,
    isLikelyScanned,
  }
}
