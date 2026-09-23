import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type {
  ProductListingDeliveryJob,
  PublishWithPlannerResult,
} from "@conduit/core"
import {
  buildLocalProductDeliveryNotice,
  buildLocalProductQueueFailureNotice,
  buildLocalProductRetryNotice,
  buildProductDeliveryNotice,
  buildQueuedProductDeletionNotice,
  formatProductRelayUrls,
  getTerminalRejectedListingRecoveryDTags,
  reconcilePendingProductDeletionRetry,
} from "../apps/merchant/src/lib/product-delivery"

function rejectedListingRecoveryFixture() {
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const event = finalizeEvent(
    {
      kind: 30402,
      created_at: 1_700_000_000,
      tags: [["d", "rejected-product"]],
      content: "Recovery fixture",
    },
    merchantSecret
  )
  const job: ProductListingDeliveryJob = {
    id: `product-listing:${event.id}`,
    merchantPubkey,
    signedEvents: [event],
    relayTargets: [{ relayUrl: "wss://relay.example", ownerSelected: true }],
    relayDelivery: [
      {
        eventId: event.id,
        relayUrl: "wss://relay.example",
        status: "rejected",
        attemptCount: 1,
      },
    ],
    state: "failed",
    deliveryAttemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const family = {
    eventId: event.id,
    dTag: "rejected-product",
    product: { pubkey: merchantPubkey },
    variations: [],
  }
  return { job, family }
}

function deliveryResult(
  overrides: Partial<PublishWithPlannerResult> = {}
): PublishWithPlannerResult {
  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: [],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    relayFailureMessages: {},
    ...overrides,
  }
}

