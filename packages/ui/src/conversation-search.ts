export function matchesConversationSearch(
  query: string,
  values: readonly (string | null | undefined)[]
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true

  return values.some((value) => value?.toLowerCase().includes(normalized))
}
