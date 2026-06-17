import { LoaderCircle, Store, Users } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@conduit/ui"
import type { MerchantTrustContext } from "../hooks/useMerchantTrustContext"

type MerchantTrustSummaryProps = {
  trust: MerchantTrustContext
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
  className = "",
}: MerchantTrustSummaryProps) {
  return (
    <div className={["flex flex-wrap gap-2", className].join(" ")}>
      {typeof trust.listingCount === "number" && (
        <TrustChip>
          <Store className="h-3 w-3" />
          {trust.listingCount} listings
        </TrustChip>
      )}
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
