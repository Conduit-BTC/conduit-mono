import type { WalletDescriptor } from "@conduit/core"
import type { CheckoutPaymentTarget } from "./payment-rails"

export interface CheckoutPaymentTargetOption {
  target: CheckoutPaymentTarget
  value: string
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

export function resolveCheckoutPaymentTarget(input: {
  selection: CheckoutPaymentTarget | null
  eligibleWallets: readonly WalletDescriptor[]
  weblnAvailable: boolean
}): CheckoutPaymentTarget {
  const preferredWallet = getPreferredWallet(input.eligibleWallets)
  if (input.selection) {
    return input.selection
  }
  if (preferredWallet) {
    return {
      type: "wallet",
      walletId: preferredWallet.id,
      providerId: preferredWallet.providerId,
    }
  }
  return input.weblnAvailable ? { type: "webln" } : { type: "manual" }
}

export function isCheckoutWalletTargetStale(input: {
  target: CheckoutPaymentTarget
  eligibleWallets: readonly WalletDescriptor[]
}): boolean {
  const target = input.target
  if (target.type !== "wallet") return false
  return !input.eligibleWallets.some(
    (wallet) =>
      wallet.id === target.walletId && wallet.providerId === target.providerId
  )
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
