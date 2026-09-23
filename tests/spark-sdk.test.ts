import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  decodeLightningInvoiceAmount,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  hashSignedZapRequestDescription,
} from "@conduit/core"

import {
  FirstPartySparkSdkFactory,
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkConfigurationForNetwork,
  type SparkNativeModule,
  type SparkNativeWallet,
} from "../apps/market/src/lib/spark-sdk"
import { MemorySparkDirectTransferSafetyStore } from "../apps/market/src/lib/spark-direct-transfer-safety"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import {
  bolt11DescriptionHashField,
  bolt11PlainDescriptionField,
  bytesToBolt11Words,
  makeBolt11Fixture,
  type Bolt11FixtureField,
} from "./support/bolt11-fixture"

const MNEMONIC = "abandon ".repeat(11) + "about"
const ZERO_PREIMAGE = "00".repeat(32)
const ZERO_PREIMAGE_PAYMENT_HASH =
  "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
const ZERO_PREIMAGE_INVOICE = makeLightningInvoice(ZERO_PREIMAGE_PAYMENT_HASH)
const ZERO_PREIMAGE_FIXED_INVOICE = makeLightningInvoice(
  ZERO_PREIMAGE_PAYMENT_HASH,
  1_000
)
const PAYMENT_ATTEMPT_ID = "c7fb0ad2-c85c-4d93-b542-6dc9d10d8c00"
const ZAP_TEST_KEY = new Uint8Array(32).fill(1)
const SIGNED_ZAP_REQUEST_JSON = JSON.stringify(
  finalizeEvent(
    {
      kind: 9734,
      created_at: 1_800_000_000,
      tags: [
        ["p", getPublicKey(new Uint8Array(32).fill(2))],
        ["amount", "1050000"],
        ["relays", "wss://relay.conduit.market"],
      ],
      content: "Public checkout zap",
    },
    ZAP_TEST_KEY
  )
)

