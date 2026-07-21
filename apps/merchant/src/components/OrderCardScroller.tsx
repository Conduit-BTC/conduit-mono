import { useEffect, useRef } from "react"
import { ChevronRight } from "lucide-react"
import { type MerchantConversationSummary } from "@conduit/core"
import { ConversationCardScroller, StatusPill } from "@conduit/ui"
import { getMerchantConversationStatusDisplay } from "../lib/order-phase"
import { BuyerAvatar } from "./OrderListItem"

export function OrderCardScroller({
  conversations,
  selectedId,
  buyerName,
  buyerPicture,
  onSelect,
}: {
  conversations: MerchantConversationSummary[]
  selectedId?: string | null
  buyerName: (pubkey: string) => string
  buyerPicture: (pubkey: string) => string | undefined
  onSelect: (conversation: MerchantConversationSummary) => void
}) {
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  useEffect(() => {
    if (!selectedId) return
    cardRefs.current.get(selectedId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    })
  }, [selectedId])

  return (
    <ConversationCardScroller label="Orders">
      {conversations.map((conversation) => {
        const active = conversation.id === selectedId
        const statusDisplay = getMerchantConversationStatusDisplay(conversation)
        const name = buyerName(conversation.buyerPubkey)
        return (
          <button
            key={conversation.id}
            type="button"
            ref={(element) => {
              if (element) cardRefs.current.set(conversation.id, element)
              else cardRefs.current.delete(conversation.id)
            }}
            onClick={() => onSelect(conversation)}
            className={`w-[16.5rem] shrink-0 snap-start rounded-[1.25rem] border p-4 text-left transition-[border-color,background-color,transform] ${
              active
                ? "border-[color-mix(in_srgb,var(--primary-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_7%,transparent)]"
                : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <BuyerAvatar
                  name={name}
                  picture={buyerPicture(conversation.buyerPubkey)}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                    {name}
                  </div>
                  <div className="mt-1 truncate text-sm text-[var(--text-secondary)]">
                    {conversation.preview || "Order"}
                  </div>
                </div>
              </div>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            </div>
            <div className="mt-3 flex min-w-0 items-center gap-2">
              <StatusPill
                variant={statusDisplay.tone}
                className="min-w-0 shrink capitalize"
              >
                {statusDisplay.label}
              </StatusPill>
              {conversation.totalSummary && (
                <span className="min-w-0 truncate text-xs font-medium text-secondary-300">
                  {conversation.totalSummary}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </ConversationCardScroller>
  )
}
