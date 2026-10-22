import {
  PrivateMessageRelayReadinessError,
  type EventMarketEnrollmentPayload,
  type EventMarketEnrollmentState,
  type EventMarketMerchantRow,
  type PrivateMessageRelayReadinessReason,
} from "@conduit/core"

/** Requests are an organizer queue, not evidence of permission to sell. */
export function getPendingEventMerchantRequests(
  merchants: readonly Pick<EventMarketMerchantRow, "pubkey">[],
  states?: readonly Pick<
    EventMarketEnrollmentState,
    "merchantPubkey" | "status"
  >[]
): string[] {
  const roster = new Set(merchants.map((merchant) => merchant.pubkey))
  return (states ?? [])
    .filter(
      (state) =>
        state.status === "requested" && !roster.has(state.merchantPubkey)
    )
    .map((state) => state.merchantPubkey)
}

export function getEventParticipationStatus({
  approved,
  revoked,
  busy,
  pendingDelivery,
  enrollmentStatus,
}: {
  approved: boolean
  revoked: boolean
  busy: boolean
  pendingDelivery: boolean
  enrollmentStatus?: EventMarketEnrollmentState["status"]
}): string {
  if (busy) return "Sending participation…"
  if (pendingDelivery) return "Participation saved; delivery needs retry."
  if (approved) return "Approved to sell"
  if (revoked) return "Approval revoked"
  if (enrollmentStatus === "requested") return "Request pending"
  if (enrollmentStatus === "invited") return "Invited to join"
  if (enrollmentStatus === "declined") return "Request declined"
  if (enrollmentStatus === "withdrawn") return "Request withdrawn"
  return "Join this event"
}

/** Keep bounded observations and explicit signed inbox states distinct. */
export function getEventMarketEnrollmentError(
  cause: unknown,
  action: EventMarketEnrollmentPayload["action"]
): string {
  if (!(cause instanceof PrivateMessageRelayReadinessError))
    return cause instanceof Error
      ? cause.message
      : "Participation could not be sent."
  const recipient =
    action === "request" || action === "withdraw" ? "The host" : "This merchant"
  const messages: Record<PrivateMessageRelayReadinessReason, string> = {
    sender_not_ready:
      "Configure your private inbox in Network settings before sending participation.",
    recipient_not_ready: `${recipient} has no usable private inbox on the relays checked. Refresh and retry.`,
    recipient_relays_excluded:
      "The recipient’s inbox relays are excluded by your Network settings. Review the settings, then retry.",
    recipient_lookup_failed:
      "The recipient’s private inbox could not be checked. Refresh and retry; this does not prove their setup is missing.",
    recipient_declaration_signed_empty: `${recipient} has a signed private inbox declaration that lists no relays. They need to update their inbox before participation messages can be sent.`,
    recipient_declaration_malformed: `${recipient} has a private inbox declaration that could not be used. They need to repair their inbox before participation messages can be sent.`,
  }
  return messages[cause.reason]
}
