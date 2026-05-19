import { readCartonSpecPack, type SpecPackV1 } from '@/lib/carton-spec-pack'

export type SpecProvenance = 'spec' | 'master' | 'override' | 'user'

export type EditableSpecField =
  | 'boardGrade' | 'gsm' | 'paperType'
  | 'coatingType' | 'embossingLeafing' | 'foilType'
  | 'pastingStyle' | 'backPrint' | 'artworkCode'

/** Editable line field -> [spec-pack group, leaf key]. */
export const EDITABLE_SPEC_FIELDS: Record<
  EditableSpecField,
  readonly [keyof SpecPackV1, string]
> = {
  boardGrade: ['board', 'boardGrade'],
  gsm: ['board', 'gsm'],
  paperType: ['board', 'paperType'],
  coatingType: ['finishing', 'coatingType'],
  embossingLeafing: ['finishing', 'embossingLeafing'],
  foilType: ['finishing', 'foilType'],
  pastingStyle: ['tooling', 'pastingStyle'],
  backPrint: ['print', 'backPrint'],
  artworkCode: ['print', 'artworkCode'],
}

export type SpecOverrides = { specPack?: Record<string, Record<string, unknown>> } | null

export interface SpecSeedLine {
  boardGrade: string
  gsm: string
  paperType: string
  coatingType: string
  embossingLeafing: string
  foilType: string
  pastingStyle: string
  backPrint: string
  artworkCode: string
  specOverrides: SpecOverrides
  specProvenance: Partial<Record<EditableSpecField, SpecProvenance>>
}

function leaf(pack: SpecPackV1, field: EditableSpecField): unknown {
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const g = (pack as unknown as Record<string, Record<string, unknown>>)[group]
  return g ? g[key] : null
}

function overrideHasPath(ov: SpecOverrides, field: EditableSpecField): boolean {
  if (!ov?.specPack) return false
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const g = ov.specPack[group]
  return !!g && Object.prototype.hasOwnProperty.call(g, key)
}

/**
 * Per-field seed of a line from the effective pack (base overlaid by
 * specOverrides). Returns only the fields to patch + their provenance.
 * Never overwrites a field whose current provenance is 'user'.
 */
export function seedLineFromSpecPack(
  line: SpecSeedLine,
  basePack: SpecPackV1,
  specOverrides: SpecOverrides,
): {
  patch: Partial<Record<EditableSpecField, string>>
  provenance: Partial<Record<EditableSpecField, SpecProvenance>>
} {
  const { pack } = readCartonSpecPack({ specPack: basePack, specOverrides })
  const patch: Partial<Record<EditableSpecField, string>> = {}
  const provenance: Partial<Record<EditableSpecField, SpecProvenance>> = {}

  for (const field of Object.keys(EDITABLE_SPEC_FIELDS) as EditableSpecField[]) {
    if (line.specProvenance[field] === 'user') continue
    const v = leaf(pack, field)
    if (v === null || v === undefined || v === '') {
      // No spec value for this field. If the line already carries a non-empty
      // value it came from a master record, so tag it 'master'. backPrint==='No'
      // is excluded because 'No' is the empty/default sentinel for backPrint —
      // a line showing 'No' has no real master value to attribute.
      const hadMaster = String(line[field] ?? '').trim() !== '' &&
        !(field === 'backPrint' && line.backPrint === 'No')
      if (hadMaster) provenance[field] = 'master'
      continue
    }
    patch[field] = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)
    provenance[field] = overrideHasPath(specOverrides, field) ? 'override' : 'spec'
  }
  return { patch, provenance }
}

/**
 * Record a user edit: write the new value into specOverrides.specPack at the
 * mapped group/leaf and flip provenance to 'user' (non-mutating).
 */
export function applySpecOverrideEdit(
  line: SpecSeedLine,
  field: EditableSpecField,
  value: string,
): { specOverrides: SpecOverrides; specProvenance: SpecSeedLine['specProvenance'] } {
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const prev = line.specOverrides?.specPack ?? {}
  const specPack = {
    ...prev,
    [group]: { ...(prev[group] ?? {}), [key]: value },
  }
  return {
    specOverrides: { specPack },
    specProvenance: { ...line.specProvenance, [field]: 'user' },
  }
}
