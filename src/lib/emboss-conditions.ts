type CartonRoutingSource = {
  embossingLeafing?: string | null
  coatingType?: string | null
  laminateType?: string | null
}

export function isEmbossingRequired(embossingLeafing: string | null | undefined): boolean {
  if (!embossingLeafing) return false
  return embossingLeafing.includes('Embossing')
}

export function isLeafingRequired(embossingLeafing: string | null | undefined): boolean {
  if (!embossingLeafing) return false
  return embossingLeafing.includes('Leafing')
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
    needsSpotUv: coating.includes('UV'),
    needsLamination: !!laminate && laminate !== 'None',
    needsChemicalCoating: coating === 'Aqueous Varnish' || coating === 'Chemical Coating',
  }
}

