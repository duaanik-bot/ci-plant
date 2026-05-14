import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-4-7'
const TOOL_NAME = 'submit_extracted_po'

export type CartonCatalogItem = {
  id: string
  cartonName: string
  artworkCode: string | null
  gsm: number | null
  rate: number | null
  gstPct: number
  cartonSize: string | null
}

export type ExtractedLineItem = {
  /** Verbatim text of the line from the PDF (for user verification). */
  rawText: string
  quantity: number
  rate: number | null
  gstPct: number | null
  artworkCode: string | null
  /** ID of an existing Carton master row, when matchConfidence >= 0.9. */
  matchedCartonId: string | null
  matchedCartonName: string | null
  /** 0..1 — operator-facing confidence the matched Carton is correct. */
  matchConfidence: number
  /** When no existing Carton fits, Claude proposes one for user approval. */
  newCartonProposal: {
    cartonName: string
    cartonSize: string | null
    gsm: number | null
    rate: number | null
    artworkCode: string | null
    reason: string
  } | null
}

export type ExtractedPo = {
  poNumber: string
  poDate: string // YYYY-MM-DD
  deliveryRequiredBy: string | null
  remarks: string | null
  lineItems: ExtractedLineItem[]
}

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  required: ['poNumber', 'poDate', 'lineItems'],
  properties: {
    poNumber: { type: 'string', description: "Customer's PO number, exactly as printed on the document" },
    poDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
    deliveryRequiredBy: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD, or null if not stated' },
    remarks: { type: ['string', 'null'], description: 'Any notes, payment terms, or special instructions on the header. Null if none.' },
    lineItems: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['rawText', 'quantity', 'matchConfidence'],
        properties: {
          rawText: { type: 'string', description: 'Verbatim text of this line as it appears in the PDF' },
          quantity: { type: 'number' },
          rate: { type: ['number', 'null'] },
          gstPct: { type: ['number', 'null'] },
          artworkCode: { type: ['string', 'null'] },
          matchedCartonId: { type: ['string', 'null'], description: "ID from the provided Carton catalog. Null if matchConfidence < 0.9." },
          matchedCartonName: { type: ['string', 'null'] },
          matchConfidence: { type: 'number', description: '0..1. Only set >= 0.9 when carton name OR artwork code matches essentially identically.' },
          newCartonProposal: {
            type: ['object', 'null'],
            description: 'Required when matchConfidence < 0.9. Suggested new Carton master row.',
            properties: {
              cartonName: { type: 'string' },
              cartonSize: { type: ['string', 'null'] },
              gsm: { type: ['number', 'null'] },
              rate: { type: ['number', 'null'] },
              artworkCode: { type: ['string', 'null'] },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

const SYSTEM_PROMPT = `You normalise customer purchase orders for a printing / carton-packaging factory in India.

You are given:
1. A JSON catalog of the customer's existing Carton master rows (id, cartonName, artworkCode, gsm, rate, gstPct, cartonSize).
2. The raw text extracted from the customer's PO PDF.

Your job is to return ONE call to the submit_extracted_po tool with:
- The PO header (poNumber, poDate, deliveryRequiredBy, remarks).
- Every line item from the PO, each mapped to an existing Carton when possible.

Matching rules — be STRICT:
- Set matchConfidence >= 0.9 ONLY when the carton name OR artwork code on the PO line is essentially identical to a catalog row (small typos, case, spacing OK). Same product family is NOT enough.
- If 0.7 <= matchConfidence < 0.9, set matchedCartonId to the best guess but the UI will still ask the user to confirm.
- If matchConfidence < 0.7 OR no catalog row is even close, set matchedCartonId=null and matchedCartonName=null, AND fill newCartonProposal with a suggested master row (cartonName must be the verbatim product name from the PO; fill cartonSize/gsm/rate/artworkCode only when explicitly stated on the line; reason explains why no catalog row fit).
- Quantities, rates, GST: parse exactly as printed. Indian PO formats often use commas as thousand separators ("10,000" = 10000) and may print rate as "@ Rs 1.85" or "Rate 1.85 / nos". Default GST to null if not stated — do NOT guess.
- Dates: convert any format (DD/MM/YYYY, DD-Mon-YYYY, etc.) to ISO YYYY-MM-DD. If only a delivery month is given, return null.

Do NOT include explanatory text — make only the tool call.`

/**
 * Calls Claude with the customer's Carton catalog and the raw PDF text and
 * returns a normalized PO. Uses tool use for strict structured output and
 * caches the catalog block so repeat POs from the same customer hit the
 * Anthropic prompt cache.
 */
export async function extractPoWithClaude(args: {
  pdfText: string
  cartonCatalog: CartonCatalogItem[]
  apiKey?: string
}): Promise<ExtractedPo> {
  const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }

  const client = new Anthropic({ apiKey })

  const catalogJson = JSON.stringify(args.cartonCatalog, null, 2)

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Submit the normalized purchase order extracted from the PDF.',
        input_schema: TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Customer's existing Carton master (use these IDs when matching):\n\n${catalogJson}`,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `Raw PDF text:\n\n${args.pdfText}`,
          },
        ],
      },
    ],
  })

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME,
  )
  if (!toolBlock) {
    throw new Error('Claude did not return a tool call. Stop reason: ' + response.stop_reason)
  }

  return toolBlock.input as ExtractedPo
}
