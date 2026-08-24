import type { InboxDeclarationStatus } from "@conduit/core"

export type ProductInboxGuidanceAction = "continue" | "retry" | "setup"

export interface ProductInboxPublishGuidance {
  action: ProductInboxGuidanceAction
  actionLabel: string
  body: string
  title: string
}

export function needsProductInboxPublishGuidance(
  status: InboxDeclarationStatus,
  existingProduct: boolean
): boolean {
  return !existingProduct && status !== "ready"
}

export function getProductInboxPublishGuidance(
  status: InboxDeclarationStatus
): ProductInboxPublishGuidance {
  switch (status) {
    case "ready":
      return {
        action: "continue",
        actionLabel: "Publish product",
        title: "Private inbox ready",
        body: "Your signed private inbox is ready for encrypted orders and messages.",
      }
    case "loading":
      return {
        action: "retry",
        actionLabel: "Checking...",
        title: "Checking your private inbox",
        body: "We are checking whether buyers and other clients can find the relays you use for encrypted orders and messages.",
      }
    case "not_observed":
      return {
        action: "setup",
        actionLabel: "Set up private inbox",
        title: "Set up your private inbox",
        body: "We did not find a signed private inbox declaration on the shared discovery relays. Set one up so buyers and other clients know where to deliver encrypted orders and messages.",
      }
    case "distribution_pending":
      return {
        action: "setup",
        actionLabel: "Finish private inbox setup",
        title: "Finish private inbox setup",
        body: "Your signed private inbox has not been confirmed on shared discovery relays. Finish setup for more reliable delivery, or publish this product now.",
      }
    case "signed_empty":
      return {
        action: "setup",
        actionLabel: "Restore private inbox",
        title: "Restore your private inbox",
        body: "Your signed private inbox currently lists no relays. Restore it so buyers and other clients know where to deliver encrypted orders and messages.",
      }
    case "malformed":
      return {
        action: "setup",
        actionLabel: "Repair private inbox",
        title: "Repair your private inbox",
        body: "Your signed private inbox declaration does not contain a usable relay. Repair it for more reliable encrypted order and message delivery.",
      }
    case "lookup_partial":
      return {
        action: "retry",
        actionLabel: "Retry check",
        title: "Private inbox check incomplete",
        body: "Some discovery relays did not respond. This does not mean your setup is missing. Retry the check, or publish this product now.",
      }
    case "lookup_unavailable":
      return {
        action: "retry",
        actionLabel: "Retry check",
        title: "Private inbox could not be checked",
        body: "No discovery relay completed the check. This does not mean your setup is missing. Retry when your connection recovers, or publish this product now.",
      }
  }
}
