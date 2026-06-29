import type {
  NwcSessionBalanceState,
  NwcSessionBudgetState,
} from "./buyer-nwc-session"

export type WalletPaymentConstraintCode =
  | "insufficient_balance"
  | "budget_exhausted"
  | "budget_error"
  | "unsupported_pay_invoice"

export interface WalletPaymentConstraint {
  code: WalletPaymentConstraintCode
  reason: string
  detail: string
}

export function formatWalletMsatsAsSats(msats: number): string {
  return Math.floor(msats / 1_000).toLocaleString()
}

export function formatBalanceFreshness(
  fetchedAt: number | null,
  nowMs = Date.now()
): string | null {
  if (!fetchedAt) return null

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000))
  if (elapsedSeconds < 60) return "Updated just now"

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes} min ago`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours} hr ago`
  }

  const elapsedDays = Math.floor(elapsedHours / 24)
  return `Updated ${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`
}

export function getKnownWalletPaymentConstraint({
  amountMsats,
  balance,
  budget,
  methods,
}: {
  amountMsats: number | null
  balance: NwcSessionBalanceState
  budget: NwcSessionBudgetState
  methods: readonly string[] | null | undefined
}): WalletPaymentConstraint | null {
  if (methods && !methods.includes("pay_invoice")) {
    return {
      code: "unsupported_pay_invoice",
      reason: "Connected wallet cannot pay invoices through NWC.",
      detail:
        "This app connection does not advertise outgoing payment support.",
    }
  }

  if (amountMsats === null) return null

  if (
    balance.status === "available" &&
    balance.balanceMsats !== null &&
    balance.balanceMsats < amountMsats
  ) {
    return {
      code: "insufficient_balance",
      reason: "Connected wallet balance is below this invoice total.",
      detail: `${formatWalletMsatsAsSats(
        balance.balanceMsats
      )} sats available for a ${formatWalletMsatsAsSats(amountMsats)} sat order.`,
    }
  }

  if (
    budget.status === "available" &&
    budget.remainingMsats !== null &&
    budget.remainingMsats < amountMsats
  ) {
    return {
      code: "budget_exhausted",
      reason: "Connected wallet budget is below this invoice total.",
      detail: `${formatWalletMsatsAsSats(
        budget.remainingMsats
      )} sats remain for a ${formatWalletMsatsAsSats(amountMsats)} sat order.`,
    }
  }

  const budgetError = budget.error ?? balance.error
  if (budgetError && isKnownSpendLimitError(budgetError)) {
    return {
      code: "budget_error",
      reason: "Connected wallet reported a spend-limit constraint.",
      detail:
        "The wallet app connection appears to be constrained by budget, allowance, permission, or balance.",
    }
  }

  return null
}

function isKnownSpendLimitError(error: string): boolean {
  const normalized = error.toLowerCase()
  return (
    normalized.includes("budget") ||
    normalized.includes("allowance") ||
    normalized.includes("spend limit") ||
    normalized.includes("spend-limit") ||
    normalized.includes("quota") ||
    normalized.includes("restricted") ||
    normalized.includes("unauthorized") ||
    normalized.includes("permission") ||
    normalized.includes("insufficient")
  )
}
