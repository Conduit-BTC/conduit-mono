import { useQuery } from "@tanstack/react-query"
import { normalizePubkey, pubkeyToNpub } from "@conduit/core"
import { cn } from "@conduit/ui"
import brainstormBMark from "../assets/brainstorm-b.svg"
import { fetchBrainstormGlobalScore } from "../lib/brainstorm-score"

export function BrainstormGlobalScoreLink({
  pubkey,
}: {
  pubkey: string | null | undefined
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
  const accessibleScore =
    score !== undefined
      ? `Brainstorm global trust score: ${score} out of 100`
      : scoreQuery.isError
        ? "Brainstorm global trust score unavailable"
        : "Checking Brainstorm global trust score"
  const scoreDisplay =
    score !== undefined ? score : scoreQuery.isError ? "—" : "…"
  const statusDisplay =
    score !== undefined
      ? "Global trust score"
      : scoreQuery.isError
        ? "Score unavailable"
        : "Checking score"

  return (
    <a
      href={`https://brainstorm.nosfabrica.com/p/${pubkeyToNpub(hexPubkey)}`}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className={cn(
        "brainstorm-score-link inline-flex h-11 w-[104px] shrink-0 items-center gap-1.5 rounded-full px-1.5 tabular-nums",
        "sm:h-[46px] sm:w-[320px] sm:gap-2 sm:px-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
      )}
      aria-label={`${accessibleScore}. Open this profile on Brainstorm`}
      title="Brainstorm's global network score is not merchant verification. A zero may mean no observed score."
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-[var(--brainstorm-score-icon-bg)] sm:size-8 sm:rounded-[10px]">
        <img
          src={brainstormBMark}
          alt=""
          className="size-5 sm:size-[22px]"
          aria-hidden="true"
        />
      </span>
      <span className="hidden min-w-0 flex-col justify-center leading-none sm:flex">
        <span className="brainstorm-score-name text-[13px] font-bold text-[var(--brainstorm-score-label)]">
          Brainstorm
        </span>
        <span className="mt-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--brainstorm-score-muted)]">
          {statusDisplay}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-baseline whitespace-nowrap">
        <span className="text-base font-bold text-[var(--brainstorm-score-value)] sm:text-xl">
          {scoreDisplay}
        </span>
        {score !== undefined && (
          <span className="ml-0.5 text-[10px] text-[var(--brainstorm-score-tail)] sm:text-[11px]">
            /100
          </span>
        )}
      </span>
    </a>
  )
}
