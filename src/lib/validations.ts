import { z } from 'zod'

// COMMON FIELD VALIDATORS
export const requiredString = (fieldName: string) =>
  z.string().trim().min(1, `${fieldName} is required`)

export const requiredNumber = (fieldName: string) =>
  z.number({ required_error: `${fieldName} is required` })
    .positive(`${fieldName} must be greater than 0`)

export const optionalString = z.string().optional()
export const optionalNumber = z.number().optional()

// PHONE VALIDATION (Indian format)
export const phoneValidator = z.string()
  .trim()
  .regex(/^[0-9+\-\s()]{6,20}$/, 'Enter valid phone number')
  .optional()

// GST VALIDATION
export const gstValidator = z.string()
  .trim()
  .max(32, 'GST number is too long')
  .optional()

// EMAIL VALIDATION
export const emailValidator = z.string()
  .email('Enter valid email address')
  .optional()

// POSITIVE INTEGER
export const positiveInt = (fieldName: string) =>
  z.number().int().positive(`${fieldName} must be a positive number`)

// DATE VALIDATOR
export const dateValidator = (fieldName: string) =>
  z.string().min(1, `${fieldName} is required`)

// RFQ SCHEMA
export const rfqSchema = z.object({
  customerId: requiredString('Customer'),
  productName: requiredString('Product name'),
  packType: requiredString('Pack type'),
  estimatedVolume: z.number().positive('Volume must be greater than 0'),
  deliveryTimeline: optionalString,
  drugSchedule: optionalString,
  specialRequirements: optionalString,
  // Dimensions
  cartonLength: z.number().positive().optional(),
  cartonWidth: z.number().positive().optional(),
  cartonHeight: z.number().positive().optional(),
  // Specs
  boardGrade: optionalString,
  gsm: z.number().int().min(150).max(600).optional(),
  numberOfColours: z.number().int().min(1).max(8).optional(),
  coatingType: optionalString,
  laminateType: optionalString,
  // Commercial
  targetPrice: z.number().positive().optional(),
  priority: z.enum(['Normal', 'Urgent', 'Critical']).default('Normal'),
})

// PURCHASE ORDER SCHEMA
export const purchaseOrderSchema = z.object({
  customerId: requiredString('Customer'),
  poNumber: requiredString('PO Number'),
  poDate: requiredString('PO Date'),
  deliveryRequiredBy: requiredString('Delivery Required By'),
  paymentTerms: optionalString,
  priority: z.enum(['Normal', 'Urgent', 'Critical']).default('Normal'),
  specialInstructions: optionalString,
  lineItems: z.array(z.object({
    cartonName: requiredString('Carton name'),
    quantity: z.number().int().positive('Quantity must be greater than 0'),
    rate: z.number().positive('Rate is required'),
    artworkCode: optionalString,
    gsm: z.number().int().optional(),
    dyeId: optionalString,
  })).min(1, 'At least one line item is required'),
})

// CARTON SCHEMA
export const cartonSchema = z.object({
  cartonName: requiredString('Carton name'),
  customerId: requiredString('Customer'),
  gsm: z.number().int().min(150, 'GSM must be at least 150').max(600, 'GSM cannot exceed 600').optional(),
  finishedLength: z.number().positive().optional(),
  finishedWidth: z.number().positive().optional(),
  finishedHeight: z.number().positive().optional(),
  numberOfColours: z.number().int().min(1).max(8).optional(),
  deltaEMax: z.number().min(0).max(6).optional(),
  aqlLevel: z.enum(['0.65', '1.0', '1.5', '2.5', '4.0']).optional(),
  glueBondMinN: z.number().min(0).max(10).optional(),
  batchSpaceL: z.number().min(20, 'Batch space length must be at least 20mm for pharma').optional(),
  batchSpaceW: z.number().min(8, 'Batch space width must be at least 8mm for pharma').optional(),
})

// DYE SCHEMA
export const dyeSchema = z.object({
  dyeNumber: z.number().int().positive('Dye number is required'),
  dyeType: requiredString('Dye type'),
  ups: z.number().int().positive('UPS is required'),
  sheetSize: requiredString('Sheet size'),
  cartonSize: requiredString('Carton size'),
})

// JOB CARD SCHEMA
export const jobCardSchema = z.object({
  customerId: requiredString('Customer'),
  requiredSheets: z.number().int().positive('Required sheets must be greater than 0'),
  wastageSheets: z.number().int().min(0, 'Wastage cannot be negative'),
  assignedOperator: optionalString,
})

// SHEET ISSUE SCHEMA
export const sheetIssueSchema = z.object({
  jobCardId: requiredString('Job card'),
  qtyRequested: z.number().int().positive('Quantity must be greater than 0'),
  lotNumber: optionalString,
})

// EXCESS REQUEST SCHEMA
export const excessRequestSchema = z.object({
  jobCardId: requiredString('Job card'),
  qtyRequested: z.number().int().positive('Additional quantity required'),
  reasonCode: requiredString('Reason is required'),
  reasonDetail: z.string().optional(),
}).refine(data => {
  if (data.reasonCode === 'Other' && !data.reasonDetail) {
    return false
  }
  return true
}, { message: 'Please provide detail for Other reason', path: ['reasonDetail'] })

// CUSTOMER SCHEMA
export const customerSchema = z.object({
  name: requiredString('Company name'),
  gstNumber: gstValidator,
  contactName: optionalString,
  contactPhone: phoneValidator,
  email: emailValidator,
})

// PLATE STORE SCHEMA
export const plateStoreSchema = z.object({
  cartonName: requiredString('Carton name'),
  artworkVersion: requiredString('Artwork version'),
  numberOfColours: z.number().int().min(1).max(8),
  storageLocation: optionalString,
  ctpDate: optionalString,
})

export const employeeSchema = z.object({
  codeNo: requiredString('Code No.'),
  name: requiredString('Employee name'),
  firm: requiredString('Firm'),
  department: requiredString('Department'),
  transactionMode: requiredString('Transaction mode'),
  status: z.enum(['Active', 'Inactive']).default('Active'),
  esiPayable: z.boolean().default(false),
  bankName: z.string().optional().nullable(),
  accountNumber: z.string().optional().nullable(),
  ifscCode: z.string().optional().nullable(),
})

export const payrollRunSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  defaultBaseSalary: z.number().min(0).default(0),
})

export const payrollUpdateRowSchema = z.object({
  id: requiredString('Salary record id'),
  baseSalary: z.number().min(0).default(0),
  increment: z.number().default(0),
  presentDays: z.number().min(0).default(0),
  absentDays: z.number().min(0).default(0),
  overtimeHours: z.number().min(0).default(0),
  miscAdditions: z.number().default(0),
  holidayPay: z.number().default(0),
  advances: z.number().default(0),
  loans: z.number().default(0),
  installments: z.number().default(0),
  paymentStatus: z.enum(['CLEAR', 'PENDING']).default('PENDING'),
})
