import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Clock, Loader2, Radio, ReceiptText, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"
import {
  config,
  EVENT_KINDS,
  fetchEventsFanout,
  formatNpub,
  formatPubkey,
  formatRelativeTime,
  parseOmfZapoutReceipt,
  pubkeyToNpub,
  type OmfZapoutReceipt,
} from "@conduit/core"
import { Badge, Button, StatusPill } from "@conduit/ui"

export const Route = createFileRoute("/zapouts")({
  component: ZapoutsPage,
})

const ZAPOUT_FEED_FETCH_LIMIT = 150
const ZAPOUT_FEED_RENDER_LIMIT = 50

function isOmfZapoutReceipt(
  receipt: OmfZapoutReceipt | null
): receipt is OmfZapoutReceipt {
  return receipt !== null
}

async function fetchOmfZapoutFeed(): Promise<OmfZapoutReceipt[]> {
  const events = await fetchEventsFanout(
    {
      kinds: [EVENT_KINDS.ZAP_RECEIPT],
      limit: ZAPOUT_FEED_FETCH_LIMIT,
    },
    {
      relayUrls: config.zapRelayUrls,
      connectTimeoutMs: 1_500,
      fetchTimeoutMs: 2_500,
      skipHealthFilter: true,
    }
  )

  return events
    .map(parseOmfZapoutReceipt)
    .filter(isOmfZapoutReceipt)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, ZAPOUT_FEED_RENDER_LIMIT)
}

function formatZapoutAmount(amountMsats: number | null): string {
  if (amountMsats === null) return "Amount unavailable"
  if (amountMsats % 1000 === 0) {
    return `${(amountMsats / 1000).toLocaleString()} sats`
  }
  return `${amountMsats.toLocaleString()} msats`
}

function formatZapoutTime(createdAt: number | null): string {
  if (createdAt === null) return "Time unavailable"
  return formatRelativeTime(createdAt)
}

function relayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function PublicProfileLink({
  pubkey,
  fallback,
}: {
  pubkey: string | null
  fallback: string
}) {
  if (!pubkey) {
    return <span className="text-[var(--text-muted)]">{fallback}</span>
  }

  return (
    <Link
      to="/u/$profileRef"
      params={{ profileRef: pubkeyToNpub(pubkey) }}
      className="font-mono text-xs text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
    >
      {formatNpub(pubkey, 8)}
    </Link>
  )
}

function ZapoutStatePanel({
  title,
  description,
  icon,
}: {
  title: string
  description: string
  icon: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-6 text-center shadow-[var(--shadow-glass-inset)]">
      <div className="mx-auto flex size-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]">
        {icon}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[var(--text-secondary)]">
        {description}
      </p>
    </section>
  )
}

function ZapoutReceiptCard({ zapout }: { zapout: OmfZapoutReceipt }) {
  const relayLabel = zapout.sourceRelayUrls[0]
    ? relayHost(zapout.sourceRelayUrls[0])
    : "Relay unknown"

  return (
    <article className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 shadow-[var(--shadow-glass-inset)] sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill variant="success">OMF zapout</StatusPill>
            <Badge variant="outline" className="border-[var(--border)]">
              {relayLabel}
            </Badge>
          </div>
          <div className="mt-3 text-2xl font-semibold text-[var(--text-primary)]">
            {formatZapoutAmount(zapout.amountMsats)}
          </div>
          {zapout.comment ? (
            <p className="mt-2 max-w-2xl break-words text-sm leading-6 text-[var(--text-secondary)]">
              {zapout.comment}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--text-muted)]">
          <Clock className="h-3.5 w-3.5" />
          {formatZapoutTime(zapout.createdAt)}
        </div>
      </div>

      <dl className="mt-5 grid gap-3 border-t border-[var(--border)] pt-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Sender
          </dt>
          <dd className="mt-1 min-w-0 truncate">
            <PublicProfileLink
              pubkey={zapout.senderPubkey}
              fallback="Unknown"
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Recipient
          </dt>
          <dd className="mt-1 min-w-0 truncate">
            <PublicProfileLink
              pubkey={zapout.recipientPubkey}
              fallback="Unknown"
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Receipt
          </dt>
          <dd className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
            {formatPubkey(zapout.id, 8)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Zap request
          </dt>
          <dd className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
            {zapout.zapRequestId
              ? formatPubkey(zapout.zapRequestId, 8)
              : "Unavailable"}
          </dd>
        </div>
      </dl>
    </article>
  )
}

function ZapoutsPage() {
  const zapoutsQuery = useQuery({
    queryKey: ["omf-zapouts", config.zapRelayUrls.join("|")],
    queryFn: fetchOmfZapoutFeed,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const zapouts = zapoutsQuery.data ?? []

  return (
    <div className="mx-auto max-w-5xl py-2 sm:py-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
            Zapouts
          </div>
          <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
            Public zapout feed
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            Recent OMF-marked checkout zaps observed on Conduit zap relays.
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 gap-2 rounded-2xl px-4 text-sm"
          onClick={() => void zapoutsQuery.refetch()}
          disabled={zapoutsQuery.isFetching}
        >
          {zapoutsQuery.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {zapoutsQuery.isLoading ? (
        <ZapoutStatePanel
          title="Loading zapouts"
          description="Checking configured zap relays for recent marked receipts."
          icon={<Loader2 className="h-5 w-5 animate-spin" />}
        />
      ) : zapoutsQuery.isError ? (
        <ZapoutStatePanel
          title="Zapout feed unavailable"
          description="Configured zap relays did not return a readable feed."
          icon={<Radio className="h-5 w-5" />}
        />
      ) : zapouts.length === 0 ? (
        <ZapoutStatePanel
          title="No zapouts found"
          description="Marked receipts will appear here after public checkout zaps settle."
          icon={<ReceiptText className="h-5 w-5" />}
        />
      ) : (
        <section className="space-y-3">
          {zapouts.map((zapout) => (
            <ZapoutReceiptCard key={zapout.id} zapout={zapout} />
          ))}
        </section>
      )}
    </div>
  )
}
