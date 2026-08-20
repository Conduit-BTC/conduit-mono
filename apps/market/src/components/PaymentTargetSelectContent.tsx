import type { WalletDescriptor } from "@conduit/core"
import { SelectContent, SelectItem, SelectValue } from "@conduit/ui"
import type { CheckoutPaymentTargetOption } from "../lib/checkout-payment-target"
import { getWalletProviderDescription } from "../lib/wallet-provider-label"

interface PaymentTargetPresentationInput {
  target: CheckoutPaymentTargetOption["target"]
  eligibleWallets: readonly WalletDescriptor[]
  walletDisplayLabels: ReadonlyMap<string, string>
  weblnAvailable: boolean
  showDefaultBadge: boolean
}

interface PaymentTargetPresentation {
  label: string
  showDefaultBadge: boolean
  wallet: WalletDescriptor | null
}

interface PaymentTargetSelectContentProps {
  options: readonly CheckoutPaymentTargetOption[]
  eligibleWallets: readonly WalletDescriptor[]
  walletDisplayLabels: ReadonlyMap<string, string>
  staleWalletValue: string | null
  weblnAvailable: boolean
  showDefaultBadge?: boolean
}

interface PaymentTargetSelectValueProps {
  target: CheckoutPaymentTargetOption["target"] | null
  eligibleWallets: readonly WalletDescriptor[]
  walletDisplayLabels: ReadonlyMap<string, string>
  weblnAvailable: boolean
  showDefaultBadge?: boolean
  placeholder?: string
}

export const PAYMENT_TARGET_SELECT_TRIGGER_CLASS_NAME =
  "[&>span]:min-w-0 [&>span]:flex-1 [&>span]:basis-0 [&>span]:overflow-hidden"

function getPaymentTargetPresentation({
  target,
  eligibleWallets,
  walletDisplayLabels,
  weblnAvailable,
  showDefaultBadge,
}: PaymentTargetPresentationInput): PaymentTargetPresentation {
  if (target.type === "wallet") {
    const wallet = eligibleWallets.find(
      (candidate) =>
        candidate.id === target.walletId &&
        candidate.providerId === target.providerId
    )
    if (!wallet) {
      return {
        label: "Previously selected wallet (unavailable)",
        showDefaultBadge: false,
        wallet: null,
      }
    }

    const displayLabel = walletDisplayLabels.get(wallet.id) ?? wallet.label
    return {
      label: `${displayLabel} (${getWalletProviderDescription(wallet)})`,
      showDefaultBadge:
        showDefaultBadge && wallet.defaultIntents.includes("pay_invoice"),
      wallet,
    }
  }

  if (target.type === "webln") {
    return {
      label: `Browser wallet (WebLN)${weblnAvailable ? "" : ", unavailable"}`,
      showDefaultBadge: false,
      wallet: null,
    }
  }

  return {
    label: "Show invoice for manual payment",
    showDefaultBadge: false,
    wallet: null,
  }
}

export function PaymentTargetSelectValue({
  target,
  eligibleWallets,
  walletDisplayLabels,
  weblnAvailable,
  showDefaultBadge = false,
  placeholder,
}: PaymentTargetSelectValueProps) {
  const presentation = target
    ? getPaymentTargetPresentation({
        target,
        eligibleWallets,
        walletDisplayLabels,
        weblnAvailable,
        showDefaultBadge,
      })
    : null

  return (
    <SelectValue placeholder={placeholder}>
      {presentation ? (
        <span className="flex w-full max-w-full min-w-0 items-center gap-2 overflow-hidden">
          <span className="w-0 min-w-0 flex-1 truncate">
            {presentation.label}
          </span>
          {presentation.showDefaultBadge && (
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              Default
            </span>
          )}
        </span>
      ) : (
        ""
      )}
    </SelectValue>
  )
}

export function PaymentTargetSelectContent({
  options,
  eligibleWallets,
  walletDisplayLabels,
  staleWalletValue,
  weblnAvailable,
  showDefaultBadge = false,
}: PaymentTargetSelectContentProps) {
  return (
    <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] [&_[data-radix-select-viewport]]:box-border [&_[data-radix-select-viewport]]:w-[var(--radix-select-trigger-width)] [&_[data-radix-select-viewport]]:min-w-0 [&_[data-radix-select-viewport]]:max-w-[calc(100vw-2rem)]">
      {staleWalletValue !== null && (
        <SelectItem
          value={staleWalletValue}
          textValue="Previously selected wallet (unavailable)"
          disabled
        >
          Previously selected wallet (unavailable)
        </SelectItem>
      )}
      {options.map((option) => {
        const target = option.target
        const presentation = getPaymentTargetPresentation({
          target,
          eligibleWallets,
          walletDisplayLabels,
          weblnAvailable,
          showDefaultBadge,
        })
        if (target.type === "wallet") {
          const wallet = presentation.wallet
          if (!wallet) return null

          return (
            <SelectItem
              key={option.value}
              value={option.value}
              textValue={`${presentation.label}${
                presentation.showDefaultBadge ? ", default" : ""
              }`}
              className="max-w-full items-start overflow-hidden py-2 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1 [&>span:last-child]:overflow-hidden"
            >
              <span className="flex w-full min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] leading-5">
                  {presentation.label}
                </span>
                {presentation.showDefaultBadge && (
                  <span className="shrink-0 text-xs leading-5 text-[var(--text-muted)]">
                    Default
                  </span>
                )}
              </span>
            </SelectItem>
          )
        }

        if (target.type === "webln") {
          return (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={!weblnAvailable}
            >
              {presentation.label}
            </SelectItem>
          )
        }

        return (
          <SelectItem key={option.value} value={option.value}>
            {presentation.label}
          </SelectItem>
        )
      })}
    </SelectContent>
  )
}
