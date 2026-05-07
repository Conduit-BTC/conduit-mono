/**
 * Nostr event kinds used in Conduit
 * Reference: https://github.com/nostr-protocol/nips
 */
export const EVENT_KINDS = {
  /** NIP-01: User profile metadata */
  PROFILE: 0,

  /** NIP-09: Event deletion */
  DELETION: 5,

  /** NIP-02: Contact list / follow graph */
  CONTACT_LIST: 3,

  /** NIP-17: Private direct messages */
  DIRECT_MESSAGE: 14,

  /** NIP-59: Sealed event (inner DM) */
  SEAL: 13,

  /** NIP-17: Gift wrap for encrypted DMs */
  GIFT_WRAP: 1059,

  /** Conduit MVP: Order message (wrapped in NIP-17) */
  ORDER: 16,

  /** NIP-57: Zap request */
  ZAP_REQUEST: 9734,

  /** NIP-57: Zap receipt */
  ZAP_RECEIPT: 9735,

  /** NIP-65: Relay list metadata */
  RELAY_LIST: 10002,

  /** NIP-89: Recommended application handlers */
  APPLICATION_RECOMMENDATION: 31989,

  /** NIP-89: Application handler metadata */
  APPLICATION_HANDLER: 31990,

  /** NIP-99: Marketplace product listing (addressable) */
  PRODUCT: 30402,

  /** Shipping option for a product */
  SHIPPING_OPTION: 30406,

  /** NIP-04: Legacy encrypted DM */
  DM_LEGACY: 4,
} as const

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS]
