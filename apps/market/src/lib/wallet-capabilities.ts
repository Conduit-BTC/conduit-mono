type WalletCapabilityVariant = "success"

interface WalletCapabilityInfo {
  methods: readonly string[]
  notifications?: readonly string[]
}

export interface WalletCapabilityPill {
  id: string
  label: string
  variant: WalletCapabilityVariant
}

const METHOD_LABELS: Record<string, string> = {
  get_balance: "Read balance",
  get_budget: "Read budget",
  get_info: "Read node info",
  list_transactions: "Read transaction history",
  lookup_invoice: "Lookup invoices",
  make_invoice: "Create invoices",
  pay_invoice: "Send payments",
  pay_keysend: "Send keysend payments",
  multi_pay_invoice: "Send multiple invoice payments",
  multi_pay_keysend: "Send multiple keysend payments",
  sign_message: "Sign messages",
  make_hold_invoice: "Create hold invoices",
  settle_hold_invoice: "Settle hold invoices",
  cancel_hold_invoice: "Cancel hold invoices",
  notifications: "Wallet notifications",
}

export function getWalletCapabilityPills(
  info: WalletCapabilityInfo | null | undefined
): WalletCapabilityPill[] {
  if (!info) return []

  const methodPills = uniqueStrings(info.methods).map((method) => ({
    id: `method:${method}`,
    label: METHOD_LABELS[method] ?? method,
    variant: "success" as const,
  }))

  const hasNotificationMethod = info.methods.includes("notifications")
  const notificationPills =
    !hasNotificationMethod && uniqueStrings(info.notifications ?? []).length > 0
      ? [
          {
            id: "notification:wallet",
            label: "Wallet notifications",
            variant: "success" as const,
          },
        ]
      : []

  return [...methodPills, ...notificationPills]
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}
