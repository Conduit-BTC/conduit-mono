import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetProtectedDeliveryTestOverrides,
  __setProtectedDeliveryTestOverrides,
  applyProtectedDeliveryPublishResult,
  createProtectedDeliveryDiagnostics,
  createProtectedDeliveryRecord,
  EVENT_KINDS,
  getRetryableProtectedDeliveryRecords,
  isFullProductCoordinate,
  persistProtectedDeliveryRecord,
  projectProtectedDeliveryBatch,
  type CreateProtectedDeliveryRecordInput,
  type PublishWithPlannerResult,
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
})
