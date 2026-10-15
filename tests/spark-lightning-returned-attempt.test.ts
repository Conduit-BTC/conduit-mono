import { describe, expect, it } from "bun:test"
import * as returnedAttempt from "@conduit/core/protocol/spark-lightning-returned-attempt"
import {
  inspectSparkCheckoutLightningReturnedAttempt,
  type SparkCheckoutLightningReturnedReader,
} from "@conduit/core/protocol/spark-lightning-returned-attempt"
import {
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const transferId = "0197f9a0-0000-7000-8000-000000000001"
const requestId = "test-lightning-send"
const identity =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const providerIdentity = "03" + identity.slice(2)
const paymentHash = "66".repeat(32)
const paymentRequest = makeBolt11Fixture({
  hrp: "lnbc10000n",
  fields: [bolt11PaymentHashField(new Uint8Array(32).fill(0x66))],
})
const input = {
  network: "mainnet" as const,
  transferId,
  paymentRequest,
  paymentHash,
  amountSats: 1_000,
  maxFeeSats: 4,
  receiverIdentityPublicKey: identity,
  minimumAvailableSats: 1_111,
}
const closedInput = {
  network: input.network,
  transferId: input.transferId,
  paymentRequest: input.paymentRequest,
  paymentHash: input.paymentHash,
  amountSats: input.amountSats,
  maxFeeSats: input.maxFeeSats,
  receiverIdentityPublicKey: input.receiverIdentityPublicKey,
}

function returnedFixture() {
  const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))
  const leaf = {
    id: "returned-leaf",
    value: 1_003,
    network: 1,
    ownerIdentityPublicKey: bytes(identity),
    status: "AVAILABLE",
    treenodeStatus: 1,
  }
  const request = {
    typename: "LightningSendRequest",
    id: requestId,
    encodedInvoice: paymentRequest,
    idempotencyKey: transferId,
    network: "MAINNET",
    status: "USER_SWAP_RETURNED",
    fee: { originalValue: 3, originalUnit: "SATOSHI" },
    transfer: {
      sparkId: transferId,
      totalAmount: { originalValue: 1_003, originalUnit: "SATOSHI" },
    },
  }
  const htlc = {
    paymentHash: bytes(paymentHash),
    senderIdentityPubkey: bytes(identity),
    receiverIdentityPubkey: bytes(providerIdentity),
    status: 2,
    transfer: {
      id: transferId,
      network: 1,
      status: 7,
      type: 0,
      senders: [{ id: "sender", identityPublicKey: bytes(identity) }],
      receivers: [
        {
          id: "receiver",
          identityPublicKey: bytes(providerIdentity),
          amountSats: 1_003,
          status: 7,
        },
      ],
      leaves: [
        { leaf, transferSenderId: "sender", transferReceiverId: "receiver" },
      ],
    },
  }
  const leaves = [
    leaf,
    { ...leaf, id: "protected-other-allocation", value: 108 },
  ]
  const reader: SparkCheckoutLightningReturnedReader = {
    async getIdentityPublicKey() {
      return identity
    },
    async getTransferFromSsp() {
      return { ...request.transfer, userRequest: request }
    },
    async getLightningSendRequest() {
      return request
    },
    async queryHTLC() {
      return { preimageRequests: [htlc], offset: -1 }
    },
    async getLeaves() {
      return leaves
    },
  }
  return { reader, request, htlc, leaves }
}

