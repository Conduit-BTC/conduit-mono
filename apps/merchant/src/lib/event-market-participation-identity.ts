export type MerchantProfileState =
  "available" | "loading" | "unresolved" | "unavailable"

export function getMerchantProfileState(input: {
  hasProfile: boolean
  lookupSettled: boolean
  error: unknown
}): MerchantProfileState {
  if (input.hasProfile) return "available"
  if (!input.lookupSettled) return "loading"
  return input.error ? "unavailable" : "unresolved"
}
