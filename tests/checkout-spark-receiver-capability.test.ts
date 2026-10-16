import { createHash } from "node:crypto"
import { describe, expect, it, spyOn } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import {
  createCheckoutSparkReceiverBinding,
  getCheckoutSparkReceiverContracts,
  observeCheckoutSparkReceiverCapability,
  parseCheckoutSparkReceiverContracts,
} from "../packages/core/src/protocol/checkout-spark-receiver-capability"
import { verifyCheckoutSparkReceiverInvoice } from "../packages/core/src/protocol/checkout-spark-receiver-verification"
import {
  encodeLnurl,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
} from "../packages/core/src/protocol/lightning"
import { resolveCheckoutSparkLnurlInvoice } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000
const ADDRESS = "merchant@receiver.conduit.cash"
const ORIGIN = "https://receiver.conduit.cash"
const METADATA = JSON.stringify([
  ["text/plain", "Synthetic receiver"],
  ["text/identifier", ADDRESS],
])
const PREIMAGE = "19".repeat(32)
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex")
const CONTRACTS = parseCheckoutSparkReceiverContracts([
  {
    schemaVersion: 1,
    contractId: "synthetic-qualified-private-v1",
    qualification: "accepted",
    payRequestOrigins: [ORIGIN],
    callbackOrigins: [ORIGIN],
    verifyOrigins: [ORIGIN],
    verifyPathPrefix: "/lnurlp/verify/",
    modes: ["private"],
    binding: "metadata_hash",
  },
])

function metadata(raw = METADATA) {
  const payRequestUrl = `${ORIGIN}/.well-known/lnurlp/merchant`
  return {
    payRequestUrl,
    lnurl: encodeLnurl(payRequestUrl),
    callback: `${ORIGIN}/lnurlp/merchant`,
    minSendable: 1_000,
    maxSendable: 10_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: raw,
  }
}

function invoice(description = METADATA, createdAt = NOW) {
  return makeSignedBolt11Fixture({
    hrp: "lnbc10000n",
    createdAt,
    fields: [
      bolt11PaymentHashField(Buffer.from(PAYMENT_HASH, "hex")),
      bolt11PaymentSecretField(),
      bolt11DescriptionHashField(description),
    ],
  })
}

