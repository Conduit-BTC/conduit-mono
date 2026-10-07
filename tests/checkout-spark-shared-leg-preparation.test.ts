import { describe, expect, it } from "bun:test"
import { checkoutSparkSettledTimingForContext } from "../apps/market/src/lib/checkout-spark-local-router-canary"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { qualifiedReceiverInvoiceFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { CheckoutSparkLnurlInvoiceRangeError } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import {
  CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS,
  assertCheckoutSparkSettledBuyerPreparationWindow,
  assertCheckoutSparkSettledMerchantPreparationWindow,
  prepareCheckoutSparkSettledOutgoingLegShared,
} from "../packages/core/src/protocol/checkout-spark-settled-leg-preparation"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import {
  CheckoutSparkSettledRepositoryConflictError,
  type CheckoutSparkSettledRepositorySnapshot,
} from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 45 * 60_000
const MERCHANT = "a".repeat(64)
type ActiveSnapshot = Extract<
  CheckoutSparkSettledRepositorySnapshot,
  { status: "active" }
>
type Dependencies = Parameters<
  typeof prepareCheckoutSparkSettledOutgoingLegShared
>[1]

function signedInvoice(
  amountSats: number,
  hashByte: number,
  options: {
    network?: "mainnet" | "regtest"
    invalidSignature?: boolean
    expiresSeconds?: number
    createdAt?: number
  } = {}
) {
  return makeSignedBolt11Fixture({
    hrp: `${options.network === "regtest" ? "lnbcrt" : "lnbc"}${amountSats * 10}n`,
    createdAt: options.createdAt ?? CREATED_AT / 1_000,
    invalidSignature: options.invalidSignature,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      ...(options.expiresSeconds === undefined
        ? []
        : [
            {
              tag: "x",
              words: [options.expiresSeconds >> 5, options.expiresSeconds & 31],
            },
          ]),
    ],
  })
}

function creditedState(
  checkoutId = "shared-checkout"
): CheckoutSparkSettledReconciliation {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId,
    orderId: "shared-order",
    merchantPubkey: MERCHANT,
    walletId: "shared-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "shared-receive",
      paymentRequest: signedInvoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@receiver.conduit.cash",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "shared-funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1,
    }
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function harness(actor: "shopper" | "merchant" = "merchant") {
  let state = creditedState()
  let revision = 1
  let current = true
  let clock = actor === "merchant" ? TAKEOVER_AT : CREATED_AT + 1_000
  const invoiceRequests: Array<
    Parameters<NonNullable<Dependencies["resolveInvoice"]>>[0]
  > = []
  const feeRequests: Array<Parameters<Dependencies["estimateFee"]>[0]> = []
  const saves: CheckoutSparkSettledReconciliation[] = []
  const acknowledgements: CheckoutSparkSettledReconciliation[] = []
  const authorityChecks: CheckoutSparkSettledReconciliation[] = []
  const snapshot = (): ActiveSnapshot => ({ status: "active", revision, state })
  const dependencies: Dependencies = {
    repository: {
      load: async () => snapshot(),
      savePreparedWithInvoiceOrigin: async (
        next,
        expected,
        _evidence,
        assertCurrent
      ) => {
        assertCurrent?.()
        if (revision !== expected)
          throw new CheckoutSparkSettledRepositoryConflictError()
        state = next
        revision += 1
        saves.push(next)
        return snapshot()
      },
    },
    resolveInvoice: async (request) => {
      invoiceRequests.push(request)
      const hashByte = invoiceRequests.length + 3
      return resolveCheckoutSparkFixtureInvoice(
        request,
        qualifiedReceiverInvoiceFixture({
          lud16: request.lud16,
          amountSats: request.amountSats,
          paymentHash: hashByte.toString(16).padStart(2, "0").repeat(32),
          createdAt: CREATED_AT / 1_000,
        })
      )
    },
    estimateFee: async (request) => {
      feeRequests.push(request)
      return 5
    },
    assertAuthority: (candidate, nowMs) => {
      if (!current) throw new Error("Authenticated actor changed")
      authorityChecks.push(candidate)
      if (actor === "merchant")
        assertCheckoutSparkSettledMerchantPreparationWindow(candidate, nowMs)
      else assertCheckoutSparkSettledBuyerPreparationWindow(candidate, nowMs)
    },
    acknowledgeRecoverySnapshot: async (candidate) => {
      acknowledgements.push(candidate)
    },
    nowMs: () => clock,
  }
  const input = {
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    legId: state.plan.recipients[0]!.legId,
    shouldContinue: () => current,
  }
  return {
    input,
    dependencies,
    invoiceRequests,
    feeRequests,
    saves,
    acknowledgements,
    authorityChecks,
    getState: () => state,
    snapshot,
    setClock: (value: number) => {
      clock = value
    },
    revoke: () => {
      current = false
    },
    setState: (value: CheckoutSparkSettledReconciliation) => {
      state = value
      revision += 1
    },
  }
}

