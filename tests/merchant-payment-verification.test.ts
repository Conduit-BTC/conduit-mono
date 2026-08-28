import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  advanceMerchantPaymentVerificationIdentity,
  assertMerchantPaymentAuthoritySnapshotCurrent,
  assertMerchantPaymentConversationSnapshotCurrent,
  assertMerchantPaymentVerificationReadsIdle,
  MerchantPaymentAuthoritySnapshotChangedError,
  getMerchantPaymentVerificationFailureRunState,
  getMerchantNwcAddressStatus,
  getMerchantPaymentConversationSnapshotIdentity,
  getMerchantPaymentVerificationCandidates,
  getMerchantPaymentVerificationCandidatesForRead,
  isMerchantPaymentConversationReadComplete,
  isNwcSettlementMatch,
  reconcileMerchantPaymentConversationReadRunState,
  reconcileMerchantPaymentStableSnapshot,
  selectAuthoritativeMerchantProfileLud16,
  verifyMerchantPaymentCandidates,
} from "../apps/merchant/src/lib/merchant-payment-verification"

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

function conversation(
  orderId = "order-1",
  proofInvoice = invoice
): MerchantConversationSummary {
  const order = {
    id: `${orderId}-order`,
    orderId,
    type: "order",
    createdAt,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      id: orderId,
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      items: [],
      subtotal: 100,
      currency: "SATS",
      createdAt,
    },
  } as ParsedOrderMessage
  const proof = {
    id: `${orderId}-proof`,
    orderId,
    type: "payment_proof",
    createdAt: createdAt + 1_000,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      orderId,
      rail: "lightning",
      action: "private_checkout",
      amount: 100,
      amountMsats: 100_000,
      currency: "SATS",
      invoice: proofInvoice,
      preimage: "preimage",
      paymentHash: "payment-hash",
    },
  } as ParsedOrderMessage

  return {
    id: orderId,
    orderId,
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    latestAt: createdAt + 1_000,
    latestType: "payment_proof",
    status: null,
    totalSummary: "100 SATS",
    preview: "Payment proof",
    messageCount: 2,
    messages: [order, proof],
  }
}

function invoiceOnlyConversation(orderId: string): MerchantConversationSummary {
  const base = conversation(orderId)
  const order = base.messages![0]!
  const paymentRequest = {
    id: `${orderId}-invoice`,
    orderId,
    type: "payment_request",
    createdAt: createdAt + 500,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: {
      orderId,
      invoice,
      amount: 100,
      currency: "SATS",
    },
  } as ParsedOrderMessage
  return {
    ...base,
    latestType: "payment_request",
    messageCount: 2,
    messages: [order, paymentRequest],
  }
}

