import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"

import { checkoutSparkProviderSendWindowEndsAt } from "../packages/core/src/protocol/checkout-spark-invoice-expiry"
import { CheckoutSparkInvoiceOriginUnavailableError } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import { checkoutSparkSettledOutgoingStatusObservation } from "../packages/core/src/protocol/checkout-spark-settled-outgoing-history"
import {
  createCheckoutSparkSettledNativeOutgoingProvider,
  type CheckoutSparkSettledNativeOutgoingWallet,
} from "../packages/core/src/protocol/checkout-spark-settled-native-outgoing"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
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
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from("11".repeat(32), "hex"))
  .digest("hex")

function invoice(
  amountSats: number,
  paymentHash: string,
  lifetimeSeconds = 3_600
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(Buffer.from(paymentHash, "hex")),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      {
        tag: "x",
        words: Array.from(lifetimeSeconds.toString(32), (digit) =>
          Number.parseInt(digit, 32)
        ),
      },
    ],
  })
}

function fixture(outgoingLifetimeSeconds = 3_600) {
  const merchant = "a".repeat(64)
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "native-provider-checkout",
    orderId: "native-provider-order",
    merchantPubkey: merchant,
    walletId: "native-provider-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchant}:native-provider-fixture`,
          productEventId: "b".repeat(64),
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-native-provider",
      paymentRequest: invoice(1_113, "03".repeat(32)),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
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
  const legId = plan.recipients[0]!.legId
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    legId,
    recipientId: merchant,
    allocationSats: 1_000,
    unpaidAllocationSats: 1_111,
    intent: {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentRequest: invoice(995, PAYMENT_HASH, outgoingLifetimeSeconds),
      paymentHash: PAYMENT_HASH,
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: CREATED_AT + 2,
    },
  }
  return { plan, target }
}

function wallet(
  overrides: Partial<CheckoutSparkSettledNativeOutgoingWallet> = {}
): CheckoutSparkSettledNativeOutgoingWallet {
  return {
    getAvailableSats: async () => 1_111n,
    estimateFee: async () => 4,
    sendFrozen: async () => undefined,
    ...overrides,
  }
}

function observation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: "not_found" | "pending" | "conflicting_evidence"
): CheckoutSparkSettledOutgoingObservation {
  return checkoutSparkSettledOutgoingStatusObservation(target, status)
}

function heldBoundary() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    started,
    release,
    async wait() {
      entered()
      await held
    },
  }
}

