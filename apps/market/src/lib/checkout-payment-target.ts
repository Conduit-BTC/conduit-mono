import type {
  OrderPaymentTarget,
  ShopperPaymentRail,
  WalletDescriptor,
} from "@conduit/core"
import type { CheckoutPaymentTarget } from "./payment-rails"

export interface CheckoutPaymentTargetOption {
  target: CheckoutPaymentTarget
  value: string
}

/** Persist an automatic rail only after its final click-time readiness check. */
export function getCheckoutOrderPaymentTarget(input: {
  selectedTarget: CheckoutPaymentTarget
  canAutoPay: boolean
  isGuest: boolean
}): OrderPaymentTarget {
  if (input.isGuest || !input.canAutoPay) return { type: "manual" }
  return input.selectedTarget
}

function getPreferredWallet(
  eligibleWallets: readonly WalletDescriptor[]
): WalletDescriptor | null {
  return (
    eligibleWallets.find((wallet) =>
      wallet.defaultIntents.includes("pay_invoice")
    ) ??
    eligibleWallets[0] ??
    null
  )
}

function getPreferredNwcWallet(
  eligibleWallets: readonly WalletDescriptor[]
): WalletDescriptor | null {
  return getPreferredWallet(
    eligibleWallets.filter((wallet) => wallet.providerId === "nwc")
  )
}

function getAutomaticPaymentTarget(input: {
  eligibleWallets: readonly WalletDescriptor[]
  weblnAvailable: boolean
}): CheckoutPaymentTarget {
  const preferredWallet = getPreferredWallet(input.eligibleWallets)
  if (preferredWallet) {
    return {
      type: "wallet",
      walletId: preferredWallet.id,
      providerId: preferredWallet.providerId,
    }
  }
  return input.weblnAvailable ? { type: "webln" } : { type: "manual" }
}

export function resolveCheckoutPaymentTarget(input: {
  selection: CheckoutPaymentTarget | null
  preferredRail?: ShopperPaymentRail
  eligibleWallets: readonly WalletDescriptor[]
  weblnAvailable: boolean
}): CheckoutPaymentTarget {
  if (input.selection) {
    return input.selection
  }

  if (input.preferredRail === "manual") return { type: "manual" }
  if (input.preferredRail === "webln") {
    if (input.weblnAvailable) return { type: "webln" }
  }
  if (input.preferredRail === "nwc") {
    const preferredNwcWallet = getPreferredNwcWallet(input.eligibleWallets)
    if (preferredNwcWallet) {
      return {
        type: "wallet",
        walletId: preferredNwcWallet.id,
        providerId: preferredNwcWallet.providerId,
      }
    }
  }

  return getAutomaticPaymentTarget(input)
}

export function getCheckoutPaymentTargetValue(
  target: CheckoutPaymentTarget
): string {
  if (target.type !== "wallet") return target.type
  return `wallet:${encodeURIComponent(target.providerId)}:${encodeURIComponent(target.walletId)}`
}

export function getCheckoutPaymentTargetOptions(input: {
  eligibleWallets: readonly WalletDescriptor[]
  selectedTarget: CheckoutPaymentTarget
  weblnAvailable: boolean
}): CheckoutPaymentTargetOption[] {
  const options: CheckoutPaymentTargetOption[] = input.eligibleWallets.map(
    (wallet) => {
      const target: CheckoutPaymentTarget = {
        type: "wallet",
        walletId: wallet.id,
        providerId: wallet.providerId,
      }
      return {
        target,
        value: getCheckoutPaymentTargetValue(target),
      }
    }
  )

  if (input.weblnAvailable || input.selectedTarget.type === "webln") {
    const target: CheckoutPaymentTarget = { type: "webln" }
    options.push({
      target,
      value: getCheckoutPaymentTargetValue(target),
    })
  }

  const manualTarget: CheckoutPaymentTarget = { type: "manual" }
  options.push({
    target: manualTarget,
    value: getCheckoutPaymentTargetValue(manualTarget),
  })

  return options
}