describe("qualified receiver capability", () => {
  it("proves a normal private invoice's origin and settlement on a fresh reader", async () => {
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    expect(observed.status).toBe("supported")
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const paymentRequest = invoice()
    let requests = 0
    const result = await verifyCheckoutSparkReceiverInvoice(
      {
        binding: JSON.parse(JSON.stringify(binding)),
        paymentRequest,
        paymentHash: PAYMENT_HASH,
        amountSats: 1_000,
        network: "mainnet",
        assertCurrent: () => undefined,
      },
      {
        contracts: CONTRACTS,
        fetchMetadata: async () => metadata(),
        fetchVerify: async (url, options) => {
          requests += 1
          expect(url === binding.verifyUrl).toBe(true)
          expect(options.signal.aborted).toBe(false)
          return {
            status: "OK",
            settled: true,
            preimage: PREIMAGE,
            pr: paymentRequest,
          }
        },
      }
    )
    expect(result.status).toBe("verified")
    expect(result.status === "verified" && result.settled).toBe(true)
    expect(requests).toBe(1)
  })

  it("leaves unconfigured and pending deployments unsupported without a metadata request", async () => {
    let requests = 0
    for (const contracts of [
      getCheckoutSparkReceiverContracts(),
      parseCheckoutSparkReceiverContracts([
        { ...CONTRACTS[0], qualification: "pending" },
      ]),
    ]) {
      const result = await observeCheckoutSparkReceiverCapability(
        { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
        {
          contracts,
          fetchMetadata: async () => {
            requests += 1
            return metadata()
          },
        }
      )
      expect(result.status).toBe("unsupported")
    }
    expect(requests).toBe(0)
  })

  it("distinguishes origin proof from an invoice that has not settled yet", async () => {
    const paymentRequest = invoice()
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const result = await verifyCheckoutSparkReceiverInvoice(
      {
        binding,
        paymentRequest,
        paymentHash: PAYMENT_HASH,
        amountSats: 1_000,
        network: "mainnet",
        assertCurrent: () => undefined,
      },
      {
        contracts: CONTRACTS,
        fetchMetadata: async () => metadata(),
        fetchVerify: async () => ({
          status: "OK",
          settled: false,
          preimage: null,
          pr: paymentRequest,
        }),
      }
    )
    expect(result.status === "verified" && result.settled === false).toBe(true)
  })

  it("verifies the saved paid invoice after expiry despite a normal provider description change", async () => {
    const paymentRequest = invoice(METADATA, NOW - 3_601)
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const updated = JSON.stringify([
      ["text/plain", "Updated receiver description"],
      ["text/identifier", ADDRESS],
    ])
    const result = await verifyCheckoutSparkReceiverInvoice(
      {
        binding,
        paymentRequest,
        paymentHash: PAYMENT_HASH,
        amountSats: 1_000,
        network: "mainnet",
        assertCurrent: () => undefined,
      },
      {
        contracts: CONTRACTS,
        fetchMetadata: async () => metadata(updated),
        fetchVerify: async () => ({
          status: "OK",
          settled: true,
          preimage: PREIMAGE,
          pr: paymentRequest,
        }),
      }
    )
    expect(result.status === "verified" && result.settled).toBe(true)
  })

  it("returns unavailable for a normal metadata or verifier outage", async () => {
    const unavailable = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      {
        contracts: CONTRACTS,
        fetchMetadata: async () => {
          throw new Error("Unavailable")
        },
      }
    )
    expect(unavailable.status).toBe("unavailable")
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const result = await verifyCheckoutSparkReceiverInvoice(
      {
        binding,
        paymentRequest: invoice(),
        paymentHash: PAYMENT_HASH,
        amountSats: 1_000,
        network: "mainnet",
        assertCurrent: () => undefined,
      },
      {
        contracts: CONTRACTS,
        fetchMetadata: async () => metadata(),
        fetchVerify: async () => {
          throw new Error("Unavailable")
        },
      }
    )
    expect(result.status).toBe("unavailable")
  })

  it("does not continue a capability or provider observation after session revocation", async () => {
    let current = true
    const assertCurrent = () => {
      if (!current) throw new Error("Session changed")
    }
    await expect(
      observeCheckoutSparkReceiverCapability(
        { lud16: ADDRESS, mode: "private", assertCurrent },
        {
          contracts: CONTRACTS,
          fetchMetadata: async () => {
            current = false
            return metadata()
          },
        }
      )
    ).rejects.toThrow("Session changed")
    current = true
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const paymentRequest = invoice()
    await expect(
      verifyCheckoutSparkReceiverInvoice(
        {
          binding,
          paymentRequest,
          paymentHash: PAYMENT_HASH,
          amountSats: 1_000,
          network: "mainnet",
          assertCurrent,
        },
        {
          contracts: CONTRACTS,
          fetchMetadata: async () => metadata(),
          fetchVerify: async () => {
            current = false
            return {
              status: "OK",
              settled: true,
              preimage: PREIMAGE,
              pr: paymentRequest,
            }
          },
        }
      )
    ).rejects.toThrow("Session changed")
  })

  it("retains callback verify hints and composes qualified unpaid resolution before exposure", async () => {
    const paymentRequest = invoice()
    const verifyUrl = `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`
    let callbackOptionsSafe = false
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      async (_url, options) => {
        callbackOptionsSafe =
          options?.credentials === "omit" &&
          options.cache === "no-store" &&
          options.referrerPolicy === "no-referrer" &&
          options.redirect === "error"
        return new Response(
          JSON.stringify({ pr: paymentRequest, verify: verifyUrl }),
          { headers: { "content-type": "application/json" } }
        )
      }
    )
    try {
      const response = await fetchLnurlInvoice(metadata().callback, 1_000_000)
      expect(
        response.invoice === paymentRequest && response.verifyUrl === verifyUrl
      ).toBe(true)
      expect(callbackOptionsSafe).toBe(true)
    } finally {
      fetchMock.mockRestore()
    }
    let invoices = 0
    let verifies = 0
    const resolved = await resolveCheckoutSparkLnurlInvoice(
      {
        lud16: ADDRESS,
        amountSats: 1_000,
        network: "mainnet",
        nowSeconds: NOW,
        shouldContinue: () => true,
        receiverMode: "private",
      },
      {
        receiverContracts: CONTRACTS,
        fetchMetadata: async () => metadata(),
        fetchInvoice: async () => {
          invoices += 1
          return { invoice: paymentRequest, verifyUrl }
        },
        fetchReceiverVerify: async () => {
          verifies += 1
          return {
            status: "OK",
            settled: false,
            preimage: null,
            pr: paymentRequest,
          }
        },
      }
    )
    expect(
      resolved.paymentRequest === paymentRequest &&
        resolved.receiverBinding?.verifyUrl === verifyUrl
    ).toBe(true)
    expect(invoices).toBe(1)
    expect(verifies).toBe(1)
  })

  it("observes a normal provider's metadata without ambient credentials or referrer", async () => {
    let metadataOptionsSafe = false
    const result = await fetchLnurlPayMetadata(ADDRESS, {
      fetchImpl: (async (_url, options) => {
        metadataOptionsSafe =
          options?.credentials === "omit" &&
          options.cache === "no-store" &&
          options.referrerPolicy === "no-referrer" &&
          options.redirect === "manual"
        return new Response(JSON.stringify(metadata()), {
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch,
    })
    expect(result.metadata === METADATA).toBe(true)
    expect(metadataOptionsSafe).toBe(true)
  })

  it("qualifies public mode separately using a real request and an authoritative account verifier", async () => {
    const signingKey = generateSecretKey()
    const requestJson = JSON.stringify(
      finalizeEvent(
        {
          kind: 9734,
          created_at: NOW,
          content: "",
          tags: [
            ["p", getPublicKey(generateSecretKey())],
            ["amount", "1000000"],
            ["lnurl", metadata().lnurl],
            ["relays", "wss://relay.conduit.cash"],
          ],
        },
        signingKey
      )
    )
    const contracts = parseCheckoutSparkReceiverContracts([
      {
        ...CONTRACTS[0],
        contractId: "synthetic-qualified-public-v1",
        modes: ["public"],
        binding: "verifier_recipient",
      },
    ])
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "public", assertCurrent: () => undefined },
      { contracts, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    const paymentRequest = invoice(requestJson)
    const result = await verifyCheckoutSparkReceiverInvoice(
      {
        binding,
        paymentRequest,
        paymentHash: PAYMENT_HASH,
        amountSats: 1_000,
        network: "mainnet",
        publicRequestJson: requestJson,
        assertCurrent: () => undefined,
      },
      {
        contracts,
        fetchMetadata: async () => metadata(),
        fetchVerify: async () => ({
          status: "OK",
          settled: true,
          preimage: PREIMAGE,
          pr: paymentRequest,
          recipient: ADDRESS,
        }),
      }
    )
    expect(result.status === "verified" && result.settled).toBe(true)
    const unsupported = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "public", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    expect(unsupported.status).toBe("unsupported")
  })

  it("uses credentialless bounded exact verification transport", async () => {
    const paymentRequest = invoice()
    const observed = await observeCheckoutSparkReceiverCapability(
      { lud16: ADDRESS, mode: "private", assertCurrent: () => undefined },
      { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
    )
    if (observed.status !== "supported") throw new Error("Expected support")
    const binding = createCheckoutSparkReceiverBinding(observed.capability, {
      paymentHash: PAYMENT_HASH,
      verifyUrl: `${ORIGIN}/lnurlp/verify/${PAYMENT_HASH}`,
    })
    let optionsSafe = false
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      async (_url, options) => {
        optionsSafe =
          options?.credentials === "omit" &&
          options.redirect === "error" &&
          options.cache === "no-store" &&
          options.referrerPolicy === "no-referrer" &&
          options.signal instanceof AbortSignal
        return new Response(
          JSON.stringify({
            status: "OK",
            settled: true,
            preimage: PREIMAGE,
            pr: paymentRequest,
          }),
          { headers: { "content-type": "application/json" } }
        )
      }
    )
    try {
      const result = await verifyCheckoutSparkReceiverInvoice(
        {
          binding,
          paymentRequest,
          paymentHash: PAYMENT_HASH,
          amountSats: 1_000,
          network: "mainnet",
          assertCurrent: () => undefined,
        },
        { contracts: CONTRACTS, fetchMetadata: async () => metadata() }
      )
      expect(result.status).toBe("verified")
      expect(optionsSafe).toBe(true)
    } finally {
      fetchMock.mockRestore()
    }
  })
})
