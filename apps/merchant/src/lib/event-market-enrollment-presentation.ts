import {
  PrivateMessageRelayReadinessError,
  type EventMarketEnrollmentPayload,
  type PrivateMessageRelayReadinessReason,
} from "@conduit/core"

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
    recipient_declaration_distribution_pending: `${recipient} has configured a private inbox, but it has not been confirmed on the discovery relays. Refresh and retry.`,
    recipient_declaration_signed_empty: `${recipient} has a signed private inbox declaration that lists no relays. They need to update their inbox before participation messages can be sent.`,
    recipient_declaration_malformed: `${recipient} has a private inbox declaration that could not be used. They need to repair their inbox before participation messages can be sent.`,
  }
  return messages[cause.reason]
}
