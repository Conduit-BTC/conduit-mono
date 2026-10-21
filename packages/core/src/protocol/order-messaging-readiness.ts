import type { InboxDeclarationStatus } from "../hooks/useInboxDeclaration"

/** Presentation/preflight only. Delivery revalidates the current authenticated
 * declaration before direct replies; this never grants transport authority.
 * Initial kind-16 orders keep their separate recipient-first delivery boundary. */
export function getOrderMessagingReadiness(
  status: InboxDeclarationStatus,
  purpose: "initial_order" | "direct_reply" = "direct_reply"
): {
  ready: boolean
  action: "setup" | "retry" | null
  title: string
  detail: string
} {
  const initialOrderNote =
    purpose === "initial_order"
      ? " You can still send this order. Updates, replies, and relay backup may be unavailable until your inbox is ready."
      : ""
  switch (status) {
    case "ready":
      return { ready: true, action: null, title: "", detail: "" }
    case "loading":
      return {
        ready: false,
        action: null,
        title: "Checking order messaging",
        detail:
          "Checking whether your private inbox can receive order updates and replies." +
          initialOrderNote,
      }
    case "lookup_partial":
    case "lookup_unavailable":
      return {
        ready: false,
        action: "retry",
        title: "Order messaging availability is unconfirmed",
        detail:
          "The inbox check was incomplete. This does not mean your setup is missing." +
          (purpose === "direct_reply"
            ? " Retry the check before continuing."
            : initialOrderNote),
      }
    case "not_observed":
      return {
        ready: false,
        action: "setup",
        title: "Set up order messaging",
        detail:
          "No private inbox was found in this check. Review Network settings so you can receive order updates and send replies." +
          initialOrderNote,
      }
    case "signed_empty":
    case "malformed":
      return {
        ready: false,
        action: "setup",
        title: "Repair order messaging",
        detail:
          "Your published private inbox is not usable. Review Network settings so you can receive order updates and send replies." +
          initialOrderNote,
      }
  }
}

export function assertOrderMessagingReady(
  status: InboxDeclarationStatus
): void {
  const readiness = getOrderMessagingReadiness(status)
  if (!readiness.ready) throw new Error(readiness.detail)
}