describe("first-party Spark SDK adapter", () => {
  it("fails closed on networks without first-party production defaults", () => {
    expect(getSparkConfigurationForNetwork("mainnet")).toEqual({
      status: "ready",
      network: "mainnet",
    })
    expect(getSparkConfigurationForNetwork("regtest")).toEqual({
      status: "ready",
      network: "regtest",
    })
    expect(getSparkConfigurationForNetwork("signet")).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on signet by the installed first-party SDK.",
    })
    expect(getSparkConfigurationForNetwork("testnet")).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on testnet by the installed first-party SDK.",
    })
  })

  it("fails closed when the browser cannot coordinate Spark sessions", () => {
    expect(
      getSparkConfiguration({
        network: "mainnet",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "This browser cannot safely coordinate Portable Wallet sessions across tabs.",
    })
    expect(
      getSparkConfiguration({
        network: "regtest",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "This browser cannot safely coordinate Portable Wallet sessions across tabs.",
    })
    expect(
      getSparkConfiguration({
        network: "signet",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on signet by the installed first-party SDK.",
    })
  })

  it("uses Spark's documented account defaults for supported networks", () => {
    expect(getDefaultSparkAccountNumber("mainnet")).toBe(1)
    expect(getDefaultSparkAccountNumber("regtest")).toBe(0)
  })

  it("creates an exact pure-BOLT11 checkout receive and exposes full funds state", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    let createInput:
      Parameters<SparkNativeWallet["createLightningInvoice"]>[0] | null = null
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 1_400n,
          satsBalance: {
            available: 1_000n,
            owned: 1_250n,
            incoming: 150n,
          },
        }
      },
      async createLightningInvoice(input) {
        createInput = input
        return nativeReceive
      },
      async getLightningReceiveRequest(id) {
        return id === nativeReceive.id ? nativeReceive : null
      },
    })
    const observedAt = 1_800_000_010_000
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => observedAt })
    )

    const request = await client.createCheckoutReceive?.({
      invoiceKind: "plain",
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
    })

    expect(createInput).toEqual({
      amountSats: 1_050,
      memo: "Guest checkout",
      expirySeconds: 300,
      includeSparkAddress: false,
      includeSparkInvoice: false,
    })
    expect(request).toEqual({
      walletId: "wallet-personal",
      network: "mainnet",
      id: "lightning-receive",
      paymentRequest: invoice,
      paymentHash: "07".repeat(32),
      providerStatus: "INVOICE_CREATED",
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
    })
    await expect(client.getFundsState?.()).resolves.toEqual({
      availableSats: 1_000,
      ownedSats: 1_250,
      incomingSats: 150,
      observedAt,
    })
    await expect(client.reconcileCheckoutReceive?.(request!)).resolves.toEqual({
      state: "pending",
      providerStatus: "INVOICE_CREATED",
      failureReason: null,
      funds: {
        availableSats: 1_000,
        ownedSats: 1_250,
        incomingSats: 150,
        observedAt,
      },
    })
  })

  it("requests and verifies an exact signed NIP-57 description-hash invoice", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
      descriptionFields: [bolt11DescriptionHashField(SIGNED_ZAP_REQUEST_JSON)],
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    let createInput:
      Parameters<SparkNativeWallet["createLightningInvoice"]>[0] | undefined
    const wallet = createNativeWallet({
      async createLightningInvoice(input) {
        createInput = input
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        return nativeReceive
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = await client.createCheckoutReceive?.({
      invoiceKind: "nip57_bound",
      signedZapRequestJson: SIGNED_ZAP_REQUEST_JSON,
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
    })

    expect(createInput).toEqual({
      amountSats: 1_050,
      descriptionHash: createHash("sha256")
        .update(SIGNED_ZAP_REQUEST_JSON, "utf8")
        .digest("hex"),
      expirySeconds: 300,
      includeSparkAddress: false,
      includeSparkInvoice: false,
    })
    expect(request?.paymentRequest).toBe(invoice)
    await expect(
      client.reconcileCheckoutReceive?.(request!)
    ).resolves.toMatchObject({
      state: "pending",
      failureReason: null,
    })
  })

  it("rejects missing, wrong, duplicate, and h-plus-d Spark invoice bindings", async () => {
    const goodHash = bolt11DescriptionHashField(SIGNED_ZAP_REQUEST_JSON)
    const cases: Bolt11FixtureField[][] = [
      [],
      [bolt11DescriptionHashField(`${SIGNED_ZAP_REQUEST_JSON} `)],
      [goodHash, goodHash],
      [goodHash, bolt11PlainDescriptionField()],
      [{ tag: "h", words: goodHash.words.slice(0, 51) }],
    ]

    for (const descriptionFields of cases) {
      const invoice = makeReceiveInvoice({
        amountSats: 1_050,
        expirySeconds: 300,
        descriptionFields,
      })
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async createLightningInvoice() {
              return createLightningReceiveResult(invoice)
            },
          })
        )
      )
      await expect(
        client.createCheckoutReceive?.({
          invoiceKind: "nip57_bound",
          signedZapRequestJson: SIGNED_ZAP_REQUEST_JSON,
          requiredNetSats: 1_000,
          grossFundingSats: 1_050,
          expirySecs: 300,
        })
      ).rejects.toThrow("without the exact NIP-57 request binding")
    }
  })

  it("binds exact signed JSON bytes and rejects invalid request evidence before SDK I/O", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
      descriptionFields: [bolt11DescriptionHashField(SIGNED_ZAP_REQUEST_JSON)],
    })
    let createCalls = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            createCalls += 1
            return createLightningReceiveResult(invoice)
          },
        })
      )
    )
    const request = (signedZapRequestJson: string) =>
      client.createCheckoutReceive!({
        invoiceKind: "nip57_bound",
        signedZapRequestJson,
        requiredNetSats: 1_000,
        grossFundingSats: 1_050,
        expirySecs: 300,
      })

    await expect(
      request(JSON.stringify(JSON.parse(SIGNED_ZAP_REQUEST_JSON), null, 2))
    ).rejects.toThrow("without the exact NIP-57 request binding")
    expect(createCalls).toBe(1)

    const unsigned = JSON.parse(SIGNED_ZAP_REQUEST_JSON)
    delete unsigned.sig
    await expect(request(JSON.stringify(unsigned))).rejects.toThrow(
      "exact signed kind-9734"
    )
    const wrongAmount = JSON.parse(SIGNED_ZAP_REQUEST_JSON)
    wrongAmount.tags[1][1] = "1049000"
    await expect(request(JSON.stringify(wrongAmount))).rejects.toThrow(
      "exact signed kind-9734"
    )
    const signedWrongAmount = JSON.stringify(
      finalizeEvent(
        {
          kind: 9734,
          created_at: 1_800_000_000,
          tags: [
            ["p", getPublicKey(new Uint8Array(32).fill(2))],
            ["amount", "1049000"],
          ],
          content: "Public checkout zap",
        },
        ZAP_TEST_KEY
      )
    )
    await expect(request(signedWrongAmount)).rejects.toThrow(
      "recipient or amount is invalid"
    )
    await expect(request("not JSON")).rejects.toThrow("exact signed kind-9734")
    expect(createCalls).toBe(1)
  })

  it("rejects malformed NIP-57 receipt relays and target tags before Spark SDK I/O", async () => {
    let createCalls = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            createCalls += 1
            throw new Error(
              "Spark SDK should not receive an invalid zap request"
            )
          },
        })
      )
    )
    const pubkey = getPublicKey(new Uint8Array(32).fill(2))
    const baseTags = [
      ["p", pubkey],
      ["amount", "1050000"],
      ["relays", "wss://relay.conduit.market"],
    ]
    const sign = (tags: string[][]) =>
      JSON.stringify(
        finalizeEvent(
          {
            kind: 9734,
            created_at: 1_800_000_000,
            tags,
            content: "Public checkout zap",
          },
          ZAP_TEST_KEY
        )
      )
    const request = (signedZapRequestJson: string) =>
      client.createCheckoutReceive!({
        invoiceKind: "nip57_bound",
        signedZapRequestJson,
        requiredNetSats: 1_000,
        grossFundingSats: 1_050,
        expirySecs: 300,
      })

    const invalidRelayTags = [
      baseTags.slice(0, 2),
      [...baseTags.slice(0, 2), ["relays"]],
      [...baseTags, ["relays", "wss://other.conduit.market"]],
      [...baseTags.slice(0, 2), ["relays", "https://relay.conduit.market"]],
      [...baseTags.slice(0, 2), ["relays", "ws://relay.conduit.market"]],
      [...baseTags.slice(0, 2), ["relays", "wss://127.0.0.1"]],
      [...baseTags.slice(0, 2), ["relays", "wss://user@relay.conduit.market"]],
      [
        ...baseTags.slice(0, 2),
        ["relays", "wss://relay.conduit.market?token=x"],
      ],
      [
        ...baseTags.slice(0, 2),
        ["relays", "wss://relay.conduit.market", "not a URL"],
      ],
    ]
    for (const tags of invalidRelayTags) {
      await expect(request(sign(tags))).rejects.toThrow(
        "receipt relays are invalid"
      )
    }

    const validCoordinate = `30402:${pubkey}:product`
    const invalidTargetTags = [
      [...baseTags, ["e", "not-an-event-id"]],
      [...baseTags, ["e", "a".repeat(64)], ["e", "b".repeat(64)]],
      [...baseTags, ["a", "30402:not-a-pubkey:product"]],
      [...baseTags, ["a", `1:${pubkey}:product`]],
      [...baseTags, ["a", `10000:${pubkey}:product`]],
      [...baseTags, ["a", `0:${pubkey}:product`]],
      [...baseTags, ["a", validCoordinate], ["a", validCoordinate]],
      [...baseTags, ["P", "not-a-pubkey"]],
      [...baseTags, ["P", pubkey], ["P", pubkey]],
    ]
    for (const tags of invalidTargetTags) {
      await expect(request(sign(tags))).rejects.toThrow(
        "target tags are invalid"
      )
    }
    expect(createCalls).toBe(0)

    for (const relay of ["wss://relay.conduit.market", "ws://localhost:7777"]) {
      for (const coordinate of [
        validCoordinate,
        `10000:${pubkey}:`,
        `0:${pubkey}:`,
        `3:${pubkey}:`,
        `30402:${pubkey}:`,
      ]) {
        const signed = sign([
          ...baseTags.slice(0, 2),
          ["relays", relay],
          ["e", "a".repeat(64)],
          ["a", coordinate],
          ["P", pubkey],
        ])
        expect(
          hashSignedZapRequestDescription({
            zapRequestJson: signed,
            expectedAmountMsats: 1_050_000,
          })
        ).toBe(createHash("sha256").update(signed, "utf8").digest("hex"))
      }
    }
  })

  it("keeps amount, network, and expiry checks on NIP-57-bound receives", async () => {
    const descriptionFields = [
      bolt11DescriptionHashField(SIGNED_ZAP_REQUEST_JSON),
    ]
    const invoices = [
      makeReceiveInvoice({
        amountSats: 1_049,
        expirySeconds: 300,
        descriptionFields,
      }),
      makeReceiveInvoice({
        amountSats: 1_050,
        expirySeconds: 300,
        network: "regtest",
        descriptionFields,
      }),
      makeReceiveInvoice({
        amountSats: 1_050,
        expirySeconds: 299,
        descriptionFields,
      }),
    ]
    for (const invoice of invoices) {
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async createLightningInvoice() {
              return createLightningReceiveResult(invoice)
            },
          })
        )
      )
      await expect(
        client.createCheckoutReceive?.({
          invoiceKind: "nip57_bound",
          signedZapRequestJson: SIGNED_ZAP_REQUEST_JSON,
          requiredNetSats: 1_000,
          grossFundingSats: 1_050,
          expirySecs: 300,
        })
      ).rejects.toThrow()
    }
  })

  it("canonicalizes fractional provider timestamps while retaining receive identity", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice, {
      createdAt: new Date(1_800_000_000_375).toISOString(),
      expiresAt: new Date(1_800_000_300_375).toISOString(),
    })
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 1_050n,
          satsBalance: {
            available: 1_050n,
            owned: 1_050n,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        return { ...nativeReceive, status: "TRANSFER_COMPLETED" }
      },
    })
    const client = await openClient(createFactory(wallet))

    const request = await client.createCheckoutReceive?.({
      invoiceKind: "plain",
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
    })

    expect(request).toMatchObject({
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
    })
    await expect(
      client.reconcileCheckoutReceive?.(request!)
    ).resolves.toMatchObject({
      state: "spendable",
      providerStatus: "TRANSFER_COMPLETED",
      failureReason: null,
    })
  })

  it("reconciles every receive status without treating unrelated balance as proof", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    let availableSats = 50_000n
    let observedAt = 1_800_000_010_000
    let lookup: "record" | "missing" | "throw" = "record"
    let currentReceive = nativeReceive
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: availableSats,
          satsBalance: {
            available: availableSats,
            owned: availableSats,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        if (lookup === "throw") throw new Error("provider unavailable")
        return lookup === "missing" ? null : currentReceive
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => observedAt })
    )
    const request = (await client.createCheckoutReceive?.({
      invoiceKind: "plain",
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
    }))!
    const reconcile = () => client.reconcileCheckoutReceive!(request)

    await expect(reconcile()).resolves.toMatchObject({
      state: "pending",
      failureReason: null,
    })

    observedAt = request.expiresAt
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "invoice_expired_unresolved",
    })

    for (const status of [
      "TRANSFER_CREATED",
      "PAYMENT_PREIMAGE_RECOVERED",
      "LIGHTNING_PAYMENT_RECEIVED",
    ]) {
      currentReceive = { ...nativeReceive, status }
      await expect(reconcile()).resolves.toMatchObject({
        state: "funded_pending_claim",
        providerStatus: status,
        failureReason: null,
      })
    }

    currentReceive = { ...nativeReceive, status: "TRANSFER_COMPLETED" }
    availableSats = 1_000n
    await expect(reconcile()).resolves.toMatchObject({
      state: "spendable",
      failureReason: null,
    })
    availableSats = 999n
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "insufficient_available_funds",
    })

    for (const status of [
      "FUTURE_VALUE",
      "TRANSFER_CREATION_FAILED",
      "REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED",
      "REFUND_SIGNING_FAILED",
      "PAYMENT_PREIMAGE_RECOVERING_FAILED",
      "TRANSFER_FAILED",
      "UNKNOWN_STATUS",
    ]) {
      currentReceive = { ...nativeReceive, status }
      await expect(reconcile()).resolves.toMatchObject({
        state: "unresolved_failure",
        providerStatus: status,
        failureReason: "provider_unresolved",
      })
    }

    lookup = "missing"
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: null,
      failureReason: "receive_not_found",
    })
    lookup = "throw"
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: null,
      failureReason: "lookup_unavailable",
    })
    lookup = "record"
    currentReceive = createLightningReceiveResult(invoice, {
      paymentHash: "08".repeat(32),
    })
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: "INVOICE_CREATED",
      failureReason: "conflicting_evidence",
    })
  })

  it("rejects conflicting checkout network evidence", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
    })
    const request = {
      invoiceKind: "plain" as const,
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_050,
      expirySecs: 300,
    }

    for (const nativeReceive of [
      createLightningReceiveResult(invoice, { network: "REGTEST" }),
      createLightningReceiveResult(invoice, { bitcoinNetwork: "REGTEST" }),
    ]) {
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async createLightningInvoice() {
              return nativeReceive
            },
          })
        )
      )
      await expect(client.createCheckoutReceive?.(request)).rejects.toThrow()
    }
  })

  it("rejects a one-second provider expiry mismatch", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_050,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice, {
      expiresAt: new Date(1_800_000_301_375).toISOString(),
    })
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return nativeReceive
          },
        })
      )
    )

    await expect(
      client.createCheckoutReceive?.({
        invoiceKind: "plain",
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_050,
        expirySecs: 300,
      })
    ).rejects.toThrow("Spark returned conflicting checkout expiry evidence.")
  })

  it("validates mainnet receive outputs before returning them", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 2_100 })
    const wallet = createNativeWallet({
      async getSparkAddress() {
        return " spark1receive "
      },
      async createLightningInvoice() {
        return createLightningReceiveResult(invoice)
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).resolves.toEqual({
      paymentRequest: "spark1receive",
      fee: 0n,
    })
    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
          amountSats: 2_100,
        },
      })
    ).resolves.toEqual({
      paymentRequest: invoice,
      fee: 0n,
    })
  })

  it("accepts a valid amountless mainnet receive invoice", async () => {
    const invoice = makeReceiveInvoice()
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(invoice)
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).resolves.toEqual({
      paymentRequest: invoice,
      fee: 0n,
    })
  })

  it("accepts valid amountless and fixed-amount regtest receive invoices", async () => {
    const amountlessInvoice = makeReceiveInvoice({ network: "regtest" })
    const fixedInvoice = makeReceiveInvoice({
      amountSats: 2_100,
      network: "regtest",
    })
    let paymentRequest = amountlessInvoice
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(paymentRequest)
      },
    })
    const client = await openClient(createFactory(wallet, {}, "regtest"))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).resolves.toMatchObject({
      paymentRequest: amountlessInvoice,
    })

    paymentRequest = fixedInvoice
    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
          amountSats: 2_100,
        },
      })
    ).resolves.toMatchObject({
      paymentRequest: fixedInvoice,
    })
  })

  it("rejects invalid, wrong-network, and invoice-form receive addresses", async () => {
    const wallet = createNativeWallet()
    const invalidClient = await openClient(
      createFactory(wallet, {
        isValidSparkAddress: () => false,
      })
    )
    const wrongNetworkClient = await openClient(
      createFactory(wallet, {
        getNetworkFromSparkAddress: () => "REGTEST",
      })
    )
    const sparkInvoiceClient = await openClient(
      createFactory(wallet, {
        decodeSparkAddress: () => ({ sparkInvoiceFields: {} }),
      })
    )

    await expect(
      invalidClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("invalid receive address")
    await expect(
      wrongNetworkClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("different Bitcoin network")
    await expect(
      sparkInvoiceClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("plain receive address")
  })

  it("rejects wrong-network, wrong-amount, and malformed receive invoices", async () => {
    const paymentMethod = {
      type: "bolt11Invoice" as const,
      description: "Receive",
      amountSats: 2_100,
    }
    const wrongNetworkClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({ amountSats: 2_100, network: "regtest" })
            )
          },
        })
      )
    )
    const wrongAmountClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({ amountSats: 2_200 })
            )
          },
        })
      )
    )
    const missingHashClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({
                amountSats: 2_100,
                includePaymentHash: false,
              })
            )
          },
        })
      )
    )

    await expect(
      wrongNetworkClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("different Bitcoin network")
    await expect(
      wrongAmountClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("different amount")
    await expect(
      missingHashClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("valid payment hash")
  })

  it("rejects an amount-bearing invoice for an amountless receive request", async () => {
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(
          makeReceiveInvoice({ amountSats: 2_100 })
        )
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).rejects.toThrow("amountless Lightning invoice")
  })

  it("rejects invalid amount components instead of treating them as amountless", async () => {
    const mainnetClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeInvalidAmountReceiveInvoice("mainnet")
            )
          },
        })
      )
    )
    const regtestClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeInvalidAmountReceiveInvoice("regtest")
            )
          },
        }),
        {},
        "regtest"
      )
    )
    const paymentMethod = {
      type: "bolt11Invoice" as const,
      description: "Receive",
    }

    await expect(
      mainnetClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("amountless Lightning invoice")
    await expect(
      regtestClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("amountless Lightning invoice")
  })

  it("opens the requested account with logging disabled and privacy enabled", async () => {
    const calls: string[] = []
    let initializeInput: Parameters<SparkNativeModule["initialize"]>[0] | null =
      null
    const wallet = createNativeWallet({
      async setPrivacyEnabled(enabled) {
        calls.push(`privacy:${enabled}`)
        return { privateEnabled: enabled }
      },
      async getWalletSettings() {
        calls.push("privacy:verify")
        return { privateEnabled: true }
      },
      async getBalance() {
        return {
          balance: 21_000n,
          satsBalance: {
            available: 21_000n,
            owned: 21_000n,
            incoming: 0n,
          },
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize(input) {
          calls.push("initialize")
          initializeInput = input
          return { wallet }
        },
      }),
      wait: async () => undefined,
    })

    const client = await factory.open({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 7,
    })

    expect(initializeInput).toEqual({
      mnemonicOrSeed: MNEMONIC,
      accountNumber: 7,
      options: {
        log: false,
        network: "MAINNET",
      },
    })
    expect(calls).toEqual(["initialize", "privacy:true", "privacy:verify"])
    await expect(client.getInfo({ ensureSynced: true })).resolves.toEqual({
      balanceSats: 21_000,
    })
  })

  it("waits for spaced public privacy observations before becoming ready", async () => {
    const calls: string[] = []
    const waitResolvers: Array<() => void> = []
    let observations = 0
    let ready = false
    const wallet = createNativeWallet({
      async getSparkAddress() {
        calls.push("wallet:address")
        return "spark1private"
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 250,
      privacyConvergenceTimeoutMs: 2_000,
      privacyReadTimeoutMs: 100,
      wait: (milliseconds) => {
        calls.push(`wait:${milliseconds}`)
        return new Promise<void>((resolve) => {
          waitResolvers.push(resolve)
        })
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient(options) {
          calls.push(`readonly:${options.network}:${options.log}`)
          return {
            async getAvailableBalance() {
              observations += 1
              calls.push(`available:${observations}`)
              return 0n
            },
            async getOwnedBalance() {
              calls.push(`owned:${observations}`)
              return 0n
            },
            async getTransfers() {
              calls.push(`history:${observations}`)
              return { transfers: [], offset: 0 }
            },
          }
        },
        async initialize() {
          calls.push("initialize")
          return { wallet }
        },
      }),
    })

    const open = factory
      .open({
        walletId: "wallet-personal",
        mnemonic: MNEMONIC,
        accountNumber: 1,
      })
      .then((client) => {
        ready = true
        return client
      })

    await waitForTestCondition(
      () => observations === 1 && waitResolvers.length === 1
    )
    expect(ready).toBe(false)
    waitResolvers.shift()?.()

    await waitForTestCondition(
      () => observations === 2 && waitResolvers.length === 1
    )
    expect(ready).toBe(false)
    waitResolvers.shift()?.()

    await open

    expect(ready).toBe(true)
    expect(observations).toBe(3)
    expect(calls).toEqual([
      "initialize",
      "wallet:address",
      "readonly:MAINNET:false",
      "available:1",
      "owned:1",
      "history:1",
      "wait:250",
      "available:2",
      "owned:2",
      "history:2",
      "wait:250",
      "available:3",
      "owned:3",
      "history:3",
    ])
  })

  it("restarts privacy convergence after a public read exposes wallet data", async () => {
    const availableByObservation = [0n, 0n, 21_000n, 0n, 0n, 0n]
    let observation = 0
    const waits: number[] = []
    const wallet = createNativeWallet()
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 400,
      privacyConvergenceTimeoutMs: 4_000,
      privacyReadTimeoutMs: 100,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient: () => ({
          async getAvailableBalance() {
            observation += 1
            return availableByObservation[observation] ?? 0n
          },
          async getOwnedBalance() {
            return availableByObservation[observation] ?? 0n
          },
          async getTransfers() {
            return {
              transfers: observation === 3 ? [{ id: "public-history" }] : [],
              offset: 0,
            }
          },
        }),
        async initialize() {
          return { wallet }
        },
      }),
    })

    await factory.open({
      walletId: "wallet-restored",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    expect(observation).toBe(6)
    expect(waits).toEqual([400, 400, 400, 400, 400])
  })

  it("times out stalled public reads and cleans up without exposing the wallet", async () => {
    let now = 0
    let cleanupCalls = 0
    let readonlyCalls = 0
    const timeoutCalls: Array<{ label: string; timeoutMs: number }> = []
    const wallet = createNativeWallet({
      async cleanup() {
        cleanupCalls += 1
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 250,
      privacyConvergenceTimeoutMs: 1_000,
      privacyReadTimeoutMs: 100,
      privacyReadWithTimeout: async (_read, timeoutMs, label) => {
        timeoutCalls.push({ label, timeoutMs })
        throw new Error(`${label} timed out`)
      },
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "REGTEST",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient: () => {
          readonlyCalls += 1
          return {
            async getAvailableBalance() {
              return new Promise<bigint>(() => undefined)
            },
            async getOwnedBalance() {
              return 0n
            },
            async getTransfers() {
              return { transfers: [], offset: 0 }
            },
          }
        },
        async initialize() {
          return { wallet }
        },
      }),
    })

    await expect(
      factory.open({
        walletId: "wallet-stalled",
        mnemonic: MNEMONIC,
        accountNumber: 0,
      })
    ).rejects.toThrow(
      "Spark private mode could not be confirmed before the readiness deadline."
    )
    expect(readonlyCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
    expect(timeoutCalls).toHaveLength(12)
    expect(timeoutCalls.every(({ timeoutMs }) => timeoutMs === 100)).toBe(true)
    expect([...new Set(timeoutCalls.map(({ label }) => label))]).toEqual([
      "Spark public available-balance read",
      "Spark public owned-balance read",
      "Spark public transfer-history read",
    ])
  })

  it("fails closed and cleans up when private wallet mode cannot be verified", async () => {
    let cleanupCalls = 0
    const wallet = createNativeWallet({
      async setPrivacyEnabled() {
        return { privateEnabled: true }
      },
      async getWalletSettings() {
        return { privateEnabled: false }
      },
      async cleanup() {
        cleanupCalls += 1
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "REGTEST",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
    })

    await expect(
      factory.open({
        walletId: "wallet-personal",
        mnemonic: MNEMONIC,
        accountNumber: 0,
      })
    ).rejects.toThrow("private mode")
    expect(cleanupCalls).toBe(1)
  })

  it("maps direct Spark transfers without inventing provider idempotency", async () => {
    const transferCalls: Array<{
      amountSats: number
      receiverSparkAddress: string
    }> = []
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls.push(input)
        return {
          id: "native-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const factory = createFactory(wallet)
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: {
        type: "input",
        input: "spark1recipient",
      },
      amount: 2_100n,
    })

    expect(prepared).toEqual({
      amount: 2_100n,
      paymentMethod: {
        fee: "0",
        type: "sparkAddress",
      },
    })
    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
        idempotencyKey: "local-safety-marker",
      })
    ).resolves.toEqual({
      payment: {
        fees: 0n,
        id: "native-transfer",
        status: "completed",
      },
    })
    expect(transferCalls).toEqual([
      {
        amountSats: 2_100,
        receiverSparkAddress: "spark1recipient",
      },
    ])
  })

  it("rejects Spark invoices before quoting or creating a transfer safety lock", async () => {
    let transferCalls = 0
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls += 1
        return {
          id: "must-not-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const safetyStore = new MemorySparkDirectTransferSafetyStore()
    const manager = new SparkWalletManager(
      new FirstPartySparkSdkFactory({
        network: "mainnet",
        loadModule: async () => ({
          eventNames: ["balance:update"],
          parseTransferId: parseTestTransferId,
          createPublicReadonlyClient: createHiddenPublicReadonlyClient,
          decodeSparkAddress: () => ({
            sparkInvoiceFields: { version: 1 },
          }),
          getNetworkFromSparkAddress: () => "MAINNET",
          isValidSparkAddress: () => true,
          async initialize() {
            return { wallet }
          },
        }),
        wait: async () => undefined,
      }),
      async () => ({ async release() {} }),
      safetyStore
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: { type: "spark_address", address: "spark1invoice" },
        amount: { type: "exact", amountSats: 2_100 },
      })
    ).rejects.toThrow(
      "Spark invoices are not supported for direct transfers. Use a plain Spark address."
    )
    expect(transferCalls).toBe(0)
    expect(manager.hasUnresolvedSend("wallet-personal")).toBe(false)
  })

  it("keeps a nonterminal direct Spark transfer pending without sending twice", async () => {
    let now = 0
    let transferCalls = 0
    const requestIds: string[] = []
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls += 1
        return {
          id: "native-pending",
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
      async getTransfer(id) {
        requestIds.push(id)
        return {
          id,
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          totalValue: 2_100,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
      pollIntervalMs: 100,
      transferCompletionTimeoutSecs: 0.25,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
    })
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: "spark1recipient" },
      amount: 2_100n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
      })
    ).resolves.toMatchObject({
      payment: {
        id: "native-pending",
        status: "pending",
      },
    })
    expect(transferCalls).toBe(1)
    expect(requestIds).toEqual([
      "native-pending",
      "native-pending",
      "native-pending",
    ])
  })

  it("maps a terminal returned direct Spark transfer to failed", async () => {
    const wallet = createNativeWallet({
      async transfer(input) {
        return {
          id: "native-returned",
          status: "TRANSFER_STATUS_RETURNED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: "spark1recipient" },
      amount: 2_100n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
      })
    ).resolves.toMatchObject({
      payment: {
        id: "native-returned",
        status: "failed",
      },
    })
  })

  it("quotes Spark's recommended fee cap, pays, and reconciles Lightning", async () => {
    const payCalls: Array<{
      invoice: string
      maxFeeSats: number
      preferSpark: boolean
      amountSatsToSend?: number
      transferId?: string
    }> = []
    let requestReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 3
      },
      async payLightningInvoice(input) {
        payCalls.push({
          ...input,
          ...(input.transferId
            ? { transferId: input.transferId.toString() }
            : {}),
        })
        return {
          id: "lightning-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        requestReads += 1
        return {
          id: "lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 2_000, originalUnit: "MILLISATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const factory = createFactory(wallet)
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })
    const response = await client.sendPayment({
      prepareResponse: prepared,
      options: {
        type: "bolt11Invoice",
        preferSpark: false,
        completionTimeoutSecs: 5,
      },
      idempotencyKey: PAYMENT_ATTEMPT_ID,
    })

    expect(prepared).toEqual({
      amount: 1_000n,
      paymentMethod: {
        lightningFeeSats: 5,
        type: "bolt11Invoice",
      },
    })
    expect(payCalls).toEqual([
      {
        amountSatsToSend: 1_000,
        invoice: ZERO_PREIMAGE_INVOICE,
        maxFeeSats: 5,
        preferSpark: false,
        transferId: PAYMENT_ATTEMPT_ID,
      },
    ])
    expect(requestReads).toBe(1)
    expect(response.payment).toMatchObject({
      fees: 2n,
      id: "lightning-request",
      status: "completed",
      details: {
        type: "lightning",
        htlcDetails: {
          preimage: ZERO_PREIMAGE,
        },
      },
    })
    expect(response.payment.details?.htlcDetails?.paymentHash).toBe(
      ZERO_PREIMAGE_PAYMENT_HASH
    )
  })

  it("applies Spark's proportional Lightning fee cap above the minimum", async () => {
    const payCalls: Array<{ maxFeeSats: number }> = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 3
      },
      async payLightningInvoice(input) {
        payCalls.push(input)
        return {
          id: "proportional-fee-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        return {
          id: "proportional-fee-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 10_000n,
    })

    expect(prepared.paymentMethod).toEqual({
      lightningFeeSats: 17,
      type: "bolt11Invoice",
    })

    await client.sendPayment({
      prepareResponse: prepared,
      options: {
        type: "bolt11Invoice",
        preferSpark: false,
        completionTimeoutSecs: 5,
      },
    })

    expect(payCalls).toEqual([
      expect.objectContaining({
        maxFeeSats: 17,
      }),
    ])
  })

  it("rejects a regtest Lightning invoice before quoting from a mainnet wallet", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet))
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      network: "regtest",
    })

    await expect(
      client.prepareSendPayment({
        paymentRequest: { type: "input", input: invoice },
        amount: 1_000n,
      })
    ).rejects.toThrow("different Bitcoin network")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects a mainnet Lightning invoice before quoting from a regtest wallet", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet, {}, "regtest"))
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      network: "mainnet",
    })

    await expect(
      client.prepareSendPayment({
        paymentRequest: { type: "input", input: invoice },
        amount: 1_000n,
      })
    ).rejects.toThrow("different Bitcoin network")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects an invalid Lightning amount component before quoting", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.prepareSendPayment({
        paymentRequest: {
          type: "input",
          input: makeInvalidAmountReceiveInvoice("mainnet"),
        },
        amount: 10n,
      })
    ).rejects.toThrow("invalid amount")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects an unexpected native transfer result from a Lightning payment", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "unexpected-direct-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 1_000,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).rejects.toThrow(
      "Spark returned an unexpected direct transfer for a Lightning payment."
    )
    expect(payCalls).toBe(1)
  })

  it("keeps an unexpected Lightning transfer result ambiguous for retries", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "unexpected-direct-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 1_000,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const manager = new SparkWalletManager(createFactory(wallet), async () => ({
      async release() {},
    }))
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    const first = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })

    expect(first).toEqual({
      status: "ambiguous",
      reason:
        "Spark returned an unexpected direct transfer for a Lightning payment. Check the wallet before retrying.",
    })
    expect(duplicate).toEqual(first)
    expect(payCalls).toBe(1)
  })

  it("rejects a completed Lightning proof whose preimage does not match the prepared invoice", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-mismatched-proof",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 0, originalUnit: "SATOSHI" },
          paymentPreimage: "11".repeat(32),
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).rejects.toThrow(
      "Spark returned a Lightning preimage that does not match the prepared invoice."
    )
    expect(payCalls).toBe(1)
  })

  it("keeps a mismatched Lightning proof ambiguous instead of recording it paid", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-mismatched-proof",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 0, originalUnit: "SATOSHI" },
          paymentPreimage: "11".repeat(32),
        }
      },
    })
    const manager = new SparkWalletManager(createFactory(wallet), async () => ({
      async release() {},
    }))
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    const first = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })

    expect(first).toEqual({
      status: "ambiguous",
      reason:
        "Spark returned a Lightning preimage that does not match the prepared invoice. Check the wallet before retrying.",
    })
    expect(duplicate).toEqual(first)
    expect(payCalls).toBe(1)
  })

  it("polls a pending Lightning request without publishing it again", async () => {
    let now = 0
    let payCalls = 0
    const requestIds: string[] = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-pending",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest(id) {
        requestIds.push(id)
        return {
          id,
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress() {
          throw new Error("not a Spark address")
        },
        async initialize() {
          return { wallet }
        },
      }),
      pollIntervalMs: 100,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
    })
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
          completionTimeoutSecs: 0.25,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).resolves.toMatchObject({
      payment: {
        id: "lightning-pending",
        status: "pending",
      },
    })
    expect(payCalls).toBe(1)
    expect(requestIds).toEqual([
      "lightning-pending",
      "lightning-pending",
      "lightning-pending",
    ])
  })

  it("keeps a live Lightning status lookup failure ambiguous with a useful reason", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-pending",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        throw new Error("provider unavailable")
      },
    })
    const manager = new SparkWalletManager(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      }),
      async () => ({ async release() {} })
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: ZERO_PREIMAGE_FIXED_INVOICE,
        amountMsats: 1_000_000,
        idempotencyKey: PAYMENT_ATTEMPT_ID,
        completionTimeoutSecs: 1,
        approveFee: async () => true,
      })
    ).resolves.toEqual({
      status: "ambiguous",
      reason:
        "Spark payment status could not be checked. Check the wallet before retrying.",
    })
    expect(payCalls).toBe(1)
    expect(statusReads).toBe(1)
  })

  it("recovers a lost Lightning response by transfer ID without paying again", async () => {
    let payCalls = 0
    const transferReads: string[] = []
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("The original response was lost.")
      },
      async getTransferFromSsp(id) {
        transferReads.push(id)
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      payment: {
        id: "recovered-lightning-request",
        status: "completed",
        fees: 2n,
        details: {
          type: "lightning",
          htlcDetails: {
            paymentHash: ZERO_PREIMAGE_PAYMENT_HASH,
            preimage: ZERO_PREIMAGE,
          },
        },
      },
    })
    expect(transferReads).toEqual([PAYMENT_ATTEMPT_ID])
    expect(payCalls).toBe(0)
  })

  it("recovers an uppercase persisted invoice from lowercase Spark evidence", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: {
            originalValue: 1_002_000,
            originalUnit: "MILLISATOSHI",
          },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE.toUpperCase(),
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      payment: { status: "completed" },
    })
    expect(payCalls).toBe(0)
  })

  it("rejects amountless recovery when the recovered amount differs", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 2_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark cannot safely reconcile an amountless Lightning invoice.",
    })
    expect(payCalls).toBe(0)
  })

  it("rejects a fixed invoice that differs from the approved amount", async () => {
    let transferReads = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        transferReads += 1
        return undefined
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 999,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason:
        "The persisted Lightning invoice does not match the approved amount.",
    })
    expect(transferReads).toBe(0)
  })

  it("rejects missing, malformed, or inconsistent recovered transfer totals", async () => {
    const cases = [
      { name: "missing", totalAmount: undefined },
      {
        name: "unsupported unit",
        totalAmount: { originalValue: 1_002, originalUnit: "BITCOIN" },
      },
      {
        name: "inconsistent amount",
        totalAmount: { originalValue: 2_002, originalUnit: "SATOSHI" },
      },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp(id) {
          return {
            sparkId: id,
            ...(testCase.totalAmount === undefined
              ? {}
              : { totalAmount: testCase.totalAmount }),
            userRequest: {
              id: "recovered-lightning-request",
              status: "LIGHTNING_PAYMENT_SUCCEEDED",
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: ZERO_PREIMAGE,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toEqual({
        status: "conflicting_evidence",
        reason: "Spark returned a conflicting Lightning transfer total.",
      })
      expect(payCalls, testCase.name).toBe(0)
    }
  })

  it("keeps a missing transfer unresolved without paying again", async () => {
    let payCalls = 0
    const transferReads: string[] = []
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        transferReads.push(id)
        return undefined
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({ status: "not_found" })
    expect(transferReads).toEqual([PAYMENT_ATTEMPT_ID])
    expect(payCalls).toBe(0)
  })

  it("keeps an unavailable transfer lookup unresolved without paying again", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp() {
        throw new Error("provider unavailable")
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({ status: "lookup_unavailable" })
    expect(payCalls).toBe(0)
  })

  it("keeps an unavailable Lightning status lookup unresolved without paying again", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        throw new Error("provider unavailable")
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({ status: "lookup_unavailable" })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("rejects a polled Lightning fee that conflicts with the recovered transfer total", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        return {
          id: "recovered-lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark returned a conflicting Lightning transfer total.",
    })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("rejects a polled Lightning status for a different recovered request", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        return {
          id: "different-lightning-request",
          status: "LIGHTNING_PAYMENT_FAILED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
          paymentPreimage: null,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark returned a conflicting Lightning request identity.",
    })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("resolves an identity-consistent polled Lightning transition", async () => {
    let now = 0
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: null,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        return {
          id: "recovered-lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      payment: {
        id: "recovered-lightning-request",
        status: "completed",
      },
    })
    expect(payCalls).toBe(0)
  })

  it("fails closed on conflicting recovered Lightning evidence", async () => {
    const cases = [
      {
        name: "transfer identity",
        transferId: "different-transfer-id",
        request: {},
        message: "Spark returned a conflicting transfer identity.",
      },
      {
        name: "request kind",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { typename: "LightningReceiveRequest" },
        message: "Spark returned invalid Lightning recovery evidence.",
      },
      {
        name: "malformed payment preimage",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { paymentPreimage: 123 },
        message: "Spark returned invalid Lightning recovery evidence.",
      },
      {
        name: "idempotency identity",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { idempotencyKey: "different-attempt-id" },
        message: "Spark returned a conflicting Lightning payment identity.",
      },
      {
        name: "invoice identity",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { encodedInvoice: "lnbc1different" },
        message: "Spark returned a different Lightning invoice.",
      },
      {
        name: "mixed-case invoice",
        transferId: PAYMENT_ATTEMPT_ID,
        request: {
          encodedInvoice: `L${ZERO_PREIMAGE_FIXED_INVOICE.slice(1)}`,
        },
        message: "Spark returned a different Lightning invoice.",
      },
      {
        name: "approved fee cap",
        transferId: PAYMENT_ATTEMPT_ID,
        request: {
          fee: { originalValue: 6, originalUnit: "SATOSHI" },
        },
        message: "Spark returned a Lightning fee above the approved maximum.",
      },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp() {
          return {
            sparkId: testCase.transferId,
            userRequest: {
              id: "recovered-lightning-request",
              status: "LIGHTNING_PAYMENT_SUCCEEDED",
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: ZERO_PREIMAGE,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
              ...testCase.request,
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toEqual({
        status: "conflicting_evidence",
        reason: testCase.message,
      })
      expect(payCalls, testCase.name).toBe(0)
    }
  })

  it("preserves recovered pending and failed Lightning outcomes", async () => {
    const cases = [
      { providerStatus: "LIGHTNING_PAYMENT_INITIATED", status: "pending" },
      { providerStatus: "LIGHTNING_PAYMENT_FAILED", status: "failed" },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp(id) {
          return {
            sparkId: id,
            totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
            userRequest: {
              id: "recovered-lightning-request",
              status: testCase.providerStatus,
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: null,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toMatchObject({
        status: "resolved",
        payment: { status: testCase.status },
      })
      expect(payCalls).toBe(0)
    }
  })

  it("subscribes to concrete native wallet events and removes every listener", async () => {
    const nativeListeners = new Map<string, (...args: unknown[]) => void>()
    const removedEvents: string[] = []
    const wallet = createNativeWallet({
      on(event, listener) {
        nativeListeners.set(event, listener)
      },
      off(event, listener) {
        if (nativeListeners.get(event) === listener) {
          nativeListeners.delete(event)
          removedEvents.push(event)
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update", "transfer:claimed"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
      wait: async () => undefined,
    })
    const client = await openClient(factory)
    let invalidations = 0
    const listenerId = await client.addEventListener?.(() => {
      invalidations += 1
    })

    nativeListeners.get("balance:update")?.({ available: 100n })
    nativeListeners.get("transfer:claimed")?.("transfer-id", 100n)
    expect(invalidations).toBe(2)

    expect(
      await client.removeEventListener?.(listenerId ?? "missing-listener")
    ).toBe(true)
    expect(removedEvents).toEqual(["balance:update", "transfer:claimed"])
    expect(nativeListeners.size).toBe(0)
  })
})

function createHiddenPublicReadonlyClient() {
  return {
    async getAvailableBalance() {
      return 0n
    },
    async getOwnedBalance() {
      return 0n
    },
    async getTransfers() {
      return { transfers: [], offset: 0 }
    },
  }
}

function parseTestTransferId(
  value: string
): ReturnType<SparkNativeModule["parseTransferId"]> {
  return {
    toString: () => value,
  } as ReturnType<SparkNativeModule["parseTransferId"]>
}

async function waitForTestCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error("Timed out waiting for the deterministic test condition.")
}

function createFactory(
  wallet: SparkNativeWallet,
  moduleOverrides: Partial<SparkNativeModule> = {},
  network: "mainnet" | "regtest" = "mainnet",
  options: {
    now?: () => number
    wait?: (milliseconds: number) => Promise<void>
    pollIntervalMs?: number
  } = {}
) {
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  return new FirstPartySparkSdkFactory({
    network,
    loadModule: async () => ({
      eventNames: ["balance:update"],
      parseTransferId: parseTestTransferId,
      createPublicReadonlyClient: createHiddenPublicReadonlyClient,
      decodeSparkAddress: () => ({}),
      getNetworkFromSparkAddress: () => nativeNetwork,
      isValidSparkAddress(address) {
        if (address.startsWith("spark1")) return true
        throw new Error("not a Spark address")
      },
      async initialize() {
        return { wallet }
      },
      ...moduleOverrides,
    }),
    wait: options.wait ?? (async () => undefined),
    now: options.now,
    pollIntervalMs: options.pollIntervalMs,
  })
}

async function openClient(factory: FirstPartySparkSdkFactory) {
  return factory.open({
    walletId: "wallet-personal",
    mnemonic: MNEMONIC,
    accountNumber: getDefaultSparkAccountNumber(factory.network),
  })
}

function createNativeWallet(
  overrides: Partial<SparkNativeWallet> = {}
): SparkNativeWallet {
  return {
    on() {},
    off() {},
    async cleanup() {},
    async setPrivacyEnabled(enabled) {
      return { privateEnabled: enabled }
    },
    async getWalletSettings() {
      return { privateEnabled: true }
    },
    async getBalance() {
      return {
        balance: 0n,
        satsBalance: { available: 0n, owned: 0n, incoming: 0n },
      }
    },
    async getTransfers() {
      return { transfers: [], offset: 0 }
    },
    async getSparkAddress() {
      return "spark1receive"
    },
    async getTransfer() {
      return undefined
    },
    async getTransferFromSsp() {
      return undefined
    },
    async transfer(input) {
      return {
        id: "native-transfer",
        status: "TRANSFER_STATUS_COMPLETED",
        totalValue: input.amountSats,
        type: "TRANSFER",
        transferDirection: "OUTGOING",
      }
    },
    async createLightningInvoice() {
      return createLightningReceiveResult(makeReceiveInvoice())
    },
    async getLightningReceiveRequest() {
      return null
    },
    async getLightningSendFeeEstimate() {
      return 0
    },
    async payLightningInvoice() {
      return {
        id: "lightning-request",
        status: "LIGHTNING_PAYMENT_INITIATED",
        fee: { originalValue: 0, originalUnit: "SATOSHI" },
      }
    },
    async getLightningSendRequest() {
      return null
    },
    ...overrides,
  }
}

function makeLightningInvoice(
  paymentHashHex: string,
  amountSats?: number
): string {
  const paymentHash = Uint8Array.from(
    paymentHashHex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  )
  return makeBolt11Fixture({
    hrp: amountSats === undefined ? "lnbc" : `lnbc${amountSats * 10}n`,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(paymentHash),
      },
    ],
  })
}

function makeReceiveInvoice({
  amountSats,
  createdAt = 1_800_000_000,
  expirySeconds,
  network = "mainnet",
  includePaymentHash = true,
  descriptionFields = [],
}: {
  amountSats?: number
  createdAt?: number
  expirySeconds?: number
  network?: "mainnet" | "regtest"
  includePaymentHash?: boolean
  descriptionFields?: Bolt11FixtureField[]
} = {}): string {
  const prefix = network === "mainnet" ? "lnbc" : "lnbcrt"
  const hrp = amountSats === undefined ? prefix : `${prefix}${amountSats * 10}n`
  return makeBolt11Fixture({
    hrp,
    createdAt,
    fields: [
      ...(includePaymentHash
        ? [
            {
              tag: "p",
              words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
            },
          ]
        : []),
      ...descriptionFields,
      ...(expirySeconds === undefined
        ? []
        : [{ tag: "x", words: numberToBolt11Words(expirySeconds) }]),
    ],
  })
}

function createLightningReceiveResult(
  paymentRequest: string,
  overrides: {
    id?: string
    status?: string
    network?: string
    bitcoinNetwork?: string
    paymentHash?: string
    createdAt?: string
    expiresAt?: string
  } = {}
) {
  const metadata = decodeLightningInvoiceMetadata(paymentRequest)
  const invoiceNetwork = getLightningInvoiceNetwork(paymentRequest)
  const nativeNetwork = invoiceNetwork === "regtest" ? "REGTEST" : "MAINNET"
  const amount = decodeLightningInvoiceAmount(paymentRequest)
  return {
    id: overrides.id ?? "lightning-receive",
    status: overrides.status ?? "INVOICE_CREATED",
    network: overrides.network ?? nativeNetwork,
    invoice: {
      encodedInvoice: paymentRequest,
      bitcoinNetwork: overrides.bitcoinNetwork ?? nativeNetwork,
      paymentHash:
        overrides.paymentHash ??
        decodeLightningInvoicePaymentHash(paymentRequest) ??
        "07".repeat(32),
      amount: {
        originalValue: amount.sats ?? 0,
        originalUnit: "SATOSHI",
      },
      createdAt:
        overrides.createdAt ??
        new Date((metadata.createdAt ?? 0) * 1_000).toISOString(),
      expiresAt:
        overrides.expiresAt ??
        new Date((metadata.expiresAt ?? 0) * 1_000).toISOString(),
    },
  }
}

function numberToBolt11Words(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid BOLT11 numeric fixture")
  }
  const words: number[] = []
  let remaining = BigInt(value)
  do {
    words.unshift(Number(remaining & 31n))
    remaining >>= 5n
  } while (remaining > 0n)
  return words
}

function makeInvalidAmountReceiveInvoice(
  network: "mainnet" | "regtest"
): string {
  return makeBolt11Fixture({
    hrp: `${network === "mainnet" ? "lnbc" : "lnbcrt"}1p`,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
      },
    ],
  })
}
