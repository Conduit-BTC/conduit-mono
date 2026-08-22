export const smokeAreaTags = {
  market: "@market",
  merchant: "@merchant",
} as const

export type SmokeArea = keyof typeof smokeAreaTags
