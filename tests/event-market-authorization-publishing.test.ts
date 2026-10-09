import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  publishEventMarketAuthorization,
  resolveEventMarketAuthorization,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair`
const rootDraft = buildEventMarketAuthorizationDraft({
  marketCoordinate,
  merchantPubkey: merchant,
  state: "active",
  sequence: 0,
  parentIds: [],
})
const root = finalizeEvent({ ...rootDraft, created_at: 100 }, secret)
async function admitted(event: SignedPublicNostrEvent) {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error(`Fixture admission failed: ${result.status}`)
  return result.event
}

async function current() {
  const event = await admitted(root)
  return {
    marketCoordinate,
    merchantPubkey: merchant,
    resolution: resolveEventMarketAuthorization({
      marketCoordinate,
      merchantPubkey: merchant,
      transitions: [event],
    }),
    coverage: "complete" as const,
    retained: true,
    actionable: true,
    observedEvidence: [event],
  }
}

describe("Event Market authorization publishing", () => {
  it("rejects a stale tip before asking the organizer to sign", async () => {
    let signCalls = 0
    await expect(
      publishEventMarketAuthorization(
        {
          marketCoordinate,
          merchantPubkey: merchant,
          state: "revoked",
          authenticatedPubkey: organizer,
          expectedTipIds: [],
          onSignedLocal: async () => undefined,
        },
        {
          read: current,
          sign: async () => {
            signCalls++
            return root
          },
          publish: async () => {
            throw new Error("must not publish")
          },
        }
      )
    ).rejects.toThrow("changed")
    expect(signCalls).toBe(0)
  })

  it("saves exact signed descendant before relay publication", async () => {
    const calls: string[] = []
    let signed: SignedPublicNostrEvent | null = null
    const result = await publishEventMarketAuthorization(
      {
        marketCoordinate,
        merchantPubkey: merchant,
        state: "revoked",
        authenticatedPubkey: organizer,
        expectedTipIds: [root.id],
        onSignedLocal: async (event) => {
          calls.push("save")
          signed = event
        },
      },
      {
        read: current,
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        publish: async (event) => {
          calls.push("publish")
          expect(event.id).toBe(signed?.id)
          return { successfulRelayUrls: ["wss://example.com"] } as never
        },
      }
    )
    expect(calls).toEqual(["save", "publish"])
    expect(result.signedEvent.id).toBe(signed?.id)
    expect(
      resolveEventMarketAuthorization({
        marketCoordinate,
        merchantPubkey: merchant,
        transitions: [await admitted(root), await admitted(result.signedEvent)],
      }).state
    ).toBe("revoked")
  })
})
