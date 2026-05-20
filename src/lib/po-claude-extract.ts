import Anthropic from '@anthropic-ai/sdk'

// Extraction model: Haiku 4.5 is ~15x cheaper than Opus 4.7 ($1/$5 vs $15/$75
// per M tokens) and tool-use structured extraction is well within its
// capability — the matching rules in SYSTEM_PROMPT do the heavy lifting.
// Override per-deploy with PO_EXTRACT_MODEL if a tougher model is needed.
const MODEL = process.env.PO_EXTRACT_MODEL || 'claude-haiku-4-5-20251001'
const TOOL_NAME = 'submit_extracted_po'
const DETECT_MODEL = 'claude-haiku-4-5-20251001'
const DETECT_TOOL_NAME = 'submit_customer_match'

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
- cartonSize on newCartonProposal MUST be a clean numeric dimension string that the system can parse into finishedLength / finishedWidth / finishedHeight columns of the Carton master:
    - 3D folding cartons / boxes: "L × W × H" e.g. "100 x 50 x 30 mm". Always three numbers separated by 'x'.
    - 2D inserts / leaflets / sachets: "L × W" e.g. "120 x 210 mm". Two numbers separated by 'x'.
    - Strip any axis prefixes from the PO — write "120 x 210 mm" NOT "L120 x H210 mm"; write "300 x 200 x 80 mm" NOT "L300 x W200 x H80 mm".
    - Always include the unit (usually mm) once at the end.
    - When the PO uses different axis labels (e.g. "L × H" for a leaflet), still emit in L × W [× H] order — the first number is always the longer "length" dimension and the second the cross dimension.
    - If the PO doesn't print dimensions, set cartonSize = null. Do not invent.
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
    max_tokens: 4000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
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

export type CustomerRosterItem = {
  id: string
  name: string
  gstNumber: string | null
  city: string | null
}

export type CustomerDetection = {
  /** Best match ID, or null if no candidate is plausible. */
  matchedCustomerId: string | null
  matchedCustomerName: string | null
  /** 0..1. >= 0.9 means safe to auto-use without operator confirmation. */
  confidence: number
  /** Verbatim text Claude used to make the match (name on the PO header). */
  evidence: string | null
  /** Top up-to-3 plausible candidates so the UI can offer a quick fallback. */
  candidates: Array<{ id: string; name: string; reason: string }>
  /** Brief note shown to the operator when confidence is low. */
  reason: string | null
  /**
   * When `matchedCustomerId` is null, Claude proposes the customer it read
   * off the PDF header so the operator can confirm-and-create instead of
   * picking from the roster. Fields are best-effort from the PDF only.
   */
  newCustomerProposal: {
    name: string
    gstNumber: string | null
    address: string | null
  } | null
}

