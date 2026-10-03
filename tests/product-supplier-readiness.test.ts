import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { readProductSupplierReadiness } from "../packages/core/src/protocol/product-supplier-readiness"
import { createSelectedProfileContext } from "../packages/core/src/protocol/profile-cache"
import type { ProfileBatchResult } from "../packages/core/src/protocol/commerce"
import type { InboxDeclarationResolution } from "../packages/core/src/protocol/private-message-routing"
import type { ProductSupplierAllocation } from "../packages/core/src/schemas"

function fixtures() {
  const contexts = [1, 2].map((byte) => {
    const secret = generateSecretKey()
    const event = finalizeEvent(
      {
        kind: 0,
        created_at: 1_750_000_000,
        tags: [],
        content: JSON.stringify({
          name: `Fixture ${byte}`,
          lud16: `fixture${byte}@wallet.example`,
        }),
      },
      secret
    )
    return {
      ...createSelectedProfileContext({
        pubkey: getPublicKey(secret),
        row: {
          pubkey: event.pubkey,
          eventId: event.id,
          eventCreatedAt: event.created_at,
          rawContent: event.content,
          cachedAt: Date.now(),
        },
        observed: true,
        readComplete: true,
      }),
      signedEvent: event,
    }
  })
  const allocation: ProductSupplierAllocation = {
    state: "valid",
    issues: [],
    recipients: contexts.map((context, index) => ({
      pubkey: context.profile.pubkey,
      role: index === 0 ? "merchant" : "supplier",
      weight: index === 0 ? 3 : 1,
      relayHint: "wss://profile.example",
    })),
  }
  const profiles = {
    data: Object.fromEntries(
      contexts.map((context) => [context.profile.pubkey, context.profile])
    ),
    profileContexts: Object.fromEntries(
      contexts.map((context) => [context.profile.pubkey, context])
    ),
    meta: { stale: false, degraded: false, capped: false },
  } as ProfileBatchResult
  const inbox = (pubkey: string): InboxDeclarationResolution => ({
    pubkey,
    state: "declared",
    relayUrls: ["wss://recipient-inbox.example"],
    stale: false,
    fetchedAt: Date.now(),
  })
  return {
    allocation,
    profiles,
    inbox,
    input: {
      allocation,
      accountPubkey: contexts[0]!.profile.pubkey,
      authenticatedPubkey: contexts[0]!.profile.pubkey,
      shouldContinue: () => true,
    },
  }
}

describe("supplier authoring readiness", () => {
  it("checks selected signed profiles, each declared inbox, and plain LNURL metadata without an invoice", async () => {
    const fixture = fixtures()
    const metadata: string[] = []
    const result = await readProductSupplierReadiness(fixture.input, {
      readProfiles: async (query) => {
        expect(query.skipCache).toBe(true)
        expect(query.evidenceScope).toBe("payment")
        expect(query.authorRelayPaymentPolicy).toBe(true)
        expect(query.relayHintsByPubkey?.[fixture.input.accountPubkey]).toEqual(
          ["wss://profile.example"]
        )
        return fixture.profiles
      },
      readInbox: async (pubkey, options) => {
        expect(options?.relayUrls).toBeUndefined()
        return fixture.inbox(pubkey)
      },
      assertMetadata: async (input) => {
        metadata.push(input.lud16)
      },
    })
    expect(result.state).toBe("ready")
    expect(result.recipients.map((recipient) => recipient.displayName)).toEqual(
      ["Fixture 1", "Fixture 2"]
    )
    expect(metadata).toEqual([
      "fixture1@wallet.example",
      "fixture2@wallet.example",
    ])
  })

  it("keeps positive signed profile evidence usable when another discovery relay is incomplete", async () => {
    const fixture = fixtures()
    fixture.profiles.meta.degraded = true
    fixture.profiles.meta.capped = true
    Object.values(fixture.profiles.profileContexts).forEach((context) => {
      context.readComplete = false
    })
    expect(
      (
        await readProductSupplierReadiness(fixture.input, {
          readProfiles: async () => fixture.profiles,
          readInbox: async (pubkey) => fixture.inbox(pubkey),
          assertMetadata: async () => undefined,
        })
      ).state
    ).toBe("ready")
  })

  it("never substitutes a profile relay for a missing, stale, pending, or signed-empty inbox", async () => {
    for (const state of [
      "not_observed",
      "lookup_partial",
      "lookup_unavailable",
      "signed_empty",
      "distribution_pending",
      "declared",
    ] as const) {
      const fixture = fixtures()
      let metadataCalls = 0
      const result = await readProductSupplierReadiness(fixture.input, {
        readProfiles: async () => fixture.profiles,
        readInbox: async (pubkey) => ({
          ...fixture.inbox(pubkey),
          state,
          stale: state === "declared",
          relayUrls:
            state === "declared" ? ["wss://recipient-inbox.example"] : [],
        }),
        assertMetadata: async () => {
          metadataCalls++
        },
      })
      expect(result.state).toBe("unavailable")
      expect(
        result.recipients.every(
          (recipient) => recipient.reason === "inbox_unavailable"
        )
      ).toBe(true)
      expect(metadataCalls).toBe(0)
    }
  })

  it("rejects a tampered profile and never calls its payment endpoint", async () => {
    const fixture = fixtures()
    const context =
      fixture.profiles.profileContexts[fixture.input.accountPubkey]!
    context.signedEvent!.sig = "0".repeat(128)
    let count = 0
    const result = await readProductSupplierReadiness(fixture.input, {
      readProfiles: async () => fixture.profiles,
      readInbox: async (pubkey) => fixture.inbox(pubkey),
      assertMetadata: async () => {
        count++
      },
    })
    expect(result.state).toBe("invalid")
    expect(result.recipients[0]!.reason).toBe("profile_invalid")
    expect(count).toBe(1)
  })

  it("returns actionable endpoint unavailability without leaking provider exceptions", async () => {
    const fixture = fixtures()
    const result = await readProductSupplierReadiness(fixture.input, {
      readProfiles: async () => fixture.profiles,
      readInbox: async (pubkey) => fixture.inbox(pubkey),
      assertMetadata: async () => {
        throw new Error("private endpoint detail")
      },
    })
    expect(result.state).toBe("unavailable")
    expect(
      result.recipients.every(
        (recipient) => recipient.reason === "payment_endpoint_unavailable"
      )
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private endpoint detail")
  })

  it("stops after the account changes while a profile read settles", async () => {
    const fixture = fixtures()
    let current = true
    let inboxCalls = 0
    await expect(
      readProductSupplierReadiness(
        { ...fixture.input, shouldContinue: () => current },
        {
          readProfiles: async () => {
            current = false
            return fixture.profiles
          },
          readInbox: async (pubkey) => {
            inboxCalls++
            return fixture.inbox(pubkey)
          },
        }
      )
    ).rejects.toThrow("cancelled")
    expect(inboxCalls).toBe(0)
  })
})
