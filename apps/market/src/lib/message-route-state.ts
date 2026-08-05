export function getAutomaticMerchantThreadId(
  currentThreadId: string | undefined,
  conversationIds: readonly string[]
): string | null {
  if (currentThreadId || conversationIds.length === 0) return null
  return conversationIds[0] ?? null
}
