import { UserRound } from "lucide-react"
import { type MerchantConversationSummary, type Profile } from "@conduit/core"
import { StatusPill } from "@conduit/ui"
import {
  getMerchantBuyerDisplayName,
  getMerchantConversationStatusDisplay,
  isMerchantGuestOrder,
} from "../lib/order-phase"

export function BuyerAvatar({
  name,
  picture,
  size = "md",
}: {
  name: string
  picture?: string
  size?: "sm" | "md"
}) {
  const dim = size === "sm" ? "h-9 w-9" : "h-11 w-11"
  return (
    <div
      className={`${dim} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]`}
    >
      {picture ? (
        <img src={picture} alt={name} className="h-full w-full object-cover" />
      ) : (
        <UserRound className="h-1/2 w-1/2 text-[var(--text-muted)]" />
      )}
    </div>
  )
}

export function merchantListCardClass(active: boolean): string {
  return `w-full rounded-[1.1rem] border p-3 text-left transition-[border-color,background-color] ${
    active
      ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)]"
      : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]"
  }`
}

export function OrderListItem({
  conversation,
  buyerProfile,
  active,
  onClick,
}: {
  conversation: MerchantConversationSummary
  buyerProfile?: Profile
  active: boolean
  onClick: () => void
}) {
  const statusDisplay = getMerchantConversationStatusDisplay(conversation)
  const visibleBuyerProfile = isMerchantGuestOrder(conversation)
    ? undefined
    : buyerProfile
  const buyerName = getMerchantBuyerDisplayName(
    conversation,
    visibleBuyerProfile
  )
  return (
    <button
      type="button"
      onClick={onClick}
      className={merchantListCardClass(active)}
    >
      <div className="flex items-start gap-3">
        <BuyerAvatar name={buyerName} picture={visibleBuyerProfile?.picture} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {buyerName}
            </div>
            <div className="shrink-0 text-[11px] text-[var(--text-muted)]">
              {new Date(conversation.latestAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
            {conversation.preview || "Order"}
          </div>
          {conversation.totalSummary && (
            <div className="mt-0.5 text-sm font-medium text-secondary-300">
              {conversation.totalSummary}
            </div>
          )}
          <div className="mt-2">
            <StatusPill variant={statusDisplay.tone} className="capitalize">
              {statusDisplay.label}
            </StatusPill>
          </div>
        </div>
      </div>
    </button>
  )
}
