import { Link } from "@tanstack/react-router"
import { formatNpub, pubkeyToNpub } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage, Badge } from "@conduit/ui"
import { MerchantAvatarFallback } from "./MerchantIdentity"
import type { MerchantIdentityView } from "../lib/marketBrowseModel"

/**
 * One discovered storefront. The name is muted until its profile resolves, so
 * a pending identity never reads as a confirmed store name.
 */
export function SellerCard({
  pubkey,
  identity,
  listingCount,
}: {
  pubkey: string
  identity: MerchantIdentityView
  listingCount: number
}) {
  return (
    <Link
      to="/store/$pubkey"
      params={{ pubkey: pubkeyToNpub(pubkey) }}
      className="flex h-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <Avatar className="size-11 shrink-0">
        {identity.picture ? (
          <AvatarImage src={identity.picture} alt="" />
        ) : null}
        <AvatarFallback className="bg-transparent">
          <MerchantAvatarFallback />
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={
            identity.status === "resolved"
              ? "truncate font-medium text-[var(--text-primary)]"
              : "truncate font-medium text-[var(--text-muted)]"
          }
        >
          {identity.displayName}
        </span>
        <span className="truncate text-xs text-[var(--text-muted)]">
          {formatNpub(pubkey, 6)}
        </span>
      </span>
      <Badge variant="secondary" className="shrink-0 text-[10px]">
        {listingCount} {listingCount === 1 ? "listing" : "listings"}
      </Badge>
    </Link>
  )
}
