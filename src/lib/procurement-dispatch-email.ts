import { Resend } from 'resend'

export async function sendVendorPoEmail(params: {
  to: string
  subject: string
  pdfBuffer: Buffer
  pdfFilename: string
  textBody: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.RESEND_FROM_EMAIL?.trim() || 'procurement@colourimpressions.in'

  if (!key) {
    return { ok: false, error: 'RESEND_API_KEY not configured' }
  }

  const resend = new Resend(key)
  const { data, error } = await resend.emails.send({
    from,
    to: [params.to],
    subject: params.subject,
    text: params.textBody,
    attachments: [
      {
        filename: params.pdfFilename,
        content: params.pdfBuffer,
      },
    ],
  })

  if (error) {
    return { ok: false, error: error.message || 'Resend error' }
  }
  if (!data?.id) {
    return { ok: false, error: 'No message id from Resend' }
  }
  return { ok: true }
}

export function vendorPoEmailSubject(boardTypesLabel: string, vendorPoNumber: string): string {
  return `Order for ${boardTypesLabel} - PO#${vendorPoNumber} - Darbi Print Pack / Colour Impressions`
}

export { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
