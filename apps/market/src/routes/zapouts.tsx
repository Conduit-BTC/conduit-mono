import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Clock, Loader2, Radio, ReceiptText, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"
import {
  config,
  EVENT_KINDS,
  fetchEventsFanoutDetailed,
  formatNpub,
  formatPubkey,
  formatRelativeTime,
  normalizePubkey,
  parseOmfZapoutReceipt,
  pubkeyToNpub,
  type OmfZapoutReceipt,
} from "@conduit/core"
import { Badge, Button, StatusPill } from "@conduit/ui"
import { useShopperPricing } from "../hooks/useShopperPricing"

export const Route = createFileRoute("/zapouts")({
  component: ZapoutsPage,
})

const ZAPOUT_FEED_FETCH_LIMIT = 150
const ZAPOUT_FEED_RENDER_LIMIT = 50
const ZAPOUT_FEED_MAX_PAGES = 3
const ZAPOUT_FEED_AUTHORITY_BATCH_SIZE = 20
const ZAPOUT_FEED_AUTHORITY_TIMEOUT_MS = 12_000
const ZAPOUT_FEED_AUTHORITY_OVERALL_TIMEOUT_MS = 20_000
const ZAPOUT_FEED_MAX_RELAYS = 8
const ZAPOUT_FEED_MAX_AUTHORITY_CANDIDATES = 200

type ZapoutRelayCoverage = {
  relayUrl: string
  status: "success" | "partial" | "failed"
}

type OmfZapoutFeed = {
  zapouts: OmfZapoutReceipt[]
  relayCoverage: ZapoutRelayCoverage[]
  usedFallbackConfiguration: boolean
  configurationTruncated: boolean
  authorityUnavailableCount: number
  authorityCandidateCount: number
}

function isOmfZapoutReceipt(
  receipt: OmfZapoutReceipt | null
): receipt is OmfZapoutReceipt {
  return receipt !== null
}

function isAllowedZapRelay(value: string): boolean {
  try {
    const url = new URL(value)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    return (
      (url.protocol === "wss:" || (url.protocol === "ws:" && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

type AuthorityResult = {
  id: string
  status: "verified" | "invalid" | "authority_unavailable"
}

async function verifyZapoutCandidates(
  candidates: Array<{
    event: Awaited<
      ReturnType<typeof fetchEventsFanoutDetailed>
    >["events"][number]
    receipt: OmfZapoutReceipt
  }>
): Promise<{
  zapouts: OmfZapoutReceipt[]
  authorityUnavailableCount: number
}> {
  const verified: OmfZapoutReceipt[] = []
  let authorityUnavailableCount = 0
  const deadline = Date.now() + ZAPOUT_FEED_AUTHORITY_OVERALL_TIMEOUT_MS

  for (
    let offset = 0;
    offset < candidates.length && verified.length < ZAPOUT_FEED_RENDER_LIMIT;
    offset += ZAPOUT_FEED_AUTHORITY_BATCH_SIZE
  ) {
    const batch = candidates.slice(
      offset,
      offset + ZAPOUT_FEED_AUTHORITY_BATCH_SIZE
    )
    let results: AuthorityResult[]
    try {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        authorityUnavailableCount += candidates.length - offset
        break
      }
      const response = await fetch("/api/zapout-authority", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receipts: batch.map(({ event }) => event.rawEvent()),
        }),
        signal: AbortSignal.timeout(
          Math.min(ZAPOUT_FEED_AUTHORITY_TIMEOUT_MS, remainingMs)
        ),
      })
      if (!response.ok) throw new Error("Zapout authority is unavailable.")
      const body = (await response.json()) as unknown
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Zapout authority returned an invalid response.")
      }
      const rawResults = (body as Record<string, unknown>).results
      if (
        !Array.isArray(rawResults) ||
        !rawResults.every(
          (result): result is AuthorityResult =>
            !!result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            typeof (result as Record<string, unknown>).id === "string" &&
            ["verified", "invalid", "authority_unavailable"].includes(
              String((result as Record<string, unknown>).status)
            )
        )
      ) {
        throw new Error("Zapout authority returned an invalid response.")
      }
      results = rawResults
    } catch {
      authorityUnavailableCount += candidates.length - offset
      break
    }

    const resultById = new Map(results.map((result) => [result.id, result]))
    for (const candidate of batch) {
      const result = resultById.get(candidate.receipt.id)
      if (result?.status === "verified") verified.push(candidate.receipt)
      else if (!result || result.status === "authority_unavailable") {
        authorityUnavailableCount += 1
      }
    }
  }

  return {
    zapouts: verified.slice(0, ZAPOUT_FEED_RENDER_LIMIT),
    authorityUnavailableCount,
  }
}

