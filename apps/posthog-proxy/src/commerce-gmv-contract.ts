export const MAX_ESTIMATED_GMV_SATS = 2_100_000_000_000_000
export const GMV_DEDUPE_RETENTION_DAYS = 30

export type CommerceGmvDailyObservation = {
  orderDay: string
  opaqueOrderKey: string
  dailyEventUuid: string
  estimatedGmvSats: number
}

export type CommerceGmvDailyObservationResult = {
  status: "accepted" | "duplicate" | "expired"
}

export type CommerceGmvCutoverResolution =
  | { status: "inactive" }
  | { status: "active"; cutoverDate: string }
  | { status: "invalid" }
  | { status: "mismatch" }
