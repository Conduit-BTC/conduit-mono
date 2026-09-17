import { describe, expect, it } from "bun:test"
import {
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type { MerchantEventHandoffStorage } from "../apps/merchant/src/lib/merchant-event-handoff-arrangement"
import {
  createMerchantEventHandoffTransition,
  getMerchantEventHandoffTransitionSummary,
  loadMerchantEventHandoffTransition,
  recordMerchantEventHandoffListingSignature,
  retryMerchantEventHandoffTransition,
} from "../apps/merchant/src/lib/merchant-event-handoff-transition"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER = "b".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:community-market`
const PICKUP = `30406:${ORGANIZER}:organizer-desk`
const FIRST_PRODUCT = `30402:${MERCHANT}:coffee`
const SECOND_PRODUCT = `30402:${MERCHANT}:tea`

class MemoryStorage implements MerchantEventHandoffStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function signedProduct(
  dTag: string,
  createdAt: number
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30402,
      content: "",
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["price", "1000", "SAT"],
        ["shipping_option", PICKUP],
      ],
      created_at: createdAt,
    },
    MERCHANT_SECRET
  )
}

function delivery(input: {
  attempted: string[]
  successful: string[]
  failed: string[]
}): PublishWithPlannerResult {
  return {
    plan: {} as PublishWithPlannerResult["plan"],
    attemptedRelayUrls: input.attempted,
    successfulRelayUrls: input.successful,
    failedRelayUrls: input.failed,
    relayFailureMessages: {},
  }
}

describe("merchant event handoff transition journal", () => {
  it("persists exact per-listing delivery truth and retries only unfinished revisions", async () => {
    const storage = new MemoryStorage()
    const firstEvent = signedProduct("coffee", 10)
    const secondEvent = signedProduct("tea", 10)
    let journal = createMerchantEventHandoffTransition({
      merchantPubkey: MERCHANT,
      collectionCoordinate: COLLECTION,
      target: {
        mode: "organizer_handoff",
        handlerPubkey: ORGANIZER,
        pickupCoordinate: PICKUP,
      },
      listings: [
        { productCoordinate: FIRST_PRODUCT, title: "Coffee" },
        { productCoordinate: SECOND_PRODUCT, title: "Tea" },
      ],
      id: "transition-1",
      now: 1,
    })
    journal = recordMerchantEventHandoffListingSignature({
      journal,
      productCoordinate: FIRST_PRODUCT,
      signedEvent: firstEvent,
      now: 2,
    })
    journal = recordMerchantEventHandoffListingSignature({
      journal,
      productCoordinate: SECOND_PRODUCT,
      signedEvent: secondEvent,
      now: 3,
    })

    const firstAttemptIds: string[] = []
    journal = await retryMerchantEventHandoffTransition({
      journal,
      storage,
      now: () => 4,
      deliver: async (event, coordinate) => {
        firstAttemptIds.push(event.id)
        return coordinate === FIRST_PRODUCT
          ? delivery({
              attempted: ["wss://one.example"],
              successful: ["wss://one.example"],
              failed: [],
            })
          : delivery({
              attempted: ["wss://one.example", "wss://two.example"],
              successful: ["wss://one.example"],
              failed: ["wss://two.example"],
            })
      },
    })

    expect(firstAttemptIds).toEqual([firstEvent.id, secondEvent.id])
    expect(getMerchantEventHandoffTransitionSummary(journal)).toMatchObject({
      state: "partial",
      total: 2,
      delivered: 1,
      partial: 1,
    })
    expect(journal.listings.map((listing) => listing.status)).toEqual([
      "delivered",
      "partial",
    ])
    const persisted = loadMerchantEventHandoffTransition(
      MERCHANT,
      COLLECTION,
      storage
    )
    expect(persisted?.id).toBe(journal.id)
    expect(
      persisted?.listings.map((listing) => ({
        productCoordinate: listing.productCoordinate,
        status: listing.status,
        signedEventId: listing.signedEvent?.id,
      }))
    ).toEqual([
      {
        productCoordinate: FIRST_PRODUCT,
        status: "delivered",
        signedEventId: firstEvent.id,
      },
      {
        productCoordinate: SECOND_PRODUCT,
        status: "partial",
        signedEventId: secondEvent.id,
      },
    ])

    const retryIds: string[] = []
    journal = await retryMerchantEventHandoffTransition({
      journal,
      storage,
      now: () => 5,
      deliver: async (event) => {
        retryIds.push(event.id)
        return delivery({
          attempted: ["wss://two.example"],
          successful: ["wss://two.example"],
          failed: [],
        })
      },
    })

    expect(retryIds).toEqual([secondEvent.id])
    expect(getMerchantEventHandoffTransitionSummary(journal)).toMatchObject({
      state: "complete",
      delivered: 2,
      partial: 0,
      retryNeeded: 0,
    })
    expect(journal.listings[1]).toMatchObject({
      status: "delivered",
      attemptCount: 2,
      acknowledgedRelayUrls: ["wss://one.example", "wss://two.example"],
      failedRelayUrls: [],
      signedEvent: { id: secondEvent.id },
    })
  })

  it("does not report unsigned or zero-ack listings as changed", async () => {
    const storage = new MemoryStorage()
    let journal = createMerchantEventHandoffTransition({
      merchantPubkey: MERCHANT,
      collectionCoordinate: COLLECTION,
      target: {
        mode: "organizer_handoff",
        handlerPubkey: ORGANIZER,
        pickupCoordinate: PICKUP,
      },
      listings: [
        { productCoordinate: FIRST_PRODUCT },
        { productCoordinate: SECOND_PRODUCT },
      ],
      id: "transition-2",
      now: 1,
    })
    journal = recordMerchantEventHandoffListingSignature({
      journal,
      productCoordinate: FIRST_PRODUCT,
      signedEvent: signedProduct("coffee", 11),
      now: 2,
    })
    let calls = 0
    journal = await retryMerchantEventHandoffTransition({
      journal,
      storage,
      now: () => 3,
      deliver: async () => {
        calls += 1
        return delivery({
          attempted: ["wss://one.example"],
          successful: [],
          failed: ["wss://one.example"],
        })
      },
    })

    expect(calls).toBe(1)
    expect(journal.listings.map((listing) => listing.status)).toEqual([
      "retry_needed",
      "awaiting_signature",
    ])
    expect(getMerchantEventHandoffTransitionSummary(journal)).toMatchObject({
      state: "retry_needed",
      delivered: 0,
      retryNeeded: 1,
      awaitingSignature: 1,
    })
  })
})
