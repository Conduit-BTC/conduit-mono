export function getClientErrorMessage(
  error: unknown,
  fallback: string
): string {
  try {
    if (!(error instanceof Error)) return fallback
    return error.message || fallback
  } catch {
    return fallback
  }
}
