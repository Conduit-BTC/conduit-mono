export const PRODUCT_OPTION_GROUP_SEPARATOR = " · "

export interface GroupedProductOptionValue {
  group: string
  value: string
}

export function formatGroupedProductOptionValue(
  group: string,
  value: string
): string {
  const normalizedGroup = group.trim()
  const normalizedValue = value.trim()
  if (!normalizedGroup) return normalizedValue
  if (!normalizedValue) return normalizedGroup
  return `${normalizedGroup}${PRODUCT_OPTION_GROUP_SEPARATOR}${normalizedValue}`
}

export function parseGroupedProductOptionValue(
  input: string
): GroupedProductOptionValue | null {
  const separatorIndex = input.indexOf(PRODUCT_OPTION_GROUP_SEPARATOR)
  if (separatorIndex <= 0) return null

  const group = input.slice(0, separatorIndex).trim()
  const value = input
    .slice(separatorIndex + PRODUCT_OPTION_GROUP_SEPARATOR.length)
    .trim()
  return group && value ? { group, value } : null
}
