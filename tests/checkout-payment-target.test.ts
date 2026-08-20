import { describe, expect, it } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"
import {
  getCheckoutOrderPaymentTarget,
  getCheckoutPaymentTargetOptions,
  resolveCheckoutPaymentTarget,
} from "../apps/market/src/lib/checkout-payment-target"

function wallet(
  id: string,
  providerId: WalletDescriptor["providerId"],
  options: { isDefault?: boolean } = {}
): WalletDescriptor {
  return {
    id,
    kind: providerId === "nwc" ? "connected" : "portable",
    providerId,
    label: id,
    network: "mainnet",
    capabilities: ["pay_invoice"],
    status: "ready",
    defaultIntents: options.isDefault ? ["pay_invoice"] : [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("checkout payment target selection", () => {
  it("stores manual payment when the selected wallet cannot auto-pay", () => {
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: {
          type: "wallet",
          walletId: "spark-personal",
          providerId: "spark",
        },
        canAutoPay: false,
        isGuest: false,
      })
    ).toEqual({ type: "manual" })
  })

  it("stores the exact selected wallet when it can auto-pay", () => {
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: {
          type: "wallet",
          walletId: "spark-personal",
          providerId: "spark",
        },
        canAutoPay: true,
        isGuest: false,
      })
    ).toEqual({
      type: "wallet",
      walletId: "spark-personal",
      providerId: "spark",
    })
  })

  it("stores manual payment for a guest even if a wallet appears capable", () => {
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: { type: "webln" },
        canAutoPay: true,
        isGuest: true,
      })
    ).toEqual({ type: "manual" })
  })

  it("stores manual payment when WebLN disappears before submission", () => {
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: { type: "webln" },
        canAutoPay: false,
        isGuest: false,
      })
    ).toEqual({ type: "manual" })
  })

  it("keeps an explicit manual selection manual", () => {
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: { type: "manual" },
        canAutoPay: false,
        isGuest: false,
      })
    ).toEqual({ type: "manual" })
  })

  it("preselects the eligible default wallet with its exact provider identity", () => {
    const target = resolveCheckoutPaymentTarget({
      selection: null,
      eligibleWallets: [
        wallet("spark-personal", "spark"),
        wallet("zeus", "nwc", { isDefault: true }),
      ],
      weblnAvailable: true,
    })

    expect(target).toEqual({
      type: "wallet",
      walletId: "zeus",
      providerId: "nwc",
    })
  })

  it("keeps explicit WebLN selected while offering every saved wallet", () => {
    const eligibleWallets = [
      wallet("spark-personal", "spark", { isDefault: true }),
      wallet("zeus", "nwc"),
    ]
    const selectedTarget = resolveCheckoutPaymentTarget({
      selection: { type: "webln" },
      eligibleWallets,
      weblnAvailable: true,
    })

    expect(selectedTarget).toEqual({ type: "webln" })
    expect(
      getCheckoutPaymentTargetOptions({
        eligibleWallets,
        selectedTarget,
        weblnAvailable: true,
      }).map((option) => option.target)
    ).toEqual([
      {
        type: "wallet",
        walletId: "spark-personal",
        providerId: "spark",
      },
      { type: "wallet", walletId: "zeus", providerId: "nwc" },
      { type: "webln" },
      { type: "manual" },
    ])
  })

  it("keeps selected WebLN visible but unavailable after the bridge disappears", () => {
    expect(
      getCheckoutPaymentTargetOptions({
        eligibleWallets: [],
        selectedTarget: { type: "webln" },
        weblnAvailable: false,
      }).map((option) => option.target)
    ).toEqual([{ type: "webln" }, { type: "manual" }])
  })

  it("offers only manual payment when no automatic target is available", () => {
    expect(
      getCheckoutPaymentTargetOptions({
        eligibleWallets: [],
        selectedTarget: { type: "manual" },
        weblnAvailable: false,
      }).map((option) => option.target)
    ).toEqual([{ type: "manual" }])
  })

  it("keeps manual payment explicit when automatic targets are available", () => {
    expect(
      resolveCheckoutPaymentTarget({
        selection: { type: "manual" },
        eligibleWallets: [
          wallet("spark-personal", "spark", { isDefault: true }),
        ],
        weblnAvailable: true,
      })
    ).toEqual({ type: "manual" })
  })

  it("preserves a stale exact wallet target until the buyer explicitly reselects", () => {
    expect(
      resolveCheckoutPaymentTarget({
        selection: {
          type: "wallet",
          walletId: "reused-id",
          providerId: "spark",
        },
        eligibleWallets: [
          wallet("reused-id", "nwc"),
          wallet("spark-current", "spark", { isDefault: true }),
        ],
        weblnAvailable: true,
      })
    ).toEqual({
      type: "wallet",
      walletId: "reused-id",
      providerId: "spark",
    })
  })
})