async function getZapoutFeedRelayConfiguration(): Promise<{
  relayUrls: string[]
  usedFallback: boolean
  truncated: boolean
}> {
  if (import.meta.env.DEV) {
    return {
      relayUrls: config.zapRelayUrls.slice(0, ZAPOUT_FEED_MAX_RELAYS),
      usedFallback: false,
      truncated: config.zapRelayUrls.length > ZAPOUT_FEED_MAX_RELAYS,
    }
  }
  try {
    const response = await fetch("/api/anon-zap-config", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2_500),
    })
    if (!response.ok) throw new Error("Zap relay configuration unavailable.")
    const body = (await response.json()) as unknown
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Zap relay configuration is invalid.")
    }
    const receiptRelayUrls = (body as Record<string, unknown>).receiptRelayUrls
    if (
      !Array.isArray(receiptRelayUrls) ||
      receiptRelayUrls.length === 0 ||
      !receiptRelayUrls.every(
        (relay): relay is string =>
          typeof relay === "string" && isAllowedZapRelay(relay)
      )
    ) {
      throw new Error("Zap relay configuration is invalid.")
    }
    const uniqueRelayUrls = Array.from(new Set(receiptRelayUrls))
    return {
      relayUrls: uniqueRelayUrls.slice(0, ZAPOUT_FEED_MAX_RELAYS),
      usedFallback: false,
      truncated: uniqueRelayUrls.length > ZAPOUT_FEED_MAX_RELAYS,
    }
  } catch {
    return {
      relayUrls: config.zapRelayUrls.slice(0, ZAPOUT_FEED_MAX_RELAYS),
      usedFallback: true,
      truncated: config.zapRelayUrls.length > ZAPOUT_FEED_MAX_RELAYS,
    }
  }
}

