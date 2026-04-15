import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Avatar, AvatarFallback, AvatarImage, Badge, Button } from "@conduit/ui"
import { formatPubkey, useProfile } from "@conduit/core"
import { Globe, Store, UserRound, Zap } from "lucide-react"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../../components/MerchantIdentity"
import { RichProfileText } from "../../components/RichProfileText"
import { resolveProfileReference } from "../../lib/profileRefs"
import { fetchStoreProducts } from "../../lib/storeProducts"

export const Route = createFileRoute("/u/$profileRef")({
  component: PublicProfilePage,
})

function PublicProfilePage() {
  const { profileRef } = Route.useParams()
  const resolved = useMemo(
    () => resolveProfileReference(profileRef),
    [profileRef]
  )
  const pubkey = resolved?.pubkey
  const profileQuery = useProfile(pubkey)
  const productsQuery = useQuery({
    queryKey: ["public-profile-storefront", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchStoreProducts(pubkey!),
  })

  if (!pubkey) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
          Profile not found
        </h1>
        <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
          This profile reference could not be resolved inside Conduit.
        </p>
      </section>
    )
  }

  const profile = profileQuery.data
  const displayName = getMerchantDisplayName(profile, pubkey)
  const hasStorefront = (productsQuery.data?.data.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Link
          to="/products"
          className="transition-colors hover:text-[var(--text-primary)]"
        >
          Shop
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Profile</span>
      </div>

      <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar className="h-24 w-24 shrink-0 border border-white/12 sm:h-28 sm:w-28">
              <AvatarImage src={profile?.picture} alt={displayName} />
              <AvatarFallback>
                <MerchantAvatarFallback iconClassName="h-8 w-8 sm:h-10 sm:w-10" />
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                Profile
              </div>
              <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.4rem]">
                {displayName}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {profile?.nip05?.trim() ? (
                  <Badge
                    variant="outline"
                    className="border-white/10 bg-white/[0.04] text-[var(--text-primary)]"
                  >
                    {profile.nip05.trim()}
                  </Badge>
                ) : null}
                <Badge
                  variant="outline"
                  className="border-white/10 bg-white/[0.04] text-[var(--text-primary)]"
                >
                  {formatPubkey(pubkey, 8)}
                </Badge>
              </div>
              <RichProfileText
                text={
                  profile?.about?.trim() ||
                  "No public profile note has been added yet."
                }
                className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-secondary)]"
              />
            </div>
          </div>

          {hasStorefront && (
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/store/$pubkey" params={{ pubkey }}>
                <Store className="h-4 w-4" />
                View storefront
              </Link>
            </Button>
          )}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-[1.35rem] border border-white/10 bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <UserRound className="mt-0.5 h-4 w-4 text-secondary-300" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Pubkey
              </div>
              <div className="mt-2 break-all font-mono text-xs leading-6 text-[var(--text-secondary)]">
                {pubkey}
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-white/10 bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <Zap className="mt-0.5 h-4 w-4 text-secondary-300" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Lightning
              </div>
              <RichProfileText
                text={
                  profile?.lud16?.trim() || "No lightning address published."
                }
                className="mt-2 text-sm text-[var(--text-secondary)]"
              />
            </div>
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-white/10 bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <Globe className="mt-0.5 h-4 w-4 text-secondary-300" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Website
              </div>
              <RichProfileText
                text={profile?.website?.trim() || "No website published."}
                className="mt-2 text-sm text-[var(--text-secondary)]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