describe("merchant NWC payment verification", () => {
  it("keeps an unchanged complete history stable across a background refresh", () => {
    const firstValue = { data: [conversation()] }
    const identity = getMerchantPaymentConversationSnapshotIdentity(
      firstValue.data
    )
    const first = reconcileMerchantPaymentStableSnapshot({
      current: null,
      boundary: "merchant-a",
      identity,
      value: firstValue,
      fetching: false,
    })
    expect(first).not.toBeNull()

    const fetching = reconcileMerchantPaymentStableSnapshot({
      current: first,
      boundary: "merchant-a",
      identity: null,
      value: null,
      fetching: true,
    })
    expect(fetching).toBe(first)

    const unchangedClone = { data: [structuredClone(conversation())] }
    const refreshed = reconcileMerchantPaymentStableSnapshot({
      current: fetching,
      boundary: "merchant-a",
      identity: getMerchantPaymentConversationSnapshotIdentity(
        unchangedClone.data
      ),
      value: unchangedClone,
      fetching: false,
    })
    expect(refreshed).toBe(first)
    expect(refreshed?.value).toBe(firstValue)
  })

  it("invalidates stable history for changed signed evidence or authority boundaries", () => {
    const firstValue = { data: [conversation()] }
    const first = reconcileMerchantPaymentStableSnapshot({
      current: null,
      boundary: "merchant-a",
      identity: getMerchantPaymentConversationSnapshotIdentity(firstValue.data),
      value: firstValue,
      fetching: false,
    })
    const changedConversation = structuredClone(conversation())
    changedConversation.messages = [
      ...(changedConversation.messages ?? []),
      {
        ...(changedConversation.messages?.[0] ?? {}),
        id: "new-signed-message",
      } as MerchantConversationSummary["messages"] extends
        Array<infer Message> | undefined
        ? Message
        : never,
    ]
    const changedValue = { data: [changedConversation] }
    const changed = reconcileMerchantPaymentStableSnapshot({
      current: first,
      boundary: "merchant-a",
      identity: getMerchantPaymentConversationSnapshotIdentity(
        changedValue.data
      ),
      value: changedValue,
      fetching: false,
    })
    expect(changed).not.toBe(first)

    expect(
      reconcileMerchantPaymentStableSnapshot({
        current: first,
        boundary: "merchant-b",
        identity: null,
        value: null,
        fetching: true,
      })
    ).toBeNull()
    expect(
      reconcileMerchantPaymentStableSnapshot({
        current: first,
        boundary: "merchant-a",
        identity: null,
        value: null,
        fetching: false,
      })
    ).toBeNull()
  })

  it("keeps unchanged profile authority stable during its 60s background refresh", () => {
    const authority = {
      principalPubkey: "merchant-a",
      connectionKey: "wallet-a",
      profileLud16: "merchant@example.com",
    }
    const identity = JSON.stringify(Object.values(authority))
    const first = reconcileMerchantPaymentStableSnapshot({
      current: null,
      boundary: "merchant-a:wallet-a",
      identity,
      value: authority,
      fetching: false,
    })
    const fetching = reconcileMerchantPaymentStableSnapshot({
      current: first,
      boundary: "merchant-a:wallet-a",
      identity: null,
      value: null,
      fetching: true,
    })
    expect(fetching).toBe(first)
    expect(
      reconcileMerchantPaymentStableSnapshot({
        current: fetching,
        boundary: "merchant-a:wallet-a",
        identity,
        value: { ...authority },
        fetching: false,
      })
    ).toBe(first)

    expect(
      reconcileMerchantPaymentStableSnapshot({
        current: first,
        boundary: "merchant-a:wallet-a",
        identity: JSON.stringify([
          authority.principalPubkey,
          authority.connectionKey,
          "rotated@example.com",
        ]),
        value: { ...authority, profileLud16: "rotated@example.com" },
        fetching: false,
      })
    ).not.toBe(first)
  })

  it("uses declared write-route completeness without hiding optional degradation", () => {
    const complete = {
      stale: false,
      degraded: false,
      capped: false,
      inbox: {
        coverage: "complete" as const,
        declarationStale: false,
        declarationEvidenceCurrent: true,
        declaredWritePlan: { coverage: "complete" as const, capped: false },
      },
    }
    expect(isMerchantPaymentConversationReadComplete({ meta: complete })).toBe(
      true
    )
    expect(
      getMerchantPaymentVerificationCandidatesForRead({
        conversations: [conversation()],
        meta: complete,
      })
    ).toHaveLength(1)

    const optionalDiscoveryDegraded = {
      ...complete,
      stale: true,
      degraded: true,
      capped: true,
      inbox: {
        ...complete.inbox,
        coverage: "partial" as const,
        declarationStale: true,
      },
    }
    expect(
      isMerchantPaymentConversationReadComplete({
        meta: optionalDiscoveryDegraded,
      })
    ).toBe(true)
    expect(
      getMerchantPaymentVerificationCandidatesForRead({
        conversations: [conversation()],
        meta: optionalDiscoveryDegraded,
      })
    ).toHaveLength(1)

    for (const input of [
      {
        meta: {
          ...complete,
          inbox: {
            ...complete.inbox,
            declarationEvidenceCurrent: false,
          },
        },
      },
      {
        meta: {
          ...complete,
          decryptFailures: [{ reason: "decrypt_failed" }],
        },
      },
      {
        meta: {
          ...complete,
          inbox: {
            ...complete.inbox,
            declaredWritePlan: {
              coverage: "partial" as const,
              capped: false,
            },
          },
        },
      },
      {
        meta: {
          ...complete,
          inbox: {
            ...complete.inbox,
            declaredWritePlan: {
              coverage: "unavailable" as const,
              capped: false,
            },
          },
        },
      },
      {
        meta: {
          ...complete,
          inbox: {
            ...complete.inbox,
            declaredWritePlan: {
              coverage: "complete" as const,
              capped: true,
            },
          },
        },
      },
      { meta: null },
      { meta: complete, error: new Error("read failed") },
    ]) {
      expect(isMerchantPaymentConversationReadComplete(input)).toBe(false)
      expect(
        getMerchantPaymentVerificationCandidatesForRead({
          conversations: [conversation()],
          ...input,
        })
      ).toEqual([])
    }
  })

  it("does not publish when protected history changes during a wallet lookup", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const expectedSnapshot = {}
    let currentSnapshot: object | null = expectedSnapshot
    let published = 0

    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence: new Set<string>(),
        lookupInvoice: async () => {
          currentSnapshot = null
          return {
            type: "incoming",
            state: "settled",
            invoice,
            paymentHash: "payment-hash",
            amountMsats: 100_000,
            settledAt: 1_700_000_010,
          }
        },
        publishConfirmation: async () => {
          assertMerchantPaymentConversationSnapshotCurrent(
            expectedSnapshot,
            currentSnapshot
          )
          published += 1
        },
      })
    ).rejects.toThrow(/history changed/i)
    expect(published).toBe(0)
  })

  it("does not publish when wallet or profile authority changes during a lookup", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const expectedAuthority = {}
    let currentAuthority: object | null = expectedAuthority
    let published = 0

    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence: new Set<string>(),
        lookupInvoice: async () => {
          currentAuthority = null
          return {
            type: "incoming",
            state: "settled",
            invoice,
            paymentHash: "payment-hash",
            amountMsats: 100_000,
            settledAt: 1_700_000_010,
          }
        },
        publishConfirmation: async () => {
          assertMerchantPaymentAuthoritySnapshotCurrent(
            expectedAuthority,
            currentAuthority
          )
          published += 1
        },
      })
    ).rejects.toThrow(/authority changed/i)
    expect(published).toBe(0)
  })

  it("does not publish when the exact wallet session changes after lookup", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const expectedConnectionUri = "nostr+walletconnect://wallet-a"
    let currentConnectionUri = expectedConnectionUri
    let authorityChecks = 0
    let published = 0

    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence: new Set<string>(),
        assertAuthorityCurrent: () => {
          if (currentConnectionUri !== expectedConnectionUri) {
            throw new MerchantPaymentAuthoritySnapshotChangedError()
          }
          authorityChecks += 1
          if (authorityChecks === 2) {
            currentConnectionUri = "nostr+walletconnect://wallet-b"
          }
        },
        lookupInvoice: async () => ({
          type: "incoming",
          state: "settled",
          invoice,
          paymentHash: "payment-hash",
          amountMsats: 100_000,
          settledAt: 1_700_000_010,
        }),
        publishConfirmation: async () => {
          published += 1
        },
      })
    ).rejects.toThrow(/authority changed/i)
    expect(authorityChecks).toBe(2)
    expect(published).toBe(0)
  })

  it("does not publish when a protected-history or wallet-authority refresh starts after lookup", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!

    for (const refreshed of ["conversation", "profile", "info"] as const) {
      let checks = 0
      let refreshStarted = false
      let published = 0

      await expect(
        verifyMerchantPaymentCandidates({
          candidates: [candidate],
          confirmedEvidence: new Set<string>(),
          assertAuthorityCurrent: () => {
            checks += 1
            assertMerchantPaymentVerificationReadsIdle({
              conversation:
                refreshed === "conversation" && refreshStarted
                  ? "fetching"
                  : "idle",
              profile:
                refreshed === "profile" && refreshStarted ? "fetching" : "idle",
              info:
                refreshed === "info" && refreshStarted ? "fetching" : "idle",
            })
            if (checks === 2) refreshStarted = true
          },
          lookupInvoice: async () => ({
            type: "incoming",
            state: "settled",
            invoice,
            paymentHash: "payment-hash",
            amountMsats: 100_000,
            settledAt: 1_700_000_010,
          }),
          publishConfirmation: async () => {
            published += 1
          },
        })
      ).rejects.toThrow(
        refreshed === "conversation" ? /history changed/i : /authority changed/i
      )
      expect(checks).toBe(3)
      expect(published).toBe(0)
    }
  })

  it("allows idle verification dependencies at a publish boundary", () => {
    expect(() =>
      assertMerchantPaymentVerificationReadsIdle({
        conversation: "idle",
        profile: "idle",
        info: undefined,
      })
    ).not.toThrow()
  })

  it("fails closed while a verification dependency refresh is paused", () => {
    expect(() =>
      assertMerchantPaymentVerificationReadsIdle({ conversation: "paused" })
    ).toThrow(/history changed/i)
    expect(() =>
      assertMerchantPaymentVerificationReadsIdle({ profile: "paused" })
    ).toThrow(/authority changed/i)
    expect(() =>
      assertMerchantPaymentVerificationReadsIdle({ info: "paused" })
    ).toThrow(/authority changed/i)
  })

  it("stops the lookup batch when payment authority invalidates", async () => {
    const first = getMerchantPaymentVerificationCandidates([conversation()])[0]!
    const second = {
      ...first,
      orderId: "order-2",
      evidenceMessageId: "order-2-proof",
    }
    const expectedAuthority = {}
    let currentAuthority: object | null = expectedAuthority
    let lookups = 0

    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [first, second],
        confirmedEvidence: new Set<string>(),
        lookupInvoice: async () => {
          lookups += 1
          assertMerchantPaymentAuthoritySnapshotCurrent(
            expectedAuthority,
            currentAuthority
          )
          currentAuthority = null
          assertMerchantPaymentAuthoritySnapshotCurrent(
            expectedAuthority,
            currentAuthority
          )
          throw new Error("unreachable")
        },
        publishConfirmation: async () => {
          throw new Error("Invalidated authority must not publish.")
        },
      })
    ).rejects.toThrow(/authority changed/i)
    expect(lookups).toBe(1)
  })

  it("does not let a pending lookup overwrite an invalidated history state", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const expectedSnapshot = {}
    let currentSnapshot: object | null = expectedSnapshot

    const result = await verifyMerchantPaymentCandidates({
      candidates: [candidate],
      confirmedEvidence: new Set<string>(),
      lookupInvoice: async () => {
        currentSnapshot = null
        return {
          type: "incoming",
          state: "pending",
          invoice,
          paymentHash: "payment-hash",
          amountMsats: 100_000,
        }
      },
      publishConfirmation: async () => {
        throw new Error("A pending lookup must not publish.")
      },
    })
    expect(result).toMatchObject({ checked: 1, verified: 0 })

    let invalidation: unknown
    try {
      assertMerchantPaymentConversationSnapshotCurrent(
        expectedSnapshot,
        currentSnapshot
      )
    } catch (error) {
      invalidation = error
    }
    expect(
      getMerchantPaymentVerificationFailureRunState({
        error: invalidation,
        checked: 0,
        verified: 0,
      })
    ).toMatchObject({
      status: "error",
      blocker: "conversation_read",
    })
  })

  it("does not retain a read error across disabled, fetching, and recovered-empty states", () => {
    const idle = { status: "idle" as const, checked: 0, verified: 0 }
    expect(
      reconcileMerchantPaymentConversationReadRunState({
        current: idle,
        eligible: false,
        fetching: false,
        unavailable: true,
        capped: false,
      })
    ).toBe(idle)

    const blocked = reconcileMerchantPaymentConversationReadRunState({
      current: idle,
      eligible: true,
      fetching: false,
      unavailable: true,
      capped: false,
    })
    expect(blocked).toMatchObject({
      status: "error",
      blocker: "conversation_read",
    })
    expect(
      reconcileMerchantPaymentConversationReadRunState({
        current: blocked,
        eligible: true,
        fetching: true,
        unavailable: true,
        capped: false,
      })
    ).toBe(blocked)
    expect(
      reconcileMerchantPaymentConversationReadRunState({
        current: blocked,
        eligible: true,
        fetching: false,
        unavailable: false,
        capped: false,
      })
    ).toEqual({ status: "idle", checked: 0, verified: 0 })
  })

  it("clears a snapshot-invalidation error after complete history recovers empty", () => {
    let invalidation: unknown
    try {
      assertMerchantPaymentConversationSnapshotCurrent({}, null)
    } catch (error) {
      invalidation = error
    }

    const blocked = getMerchantPaymentVerificationFailureRunState({
      error: invalidation,
      checked: 1,
      verified: 0,
    })
    expect(blocked).toMatchObject({
      status: "error",
      checked: 1,
      blocker: "conversation_read",
    })
    expect(
      reconcileMerchantPaymentConversationReadRunState({
        current: blocked,
        eligible: true,
        fetching: false,
        unavailable: false,
        capped: false,
      })
    ).toEqual({ status: "idle", checked: 0, verified: 0 })
  })

  it("returns to idle when payment authority changes during verification", () => {
    let invalidation: unknown
    try {
      assertMerchantPaymentAuthoritySnapshotCurrent({}, null)
    } catch (error) {
      invalidation = error
    }

    expect(
      getMerchantPaymentVerificationFailureRunState({
        error: invalidation,
        checked: 1,
        verified: 0,
      })
    ).toEqual({ status: "idle", checked: 0, verified: 0 })
  })

  it("retries pending evidence and suppresses a published confirmation", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const confirmedEvidence = new Set<string>()
    let settled = false
    let published = 0
    const lookupInvoice = async () => ({
      type: "incoming" as const,
      state: settled ? ("settled" as const) : ("pending" as const),
      invoice,
      paymentHash: "payment-hash",
      amountMsats: 100_000,
      settledAt: 1_700_000_010,
    })
    const publishConfirmation = async () => {
      published += 1
    }

    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 0, lookupFailures: 0 })
    settled = true
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 1, lookupFailures: 0 })
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 0, verified: 0, lookupFailures: 0 })
    expect(published).toBe(1)
  })

  it("retries lookup and publication failures", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const confirmedEvidence = new Set<string>()
    let lookupFails = true
    let publishFails = true
    const lookupInvoice = async () => {
      if (lookupFails) throw new Error("wallet unavailable")
      return {
        type: "incoming" as const,
        state: "settled" as const,
        invoice,
        paymentHash: "payment-hash",
        amountMsats: 100_000,
        settledAt: 1_700_000_010,
      }
    }
    const publishConfirmation = async () => {
      if (publishFails) throw new Error("signer unavailable")
    }

    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 0, verified: 0, lookupFailures: 1 })
    lookupFails = false
    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).rejects.toThrow("signer unavailable")
    publishFails = false
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 1, lookupFailures: 0 })
  })

  it("reports an earlier confirmation when a later publication fails", async () => {
    const first = getMerchantPaymentVerificationCandidates([
      conversation("order-1"),
    ])[0]!
    const second = {
      ...getMerchantPaymentVerificationCandidates([
        conversation("order-2"),
      ])[0]!,
      paymentHash: "second-payment-hash",
    }
    const confirmedEvidence = new Set<string>()
    let confirmed = 0
    let publishCount = 0

    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [first, second],
        confirmedEvidence,
        lookupInvoice: async (candidate) => ({
          type: "incoming",
          state: "settled",
          invoice: candidate.invoice,
          paymentHash: candidate.paymentHash ?? "payment-hash",
          amountMsats: candidate.expectedAmountMsats,
          settledAt: 1_700_000_010,
        }),
        publishConfirmation: async () => {
          publishCount += 1
          if (publishCount === 2) throw new Error("second publish failed")
        },
        onConfirmed: () => {
          confirmed += 1
        },
      })
    ).rejects.toThrow("second publish failed")
    expect(confirmed).toBe(1)
    expect(confirmedEvidence.size).toBe(1)
  })

  it("requires exact order invoices and rejects replay across orders", () => {
    expect(getMerchantPaymentVerificationCandidates([conversation()])).toEqual([
      expect.objectContaining({
        orderId: "order-1",
        invoice,
        expectedAmountMsats: 100_000,
      }),
    ])

    expect(
      getMerchantPaymentVerificationCandidates([
        conversation("order-1"),
        conversation("order-2"),
      ])
    ).toEqual([])
    expect(
      getMerchantPaymentVerificationCandidates([
        conversation("order-1"),
        invoiceOnlyConversation("order-2"),
      ])
    ).toEqual([])
  })

  it("only accepts incoming, settled, exact, timely wallet results", () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const settlement = {
      type: "incoming" as const,
      state: "settled" as const,
      invoice,
      paymentHash: "payment-hash",
      amountMsats: 100_000,
      settledAt: 1_700_000_010,
    }

    expect(
      isNwcSettlementMatch(candidate, settlement, createdAt + 20_000)
    ).toBe(true)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, type: "outgoing" },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, state: "pending" },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, amountMsats: 99_000 },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, paymentHash: "other-hash" },
        createdAt + 20_000
      )
    ).toBe(false)
  })

  it("blocks explicit address mismatches without trusting an address claim", () => {
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "Merchant@Example.com",
        connectionLud16: "merchant@example.com",
        walletLud16: undefined,
      })
    ).toBe("match")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: "merchant@example.com",
        walletLud16: "",
      })
    ).toBe("match")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: "other@example.com",
        walletLud16: undefined,
      })
    ).toBe("mismatch")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: undefined,
        walletLud16: "merchant@example.com",
      })
    ).toBe("unconfirmed")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: undefined,
        walletLud16: undefined,
      })
    ).toBe("unconfirmed")
  })

  it("exposes a profile payment destination only from confirmed current authority", () => {
    const confirmed = {
      lud16: "Merchant@Example.com",
      frontierConfirmed: true,
      degraded: false,
      capped: false,
      isFetching: false,
      hasError: false,
    }
    expect(selectAuthoritativeMerchantProfileLud16(confirmed)).toBe(
      "merchant@example.com"
    )

    for (const unavailable of [
      { ...confirmed, lud16: null },
      { ...confirmed, frontierConfirmed: false },
      { ...confirmed, degraded: true },
      { ...confirmed, capped: true },
      { ...confirmed, isFetching: true },
      { ...confirmed, hasError: true },
    ]) {
      expect(selectAuthoritativeMerchantProfileLud16(unavailable)).toBeNull()
    }
  })

  it("does not rearm confirmed publication during a background profile refetch", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const confirmedEvidence = new Set<string>()
    let published = 0
    const verify = () =>
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice: async () => ({
          type: "incoming",
          state: "settled",
          invoice,
          paymentHash: "payment-hash",
          amountMsats: 100_000,
          settledAt: 1_700_000_010,
        }),
        publishConfirmation: async () => {
          published += 1
        },
      })
    const initial = advanceMerchantPaymentVerificationIdentity(null, {
      principalPubkey: "merchant",
      connectionKey: "wallet-a",
      confirmedDestination: "merchant@example.com",
    })
    expect(await verify()).toEqual({
      checked: 1,
      verified: 1,
      lookupFailures: 0,
    })

    const fetching = advanceMerchantPaymentVerificationIdentity(
      initial.identity,
      {
        principalPubkey: "merchant",
        connectionKey: "wallet-a",
        confirmedDestination: undefined,
      }
    )
    const refreshed = advanceMerchantPaymentVerificationIdentity(
      fetching.identity,
      {
        principalPubkey: "merchant",
        connectionKey: "wallet-a",
        confirmedDestination: "merchant@example.com",
      }
    )

    expect(fetching.resetEvidence).toBe(false)
    expect(fetching.identity).toEqual(initial.identity)
    expect(refreshed.resetEvidence).toBe(false)
    if (fetching.resetEvidence || refreshed.resetEvidence) {
      confirmedEvidence.clear()
    }
    expect(await verify()).toEqual({
      checked: 0,
      verified: 0,
      lookupFailures: 0,
    })
    expect(published).toBe(1)

    expect(
      advanceMerchantPaymentVerificationIdentity(refreshed.identity, {
        principalPubkey: "merchant",
        connectionKey: "wallet-a",
        confirmedDestination: "new-destination@example.com",
      }).resetEvidence
    ).toBe(true)
    expect(
      advanceMerchantPaymentVerificationIdentity(refreshed.identity, {
        principalPubkey: "merchant",
        connectionKey: "wallet-b",
        confirmedDestination: undefined,
      }).resetEvidence
    ).toBe(true)
    expect(
      advanceMerchantPaymentVerificationIdentity(refreshed.identity, {
        principalPubkey: "other-merchant",
        connectionKey: "wallet-a",
        confirmedDestination: undefined,
      }).resetEvidence
    ).toBe(true)
  })
})

function minimalBolt11Invoice(hrp: string): string {
  const words = [0, 0, 0, 0, 0, 0, 1]
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  const checksum = Array.from(
    { length: 6 },
    (_, index) => (polymod >> (5 * (5 - index))) & 31
  )
  return `${hrp}1${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

function hrpExpand(hrp: string): number[] {
  return [
    ...Array.from(hrp, (char) => char.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (char) => char.charCodeAt(0) & 31),
  ]
}

function bech32Polymod(values: number[]): number {
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) checksum ^= BECH32_GENERATORS[index]!
    }
  }
  return checksum
}

const invoice = minimalBolt11Invoice("lnbc1000n")
const createdAt = 1_700_000_000_000