const DETECT_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  required: ['matchedCustomerId', 'confidence', 'candidates'],
  properties: {
    matchedCustomerId: {
      type: ['string', 'null'],
      description:
        "ID from the provided customer roster, or null if no customer is plausible. " +
        'Match on legal name, brand name, or GST number — strictly only IDs from the roster.',
    },
    matchedCustomerName: { type: ['string', 'null'] },
    confidence: {
      type: 'number',
      description:
        '0..1. >= 0.9 only when the customer name OR GST on the PO matches a roster row clearly. ' +
        '0.7..0.9 = likely but worth confirming. < 0.7 = unsure.',
    },
    evidence: {
      type: ['string', 'null'],
      description: 'Verbatim text from the PDF that you used to identify the customer (e.g., the buyer name on the letterhead).',
    },
    candidates: {
      type: 'array',
      description: 'Up to 3 plausible IDs from the roster, ranked best-first. Empty array if nothing fits.',
      items: {
        type: 'object',
        required: ['id', 'name', 'reason'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    reason: {
      type: ['string', 'null'],
      description: 'Short note explaining the match (or why no match was found). Null if confidence >= 0.9.',
    },
    newCustomerProposal: {
      type: ['object', 'null'],
      description:
        'Required when matchedCustomerId=null. The buyer (customer) details read directly from the PO PDF header so the operator can confirm-and-create. Use verbatim text from the PDF — do NOT invent or paraphrase fields.',
      properties: {
        name: {
          type: 'string',
          description: 'Buyer / customer legal name as printed on the PO. The company SENDING the PO, not the factory receiving it.',
        },
        gstNumber: {
          type: ['string', 'null'],
          description: '15-char Indian GST number of the buyer if printed on the PO, else null.',
        },
        address: {
          type: ['string', 'null'],
          description: 'Buyer billing address from the PO if printed, else null. Single-line, comma-separated.',
        },
      },
      required: ['name'],
    },
  },
}

const DETECT_SYSTEM_PROMPT = `You identify which existing customer a purchase order PDF was issued to, for an Indian printing / carton-packaging factory.

You receive:
1. A JSON roster of the factory's existing Customer master rows (id, name, gstNumber, city).
2. The raw text from the customer's PO PDF.

WHERE TO LOOK ON THE PO (and where NOT to look):
- The buyer is the company that PLACED the PO. Always identified in one of these sections, in this priority:
    1. The top letterhead / header (logo + company name + "PURCHASE ORDER" title near it).
    2. The "Ship To" / "Bill To" / "Consignee" / "Bill From" block (which is the PO issuer's address).
    3. Any "PAN", "GSTIN", "CIN" block on the same header — those identify the buyer.
- IGNORE:
    - The "Vendor" / "Supplier" / "To" / "M/s" section addressed to the factory.
    - Product / item / carton names in the line-item table — those are SKUs, never customer names.
    - Footer disclaimers, terms & conditions, signatory blocks.
- Do not infer the buyer from product names or design codes. If the header / Ship-To / Bill-To section is unreadable, prefer to return no match over guessing from the body.

RETURN ONE call to submit_customer_match with:
- matchedCustomerId: the id of the best match, or null.
- confidence: how sure you are.
- candidates: up to 3 plausible roster rows ranked best-first.

MATCHING RULES — match liberally on roster brand name:
- Only return IDs that appear in the roster — never invent.
- A "match" is when the same legal entity / brand is plainly the buyer. Treat ALL of the following as the same name:
    - "Swiss Garnier Biotech" ≡ "Swiss Garniers Biotech" ≡ "Swiss Garnier Biotech Private Limited" ≡ "Swiss Garniers Biotech Pvt. Ltd." ≡ "Swiss Garnier Biotech (P) Ltd"
    - Capitalisation, punctuation, &/and, trailing "Limited" / "Pvt Ltd" / "(P) Ltd" / "LLP" / "Inc." differences.
    - Common Indian pluralisation drift on brand words (Garnier vs Garniers, Pharma vs Pharmas, Lab vs Labs).
    - Diacritics, hyphens, extra spaces.
- If the PO buyer name shares an unambiguous brand stem with a roster row AND no other roster row competes for it, match with confidence 0.9+. Don't penalise for "Pvt Ltd" or pluralisation when the brand is unique.
- GST match is decisive when present (15-char alphanumeric like "07AAACS1234A1Z5"). If GST matches a roster row, that wins regardless of name drift.
- Note: existing seed customers may carry placeholder GSTs ("03XXXXX0000X0XX", short numeric values, etc.). If the roster GST clearly isn't a real 15-char GSTIN, ignore it for matching and decide purely on name.
- City helps disambiguate only when TWO roster rows share the same brand.

WHEN NOTHING FITS:
- Set matchedCustomerId=null, confidence=0, candidates=[], explain briefly in reason.
- ALSO fill newCustomerProposal with the buyer details read VERBATIM from the PO header / Ship-To / Bill-To block:
    - name: buyer legal name exactly as printed (keep "Private Limited" / "Pvt Ltd" suffix if printed)
    - gstNumber: only if a clear 15-char GSTIN is printed on the buyer side; else null
    - address: buyer billing address as one comma-separated line if printed; else null
- Never invent fields. If unsure, null.`

/**
 * Identifies which existing customer a PO PDF belongs to. Cheap, focused call —
 * uses a small/fast model + only the slim customer roster (no carton catalog).
 */
export async function detectCustomerWithClaude(args: {
  pdfText: string
  customerRoster: CustomerRosterItem[]
  apiKey?: string
}): Promise<CustomerDetection> {
  const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }

  const client = new Anthropic({ apiKey })
  const rosterJson = JSON.stringify(args.customerRoster, null, 2)
  // Customer header info is on the first page — cap PDF text to keep this call cheap.
  const pdfSnippet = args.pdfText.slice(0, 6000)

  if (process.env.PO_DETECT_DEBUG === '1') {
    console.log('[detectCustomerWithClaude] roster size:', args.customerRoster.length)
    console.log('[detectCustomerWithClaude] roster names:', args.customerRoster.map((c) => c.name))
    console.log('[detectCustomerWithClaude] pdf snippet (first 1500 chars):\n' + pdfSnippet.slice(0, 1500))
  }

  const response = await client.messages.create({
    model: DETECT_MODEL,
    max_tokens: 1500,
    system: DETECT_SYSTEM_PROMPT,
    tools: [
      {
        name: DETECT_TOOL_NAME,
        description: 'Submit the identified customer from the PO PDF.',
        input_schema: DETECT_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: DETECT_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Customer roster (only return IDs from this list):\n\n${rosterJson}`,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: `PO PDF text (first page is usually enough):\n\n${pdfSnippet}` },
        ],
      },
    ],
  })

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === DETECT_TOOL_NAME,
  )
  if (!toolBlock) {
    throw new Error('Claude did not return a customer match. Stop reason: ' + response.stop_reason)
  }

  const raw = toolBlock.input as Partial<CustomerDetection> & {
    matchedCustomerId?: string | null
    candidates?: Array<{ id: string; name: string; reason: string }>
    newCustomerProposal?: {
      name?: string
      gstNumber?: string | null
      address?: string | null
    } | null
  }

  if (process.env.PO_DETECT_DEBUG === '1') {
    console.log('[detectCustomerWithClaude] Claude raw response:', JSON.stringify(raw, null, 2))
  }

  // Defensive: drop any id Claude invented that isn't in the roster.
  const validIds = new Set(args.customerRoster.map((c) => c.id))
  const matchedId =
    raw.matchedCustomerId && validIds.has(raw.matchedCustomerId) ? raw.matchedCustomerId : null
  const candidates = (raw.candidates ?? []).filter((c) => validIds.has(c.id)).slice(0, 3)
  // Proposal only matters when no roster match — never let it overwrite a real match.
  let proposal: CustomerDetection['newCustomerProposal'] = null
  if (!matchedId && raw.newCustomerProposal?.name?.trim()) {
    proposal = {
      name: raw.newCustomerProposal.name.trim().slice(0, 200),
      gstNumber: raw.newCustomerProposal.gstNumber?.trim() || null,
      address: raw.newCustomerProposal.address?.trim() || null,
    }
  }
  return {
    matchedCustomerId: matchedId,
    matchedCustomerName: raw.matchedCustomerName ?? null,
    confidence: Math.max(0, Math.min(1, raw.confidence ?? 0)),
    evidence: raw.evidence ?? null,
    candidates,
    reason: raw.reason ?? null,
    newCustomerProposal: proposal,
  }
}
