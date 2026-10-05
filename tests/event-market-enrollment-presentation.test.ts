import { describe, expect, it } from "bun:test"
import { PrivateMessageRelayReadinessError } from "@conduit/core"
import { getEventMarketEnrollmentError } from "../apps/merchant/src/lib/event-market-enrollment-presentation"

describe("Merchant participation inbox errors", () => {
  it.each(["request", "withdraw", "invite", "decline"] as const)(
    "preserves every readiness reason for %s",
    (action) => {
      const recipient =
        action === "request" || action === "withdraw"
          ? "The host"
          : "This merchant"
      const cases = [
        [
          "sender_not_ready",
          "Configure your private inbox in Network settings",
        ],
        [
          "recipient_not_ready",
          `${recipient} has no usable private inbox on the relays checked`,
        ],
        ["recipient_relays_excluded", "excluded by your Network settings"],
        ["recipient_lookup_failed", "could not be checked"],
        [
          "recipient_declaration_distribution_pending",
          `${recipient} has configured a private inbox, but it has not been confirmed`,
        ],
        [
          "recipient_declaration_signed_empty",
          `${recipient} has a signed private inbox declaration that lists no relays`,
        ],
        [
          "recipient_declaration_malformed",
          `${recipient} has a private inbox declaration that could not be used`,
        ],
      ] as const
      const messages = cases.map(([reason, expected]) => {
        const message = getEventMarketEnrollmentError(
          new PrivateMessageRelayReadinessError(reason),
          action
        )
        expect(message).toContain(expected)
        expect(message).not.toContain("has not configured")
        return message
      })
      expect(new Set(messages).size).toBe(cases.length)
    }
  )
  it("preserves ordinary errors and gives unknown failures actionable copy", () => {
    expect(
      getEventMarketEnrollmentError(
        new Error("Connect your signer."),
        "request"
      )
    ).toBe("Connect your signer.")
    expect(getEventMarketEnrollmentError(null, "request")).toBe(
      "Participation could not be sent."
    )
  })
})