describe("exact returned Lightning attempt inspection", () => {
  it("attests closed returned history after successor spending without making spendable proof", async () => {
    const { reader } = returnedFixture()
    reader.getLeaves = async () => {
      throw new Error("Retirement must not recover or inspect spendable leaves")
    }
    const result =
      await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
        reader,
        closedInput,
        { now: () => 1_900_000_000_000 }
      )
    expect(result.status).toBe("closed_returned")
    if (result.status !== "closed_returned")
      throw new Error("Expected exact closure")
    expect(result.evidence.transferId).toBe(transferId)
    expect(result.evidence.debitedSats).toBe(1_003)
    expect(result.evidence.returnedSats).toBe(1_003)
    expect(Object.hasOwn(result.evidence, "availableSats")).toBe(false)
    expect(Object.hasOwn(result.evidence, "availableLeaves")).toBe(false)
    reader.getLeaves = async () => []
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(reader, input)
    ).toEqual({ status: "not_closed" })
  })

  it("provides full-refund evidence only for the exact closed attempt and available original leaves", async () => {
    const { reader } = returnedFixture()
    const result = await inspectSparkCheckoutLightningReturnedAttempt(
      reader,
      input,
      { now: () => 1_900_000_000_000 }
    )
    expect(result).toEqual({
      status: "returned",
      evidence: {
        network: "mainnet",
        walletIdentityPublicKey: identity,
        transferId,
        requestId,
        paymentRequest,
        paymentHash,
        invoiceAmountSats: 1_000,
        maxFeeSats: 4,
        debitedSats: 1_003,
        returnedSats: 1_003,
        availableSats: 1_111,
        sspStatus: "USER_SWAP_RETURNED",
        operatorStatus: "RETURNED",
        htlcStatus: "RETURNED",
        preimage: null,
        returnedLeaves: [{ id: "returned-leaf", valueSats: 1_003 }],
        availableLeaves: [
          { id: "returned-leaf", valueSats: 1_003 },
          { id: "protected-other-allocation", valueSats: 108 },
        ],
        observedAt: 1_900_000_000_000,
      },
    })
  })

  it("rejects a provider request for a different exact attempt without leaking identifiers", async () => {
    const { reader, request } = returnedFixture()
    request.idempotencyKey = "0197f9a0-0000-7000-8000-000000000002"
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(reader, input)
    ).toEqual({ status: "conflicting" })
  })

  it("does not call a completed operator transfer a returned unpaid attempt", async () => {
    const { reader, htlc } = returnedFixture()
    htlc.transfer.status = 5
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(reader, input)
    ).toEqual({ status: "conflicting" })
  })

  it("rejects malformed HTLC preimage fields instead of treating them as absence", async () => {
    const { reader, htlc } = returnedFixture()
    reader.queryHTLC = async () => ({
      preimageRequests: [{ ...htlc, preimage: "" }],
      offset: -1,
    })
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(reader, input)
    ).toEqual({ status: "conflicting" })
  })

  it("bounds a stalled authenticated provider read without returning partial proof", async () => {
    const { reader } = returnedFixture()
    reader.queryHTLC = () => new Promise(() => {})
    const result = await Promise.race([
      inspectSparkCheckoutLightningReturnedAttempt(reader, input, {
        readTimeoutMs: 5,
      }),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "test_deadline" }), 100)
      ),
    ])
    expect(result).toEqual({ status: "unavailable" })
  })

  const conflictingCases: [
    string,
    (fixture: ReturnType<typeof returnedFixture>) => void,
  ][] = [
    [
      "fresh SSP request identity differs",
      ({ reader, request }) => {
        reader.getLightningSendRequest = async () => ({
          ...request,
          id: "different-request",
        })
      },
    ],
    [
      "SSP network differs",
      ({ request }) => {
        request.network = "REGTEST"
      },
    ],
    [
      "SSP reports successful payment",
      ({ request }) => {
        request.status = "LIGHTNING_PAYMENT_SUCCEEDED"
      },
    ],
    [
      "SSP contains any preimage",
      ({ reader, request }) => {
        reader.getLightningSendRequest = async () => ({
          ...request,
          paymentPreimage: "provider-private-value",
        })
      },
    ],
    [
      "HTLC payment hash differs",
      ({ htlc }) => {
        htlc.paymentHash = new Uint8Array(32)
      },
    ],
    [
      "HTLC sender differs",
      ({ htlc }) => {
        htlc.senderIdentityPubkey = new Uint8Array(33)
      },
    ],
    [
      "HTLC contains any preimage",
      ({ reader, htlc }) => {
        reader.queryHTLC = async () => ({
          preimageRequests: [{ ...htlc, preimage: new Uint8Array(32) }],
          offset: -1,
        })
      },
    ],
    [
      "more than one exact HTLC row",
      ({ reader, htlc }) => {
        reader.queryHTLC = async () => ({
          preimageRequests: [htlc, htlc],
          offset: -1,
        })
      },
    ],
    [
      "operator transfer identity differs",
      ({ htlc }) => {
        htlc.transfer.id = "different-transfer"
      },
    ],
    [
      "operator network differs",
      ({ htlc }) => {
        htlc.transfer.network = 2
      },
    ],
    [
      "operator type is not preimage swap",
      ({ htlc }) => {
        htlc.transfer.type = 2
      },
    ],
    [
      "operator sender edge differs",
      ({ htlc }) => {
        htlc.transfer.senders[0]!.identityPublicKey = new Uint8Array(33)
      },
    ],
    [
      "operator receiver completed",
      ({ htlc }) => {
        htlc.transfer.receivers[0]!.status = 6
      },
    ],
    [
      "return leaf not assigned to exact sender",
      ({ htlc }) => {
        htlc.transfer.leaves[0]!.transferSenderId = "different-sender"
      },
    ],
    [
      "duplicate returned leaf IDs",
      ({ htlc }) => {
        htlc.transfer.leaves.push(htlc.transfer.leaves[0]!)
      },
    ],
    [
      "returned value does not cover exact debit",
      ({ htlc }) => {
        htlc.transfer.leaves[0]!.leaf.value = 1_002
      },
    ],
    [
      "available leaf belongs to another wallet",
      ({ leaves }) => {
        leaves[0]!.ownerIdentityPublicKey = new Uint8Array(33)
      },
    ],
    [
      "duplicate available leaf IDs",
      ({ leaves }) => {
        leaves.push(leaves[0]!)
      },
    ],
  ]
  for (const [name, modify] of conflictingCases) {
    it(`rejects conflicting evidence: ${name}`, async () => {
      const fixture = returnedFixture()
      modify(fixture)
      expect(
        await inspectSparkCheckoutLightningReturnedAttempt(
          fixture.reader,
          input
        )
      ).toEqual({ status: "conflicting" })
    })
    if (name !== "duplicate available leaf IDs") {
      it(`rejects conflicting terminal history without reading available leaves: ${name}`, async () => {
        const fixture = returnedFixture()
        modify(fixture)
        delete fixture.reader.getLeaves
        expect(
          await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
            fixture.reader,
            closedInput
          )
        ).toEqual({ status: "conflicting" })
      })
    }
  }

  const notClosedCases: [
    string,
    (fixture: ReturnType<typeof returnedFixture>) => void,
  ][] = [
    [
      "SSP coarse failure",
      ({ request }) => {
        request.status = "TRANSFER_FAILED"
      },
    ],
    [
      "SSP failed return",
      ({ request }) => {
        request.status = "USER_SWAP_RETURN_FAILED"
      },
    ],
    [
      "SSP still returning",
      ({ request }) => {
        request.status = "PENDING_USER_SWAP_RETURN"
      },
    ],
    [
      "operator transfer still active",
      ({ htlc }) => {
        htlc.transfer.status = 1
      },
    ],
    [
      "HTLC still active",
      ({ htlc }) => {
        htlc.status = 0
      },
    ],
    [
      "operator receiver still active",
      ({ htlc }) => {
        htlc.transfer.receivers[0]!.status = 1
      },
    ],
    [
      "returned original leaf is missing",
      ({ leaves }) => {
        leaves[0] = { ...leaves[0]!, id: "different-leaf-with-same-value" }
      },
    ],
    [
      "original return leaf is locked",
      ({ leaves }) => {
        leaves[0] = {
          ...leaves[0]!,
          status: "TRANSFER_LOCKED",
          treenodeStatus: 3,
        }
      },
    ],
    [
      "protected unpaid budget is not available",
      ({ leaves }) => {
        leaves.pop()
      },
    ],
  ]
  for (const [name, modify] of notClosedCases) {
    it(`keeps an incomplete return ineligible: ${name}`, async () => {
      const fixture = returnedFixture()
      modify(fixture)
      expect(
        await inspectSparkCheckoutLightningReturnedAttempt(
          fixture.reader,
          input
        )
      ).toEqual({ status: "not_closed" })
    })
    if (
      name.startsWith("SSP ") ||
      name.startsWith("operator ") ||
      name.startsWith("HTLC ")
    ) {
      it(`keeps unfinished terminal history ineligible: ${name}`, async () => {
        const fixture = returnedFixture()
        modify(fixture)
        delete fixture.reader.getLeaves
        expect(
          await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
            fixture.reader,
            closedInput
          )
        ).toEqual({ status: "not_closed" })
      })
    }
  }

  it("bounds terminal history reads and redacts a revoked session without requesting leaves", async () => {
    const { reader } = returnedFixture()
    delete reader.getLeaves
    reader.queryHTLC = () => new Promise(() => {})
    expect(
      await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
        reader,
        closedInput,
        { readTimeoutMs: 5 }
      )
    ).toEqual({ status: "unavailable" })
    expect(
      await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
        reader,
        closedInput,
        {
          assertCurrent: () => {
            throw new Error("Private session details")
          },
        }
      )
    ).toEqual({ status: "unavailable" })
  })

  it("accepts exact EXPIRED return history with documented compatibility SSP status and no leaf availability capability", async () => {
    const { reader, request, htlc } = returnedFixture()
    delete reader.getLeaves
    request.status = "LIGHTNING_PAYMENT_FAILED"
    htlc.transfer.status = 6
    expect(
      (
        await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
          reader,
          closedInput
        )
      ).status
    ).toBe("closed_returned")
    htlc.transfer.status = 5
    expect(
      await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
        reader,
        closedInput
      )
    ).toEqual({ status: "conflicting" })
    reader.getTransferFromSsp = async () => undefined
    expect(
      await returnedAttempt.inspectSparkCheckoutLightningClosedReturnedAttempt(
        reader,
        closedInput
      )
    ).toEqual({ status: "unavailable" })
  })

  it("accepts the documented compatibility failed status only with full positive operator/HTLC return", async () => {
    const { reader, request, htlc } = returnedFixture()
    request.status = "LIGHTNING_PAYMENT_FAILED"
    htlc.transfer.status = 6
    const result = await inspectSparkCheckoutLightningReturnedAttempt(
      reader,
      input
    )
    expect(result.status).toBe("returned")
    if (result.status === "returned")
      expect(result.evidence.operatorStatus).toBe("EXPIRED")
  })

  it("does not promote absence or incomplete HTLC coverage into closure", async () => {
    const fixture = returnedFixture()
    fixture.reader.getTransferFromSsp = async () => undefined
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(fixture.reader, input)
    ).toEqual({ status: "unavailable" })
    const paged = returnedFixture()
    paged.reader.queryHTLC = async () => ({
      preimageRequests: [paged.htlc],
      offset: 1,
    })
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(paged.reader, input)
    ).toEqual({ status: "unavailable" })
  })

  it("redacts all provider exception details", async () => {
    const { reader } = returnedFixture()
    reader.getLeaves = async () => {
      throw new Error(`private-provider-data ${paymentRequest} ${identity}`)
    }
    const result = await inspectSparkCheckoutLightningReturnedAttempt(
      reader,
      input
    )
    expect(result).toEqual({ status: "unavailable" })
    expect(JSON.stringify(result)).not.toContain("private-provider-data")
  })

  it("stops proof collection when the authorized wallet session is no longer current", async () => {
    const { reader } = returnedFixture()
    let current = true
    reader.getLeaves = async () => {
      current = false
      return returnedFixture().leaves
    }
    expect(
      await inspectSparkCheckoutLightningReturnedAttempt(reader, input, {
        assertCurrent() {
          if (!current) throw new Error("private-session-details")
        },
      })
    ).toEqual({ status: "unavailable" })
  })
})
