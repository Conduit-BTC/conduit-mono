export type BillingTier = "free" | "starter" | "pro_hustle"

export interface Entitlements {
  tier: BillingTier
  maxProducts: number
  maxImages: number
  analytics: boolean
  customDomain: boolean
  prioritySupport: boolean
}

const FULL_ACCESS: Entitlements = {
  tier: "pro_hustle",
  maxProducts: Infinity,
  maxImages: 10,
  analytics: true,
  customDomain: true,
  prioritySupport: true,
}

export function getEntitlements(_pubkey: string): Entitlements {
  return FULL_ACCESS
}
