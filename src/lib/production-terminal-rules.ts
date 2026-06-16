// src/lib/production-terminal-rules.ts
import { PRINTING_FIXED_ASSIGNMENT, MACHINE_CODES_BY_GROUP } from '@/lib/master-data'

export type TerminalRule = {
  /** stageKey from PRODUCTION_STAGES */
  stageKey: string
  operatorRequired: boolean
  machineSelectable: boolean
  machineRequired: boolean
  /** when set, machine is locked to this code */
  fixedMachineCode: string | null
  /** when true, machine is derived from the chosen operator (printing) */
  machineAutoFromOperator: boolean
  /** machine codes valid for this terminal's selector */
  machineCodes: string[]
}

const RULES: Record<string, TerminalRule> = {
  cutting: {
    stageKey: 'cutting',
    operatorRequired: false,
    machineSelectable: false,
    machineRequired: true,
    fixedMachineCode: 'CUT-01',
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.cutting,
  },
  printing: {
    stageKey: 'printing',
    operatorRequired: true,
    machineSelectable: false,
    machineRequired: false,
    fixedMachineCode: null,
    machineAutoFromOperator: true,
    machineCodes: MACHINE_CODES_BY_GROUP.printing,
  },
  chemical_coating: {
    stageKey: 'chemical_coating',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.coating,
  },
  dye_cutting: {
    stageKey: 'dye_cutting',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.die,
  },
  pasting: {
    stageKey: 'pasting',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.pasting,
  },
}

const DEFAULT_RULE = (stageKey: string): TerminalRule => ({
  stageKey,
  operatorRequired: false,
  machineSelectable: true,
  machineRequired: false,
  fixedMachineCode: null,
  machineAutoFromOperator: false,
  machineCodes: [],
})

export function getTerminalRule(stageKey: string): TerminalRule {
  return RULES[stageKey] ?? DEFAULT_RULE(stageKey)
}

export function resolvePrintingMachine(operatorName: string): string | null {
  return PRINTING_FIXED_ASSIGNMENT[operatorName.trim()] ?? null
}
