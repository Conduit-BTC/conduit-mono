import { formatNpub, type DirectConversationSummary } from "@conduit/core"
import { Badge, getConversationMessageDisplayContent } from "@conduit/ui"
import { BuyerAvatar, merchantListCardClass } from "./OrderListItem"

export function DirectConversationListItem({
  conversation,
  buyerName,
  buyerPicture,
  active,
  onClick,
}: {
  conversation: DirectConversationSummary
  buyerName: string
  buyerPicture?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-conversation-id={conversation.id}
      className={merchantListCardClass(active)}
    >
      <div className="flex items-start gap-3">
        <BuyerAvatar name={buyerName} picture={buyerPicture} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {buyerName}
            </div>
            <div className="shrink-0 text-[11px] text-[var(--text-muted)]">
              {new Date(conversation.latestAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {formatNpub(conversation.counterpartyPubkey, 8)}
          </div>
          {conversation.preview && (
            <div className="mt-1 truncate text-sm text-[var(--text-secondary)]">
              {getConversationMessageDisplayContent(conversation.preview)}
            </div>
          )}
          {(conversation.unreadFromCounterparty > 0 ||
            conversation.transport === "nip04") && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {conversation.unreadFromCounterparty > 0 && (
                <Badge variant="secondary">
                  {conversation.unreadFromCounterparty} unread
                </Badge>
              )}
              {conversation.transport === "nip04" && (
                <Badge variant="secondary">Legacy</Badge>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}
