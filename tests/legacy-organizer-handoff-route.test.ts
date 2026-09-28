import { describe, expect, it } from "bun:test"
import type { EventMarketOrganizerClaim } from "@conduit/core"
import { fulfillLegacyOrganizerClaim } from "../apps/merchant/src/components/LegacyOrganizerHandoffQueue"

const organizer = "a".repeat(64)
const otherOrganizer = "b".repeat(64)

describe("historical organizer fulfillment compatibility", () => {
  it("exposes private fulfillment only to the authenticated historical organizer", async () => {
    const route = await Bun.file(
      "apps/merchant/src/routes/events/$collectionRef.tsx"
    ).text()
    const queue = await Bun.file(
      "apps/merchant/src/components/LegacyOrganizerHandoffQueue.tsx"
    ).text()
    expect(route).toContain("authenticatedPubkey === decoded.authorPubkey")
    expect(route).toContain("<LegacyOrganizerHandoffQueue")
    expect(queue).toContain("readEventMarketReadyReceipts")
    expect(queue).toContain("resolveOrganizerHandoffMerchandise")
    expect(queue).toContain("resolveOrganizerHandoffAckReadiness")
    expect(queue).toContain("acknowledgeOrganizerHandoff")
    expect(queue).toContain("retryStoredOrganizerHandoffAck")
    for (const writer of [
      "publishOrganizerEventMarket",
      "publishOrganizerCollection",
      "publishEventMarketRoster",
      "publishMerchantProduct",
    ]) {
      expect(route).not.toContain(writer)
      expect(queue).not.toContain(writer)
    }
  })

  it.each([
    {
      coordinate: `30405:${otherOrganizer}:historical`,
      active: true,
      error: "does not belong",
    },
    {
      coordinate: `30409:${organizer}:future`,
      active: true,
      error: "does not belong",
    },
    {
      coordinate: `30405:${organizer}:historical`,
      active: false,
      error: "session changed",
    },
  ])(
    "rejects invalid owner or changed session before any private read or signature",
    async ({ coordinate, active, error }) => {
      let calls = 0
      const unexpected = async () => {
        calls += 1
        throw new Error("Unexpected boundary call")
      }
      await expect(
        fulfillLegacyOrganizerClaim(
          {
            organizerPubkey: organizer,
            collectionCoordinate: coordinate,
            claim: {} as EventMarketOrganizerClaim,
            shouldContinue: () => active,
          },
          {
            read: unexpected,
            market: unexpected,
            merchandise: unexpected,
            signer: unexpected,
          }
        )
      ).rejects.toThrow(error)
      expect(calls).toBe(0)
    }
  )

  it("keeps saved ACK retries available after a recovery copy reports handed out", async () => {
    const queue = await Bun.file(
      "apps/merchant/src/components/OrganizerHandoffReceiptQueue.tsx"
    ).text()
    expect(queue).toContain('claim.state === "ready_for_pickup" ||')
    expect(queue).toContain("(ackDelivery && ackNeedsRetry)")
    expect(queue).toContain('(!ackDelivery && ackReadiness?.state !== "ready")')
  })
})
