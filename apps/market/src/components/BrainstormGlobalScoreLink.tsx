import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { normalizePubkey, pubkeyToNpub } from "@conduit/core"
import { badgeVariants, cn } from "@conduit/ui"
import { fetchBrainstormGlobalScore } from "../lib/brainstorm-score"

export function BrainstormGlobalScoreLink({
  pubkey,
  className,
}: {
  pubkey: string | null | undefined
  className?: string
}) {
  const hexPubkey = normalizePubkey(pubkey)
  const scoreQuery = useQuery({
    queryKey: ["brainstorm-global-score", hexPubkey],
    enabled: !!hexPubkey,
    queryFn: ({ signal }) => fetchBrainstormGlobalScore(hexPubkey!, signal),
    staleTime: 60 * 60 * 1_000,
    refetchOnWindowFocus: false,
    retry: false,
  })

  if (!hexPubkey) return null

  const score = scoreQuery.data?.score
  const label =
    score !== undefined
      ? `Brainstorm global · ${score}/100`
      : scoreQuery.isError
        ? "Brainstorm unavailable"
        : "Checking Brainstorm"

  return (
    <a
      href={`https://brainstorm.nosfabrica.com/p/${pubkeyToNpub(hexPubkey)}`}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className={cn(
        badgeVariants({ variant: "outline" }),
        "min-h-7 gap-1.5 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className
      )}
      aria-label={`${label}. Open this profile on Brainstorm`}
      title="Brainstorm's global network score is not merchant verification. A zero may mean no observed score."
    >
      <span aria-hidden="true">{label}</span>
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  )
}