describe("native settled Spark outgoing provider", () => {
  it("keeps missing local recipient origin history-only without balance, fee, or send work", async () => {
    const { plan, target } = fixture()
    const calls: string[] = []
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        getAvailableSats: async () => {
          calls.push("balance")
          return 1_111n
        },
        estimateFee: async () => {
          calls.push("fee")
          return 4
        },
        sendFrozen: async () => {
          calls.push("send")
        },
      }),
      reconcile: async () => {
        calls.push("history")
        return observation(target, "not_found")
      },
      assertBeforeSend: () => {
        throw new CheckoutSparkInvoiceOriginUnavailableError()
      },
      now: () => CREATED_AT + 3,
    })
    expect(await provider.preflight(target)).toBe("recipient_unverified")
    expect(await provider.reconcile(target)).toMatchObject({
      status: "not_found",
    })
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(calls).toEqual(["history", "history"])
  })

  it("preserves exact provider-paid history even when local origin is unavailable", async () => {
    const { plan, target } = fixture()
    const paid: CheckoutSparkSettledOutgoingObservation = {
      ...observation(target, "not_found"),
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: 999,
    }
    let sendCalls = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sendCalls += 1
        },
      }),
      reconcile: async () => paid,
      assertBeforeSend: () => {
        throw new CheckoutSparkInvoiceOriginUnavailableError()
      },
      now: () => CREATED_AT + 3,
    })
    expect(await provider.reconcile(target)).toEqual(paid)
    expect(await provider.send(target)).toEqual(paid)
    expect(sendCalls).toBe(0)
  })

  it("sends an exact 59-second invoice before expiry without a one-minute buffer", async () => {
    const { plan, target } = fixture(59)
    const expiresAt = CREATED_AT + 59_000
    let now = CREATED_AT + 1_000
    const sent: unknown[] = []
    let reads = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async (request) => {
          sent.push(request)
        },
      }),
      reconcile: async () => {
        reads += 1
        return reads === 3
          ? {
              ...observation(target, "not_found"),
              status: "paid",
              finalFeeSats: 4,
              finalDebitSats: 999,
            }
          : observation(target, "not_found")
      },
      assertBeforeSend: () => {},
      now: () => now,
    })

    expect(
      checkoutSparkProviderSendWindowEndsAt(target.intent.paymentRequest)
    ).toBe(expiresAt)
    expect(await provider.preflight(target)).toBe("ready")
    now = expiresAt - 1
    expect(await provider.send(target)).toMatchObject({ status: "paid" })
    expect(sent).toEqual([
      {
        paymentRequest: target.intent.paymentRequest,
        maxFeeSats: target.intent.maxFeeSats,
        transferId: target.intent.transferId,
      },
    ])
    expect(reads).toBe(3)
  })

  for (const boundary of ["balance", "fee"] as const) {
    it(`fails preflight when the invoice expires during the awaited ${boundary} read`, async () => {
      const { plan, target } = fixture()
      const held = heldBoundary()
      let now = CREATED_AT + 1_000
      let sends = 0
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          getAvailableSats: async () => {
            if (boundary === "balance") await held.wait()
            return 1_111n
          },
          estimateFee: async () => {
            if (boundary === "fee") await held.wait()
            return 4
          },
          sendFrozen: async () => {
            sends += 1
          },
        }),
        reconcile: async () => observation(target, "not_found"),
        assertBeforeSend: () => {},
        now: () => now,
      })

      const pending = provider.preflight(target)
      await held.started
      now = CREATED_AT + 3_600_000
      held.release()
      expect(await pending).toBe("unavailable")
      expect(await provider.send(target)).toEqual({ status: "not_sent" })
      expect(sends).toBe(0)
    })
  }

  for (const boundary of [
    "initial_history",
    "final_history",
    "final_balance",
    "final_authority",
  ] as const) {
    it(`does not enter the SDK when exact expiry arrives during ${boundary}`, async () => {
      const { plan, target } = fixture()
      const held = heldBoundary()
      let now = CREATED_AT + 1_000
      let historyReads = 0
      let balanceReads = 0
      let authorityChecks = 0
      let sends = 0
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          getAvailableSats: async () => {
            balanceReads += 1
            if (boundary === "final_balance" && balanceReads === 3)
              await held.wait()
            return 1_111n
          },
          sendFrozen: async () => {
            sends += 1
          },
        }),
        reconcile: async () => {
          historyReads += 1
          if (
            (boundary === "initial_history" && historyReads === 1) ||
            (boundary === "final_history" && historyReads === 2)
          )
            await held.wait()
          return observation(target, "not_found")
        },
        assertBeforeSend: async () => {
          authorityChecks += 1
          if (boundary === "final_authority" && authorityChecks === 6)
            await held.wait()
        },
        now: () => now,
      })

      const pending = provider.send(target)
      await held.started
      expect(sends).toBe(0)
      now = CREATED_AT + 3_600_000
      held.release()
      expect(await pending).toEqual({ status: "not_sent" })
      expect(historyReads).toBe(boundary === "initial_history" ? 1 : 2)
      expect(sends).toBe(0)
    })
  }

  for (const postSendHistory of ["not_found", "unavailable"] as const) {
    it(`preserves a send that throws after expiry as pending when readback is ${postSendHistory}`, async () => {
      const { plan, target } = fixture()
      const held = heldBoundary()
      let now = CREATED_AT + 1_000
      let reads = 0
      const sent: unknown[] = []
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          sendFrozen: async (request) => {
            sent.push(request)
            await held.wait()
            throw new Error("Synthetic submission result unavailable")
          },
        }),
        reconcile: async () => {
          reads += 1
          if (reads === 3 && postSendHistory === "unavailable")
            throw new Error("Synthetic history unavailable")
          return observation(target, "not_found")
        },
        assertBeforeSend: () => {},
        now: () => now,
      })

      const pending = provider.send(target)
      await held.started
      now = CREATED_AT + 3_600_000
      held.release()
      expect(await pending).toEqual(observation(target, "pending"))
      expect(reads).toBe(3)
      expect(await provider.preflight(target)).toBe("unavailable")
      expect(await provider.send(target)).toEqual({ status: "not_sent" })
      expect(sent).toEqual([
        {
          paymentRequest: target.intent.paymentRequest,
          maxFeeSats: target.intent.maxFeeSats,
          transferId: target.intent.transferId,
        },
      ])
    })
  }

  it("accepts late exact paid evidence after invoice expiry without sending again", async () => {
    const { plan, target } = fixture()
    const held = heldBoundary()
    let now = CREATED_AT + 1_000
    let reads = 0
    let sends = 0
    const paid: CheckoutSparkSettledOutgoingObservation = {
      ...observation(target, "not_found"),
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: 999,
    }
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sends += 1
          await held.wait()
          throw new Error("Synthetic submission response lost")
        },
      }),
      reconcile: async () => {
        reads += 1
        return reads < 3 ? observation(target, "not_found") : paid
      },
      assertBeforeSend: () => {},
      now: () => now,
    })

    const pending = provider.send(target)
    await held.started
    now = CREATED_AT + 3_600_001
    held.release()
    expect(await pending).toEqual(paid)
    expect(await provider.reconcile(target)).toEqual(paid)
    expect(await provider.send(target)).toEqual(paid)
    expect(sends).toBe(1)
  })

  it("sends only the frozen invoice, fee cap and transfer ID, then trusts exact readback", async () => {
    const { plan, target } = fixture()
    const sent: unknown[] = []
    let reads = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async (input) => {
          sent.push(input)
          return { status: "completed", finalFeeSats: 0 }
        },
      }),
      reconcile: async () => {
        reads += 1
        return reads === 3
          ? {
              ...observation(target, "not_found"),
              status: "paid",
              finalFeeSats: 4,
              finalDebitSats: 999,
            }
          : observation(target, "not_found")
      },
      assertBeforeSend: () => {},
      now: () => CREATED_AT + 1_000,
    })

    expect(await provider.preflight(target)).toBe("ready")
    expect(await provider.send(target)).toMatchObject({
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: 999,
    })
    expect(sent).toEqual([
      {
        paymentRequest: target.intent.paymentRequest,
        maxFeeSats: target.intent.maxFeeSats,
        transferId: target.intent.transferId,
      },
    ])
    expect(reads).toBe(3)
  })

  it.each([5, 6])(
    "fits the current fee only inside the recipient's frozen cap: %s",
    async (feeSats) => {
      const { plan, target } = fixture()
      let sends = 0
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          estimateFee: async () => feeSats,
          sendFrozen: async () => {
            sends += 1
          },
        }),
        reconcile: async () => observation(target, "not_found"),
        assertBeforeSend: () => {},
        now: () => CREATED_AT + 1_000,
      })
      expect(await provider.preflight(target)).toBe(
        feeSats === 5 ? "ready" : "fee_over_cap"
      )
      expect((await provider.send(target)).status).toBe(
        feeSats === 5 ? "pending" : "not_sent"
      )
      expect(sends).toBe(feeSats === 5 ? 1 : 0)
    }
  )

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null])(
    "does not enter the SDK for unavailable or malformed fee estimate %s",
    async (feeSats) => {
      const { plan, target } = fixture()
      let sends = 0
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          estimateFee: async () => {
            if (feeSats === null) throw new Error("Fee unavailable")
            return feeSats
          },
          sendFrozen: async () => {
            sends++
          },
        }),
        reconcile: async () => observation(target, "not_found"),
        assertBeforeSend: () => {},
        now: () => CREATED_AT + 1_000,
      })
      expect(await provider.preflight(target)).toBe("unavailable")
      expect((await provider.send(target)).status).toBe("not_sent")
      expect(sends).toBe(0)
    }
  )

  it("rechecks the invoice window after an asynchronous fee estimate", async () => {
    const { plan, target } = fixture()
    const windowEnd = checkoutSparkProviderSendWindowEndsAt(
      target.intent.paymentRequest
    )!
    let now = CREATED_AT + 1_000
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        estimateFee: async () => {
          now = windowEnd
          return 4
        },
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => observation(target, "not_found"),
      assertBeforeSend: () => {},
      now: () => now,
    })
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(sends).toBe(0)
  })

  it("rechecks every unpaid share after fresh exact history", async () => {
    const { plan, target } = fixture()
    let funds = 1_111n
    let reads = 0
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        getAvailableSats: async () => funds,
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => {
        reads += 1
        if (reads === 2) funds = 1_110n
        return observation(target, "not_found")
      },
      assertBeforeSend: () => {},
      now: () => CREATED_AT + 1_000,
    })
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(reads).toBe(2)
    expect(sends).toBe(0)
  })

  it("rechecks actor authority after an awaited history lookup", async () => {
    const { plan, target } = fixture()
    let currentActor = true
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => {
        currentActor = false
        return observation(target, "not_found")
      },
      assertBeforeSend: () => {
        if (!currentActor) throw new Error("actor authority changed")
      },
      now: () => CREATED_AT + 1_000,
    })
    await expect(provider.send(target)).rejects.toThrow(
      "actor authority changed"
    )
    expect(sends).toBe(0)
  })

  it("does not send if the invoice expires during the final exact lookup", async () => {
    const { plan, target } = fixture()
    const windowEnd = checkoutSparkProviderSendWindowEndsAt(
      target.intent.paymentRequest
    )!
    let now = CREATED_AT + 1_000
    let reads = 0
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => {
        reads += 1
        if (reads === 2) now = windowEnd
        return observation(target, "not_found")
      },
      assertBeforeSend: () => {},
      now: () => now,
    })
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(reads).toBe(2)
    expect(sends).toBe(0)
  })

  for (const status of ["pending", "paid", "conflicting_evidence"] as const) {
    it(`does not re-send when exact history is ${status}`, async () => {
      const { plan, target } = fixture()
      let sends = 0
      const history: CheckoutSparkSettledOutgoingObservation =
        status === "paid"
          ? {
              ...observation(target, "not_found"),
              status: "paid",
              finalFeeSats: 4,
              finalDebitSats: 999,
            }
          : observation(target, status)
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet({
          sendFrozen: async () => {
            sends += 1
          },
        }),
        reconcile: async () => history,
        assertBeforeSend: () => {},
        now: () => CREATED_AT + 1_000,
      })
      expect(await provider.send(target)).toEqual(history)
      expect(sends).toBe(0)
    })
  }

  it("does not send when a later exact read finds a pending transfer", async () => {
    const { plan, target } = fixture()
    let reads = 0
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => {
        reads += 1
        return observation(target, reads === 1 ? "not_found" : "pending")
      },
      assertBeforeSend: () => {},
      now: () => CREATED_AT + 1_000,
    })
    expect((await provider.send(target)).status).toBe("pending")
    expect(sends).toBe(0)
  })

  it("keeps a thrown or unobserved send pending under the same transfer ID", async () => {
    const { plan, target } = fixture()
    const sentIds: string[] = []
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async ({ transferId }) => {
          sentIds.push(transferId)
          throw new Error("timed out after provider submission")
        },
      }),
      reconcile: async () => observation(target, "not_found"),
      assertBeforeSend: () => {},
      now: () => CREATED_AT + 1_000,
    })
    expect((await provider.send(target)).status).toBe("pending")
    expect(sentIds).toEqual([target.intent.transferId])
  })

  it("rejects a changed target before reading or sending", async () => {
    const { plan, target } = fixture()
    let historyReads = 0
    let sends = 0
    const provider = createCheckoutSparkSettledNativeOutgoingProvider({
      plan,
      wallet: wallet({
        sendFrozen: async () => {
          sends += 1
        },
      }),
      reconcile: async () => {
        historyReads += 1
        return observation(target, "not_found")
      },
      assertBeforeSend: () => {},
      now: () => CREATED_AT + 1_000,
    })
    await expect(
      provider.send({
        ...target,
        intent: { ...target.intent, transferId: "replacement" },
      })
    ).rejects.toThrow("differs from its plan")
    expect(historyReads).toBe(0)
    expect(sends).toBe(0)
  })
})
