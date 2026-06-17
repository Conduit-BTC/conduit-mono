import { afterEach, describe, expect, it } from "bun:test"
import NDK, { NDKEvent, NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { randomBytes } from "node:crypto"
import {
  __resetProtectedDeliveryTestOverrides,
  __setProtectedDeliveryTestOverrides,
  applyProtectedDeliveryPublishResult,
  createProtectedDeliveryDiagnostics,
  createProtectedDeliveryRecord,
  deliverProtectedOrderMessage,
  EVENT_KINDS,
  getRetryableProtectedDeliveryRecords,
  isFullProductCoordinate,
  persistProtectedDeliveryRecord,
  projectProtectedDeliveryBatch,
  type CreateProtectedDeliveryRecordInput,
  type PublishWithPlannerInput,
  type PublishWithPlannerResult,
  type RelayWritePlan,
  type StoredProtectedDeliveryRecord,
} from "@conduit/core"

const NOW = 1_700_000_000_000
const SENDER = "a".repeat(64)
const RECIPIENT = "b".repeat(64)
const PRODUCT_COORDINATE = `30402:${RECIPIENT}:sku-1`
const WRAP_ID = "e".repeat(64)

afterEach(() => {
  __resetProtectedDeliveryTestOverrides()
})

function signedWrapEventJson(
  id: string = WRAP_ID,
  content = "encrypted-payload"
): string {
  return JSON.stringify({
    id,
    pubkey: SENDER,
    created_at: Math.floor(NOW / 1000),
    kind: EVENT_KINDS.GIFT_WRAP,
    tags: [["p", RECIPIENT]],
    content,
    sig: "f".repeat(128),
  })
}

function createRecord(
  overrides: Partial<CreateProtectedDeliveryRecordInput> = {}
): StoredProtectedDeliveryRecord {
  return createProtectedDeliveryRecord({
    orderId: "order-1",
    senderPubkey: SENDER,
    recipientPubkey: RECIPIENT,
    recipientRole: "primary_recipient",
    surface: "market_checkout",
    intent: "checkout_order",
    productCoordinates: [PRODUCT_COORDINATE],
    signedWrapEventId: WRAP_ID,
    signedWrapEventJson: signedWrapEventJson(),
    sourceRationale: ["recipient_nip17_10050"],
    plannedRelayUrls: ["merchant.example", "wss://sender.example"],
    requiredRelayUrls: ["wss://merchant.example"],
    now: NOW,
    ...overrides,
  })
}

function publishResult(input: {
  primaryRelayUrls?: string[]
  broadcastRelayUrls?: string[]
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  relayFailureMessages?: Record<string, string>
}): PublishWithPlannerResult {
  return {
    plan: {
      intent: "recipient_event",
      primaryRelayUrls: input.primaryRelayUrls ?? ["wss://merchant.example"],
      broadcastRelayUrls: input.broadcastRelayUrls ?? ["wss://sender.example"],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: input.attemptedRelayUrls,
    successfulRelayUrls: input.successfulRelayUrls,
    failedRelayUrls: input.failedRelayUrls,
    relayFailureMessages: input.relayFailureMessages ?? {},
  }
}

function plan(input: {
  primaryRelayUrls: string[]
  broadcastRelayUrls?: string[]
}): RelayWritePlan {
  return {
    intent: "recipient_event",
    primaryRelayUrls: input.primaryRelayUrls,
    broadcastRelayUrls: input.broadcastRelayUrls ?? [],
    parkedRelayUrls: [],
  }
}

async function createSignedOrderRumor(input: {
  senderPubkey: string
  recipientPubkey: string
}): Promise<{ ndk: NDK; signer: NDKPrivateKeySigner; rumor: NDKEvent }> {
  const signer = new NDKPrivateKeySigner(nip19.nsecEncode(randomBytes(32)))
  const ndk = new NDK()
  ndk.signer = signer
  const rumor = new NDKEvent(ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(NOW / 1000)
  rumor.pubkey = input.senderPubkey
  rumor.tags = [
    ["p", input.recipientPubkey],
    ["type", "order"],
    ["order", "order-1"],
    ["item", PRODUCT_COORDINATE, "1"],
  ]
  rumor.content = JSON.stringify({ id: "order-1" })
  return { ndk, signer, rumor }
}

describe("protected commerce delivery ledger", () => {
  it("creates queued records with normalized relays and full product coordinates", () => {
    const record = createRecord({
      plannedRelayUrls: [
        "merchant.example/",
        "https://merchant.example",
        "not a relay",
        "wss://sender.example",
      ],
    })

    expect(isFullProductCoordinate(PRODUCT_COORDINATE)).toBe(true)
    expect(isFullProductCoordinate("sku-1")).toBe(false)
    expect(record.deliveryState).toBe("queued")
    expect(record.confirmationState).toBe("unconfirmed")
    expect(record.plannedRelayUrls).toEqual([
      "wss://merchant.example",
      "wss://sender.example",
    ])
    expect(record.productCoordinates).toEqual([PRODUCT_COORDINATE])
    expect(record.signedWrapEventKind).toBe(EVENT_KINDS.GIFT_WRAP)
    expect(record.relayOutcomes).toEqual([])
    expect(() => createRecord({ productCoordinates: ["sku-1"] })).toThrow(
      "full 30402"
    )
  })

  it("persists signed wrap records before relay outcomes exist", async () => {
    const writes: StoredProtectedDeliveryRecord[] = []
    __setProtectedDeliveryTestOverrides({
      putRecord: async (record) => {
        writes.push(record)
      },
    })
    const record = createRecord()

    await persistProtectedDeliveryRecord(record)

    expect(writes).toHaveLength(1)
    expect(writes[0]?.signedWrapEventJson).toBe(record.signedWrapEventJson)
    expect(writes[0]?.deliveryState).toBe("queued")
    expect(writes[0]?.relayOutcomes).toEqual([])
  })

  it("does not treat sender self/broadcast ACKs as required recipient delivery", () => {
    const record = createRecord()

    const broadcastOnly = applyProtectedDeliveryPublishResult(
      record,
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example", "wss://sender.example"],
        successfulRelayUrls: ["wss://sender.example"],
        failedRelayUrls: ["wss://merchant.example"],
        relayFailureMessages: {
          "wss://merchant.example": "No acknowledgement before timeout",
        },
      }),
      NOW + 1_000
    )

    expect(broadcastOnly.deliveryState).toBe("partially_delivered")
    expect(broadcastOnly.confirmationState).toBe("unconfirmed")
    expect(broadcastOnly.retryCount).toBe(1)
    expect(broadcastOnly.nextRetryAt).toBeGreaterThan(NOW)

    const requiredDelivered = applyProtectedDeliveryPublishResult(
      broadcastOnly,
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example"],
        successfulRelayUrls: ["wss://merchant.example"],
        failedRelayUrls: [],
      }),
      NOW + 2_000
    )

    expect(requiredDelivered.deliveryState).toBe("delivered_required")
    expect(requiredDelivered.confirmationState).toBe("acked_by_relay")
    expect(requiredDelivered.nextRetryAt).toBeUndefined()
  })

  it("keeps self-copy failure recoverable after required recipient delivery", () => {
    const primary = applyProtectedDeliveryPublishResult(
      createRecord(),
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example"],
        successfulRelayUrls: ["wss://merchant.example"],
        failedRelayUrls: [],
      }),
      NOW + 1_000
    )
    const selfCopy = applyProtectedDeliveryPublishResult(
      createRecord({
        signedWrapEventId: "d".repeat(64),
        signedWrapEventJson: signedWrapEventJson("d".repeat(64)),
        recipientRole: "self_copy",
        recipientPubkey: SENDER,
        requiredRelayUrls: ["wss://sender.example"],
        sourceRationale: ["sender_write_relay"],
      }),
      publishResult({
        primaryRelayUrls: ["wss://sender.example"],
        broadcastRelayUrls: [],
        attemptedRelayUrls: ["wss://sender.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://sender.example"],
        relayFailureMessages: {
          "wss://sender.example": "No acknowledgement before timeout",
        },
      }),
      NOW + 1_000
    )

    const projection = projectProtectedDeliveryBatch([primary, selfCopy])

    expect(projection.overallState).toBe("delivered_required")
    expect(projection.requiredDelivered).toBe(true)
    expect(projection.selfCopyState).toBe("retry_needed")
    expect(projection.selfCopyRetryNeeded).toBe(true)
    expect(projection.retryNeededRecordIds).toContain(selfCopy.id)
  })

  it("returns retryable records without requiring IndexedDB in tests", async () => {
    const retryNeeded = applyProtectedDeliveryPublishResult(
      createRecord(),
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://merchant.example"],
      }),
      NOW - 60_000
    )
    const delivered = applyProtectedDeliveryPublishResult(
      createRecord({
        signedWrapEventId: "c".repeat(64),
        signedWrapEventJson: signedWrapEventJson("c".repeat(64)),
      }),
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example"],
        successfulRelayUrls: ["wss://merchant.example"],
        failedRelayUrls: [],
      }),
      NOW - 60_000
    )
    __setProtectedDeliveryTestOverrides({
      getRecords: async () => [retryNeeded, delivered],
    })

    const records = await getRetryableProtectedDeliveryRecords(NOW)

    expect(records.map((record) => record.id)).toEqual([retryNeeded.id])
  })

  it("keeps diagnostics content-free", () => {
    const record = createRecord({
      signedWrapEventJson: signedWrapEventJson(
        WRAP_ID,
        "lnbc-secret-invoice buyer@example.com 123 Main Street"
      ),
    })
    const failed = applyProtectedDeliveryPublishResult(
      record,
      publishResult({
        attemptedRelayUrls: ["wss://merchant.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://merchant.example"],
        relayFailureMessages: {
          "wss://merchant.example":
            "rejected invoice lnbc-secret-invoice buyer@example.com 123 Main Street",
        },
      }),
      NOW + 1_000
    )

    const diagnostics = JSON.stringify(
      createProtectedDeliveryDiagnostics(failed)
    )

    expect(diagnostics).not.toContain("lnbc-secret-invoice")
    expect(diagnostics).not.toContain("buyer@example.com")
    expect(diagnostics).not.toContain("123 Main Street")
    expect(diagnostics).not.toContain(SENDER)
    expect(diagnostics).not.toContain(RECIPIENT)
    expect(diagnostics).toContain("relay_rejected")
  })

  it("persists primary and self-copy signed wraps before first checkout publish", async () => {
    const buyerSigner = new NDKPrivateKeySigner(
      nip19.nsecEncode(randomBytes(32))
    )
    const buyer = await buyerSigner.user()
    const merchant = await new NDKPrivateKeySigner(
      nip19.nsecEncode(randomBytes(32))
    ).user()
    const { ndk, rumor } = await createSignedOrderRumor({
      senderPubkey: buyer.pubkey,
      recipientPubkey: merchant.pubkey,
    })
    ndk.signer = buyerSigner
    const writes: StoredProtectedDeliveryRecord[] = []
    const queuedCountAtPublish: number[] = []

    __setProtectedDeliveryTestOverrides({
      now: () => NOW,
      putRecord: async (record) => {
        writes.push({
          ...record,
          relayOutcomes: [...record.relayOutcomes],
        })
      },
      planPublishRelays: async (input: PublishWithPlannerInput) =>
        input.recipientPubkeys?.[0] === merchant.pubkey
          ? plan({
              primaryRelayUrls: ["wss://merchant.example"],
              broadcastRelayUrls: ["wss://buyer.example"],
            })
          : plan({ primaryRelayUrls: ["wss://buyer.example"] }),
      publishWithPlanner: async (_event, input) => {
        queuedCountAtPublish.push(
          writes.filter((record) => record.deliveryState === "queued").length
        )
        const relayUrl =
          input.recipientPubkeys?.[0] === merchant.pubkey
            ? "wss://merchant.example"
            : "wss://buyer.example"
        return publishResult({
          primaryRelayUrls: [relayUrl],
          broadcastRelayUrls:
            input.recipientPubkeys?.[0] === merchant.pubkey
              ? ["wss://buyer.example"]
              : [],
          attemptedRelayUrls: [relayUrl],
          successfulRelayUrls: [relayUrl],
          failedRelayUrls: [],
        })
      },
    })

    const result = await deliverProtectedOrderMessage({
      rumor,
      signer: buyerSigner,
      orderId: "order-1",
      senderPubkey: buyer.pubkey,
      recipientPubkey: merchant.pubkey,
      selfCopyPubkey: buyer.pubkey,
      productCoordinates: [PRODUCT_COORDINATE],
      surface: "market_checkout",
      now: NOW,
    })

    expect(queuedCountAtPublish[0]).toBe(2)
    expect(writes[0]?.recipientRole).toBe("primary_recipient")
    expect(writes[1]?.recipientRole).toBe("self_copy")
    expect(JSON.parse(writes[0]?.signedWrapEventJson ?? "{}").kind).toBe(
      EVENT_KINDS.GIFT_WRAP
    )
    expect(result.primaryRecord.deliveryState).toBe("delivered_required")
    expect(result.selfCopyRecord.deliveryState).toBe("delivered_required")
    expect(result.selfCopyError).toBe(null)
  })

  it("returns a retryable self-copy warning without failing merchant delivery", async () => {
    const buyerSigner = new NDKPrivateKeySigner(
      nip19.nsecEncode(randomBytes(32))
    )
    const buyer = await buyerSigner.user()
    const merchant = await new NDKPrivateKeySigner(
      nip19.nsecEncode(randomBytes(32))
    ).user()
    const { rumor } = await createSignedOrderRumor({
      senderPubkey: buyer.pubkey,
      recipientPubkey: merchant.pubkey,
    })
    const writes: StoredProtectedDeliveryRecord[] = []

    __setProtectedDeliveryTestOverrides({
      now: () => NOW,
      putRecord: async (record) => {
        writes.push({
          ...record,
          relayOutcomes: [...record.relayOutcomes],
        })
      },
      planPublishRelays: async (input: PublishWithPlannerInput) =>
        input.recipientPubkeys?.[0] === merchant.pubkey
          ? plan({ primaryRelayUrls: ["wss://merchant.example"] })
          : plan({ primaryRelayUrls: ["wss://buyer.example"] }),
      publishWithPlanner: async (_event, input) => {
        const isMerchant = input.recipientPubkeys?.[0] === merchant.pubkey
        if (!isMerchant) {
          throw new Error("No acknowledgement before timeout")
        }
        return publishResult({
          primaryRelayUrls: ["wss://merchant.example"],
          attemptedRelayUrls: ["wss://merchant.example"],
          successfulRelayUrls: ["wss://merchant.example"],
          failedRelayUrls: [],
        })
      },
    })

    const result = await deliverProtectedOrderMessage({
      rumor,
      signer: buyerSigner,
      orderId: "order-1",
      senderPubkey: buyer.pubkey,
      recipientPubkey: merchant.pubkey,
      selfCopyPubkey: buyer.pubkey,
      productCoordinates: [PRODUCT_COORDINATE],
      now: NOW,
    })

    expect(result.primaryRecord.deliveryState).toBe("delivered_required")
    expect(result.selfCopyRecord.deliveryState).toBe("retry_needed")
    expect(result.selfCopyError).toBe(
      "Protected delivery is saved locally and needs retry."
    )
    expect(
      writes.some(
        (record) =>
          record.recipientRole === "self_copy" &&
          record.deliveryState === "retry_needed"
      )
    ).toBe(true)
  })
})
