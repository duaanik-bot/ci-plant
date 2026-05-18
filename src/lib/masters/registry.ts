// The single source of truth for which controlled lists exist.
// Consumers reference MASTER.* — never a string literal.
// Adding a category = add one line here + a seed row in prisma/seed-masters.ts.
export const MASTER = {
  UNIT: 'UNIT',
  BOARD_TYPE: 'BOARD_TYPE',
  BOARD_COLOUR: 'BOARD_COLOUR',
  COATING: 'COATING',
  FOIL: 'FOIL',
  EMBOSS: 'EMBOSS',
  PASTING: 'PASTING',
} as const

export type MasterKey = (typeof MASTER)[keyof typeof MASTER]

export const MASTER_KEYS = Object.values(MASTER) as MasterKey[]
