import { Link } from "@tanstack/react-router"
import { LoaderCircle, ShieldCheck, Store, Users, Zap } from "lucide-react"
import type { ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage, Badge } from "@conduit/ui"
import { formatNpub } from "@conduit/core"
import { MerchantAvatarFallback } from "./MerchantIdentity"
import type { MerchantTrustContext } from "../hooks/useMerchantTrustContext"

type MerchantTrustSummaryProps = {
  trust: MerchantTrustContext
  variant?: "storefront" | "checkout"
  className?: string
}

function TrustChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode
  tone?: "neutral" | "positive" | "warning"
}) {
  const variant =
    tone === "positive" ? "success" : tone === "warning" ? "warning" : "outline"

  return (
    <Badge
      variant={variant}
      className="min-h-7 gap-1.5 px-2.5 py-1 text-[11px] font-medium"
    >
      {children}
    </Badge>
  )
}

function SocialChips({ trust }: { trust: MerchantTrustContext }) {
  if (trust.socialState === "loading") {
    return (
      <TrustChip>
        <LoaderCircle className="h-3 w-3 animate-spin" />
        Checking follows
      </TrustChip>
    )
  }

  if (trust.socialState === "disconnected") {
    return <TrustChip>Connect to check follows</TrustChip>
  }

  if (trust.socialState === "own_store") {
    return <TrustChip tone="positive">Your store</TrustChip>
  }

  if (trust.socialState === "unavailable") {
    return <TrustChip tone="warning">Follow context unavailable</TrustChip>
  }

  return (
    <>
      <TrustChip tone={trust.viewerFollowsMerchant ? "positive" : "neutral"}>
        {trust.viewerFollowsMerchant ? "You follow" : "You don't follow"}
      </TrustChip>
      {trust.merchantFollowsViewer && (
        <TrustChip tone="positive">Follows you</TrustChip>
      )}
      {typeof trust.mutualFollowCount === "number" &&
        trust.mutualFollowCount > 0 && (
          <TrustChip tone="positive">
            {trust.mutualFollowCount} mutual
          </TrustChip>
        )}
    </>
  )
}

export function MerchantTrustSummary({
  trust,
  variant = "storefront",
  className = "",
}: MerchantTrustSummaryProps) {
  const compact = variant === "checkout"
  const merchantPubkey = trust.merchantPubkey
  const npub = merchantPubkey ? formatNpub(merchantPubkey, 8) : null

  if (compact) {
    return (
      <div
        className={[
          "rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4",
          className,
        ].join(" ")}
      >
        <div className="flex items-start gap-3">
          <Avatar className="h-11 w-11 border border-[var(--border)]">
            <AvatarImage
              src={trust.profile?.picture}
              alt={trust.merchantName}
              className="object-cover"
            />
            <AvatarFallback>
              <MerchantAvatarFallback iconClassName="h-5 w-5" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Merchant context
              </div>
              {merchantPubkey && (
                <Link
                  to="/store/$pubkey"
                  params={{ pubkey: merchantPubkey }}
                  className="text-xs text-[var(--text-secondary)] underline underline-offset-4 hover:text-[var(--text-primary)]"
                >
                  View store
                </Link>
              )}
            </div>
            <div className="mt-1 truncate text-base font-semibold text-[var(--text-primary)]">
              {trust.merchantNamePending ? (
                <span className="inline-block max-w-full animate-pulse truncate">
                  {trust.merchantName}
                </span>
              ) : (
                trust.merchantName
              )}
            </div>
            <div className="mt-1 truncate text-xs text-[var(--text-muted)]">
              {trust.profile?.nip05?.trim() || npub || "Unknown pubkey"}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {typeof trust.listingCount === "number" && (
            <TrustChip>
              <Store className="h-3 w-3" />
              {trust.listingCount} listings
            </TrustChip>
          )}
          <TrustChip tone={trust.hasNip05 ? "positive" : "warning"}>
            <ShieldCheck className="h-3 w-3" />
            {trust.hasNip05 ? "NIP-05 claimed" : "No NIP-05"}
          </TrustChip>
          <TrustChip tone={trust.hasLightningAddress ? "positive" : "warning"}>
            <Zap className="h-3 w-3" />
            {trust.hasLightningAddress ? "Lightning address" : "No wallet"}
          </TrustChip>
          {trust.merchantFollowingCount > 0 && (
            <TrustChip>
              <Users className="h-3 w-3" />
              Follows {trust.merchantFollowingCount}
            </TrustChip>
          )}
          <SocialChips trust={trust} />
        </div>
      </div>
    )
  }

  return (
    <div className={["flex flex-wrap gap-2", className].join(" ")}>
      {typeof trust.listingCount === "number" && (
        <TrustChip>
          <Store className="h-3 w-3" />
          {trust.listingCount} listings
        </TrustChip>
      )}
      <TrustChip tone={trust.hasNip05 ? "positive" : "warning"}>
        <ShieldCheck className="h-3 w-3" />
        {trust.hasNip05 ? "NIP-05 claimed" : "No NIP-05"}
      </TrustChip>
      <TrustChip tone={trust.hasLightningAddress ? "positive" : "warning"}>
        <Zap className="h-3 w-3" />
        {trust.hasLightningAddress ? "Lightning address" : "No wallet"}
      </TrustChip>
      {trust.merchantFollowingCount > 0 && (
        <TrustChip>
          <Users className="h-3 w-3" />
          Follows {trust.merchantFollowingCount}
        </TrustChip>
      )}
      <SocialChips trust={trust} />
    </div>
  )
}