async function fetchOmfZapoutsFromRelay(relayUrl: string): Promise<{
  events: Awaited<ReturnType<typeof fetchEventsFanoutDetailed>>["events"]
  coverage: ZapoutRelayCoverage
}> {
  const fetchPage = (filter: {
    kinds: number[]
    limit: number
    "#P"?: string[]
    since?: number
    until?: number
  }) =>
    fetchEventsFanoutDetailed(filter, {
      relayUrls: [relayUrl],
      connectTimeoutMs: 1_500,
      fetchTimeoutMs: 2_500,
      skipHealthFilter: true,
    })

  const anonZapSignerPubkey = normalizePubkey(config.anonZapSignerPubkey)
  const [targetedResult, firstPageResult] = await Promise.all([
    anonZapSignerPubkey
      ? fetchPage({
          kinds: [EVENT_KINDS.ZAP_RECEIPT],
          "#P": [anonZapSignerPubkey],
          limit: ZAPOUT_FEED_FETCH_LIMIT,
        })
      : Promise.resolve(null),
    fetchPage({
      kinds: [EVENT_KINDS.ZAP_RECEIPT],
      limit: ZAPOUT_FEED_FETCH_LIMIT,
    }),
  ])

  let usableReads = 0
  let incompleteReads = 0
  const recordRead = (
    result: Awaited<ReturnType<typeof fetchEventsFanoutDetailed>> | null
  ) => {
    if (!result) return
    const status = result.relays[0]?.status
    if (status === "success") usableReads += 1
    else {
      if (result.events.length > 0) usableReads += 1
      incompleteReads += 1
    }
  }
  recordRead(targetedResult)
  recordRead(firstPageResult)

  const eventsById = new Map(
    [...(targetedResult?.events ?? []), ...firstPageResult.events].map(
      (event) => [event.id, event]
    )
  )
  let page = firstPageResult.events
  let paginationIncomplete = false

  for (
    let pageNumber = 1;
    pageNumber < ZAPOUT_FEED_MAX_PAGES;
    pageNumber += 1
  ) {
    const observedCount = Array.from(eventsById.values())
      .map(parseOmfZapoutReceipt)
      .filter(isOmfZapoutReceipt).length
    if (observedCount >= ZAPOUT_FEED_RENDER_LIMIT) break

    if (page.length < ZAPOUT_FEED_FETCH_LIMIT) break

    const oldestCreatedAt = page.reduce<number | null>((oldest, event) => {
      if (!Number.isSafeInteger(event.created_at)) return oldest
      return oldest === null
        ? event.created_at!
        : Math.min(oldest, event.created_at!)
    }, null)
    if (oldestCreatedAt === null || page.length === 0) break

    const boundaryResult = await fetchPage({
      kinds: [EVENT_KINDS.ZAP_RECEIPT],
      limit: ZAPOUT_FEED_FETCH_LIMIT,
      since: oldestCreatedAt,
      until: oldestCreatedAt,
    })
    recordRead(boundaryResult)
    for (const event of boundaryResult.events) eventsById.set(event.id, event)
    if (
      boundaryResult.relays[0]?.status !== "success" ||
      boundaryResult.events.length >= ZAPOUT_FEED_FETCH_LIMIT
    ) {
      paginationIncomplete = true
      break
    }

    const pageResult = await fetchPage({
      kinds: [EVENT_KINDS.ZAP_RECEIPT],
      limit: ZAPOUT_FEED_FETCH_LIMIT,
      until: Math.max(0, oldestCreatedAt - 1),
    })
    recordRead(pageResult)
    const previousSize = eventsById.size
    for (const event of pageResult.events) eventsById.set(event.id, event)
    if (pageResult.relays[0]?.status !== "success") break
    page = pageResult.events
    if (eventsById.size === previousSize) break

    if (
      pageNumber === ZAPOUT_FEED_MAX_PAGES - 1 &&
      page.length >= ZAPOUT_FEED_FETCH_LIMIT
    ) {
      paginationIncomplete = true
    }
  }

  return {
    events: Array.from(eventsById.values()),
    coverage: {
      relayUrl,
      status:
        usableReads === 0
          ? "failed"
          : incompleteReads > 0 || paginationIncomplete
            ? "partial"
            : "success",
    },
  }
}

async function fetchOmfZapoutFeed(): Promise<OmfZapoutFeed> {
  const relayConfiguration = await getZapoutFeedRelayConfiguration()
  if (relayConfiguration.relayUrls.length === 0) {
    throw new Error("No public zap receipt relays are configured.")
  }
  const relayResults = await Promise.all(
    relayConfiguration.relayUrls.map(fetchOmfZapoutsFromRelay)
  )
  if (relayResults.every((result) => result.coverage.status === "failed")) {
    throw new Error("Configured zap relays did not return a readable feed.")
  }

  const eventsById = new Map(
    relayResults
      .flatMap((result) => result.events)
      .map((event) => [event.id, event])
  )
  const candidates = Array.from(eventsById.values())
    .flatMap((event) => {
      const receipt = parseOmfZapoutReceipt(event)
      return receipt ? [{ event, receipt }] : []
    })
    .sort((a, b) => (b.receipt.createdAt ?? 0) - (a.receipt.createdAt ?? 0))
  const authorityCandidates = candidates.slice(
    0,
    ZAPOUT_FEED_MAX_AUTHORITY_CANDIDATES
  )
  const authority = await verifyZapoutCandidates(authorityCandidates)
  authority.authorityUnavailableCount +=
    candidates.length - authorityCandidates.length

  return {
    zapouts: authority.zapouts,
    relayCoverage: relayResults.map((result) => result.coverage),
    usedFallbackConfiguration: relayConfiguration.usedFallback,
    configurationTruncated: relayConfiguration.truncated,
    authorityUnavailableCount: authority.authorityUnavailableCount,
    authorityCandidateCount: candidates.length,
  }
}

