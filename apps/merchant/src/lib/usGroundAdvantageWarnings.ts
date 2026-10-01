/** Advisory only: dimensions never silently change signed weight-table prices. */
export function getUSGroundAdvantageWarnings(dimensions?: {
  length: number
  width: number
  height: number
}): string[] {
  if (!dimensions) return []
  const sides = [dimensions.length, dimensions.width, dimensions.height].sort(
    (a, b) => b - a
  )
  const length = sides[0]!
  const lengthAndGirth = length + 2 * (sides[1]! + sides[2]!)
  const volume = dimensions.length * dimensions.width * dimensions.height
  const warnings: string[] = []
  if (lengthAndGirth > 330.2)
    warnings.push(
      "USPS Ground Advantage: this parcel exceeds the 130-inch length-plus-girth limit. Arrange another service."
    )
  else if (lengthAndGirth > 274.32)
    warnings.push(
      "USPS Ground Advantage: oversized pricing may apply above 108 inches of length plus girth; the US starter excludes it."
    )
  if (length > 55.88)
    warnings.push(
      `USPS Ground Advantage: a nonstandard length fee may apply above ${length > 76.2 ? "30" : "22"} inches; review the shipping charge.`
    )
  if (volume > 28316.846592)
    warnings.push(
      "USPS Ground Advantage: dimensional weight may apply above one cubic foot; the starter uses weight only. Review the parcel quote."
    )
  if (volume > 56633.693184)
    warnings.push(
      "USPS Ground Advantage: a nonstandard volume fee may apply above two cubic feet."
    )
  return warnings
}
