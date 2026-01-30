/**
 * Nostr event kinds used in Conduit
 * Reference: https://github.com/nostr-protocol/nips
 */
export const EVENT_KINDS = {
  /** NIP-01: User profile metadata */
  PROFILE: 0,

  /** NIP-09: Event deletion */
  DELETION: 5,

  /** NIP-65: Relay list metadata */
  RELAY_LIST: 10002,

  /** NIP-15: Marketplace product listing (replaceable) */
  PRODUCT: 30402,

  /** NIP-17: Private direct messages */
  DIRECT_MESSAGE: 14,

  /** Gift wrap for encrypted DMs */
  GIFT_WRAP: 1059,
} as const

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS]
