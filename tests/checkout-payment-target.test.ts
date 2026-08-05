import { describe, expect, it } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"
import {
  getCheckoutPaymentTargetOptions,
  isCheckoutWalletTargetStale,
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

  it("marks only a missing exact wallet selection as stale", () => {
    const eligibleWallets = [wallet("reused-id", "nwc")]

    expect(
      isCheckoutWalletTargetStale({
        target: {
          type: "wallet",
          walletId: "reused-id",
          providerId: "spark",
        },
        eligibleWallets,
      })
    ).toBe(true)
    expect(
      isCheckoutWalletTargetStale({
        target: {
          type: "wallet",
          walletId: "reused-id",
          providerId: "nwc",
        },
        eligibleWallets,
      })
    ).toBe(false)
    expect(
      isCheckoutWalletTargetStale({
        target: { type: "manual" },
        eligibleWallets,
      })
    ).toBe(false)
  })
})