function frozenIntent(state: CheckoutSparkSettledReconciliation, hashByte = 9) {
  const leg = state.legs[0]!
  return prepareCheckoutSparkSettledLeg(state, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(state.plan, leg.legId),
    paymentRequest: signedInvoice(995, hashByte),
    paymentHash: hashByte.toString(16).padStart(2, "0").repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: CREATED_AT + 1_000,
  })
}

function configureInvoiceRange(
  test: ReturnType<typeof harness>,
  maximumMsats: number,
  minimumMsats = 1_000
) {
  const callbackAmounts: number[] = []
  test.dependencies.resolveInvoice = async (request) => {
    test.invoiceRequests.push(request)
    return resolveCheckoutSparkFixtureInvoice(
      request,
      qualifiedReceiverInvoiceFixture({
        lud16: request.lud16,
        amountSats: request.amountSats,
        paymentHash: (callbackAmounts.length + 4)
          .toString(16)
          .padStart(2, "0")
          .repeat(32),
        createdAt: request.nowSeconds,
      }),
      {
        minSendable: minimumMsats,
        maxSendable: maximumMsats,
        onInvoice: (amountMsats) => callbackAmounts.push(amountMsats / 1_000),
      }
    )
  }
  return callbackAmounts
}

describe("shared settled Spark payout preparation", () => {
  it("fee-probes within the endpoint maximum, then persists only the fee-fitted amount for either actor", async () => {
    for (const actor of ["shopper", "merchant"] as const) {
      const test = harness(actor)
      const original = test.getState()
      const callbackAmounts = configureInvoiceRange(test, 998_999)
      const result = await prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
      expect(test.invoiceRequests.map(({ amountSats }) => amountSats)).toEqual([
        999, 998, 995,
      ])
      expect(callbackAmounts).toEqual([998, 995])
      expect(test.feeRequests.map(({ amountSats }) => amountSats)).toEqual([
        998, 995,
      ])
      expect(result.state.plan).toEqual(original.plan)
      expect(result.state.legs[0]!.intent).toMatchObject({
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        transferId: deriveCheckoutSparkSettledTransferId(
          original.plan,
          test.input.legId
        ),
      })
      expect(result.state.legs[1]).toEqual(original.legs[1])
      expect(test.saves).toEqual([result.state])
      expect(test.acknowledgements).toEqual([result.state])
    }
  })

  it("does not turn endpoint capacity into a fee allowance or a partial completed leg", async () => {
    const test = harness()
    const original = test.getState()
    const callbackAmounts = configureInvoiceRange(test, 500_000)
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toBeInstanceOf(CheckoutSparkLnurlInvoiceRangeError)
    expect(test.invoiceRequests.map(({ amountSats }) => amountSats)).toEqual([
      999, 500,
    ])
    expect(callbackAmounts).toEqual([500])
    expect(test.feeRequests.map(({ amountSats }) => amountSats)).toEqual([500])
    expect(test.getState()).toEqual(original)
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
  })

  it("retains only already-quoted fee reserve when the fitted invoice has a lower fee", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 998_000)
    test.dependencies.estimateFee = async (request) => {
      test.feeRequests.push(request)
      return request.amountSats === 998 ? 5 : 3
    }
    const result = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(callbackAmounts).toEqual([998, 995])
    expect(result.state.legs[0]!.intent).toMatchObject({
      invoiceAmountSats: 995,
      maxFeeSats: 5,
    })
    expect(test.saves).toHaveLength(1)
  })

  it("can retain the probe itself only when its exact fee justifies the full reserve", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 998_000)
    test.dependencies.estimateFee = async (request) => {
      test.feeRequests.push(request)
      return 2
    }
    const result = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(callbackAmounts).toEqual([998])
    expect(result.state.legs[0]!.intent).toMatchObject({
      invoiceAmountSats: 998,
      maxFeeSats: 2,
    })
    expect(test.saves).toHaveLength(1)
  })

  it("leaves an allocation below the endpoint minimum unprepared without an invoice", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 2_000_000, 999_001)
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toBeInstanceOf(CheckoutSparkLnurlInvoiceRangeError)
    expect(test.invoiceRequests).toHaveLength(1)
    expect(callbackAmounts).toHaveLength(0)
    expect(test.feeRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
  })

  it("does not persist when quoted fees push the required amount below the rounded endpoint minimum", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 998_999, 995_001)
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toBeInstanceOf(CheckoutSparkLnurlInvoiceRangeError)
    expect(callbackAmounts).toEqual([998])
    expect(test.feeRequests).toHaveLength(1)
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
    expect(test.getState().legs[0]!.intent).toBeNull()
  })

  it("does not retry generic endpoint failure as a range probe", async () => {
    const test = harness()
    let calls = 0
    test.dependencies.resolveInvoice = async () => {
      calls += 1
      throw new Error(
        "Checkout Spark recipient payment endpoint is unavailable."
      )
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow("endpoint is unavailable")
    expect(calls).toBe(1)
    expect(test.feeRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
  })

  it("counts range discovery within the existing three resolution attempts", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 998_000)
    test.dependencies.estimateFee = async (request) => {
      test.feeRequests.push(request)
      return request.amountSats === 998 ? 5 : 7
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow("fee did not fit allocation")
    expect(test.invoiceRequests.map(({ amountSats }) => amountSats)).toEqual([
      999, 998, 995,
    ])
    expect(callbackAmounts).toEqual([998, 995])
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
  })

  it("does not start a probe after authority is revoked during the range read", async () => {
    const test = harness()
    const callbackAmounts = configureInvoiceRange(test, 998_000)
    const resolve = test.dependencies.resolveInvoice!
    test.dependencies.resolveInvoice = async (request) => {
      try {
        return await resolve(request)
      } finally {
        test.revoke()
      }
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow("authority changed")
    expect(test.invoiceRequests).toHaveLength(1)
    expect(callbackAmounts).toHaveLength(0)
    expect(test.feeRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
  })

  it("never consults a newly limited endpoint for an already saved invoice", async () => {
    const test = harness()
    const state = frozenIntent(test.getState())
    test.setState(state)
    const callbackAmounts = configureInvoiceRange(test, 500_000)
    const result = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(result.state.legs[0]!.intent).toEqual(state.legs[0]!.intent)
    expect(test.invoiceRequests).toHaveLength(0)
    expect(callbackAmounts).toHaveLength(0)
    expect(test.feeRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toEqual([state])
  })

  function configureShortInvoice(test: ReturnType<typeof harness>) {
    const issuedAt = test.dependencies.nowMs!()
    test.dependencies.resolveInvoice = async (request) => {
      test.invoiceRequests.push(request)
      return resolveCheckoutSparkFixtureInvoice(
        request,
        qualifiedReceiverInvoiceFixture({
          lud16: request.lud16,
          amountSats: request.amountSats,
          paymentHash: "07".repeat(32),
          createdAt: issuedAt / 1_000,
          expiresSeconds: 59,
        })
      )
    }
    return issuedAt + 59_000
  }

  it("prepares a 59-second invoice for either actor without changing the frozen plan or fee allocation", async () => {
    for (const actor of ["shopper", "merchant"] as const) {
      const test = harness(actor)
      configureShortInvoice(test)
      const original = test.getState()
      const result = await prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
      expect(result.state.plan).toEqual(original.plan)
      expect(result.state.legs[0]!.intent).toMatchObject({
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        transferId: deriveCheckoutSparkSettledTransferId(
          original.plan,
          test.input.legId
        ),
      })
      expect(test.saves).toHaveLength(1)
      expect(test.acknowledgements).toEqual([result.state])
    }
  })

  for (const seam of ["invoice", "fee", "reload"] as const) {
    it(`does not persist an invoice that reaches exact expiry during ${seam}`, async () => {
      const test = harness()
      const deadline = configureShortInvoice(test)
      if (seam === "invoice") {
        const original = test.dependencies.resolveInvoice!
        test.dependencies.resolveInvoice = async (request) => {
          const result = await original(request)
          test.setClock(deadline)
          return result
        }
      } else if (seam === "fee") {
        test.dependencies.estimateFee = async () => {
          test.setClock(deadline)
          return 1
        }
      } else {
        const original = test.dependencies.repository.load
        let reads = 0
        test.dependencies.repository.load = async (...args) => {
          const result = await original(...args)
          if (++reads === 2) test.setClock(deadline)
          return result
        }
      }
      await expect(
        prepareCheckoutSparkSettledOutgoingLegShared(
          test.input,
          test.dependencies
        )
      ).rejects.toThrow()
      expect(test.saves).toHaveLength(0)
      expect(test.acknowledgements).toHaveLength(0)
      expect(test.getState().legs[0]!.intent).toBeNull()
      if (seam === "invoice") expect(test.feeRequests).toHaveLength(0)
    })
  }

  it("retains the immutable intent if delivery crosses expiry instead of requesting another invoice", async () => {
    const test = harness()
    const deadline = configureShortInvoice(test)
    test.dependencies.acknowledgeRecoverySnapshot = async (state) => {
      test.acknowledgements.push(state)
      test.setClock(deadline)
    }
    const first = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    const requestCount = test.invoiceRequests.length
    const next = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(next.state.legs[0]!.intent).toEqual(first.state.legs[0]!.intent)
    expect(test.invoiceRequests).toHaveLength(requestCount)
    expect(test.saves).toHaveLength(1)
    expect(test.acknowledgements).toEqual([first.state, first.state])
  })

  it("prepares at merchant takeover under injected authority, without a send boundary", async () => {
    const test = harness()
    const original = test.getState()
    const result = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(test.authorityChecks.length).toBeGreaterThan(0)
    expect(test.invoiceRequests.map(({ amountSats }) => amountSats)).toEqual([
      999, 995,
    ])
    for (const request of test.invoiceRequests) {
      expect(request.lud16).toBe(original.plan.recipients[0]!.destination.value)
      expect(request.network).toBe(original.plan.network)
      expect(request.shouldContinue()).toBe(true)
    }
    expect(test.feeRequests.map(({ amountSats }) => amountSats)).toEqual([
      999, 995,
    ])
    expect(
      test.feeRequests.every(
        ({ walletId }) => walletId === original.plan.walletId
      )
    ).toBe(true)
    expect(result.state.plan).toEqual(original.plan)
    expect(result.state.legs[0]!.status).toBe("prepared")
    expect(result.state.legs[0]!.intent).toMatchObject({
      transferId: deriveCheckoutSparkSettledTransferId(
        original.plan,
        test.input.legId
      ),
      invoiceAmountSats: 995,
      maxFeeSats: 5,
    })
    expect(result.state.legs[1]).toEqual(original.legs[1])
    expect(test.saves).toEqual([result.state])
    expect(test.acknowledgements).toEqual([result.state])
  })

  it("rejects merchant preparation before handoff and permits the exact handoff instant", async () => {
    const test = harness()
    test.setClock(TAKEOVER_AT - 1)
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow()
    expect(test.invoiceRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
    test.setClock(TAKEOVER_AT)
    expect(
      (
        await prepareCheckoutSparkSettledOutgoingLegShared(
          test.input,
          test.dependencies
        )
      ).state.legs[0]!.status
    ).toBe("prepared")
  })

  it("retains the separate 60-second buyer preparation cutoff before handoff", async () => {
    expect(CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS).toBe(60_000)
    const cutoff = TAKEOVER_AT - CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS
    const before = harness("shopper")
    before.setClock(cutoff - 1)
    expect(
      (
        await prepareCheckoutSparkSettledOutgoingLegShared(
          before.input,
          before.dependencies
        )
      ).state.legs[0]!.status
    ).toBe("prepared")
    for (const now of [cutoff, TAKEOVER_AT]) {
      const test = harness("shopper")
      test.setClock(now)
      await expect(
        prepareCheckoutSparkSettledOutgoingLegShared(
          test.input,
          test.dependencies
        )
      ).rejects.toThrow()
      expect(test.invoiceRequests).toHaveLength(0)
      expect(test.saves).toHaveLength(0)
    }
  })

  it.each([false, true])(
    "respects a new plan's frozen handoff without shortening an existing plan (rehearsal: %s)",
    (rehearsal) => {
      const timing = checkoutSparkSettledTimingForContext({
        dev: rehearsal,
        flag: rehearsal ? "true" : undefined,
        hostname: rehearsal ? "127.0.0.1" : "shop.conduit.market",
        rehearsalFlag: rehearsal ? "true" : undefined,
        fastHandoffFlag: rehearsal ? "true" : undefined,
      })
      expect(timing.takeoverAfterMs).toBe((rehearsal ? 3 : 2) * 60_000)
      expect(timing.fundingExpirySecs).toBe((rehearsal ? 2 : 15) * 60)
      const original = creditedState()
      const demo = createCheckoutSparkSettledReconciliation(
        freezeCheckoutSparkSettledPlan({
          ...original.plan,
          takeoverAt: CREATED_AT + timing.takeoverAfterMs,
        })
      )
      const buyerCutoff = demo.plan.takeoverAt - 60_000
      expect(() =>
        assertCheckoutSparkSettledBuyerPreparationWindow(demo, buyerCutoff - 1)
      ).not.toThrow()
      expect(() =>
        assertCheckoutSparkSettledBuyerPreparationWindow(demo, buyerCutoff)
      ).toThrow("buyer payout authority has ended")
      expect(() =>
        assertCheckoutSparkSettledMerchantPreparationWindow(
          demo,
          demo.plan.takeoverAt - 1
        )
      ).toThrow("merchant payout authority has not begun")
      expect(() =>
        assertCheckoutSparkSettledMerchantPreparationWindow(
          demo,
          demo.plan.takeoverAt
        )
      ).not.toThrow()
      expect(original.plan.takeoverAt).toBe(TAKEOVER_AT)
      expect(() =>
        assertCheckoutSparkSettledMerchantPreparationWindow(
          original,
          demo.plan.takeoverAt
        )
      ).toThrow("merchant payout authority has not begun")
    }
  )

  for (const seam of ["load", "reload", "invoice", "fee", "save"] as const) {
    it(`rejects revoked authority while ${seam} is awaited without acknowledging a stale result`, async () => {
      const test = harness()
      const reached = deferred()
      const release = deferred()
      async function hold<T>(result: T): Promise<T> {
        reached.resolve()
        await release.promise
        return result
      }
      if (seam === "load" || seam === "reload") {
        const original = test.dependencies.repository.load
        let calls = 0
        test.dependencies.repository.load = async (...args) => {
          const result = await original(...args)
          calls += 1
          return calls === (seam === "load" ? 1 : 2) ? hold(result) : result
        }
      } else if (seam === "invoice") {
        const original = test.dependencies.resolveInvoice!
        test.dependencies.resolveInvoice = async (request) =>
          hold(await original(request))
      } else if (seam === "fee") {
        const original = test.dependencies.estimateFee
        test.dependencies.estimateFee = async (request) =>
          hold(await original(request))
      } else {
        const original =
          test.dependencies.repository.savePreparedWithInvoiceOrigin
        test.dependencies.repository.savePreparedWithInvoiceOrigin = async (
          ...args
        ) => hold(await original(...args))
      }
      const pending = prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
      await reached.promise
      test.revoke()
      release.resolve()
      await expect(pending).rejects.toThrow()
      expect(test.acknowledgements).toHaveLength(0)
      if (seam === "save") {
        // A completed durable write is retained, but is not handed to the old actor.
        expect(test.saves).toHaveLength(1)
        expect(test.getState().legs[0]!.status).toBe("prepared")
      } else {
        expect(test.saves).toHaveLength(0)
      }
      if (seam === "load") expect(test.invoiceRequests).toHaveLength(0)
    })
  }

  it("rechecks the buyer time boundary after the invoice await", async () => {
    const test = harness("shopper")
    const original = test.dependencies.resolveInvoice!
    test.dependencies.resolveInvoice = async (request) => {
      const result = await original(request)
      test.setClock(TAKEOVER_AT)
      return result
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow()
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
  })

  it("uses the durable save admission guard to reject revocation before commit", async () => {
    const test = harness()
    const reached = deferred()
    const release = deferred()
    const original = test.dependencies.repository.savePreparedWithInvoiceOrigin
    test.dependencies.repository.savePreparedWithInvoiceOrigin = async (
      ...args
    ) => {
      reached.resolve()
      await release.promise
      return original(...args)
    }
    const pending = prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    await reached.promise
    test.revoke()
    release.resolve()
    await expect(pending).rejects.toThrow()
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
    expect(test.getState().legs[0]!.intent).toBeNull()
  })

  it("rejects a different frozen checkout, digest, recipient, or missing credit before invoice work", async () => {
    for (const change of [
      "checkout",
      "digest",
      "recipient",
      "credit",
    ] as const) {
      const test = harness()
      if (change === "checkout") test.setState(creditedState("other-checkout"))
      if (change === "digest") test.input.planDigest = "e".repeat(64)
      if (change === "recipient") test.input.legId = "e".repeat(64)
      if (change === "credit")
        test.setState(
          createCheckoutSparkSettledReconciliation(test.getState().plan)
        )
      await expect(
        prepareCheckoutSparkSettledOutgoingLegShared(
          test.input,
          test.dependencies
        )
      ).rejects.toThrow()
      expect(test.invoiceRequests).toHaveLength(0)
      expect(test.feeRequests).toHaveLength(0)
      expect(test.saves).toHaveLength(0)
    }
  })

  it("validates canonical invoice amount, hash, network, signature, and lifetime before fee or persistence", async () => {
    for (const invalid of [
      "amount",
      "hash",
      "network",
      "signature",
      "expiry",
    ] as const) {
      const test = harness()
      test.dependencies.resolveInvoice = async (request) => ({
        paymentRequest: signedInvoice(
          request.amountSats + (invalid === "amount" ? 1 : 0),
          7,
          {
            network: invalid === "network" ? "regtest" : "mainnet",
            invalidSignature: invalid === "signature",
            ...(invalid === "expiry" ? { expiresSeconds: 59 } : {}),
          }
        ),
        paymentHash: (invalid === "hash" ? "08" : "07").repeat(32),
        // Returned metadata cannot override the signed BOLT11 fields.
        expiresAt: CREATED_AT / 1_000 + 3_600,
      })
      await expect(
        prepareCheckoutSparkSettledOutgoingLegShared(
          test.input,
          test.dependencies
        )
      ).rejects.toThrow()
      expect(test.feeRequests).toHaveLength(0)
      expect(test.saves).toHaveLength(0)
      expect(test.getState().legs[0]!.intent).toBeNull()
    }
  })

  it("never refreshes or replaces an existing expired or submitted invoice", async () => {
    for (const submitted of [false, true]) {
      const test = harness()
      let state = frozenIntent(test.getState())
      const intent = state.legs[0]!.intent!
      if (submitted)
        state = recordCheckoutSparkSettledLegStatus(state, {
          legId: intent.legId,
          transferId: intent.transferId,
          paymentHash: intent.paymentHash,
          status: "submitted",
          observedAt: CREATED_AT + 2_000,
        })
      test.setState(state)
      test.setClock(CREATED_AT + 7_200_000)
      const result = await prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
      expect(result.state.legs[0]!.intent).toEqual(intent)
      expect(result.state.legs[0]!.status).toBe(
        submitted ? "submitted" : "prepared"
      )
      expect(test.invoiceRequests).toHaveLength(0)
      expect(test.feeRequests).toHaveLength(0)
      expect(test.saves).toHaveLength(0)
      expect(test.acknowledgements).toEqual([state])
    }
  })

  it("leaves a legacy resolver result without local origin unprepared", async () => {
    const test = harness()
    const resolve = test.dependencies.resolveInvoice!
    test.dependencies.resolveInvoice = async (request) => {
      const invoice = await resolve(request)
      return {
        paymentRequest: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        expiresAt: invoice.expiresAt,
      }
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow("recipient is not verified on this device")
    expect(test.feeRequests).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
    expect(test.getState().legs[0]!.intent).toBeNull()
  })

  it("reuses the CAS winner without replacing its invoice or stable transfer ID", async () => {
    const test = harness()
    const winner = frozenIntent(test.getState(), 10)
    let attempts = 0
    test.dependencies.repository.savePreparedWithInvoiceOrigin = async () => {
      attempts += 1
      test.setState(winner)
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
    const result = await prepareCheckoutSparkSettledOutgoingLegShared(
      test.input,
      test.dependencies
    )
    expect(result.state).toEqual(winner)
    expect(result.state.legs[0]!.intent?.paymentHash).toBe("0a".repeat(32))
    expect(attempts).toBe(1)
    expect(test.invoiceRequests).toHaveLength(2)
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toEqual([winner])
  })

  it("cannot borrow another leg's allocation to cover a merchant fee", async () => {
    const test = harness()
    const original = test.getState()
    test.dependencies.estimateFee = async () =>
      original.legs[0]!.allocationSats!
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow()
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
    expect(test.getState()).toEqual(original)
  })

  it("bounds invoice resizing when fee estimates never fit", async () => {
    const test = harness()
    let estimate = 3
    test.dependencies.estimateFee = async () => {
      estimate += 2
      return estimate
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLegShared(
        test.input,
        test.dependencies
      )
    ).rejects.toThrow()
    expect(test.invoiceRequests.map(({ amountSats }) => amountSats)).toEqual([
      999, 995, 993,
    ])
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
  })
})