function formatZapoutAmount(
  amountMsats: number | null,
  formatSats: (sats: number) => string
): string {
  if (amountMsats === null) return "Amount unavailable"
  if (amountMsats % 1000 === 0) {
    return formatSats(amountMsats / 1000)
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

function ZapoutReceiptCard({
  zapout,
  formatSats,
}: {
  zapout: OmfZapoutReceipt
  formatSats: (sats: number) => string
}) {
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
            {formatZapoutAmount(zapout.amountMsats, formatSats)}
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
  const shopperPricing = useShopperPricing()
  const zapoutsQuery = useQuery({
    queryKey: ["omf-zapouts", config.zapRelayUrls.join("|")],
    queryFn: fetchOmfZapoutFeed,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const zapouts = zapoutsQuery.data?.zapouts ?? []
  const degradedRelayCount =
    zapoutsQuery.data?.relayCoverage.filter(
      (relay) => relay.status !== "success"
    ).length ?? 0
  const authorityUnavailableCount =
    zapoutsQuery.data?.authorityUnavailableCount ?? 0
  const hasCoverageWarning =
    degradedRelayCount > 0 ||
    authorityUnavailableCount > 0 ||
    zapoutsQuery.data?.usedFallbackConfiguration === true ||
    zapoutsQuery.data?.configurationTruncated === true

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

      {hasCoverageWarning ? (
        <section
          role="status"
          className="mb-4 flex gap-3 rounded-2xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm"
        >
          <Radio
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-medium text-[var(--text-primary)]">
              Feed coverage is partial
            </h2>
            <p className="mt-1 leading-5 text-[var(--text-secondary)]">
              {degradedRelayCount > 0
                ? `${degradedRelayCount} configured ${
                    degradedRelayCount === 1 ? "relay is" : "relays are"
                  } unavailable or returned an incomplete read. `
                : ""}
              {authorityUnavailableCount > 0
                ? `${authorityUnavailableCount} otherwise valid ${
                    authorityUnavailableCount === 1 ? "receipt" : "receipts"
                  } could not be checked against provider authority. `
                : ""}
              {zapoutsQuery.data?.usedFallbackConfiguration
                ? "The public server relay configuration was unavailable, so the built-in relay list is being used."
                : zapoutsQuery.data?.configurationTruncated
                  ? "The configured relay list exceeded the feed safety cap, so only the first bounded set was queried."
                  : "Entries from readable relays are shown below."}
            </p>
          </div>
        </section>
      ) : null}

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
          title={
            authorityUnavailableCount > 0 &&
            (zapoutsQuery.data?.authorityCandidateCount ?? 0) > 0
              ? "Zapout verification unavailable"
              : "No zapouts found"
          }
          description={
            authorityUnavailableCount > 0 &&
            (zapoutsQuery.data?.authorityCandidateCount ?? 0) > 0
              ? "Receipts were found, but their provider authority could not be verified."
              : "Marked receipts will appear here after public checkout zaps settle."
          }
          icon={<ReceiptText className="h-5 w-5" />}
        />
      ) : (
        <section className="space-y-3">
          {zapouts.map((zapout) => (
            <ZapoutReceiptCard
              key={zapout.id}
              zapout={zapout}
              formatSats={(sats) =>
                shopperPricing.formatSatsAmount(sats).primary
              }
            />
          ))}
        </section>
      )}
    </div>
  )
}
