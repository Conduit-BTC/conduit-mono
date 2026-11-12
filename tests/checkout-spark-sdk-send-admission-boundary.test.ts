import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  adaptFirstPartySparkWallet,
  loadFirstPartySparkModule,
  type SparkNativeModule,
  type SparkNativeWallet,
} from "../packages/core/src/wallets/spark-sdk"
import { CheckoutSparkOutgoingNotAdmittedError } from "../packages/core/src/protocol/checkout-spark-outgoing-admission"
import type { SparkCheckoutLightningObligationInput } from "../packages/core/src/wallets/spark-wallet"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

/**
 * Adapter-boundary proof, fully offline with a fake wallet: the typed
 * pre-admission signal can only arise BEFORE `payLightningInvoice`, and every
 * error at or after SDK entry stays possibly-sent (untyped). No wallet, network,
 * funds, or secrets are involved.
 */

const CREATED_AT_MS = 1_800_000_000_000
const AMOUNT_SATS = 1_000
const MAX_FEE_SATS = 10
const TRANSFER_ID = "11111111-1111-4111-8111-111111111111"
const PAYMENT_REQUEST = makeSignedBolt11Fixture({
  hrp: `lnbc${AMOUNT_SATS * 10}n`,
  createdAt: CREATED_AT_MS / 1_000,
  fields: [
    bolt11PaymentHashField(
      new Uint8Array(createHash("sha256").update("boundary-test").digest())
    ),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
  ],
})

type SdkModule = typeof import("@buildonspark/spark-sdk")
const SDK_PATH = "../packages/core/node_modules/@buildonspark/spark-sdk"

async function realModule() {
  // Real SDK classes (offline import) so SparkValidationError is the genuine one.
  const sdk = (await import(SDK_PATH)) as SdkModule
  const module = await loadFirstPartySparkModule(async () => sdk)
  return { sdk, module }
}

function setup(input: {
  module: SparkNativeModule
  payLightningInvoice: (request: unknown) => Promise<unknown>
}) {
  const calls = { pay: [] as unknown[] }
  const wallet = {
    // Exact-ID history: initial successful empty query.
    getTransferFromSsp: async () => undefined,
    getLightningSendFeeEstimate: async () => 1,
    payLightningInvoice: async (request: unknown) => {
      calls.pay.push(request)
      return input.payLightningInvoice(request)
    },
  } as unknown as SparkNativeWallet
  const client = adaptFirstPartySparkWallet({
    walletId: "wallet-1",
    wallet,
    module: input.module,
    network: "MAINNET",
    pollIntervalMs: 1,
    retirementReadTimeoutMs: 1,
    transferCompletionTimeoutSecs: 1,
    wait: async () => {},
    now: () => CREATED_AT_MS + 1_000,
  })
  const request = (
    assertBeforeSend?: () => Promise<void>
  ): SparkCheckoutLightningObligationInput => ({
    network: "mainnet",
    transferId: TRANSFER_ID,
    paymentRequest: PAYMENT_REQUEST,
    amountSats: AMOUNT_SATS,
    maxFeeSats: MAX_FEE_SATS,
    assertBeforeSend,
  })
  return { client, calls, request }
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown, error })
  )

describe("Spark SDK adapter pre-admission boundary", () => {
  it("types a throwing assertBeforeSend as not admitted with zero SDK sends", async () => {
    const { module } = await realModule()
    const { client, calls, request } = setup({
      module,
      payLightningInvoice: async () => {
        throw new Error("must never be reached")
      },
    })
    const guardFailure = new Error("authority ended")
    const { error } = await settle(
      client.sendCheckoutLightningObligation!(
        request(async () => {
          throw guardFailure
        })
      )
    )
    expect(error).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect((error as Error).cause).toBe(guardFailure)
    expect(calls.pay).toHaveLength(0)
  })

  it("preserves an already-typed guard error without re-wrapping", async () => {
    const { module } = await realModule()
    const { client, calls, request } = setup({
      module,
      payLightningInvoice: async () => {
        throw new Error("must never be reached")
      },
    })
    const typed = new CheckoutSparkOutgoingNotAdmittedError(new Error("x"))
    const { error } = await settle(
      client.sendCheckoutLightningObligation!(
        request(async () => {
          throw typed
        })
      )
    )
    expect(error).toBe(typed)
    expect(calls.pay).toHaveLength(0)
  })

  it("propagates a payLightningInvoice error untyped and possibly sent", async () => {
    const { module } = await realModule()
    const failure = new Error("connection dropped after SDK entry")
    let guards = 0
    const { client, calls, request } = setup({
      module,
      payLightningInvoice: async () => {
        throw failure
      },
    })
    const { value, error } = await settle(
      client.sendCheckoutLightningObligation!(
        request(async () => {
          guards += 1
        })
      )
    )
    expect(guards).toBe(1)
    expect(calls.pay).toHaveLength(1)
    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect(value).toBeUndefined() // never mapped to a not_sent result
  })

  it("maps only the exact pre-send fee-cap SparkValidationError to not_sent/fee_over_cap", async () => {
    const { sdk, module } = await realModule()
    const { client, calls, request } = setup({
      module,
      payLightningInvoice: async () => {
        throw new sdk.SparkValidationError(
          "maxFeeSats does not cover fee estimate (11 > 10)",
          { field: "maxFeeSats", value: MAX_FEE_SATS }
        )
      },
    })
    const { value, error } = await settle(
      client.sendCheckoutLightningObligation!(request(async () => {}))
    )
    expect(error).toBeUndefined()
    expect(value).toEqual({ status: "not_sent", reason: "fee_over_cap" })
    expect(calls.pay).toHaveLength(1)
  })

  const lookAlikes: Array<[string, (sdk: SdkModule) => unknown]> = [
    [
      "wrong field",
      (sdk) =>
        new sdk.SparkValidationError(
          "maxFeeSats does not cover fee estimate (11 > 10)",
          { field: "invoice" }
        ),
    ],
    [
      "missing field context",
      (sdk) =>
        new sdk.SparkValidationError(
          "maxFeeSats does not cover fee estimate (11 > 10)"
        ),
    ],
    [
      "wrong message",
      (sdk) =>
        new sdk.SparkValidationError("maxFeeSats must be positive", {
          field: "maxFeeSats",
        }),
    ],
    [
      "message prefix not at start",
      (sdk) =>
        new sdk.SparkValidationError(
          "error: maxFeeSats does not cover fee estimate",
          { field: "maxFeeSats" }
        ),
    ],
    [
      "right shape but not a SparkValidationError",
      () =>
        Object.assign(
          new Error("maxFeeSats does not cover fee estimate (11 > 10)"),
          { getContext: () => ({ field: "maxFeeSats" }) }
        ),
    ],
    [
      "different SparkError subclass",
      (sdk) =>
        new sdk.SparkRequestError(
          "maxFeeSats does not cover fee estimate (11 > 10)",
          { field: "maxFeeSats" }
        ),
    ],
  ]
  for (const [name, make] of lookAlikes) {
    it(`does not map a look-alike (${name}) to not_sent`, async () => {
      const { sdk, module } = await realModule()
      const failure = make(sdk)
      const { client, calls, request } = setup({
        module,
        payLightningInvoice: async () => {
          throw failure
        },
      })
      const { value, error } = await settle(
        client.sendCheckoutLightningObligation!(request(async () => {}))
      )
      expect(calls.pay).toHaveLength(1)
      expect(value).toBeUndefined()
      expect(error).toBe(failure)
      expect(error).not.toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    })
  }
})
