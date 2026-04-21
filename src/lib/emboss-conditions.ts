type CartonRoutingSource = {
  embossingLeafing?: string | null
  coatingType?: string | null
  laminateType?: string | null
}

export function isEmbossingRequired(embossingLeafing: string | null | undefined): boolean {
  if (!embossingLeafing || embossingLeafing === 'None') return false
  const s = embossingLeafing.toLowerCase()
  return (
    s.includes('emboss') ||
    s.includes('deboss') ||
    s.includes('braille')
  )
}

export function isLeafingRequired(embossingLeafing: string | null | undefined): boolean {
  if (!embossingLeafing || embossingLeafing === 'None') return false
  const s = embossingLeafing.toLowerCase()
  return s.includes('foil') || s.includes('holographic') || s.includes('leafing')
}

export function getPostPressRouting(carton: CartonRoutingSource): {
  needsEmbossing: boolean
  needsLeafing: boolean
  needsSpotUv: boolean
  needsLamination: boolean
  needsChemicalCoating: boolean
} {
  const coating = carton.coatingType ?? ''
  const laminate = carton.laminateType ?? ''
  return {
    needsEmbossing: isEmbossingRequired(carton.embossingLeafing),
    needsLeafing: isLeafingRequired(carton.embossingLeafing),
    needsSpotUv: coating.includes('Spot UV') || coating.includes('UV'),
    needsLamination: coating.includes('Thermal Lamination') || (!!laminate && laminate !== 'None'),
    needsChemicalCoating:
      coating.includes('Aqueous Varnish') || coating.includes('Blister Coating') || coating.includes('Drip-Off'),
  }
}

