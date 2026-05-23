// src/lib/master-data.ts
// Single source of truth for plant master data: machines, operators,
// departments, dedicated login users, fixed printing assignments, terminals.

/** Production stage groups → drives machine taxonomy + terminal rules. */
export type MachineGroup = 'cutting' | 'printing' | 'coating' | 'die' | 'pasting'

export type MachineSeed = {
  machineCode: string
  name: string
  group: MachineGroup
  capacityPerShift: number
  stdWastePct: number
}

export const MACHINES: MachineSeed[] = [
  { machineCode: 'CUT-01', name: 'Polar Cutting Machine', group: 'cutting', capacityPerShift: 12000, stdWastePct: 0.5 },
  { machineCode: 'PRN-01', name: 'Komori 5 Colour Press 1', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'PRN-02', name: 'Komori 5 Colour Press 2', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'PRN-03', name: 'Komori 5 Colour Press 3', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'COT-01', name: 'UV Coating Machine 1', group: 'coating', capacityPerShift: 48000, stdWastePct: 2.0 },
  { machineCode: 'COT-02', name: 'UV Coating Machine 2', group: 'coating', capacityPerShift: 48000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A01', name: 'Automatic Die Cutter 1', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A02', name: 'Automatic Die Cutter 2', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A03', name: 'Automatic Die Cutter 3', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-M01', name: 'Manual Die Punching Machine 1', group: 'die', capacityPerShift: 8000, stdWastePct: 2.5 },
  { machineCode: 'DIE-M02', name: 'Manual Die Punching Machine 2', group: 'die', capacityPerShift: 8000, stdWastePct: 2.5 },
  { machineCode: 'PST-01', name: 'Folder Gluer 1', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
  { machineCode: 'PST-02', name: 'Folder Gluer 2', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
  { machineCode: 'PST-03', name: 'Folder Gluer 3', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
]

/** machineCodes by group — convenience for filters/dropdowns. */
export const MACHINE_CODES_BY_GROUP: Record<MachineGroup, string[]> = {
  cutting: MACHINES.filter((m) => m.group === 'cutting').map((m) => m.machineCode),
  printing: MACHINES.filter((m) => m.group === 'printing').map((m) => m.machineCode),
  coating: MACHINES.filter((m) => m.group === 'coating').map((m) => m.machineCode),
  die: MACHINES.filter((m) => m.group === 'die').map((m) => m.machineCode),
  pasting: MACHINES.filter((m) => m.group === 'pasting').map((m) => m.machineCode),
}

/** Press machine codes used by dashboards/OEE (replaces legacy ['CI-01','CI-02','CI-03']). */
export const PRESS_MACHINE_CODES = MACHINE_CODES_BY_GROUP.printing

export type OperatorSeed = { name: string; department: string; stageKey: string }

export const OPERATORS: OperatorSeed[] = [
  { name: 'Parkash', department: 'Coating', stageKey: 'chemical_coating' },
  { name: 'Raja', department: 'Coating', stageKey: 'chemical_coating' },
  { name: 'Jiut', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Shankar', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Dileep Pasting', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Dileep Printing', department: 'Printing', stageKey: 'printing' },
  { name: 'Modi', department: 'Printing', stageKey: 'printing' },
  { name: 'Shiv', department: 'Printing', stageKey: 'printing' },
  { name: 'Sonu', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Surjeet', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Rajesh', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Birju', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Nitish', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Lakhan', department: 'Die Punching', stageKey: 'dye_cutting' },
]

export type LoginUserSeed = { name: string; email: string; roleSlug: string }

export const LOGIN_USERS: LoginUserSeed[] = [
  { name: 'Ravi', email: 'ravi@ci.local', roleSlug: 'admin' },
  { name: 'Shamsheer Inder', email: 'shamsheer@ci.local', roleSlug: 'admin' },
  { name: 'Manish Admin', email: 'manish@ci.local', roleSlug: 'admin' },
  { name: 'Dharminder', email: 'dharminder@ci.local', roleSlug: 'plant_head' },
  { name: 'Amrinder Accounts', email: 'amrinder@ci.local', roleSlug: 'accounts' },
  { name: 'Avneet Designs', email: 'avneet@ci.local', roleSlug: 'design_planning' },
  { name: 'Ankit Loader', email: 'ankit@ci.local', roleSlug: 'production' },
]

export const DEFAULT_USER_PIN = '123456'

/** Operator name → fixed printing machine code. */
export const PRINTING_FIXED_ASSIGNMENT: Record<string, string> = {
  'Dileep Printing': 'PRN-01',
  Modi: 'PRN-02',
  Shiv: 'PRN-03',
}

export type TerminalSeed = { code: string; label: string; stageKey: string }

export const TERMINALS: TerminalSeed[] = [
  { code: 'TERM-CUT', label: 'Cutting Terminal', stageKey: 'cutting' },
  { code: 'TERM-PRN', label: 'Printing Terminal', stageKey: 'printing' },
  { code: 'TERM-COT', label: 'Coating Terminal', stageKey: 'chemical_coating' },
  { code: 'TERM-DIE', label: 'Die Terminal', stageKey: 'dye_cutting' },
  { code: 'TERM-PST', label: 'Pasting Terminal', stageKey: 'pasting' },
]
