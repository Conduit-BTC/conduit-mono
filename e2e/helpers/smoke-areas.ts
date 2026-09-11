export const smokeAreaTags = {
  market: "@market",
  merchant: "@merchant",
  commerce: "@commerce",
} as const

export type SmokeArea = keyof typeof smokeAreaTags
