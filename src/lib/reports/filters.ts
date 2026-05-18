import { z } from 'zod'

function monthStart(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }
function monthEnd(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)) }

export const dateRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform((v) => ({
    from: v.from ?? monthStart(),
    to: v.to ?? monthEnd(),
  }))
  .refine((v) => v.from.getTime() <= v.to.getTime(), {
    message: 'from must be on or before to',
  })

export const optionalId = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v : undefined))

/** Compose a report filter object schema that always carries from/to. */
export function withDateRange<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), ...shape })
    .transform((v) => {
      const { from, to, ...rest } = v
      return {
        from: from ?? monthStart(),
        to: to ?? monthEnd(),
        ...rest,
      } as { from: Date; to: Date } & { [K in keyof T]: z.infer<T[K]> }
    })
}
