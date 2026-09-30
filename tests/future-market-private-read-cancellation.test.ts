import { NDKEvent } from "@nostr-dev-kit/ndk"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetInboxDeclarationCache,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setRelayPublishTestOverrides,
  readFutureMarketReadyReceipts,
  readFutureMarketHandoffAcks,
  resolveInboxDeclaration,
  retryFutureMarketPrivateDelivery,
} from "@conduit/core"

const ORGANIZER = "a".repeat(64)

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetInboxDeclarationCache()
  __resetRelayPublishTestOverrides()
})

describe("future market private read cancellation", () => {
  it("rejects a cancelled organizer read before invoking the signer", async () => {
    let signerReads = 0
    __setCommerceTestOverrides({
      getNdk: async () => {
        signerReads += 1
        return {} as never
      },
    })
    await expect(
      readFutureMarketReadyReceipts({
        organizerPubkey: ORGANIZER,
        shouldContinue: () => false,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(signerReads).toBe(0)
  })

  it("rejects a read whose caller is retired while its inbox read is pending", async () => {
    let live = true
    let declarationReads = 0
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => {
        declarationReads += 1
        live = false
        return []
      },
    })
    await expect(
      readFutureMarketReadyReceipts({
        organizerPubkey: ORGANIZER,
        shouldContinue: () => live,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(declarationReads).toBe(1)
  })

  it("rejects a cancelled merchant ack read before parsing or reading recovery", async () => {
    await expect(
      readFutureMarketHandoffAcks({
        merchantPubkey: ORGANIZER,
        readyReceiptId: "b".repeat(64),
        receipt: {} as never,
        shouldContinue: () => false,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("stops exact retry before self-copy when the owner retires during recipient publication", async () => {
    const merchantSecret = generateSecretKey()
    const organizerSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(organizerSecret)
    const discoveryRelay = "wss://discovery.relay.dev"
    const recipientRelay = "wss://organizer.inbox.relay.dev"
    const senderRelay = "wss://merchant.inbox.relay.dev"
    const issuedAt = Math.floor(Date.now() / 1000)
    for (const [secret, inboxRelay] of [
      [organizerSecret, recipientRelay],
      [merchantSecret, senderRelay],
    ] as const) {
      const declaration = finalizeEvent(
        {
          kind: 10050,
          created_at: issuedAt,
          tags: [["relay", inboxRelay]],
          content: "",
        },
        secret
      )
      const resolution = await resolveInboxDeclaration(declaration.pubkey, {
        relayUrls: [discoveryRelay],
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration)],
          attemptedRelayUrls: [discoveryRelay],
          successfulRelayUrls: [discoveryRelay],
          failedRelayUrls: [],
        }),
      })
      expect(resolution.state).toBe("declared")
    }
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: issuedAt,
        tags: [["p", organizer]],
        content: "encrypted-recipient",
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: issuedAt,
        tags: [["p", merchant]],
        content: "encrypted-self",
      },
      merchantSecret
    )
    const published: string[] = []
    let ownerCurrent = true
    __setRelayPublishTestOverrides({
      accountNetworkLocalStateRepository: { get: async () => null },
    })
    const publish = spyOn(NDKEvent.prototype, "publish").mockImplementation(
      async function (this: NDKEvent) {
        published.push(this.id)
        ownerCurrent = false
        return new Set([{ url: recipientRelay }]) as never
      }
    )
    try {
      await expect(
        retryFutureMarketPrivateDelivery({
          record: {
            version: 2,
            type: "future_market_ready",
            rumorId: "a".repeat(64),
            readyReceiptId: "a".repeat(64),
            claimRef: "b".repeat(64),
            senderPubkey: merchant,
            recipientPubkey: organizer,
            signedRecipientWrap: recipientWrap,
            signedSelfWrap: selfWrap,
          },
          authenticatedOwnerPubkey: merchant,
          shouldContinue: () => ownerCurrent,
        })
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(published).toEqual([recipientWrap.id])
      expect(published).not.toContain(selfWrap.id)
    } finally {
      publish.mockRestore()
    }
  })
})