describe("merchant product delivery notices", () => {
  it("permits a newly signed restart only for the current same-author rejected revision", () => {
    const { job, family } = rejectedListingRecoveryFixture()
    expect(getTerminalRejectedListingRecoveryDTags(job, family)).toEqual([
      "rejected-product",
    ])
    expect(
      getTerminalRejectedListingRecoveryDTags(job, {
        ...family,
        eventId: "a".repeat(64),
      })
    ).toBeNull()
    expect(
      getTerminalRejectedListingRecoveryDTags(job, {
        ...family,
        product: { pubkey: "b".repeat(64) },
      })
    ).toBeNull()
    expect(
      getTerminalRejectedListingRecoveryDTags(
        {
          ...job,
          relayDelivery: [{ ...job.relayDelivery[0]!, status: "timed_out" }],
        },
        family
      )
    ).toBeNull()
    expect(
      getTerminalRejectedListingRecoveryDTags(
        { ...job, companionDeletionJobId: "linked-deletion" },
        family
      )
    ).toBeNull()
  })

  it("shows the signed local projection while relay delivery is pending", () => {
    const publish = buildLocalProductDeliveryNotice("publish")
    const deletion = buildLocalProductDeliveryNotice("delete")

    expect(publish.state).toBe("delivering")
    expect(publish.detail).toContain("visible locally")
    expect(deletion.state).toBe("delivering")
    expect(deletion.detail).toContain("hidden locally")
  })

  it("summarizes successful relay acknowledgements without duplicating counts", () => {
    const notice = buildProductDeliveryNotice(
      "publish",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one"],
        successfulRelayUrls: ["wss://relay.one"],
      })
    )

    expect(notice.state).toBe("delivered")
    expect(notice.detail).toContain("ACKed 1 of 1 relay.")
    expect(notice.detail).not.toContain("1 of 1 1 relay")
  })

  it("keeps partial delivery visible with actionable retry guidance", () => {
    const notice = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        successfulRelayUrls: ["wss://relay.one"],
        failedRelayUrls: ["wss://relay.two"],
        relayFailureMessages: {
          "wss://relay.two": "rate-limited: retry later",
        },
      })
    )

    expect(notice.state).toBe("partial")
    expect(notice.detail).toContain("Use Retry delivery")
    expect(notice.failedRelayUrls).toEqual(["wss://relay.two"])
  })

  it("accumulates relay acknowledgements across retry attempts", () => {
    const firstAttempt = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: [
          "wss://relay.one",
          "wss://relay.two",
          "wss://relay.three",
        ],
        successfulRelayUrls: ["wss://relay.one", "wss://relay.three"],
        failedRelayUrls: ["wss://relay.two"],
      })
    )
    const retry = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: [
          "wss://relay.one",
          "wss://relay.two",
          "wss://relay.three",
        ],
        successfulRelayUrls: ["wss://relay.two", "wss://relay.three"],
        failedRelayUrls: ["wss://relay.one"],
      }),
      firstAttempt
    )

    expect(retry.state).toBe("delivered")
    expect(retry.detail).toContain("ACKed 3 of 3 relays.")
    expect(retry.failedRelayUrls).toEqual([])
  })

  it("describes a local retry without claiming relay acknowledgement", () => {
    const notice = buildLocalProductRetryNotice("publish")

    expect(notice.state).toBe("retry_needed")
    expect(notice.detail).toContain("remains visible locally")
    expect(notice.successfulRelayUrls).toEqual([])
  })

  it("does not offer an impossible retry when the outbox was not saved", () => {
    const notice = buildLocalProductQueueFailureNotice("publish")

    expect(notice.state).toBe("failed")
    expect(notice.detail).toContain("No relay delivery was attempted")
    expect(notice.detail).not.toContain("Retry delivery")
  })

  it("projects terminal relay rejection without a no-op retry", () => {
    const notice = buildProductDeliveryNotice(
      "publish",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one"],
        failedRelayUrls: ["wss://relay.one"],
        rejectedRelayUrls: ["wss://relay.one"],
      })
    )

    expect(notice.state).toBe("rejected")
    expect(notice.rejectedRelayUrls).toEqual(["wss://relay.one"])
    expect(notice.detail).toContain("nothing left to retry")
    expect(notice.detail).not.toContain("Use Retry delivery")
  })

  it("keeps an all-rejected deletion in the exact-delivery retry state", () => {
    const rejected = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        failedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        rejectedRelayUrls: ["wss://relay.one", "wss://relay.two"],
      })
    )

    expect(rejected.state).toBe("retry_needed")
    expect(rejected.title).toBe("Delete saved locally")
    expect(rejected.detail).toContain("Use Retry delivery for 2 relays")
    expect(rejected.detail).not.toContain("nothing left to retry")

    const partlyAcknowledged = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        successfulRelayUrls: ["wss://relay.one"],
        failedRelayUrls: ["wss://relay.two"],
        rejectedRelayUrls: ["wss://relay.two"],
      }),
      rejected
    )
    expect(partlyAcknowledged.state).toBe("partial")
    expect(partlyAcknowledged.detail).toContain("ACKed 1 of 2 relays")
    expect(partlyAcknowledged.detail).toContain(
      "Use Retry delivery for 1 relay"
    )

    const delivered = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.two"],
        successfulRelayUrls: ["wss://relay.two"],
      }),
      partlyAcknowledged
    )
    expect(delivered.state).toBe("delivered")
    expect(delivered.failedRelayUrls).toEqual([])
  })

  it("treats a common family ACK as delivered when another relay rejects it", () => {
    const notice = buildProductDeliveryNotice(
      "publish",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        successfulRelayUrls: ["wss://relay.one"],
        failedRelayUrls: ["wss://relay.two"],
        rejectedRelayUrls: ["wss://relay.two"],
      })
    )

    expect(notice.state).toBe("delivered")
    expect(notice.rejectedRelayUrls).toEqual(["wss://relay.two"])
    expect(notice.detail).toContain("nothing left to retry")
    expect(notice.detail).not.toContain("Use Retry delivery")
  })

  it("does not claim a queued deletion is hidden before restoring local evidence", () => {
    const pending = buildQueuedProductDeletionNotice("retry_needed")
    const restoring = buildQueuedProductDeletionNotice("delivering")

    expect(pending.state).toBe("retry_needed")
    expect(pending.detail).toContain("local tombstone could not be confirmed")
    expect(pending.detail).toContain("before contacting relays")
    expect(pending.detail).not.toContain("hidden locally")
    expect(restoring.state).toBe("delivering")
    expect(restoring.detail).toContain("Confirming its local tombstone")
    expect(restoring.detail).not.toContain("active locally")
  })

  it("caps the visible relay list", () => {
    expect(
      formatProductRelayUrls([
        "wss://one",
        "wss://two",
        "wss://three",
        "wss://four",
        "wss://five",
      ])
    ).toBe("wss://one, wss://two, wss://three, wss://four, +1 more")
  })

  it("keeps a mixed publish retry paired while a deletion job is pending", () => {
    type RetryState =
      | { action: "publish"; payload: { signedBundleId: string } }
      | { action: "delete"; payload: { deliveryJobId: string } }
    const publishRetry: RetryState = {
      action: "publish",
      payload: { signedBundleId: "publish-bundle" },
    }
    const deletionRetry: RetryState = {
      action: "delete",
      payload: { deliveryJobId: "deletion-job" },
    }

    expect(
      reconcilePendingProductDeletionRetry<RetryState>(
        publishRetry,
        deletionRetry
      )
    ).toBe(publishRetry)
    expect(
      reconcilePendingProductDeletionRetry<RetryState>(null, deletionRetry)
    ).toEqual(deletionRetry)
  })
})
