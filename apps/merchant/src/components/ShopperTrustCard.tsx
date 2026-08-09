import {
  formatNpub,
  getProfileName,
  type Nip05TrustStatus,
  type Profile,
  type ShopperTrustEvidence,
  type ShopperTrustSignal,
} from "@conduit/core"
import { Button, StatusPill, type StatusPillProps } from "@conduit/ui"
import { useId } from "react"
import { BuyerAvatar } from "./OrderListItem"
import { getProfileUrl } from "../lib/market-links"

type StatusTone = NonNullable<StatusPillProps["variant"]>

export interface ShopperTrustCardProps {
  shopperPubkey: string
  profile?: Profile
  profileState: "loading" | "loaded" | "unavailable"
  evidence?: ShopperTrustEvidence
  isHydrating: boolean
  nip05Status: Nip05TrustStatus
  statusDisplay: {
    label: string
    tone: StatusTone
  }
  messageCount: number
  messageLabel: string
  onRefresh: () => void
  onOpenMessages: () => void
}

type SignalValue = {
  primary: string
  qualifiers?: string[]
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural
}

function formatEventAge(timestamp: number): string {
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.now() - timestamp * 1_000) / 86_400_000)
  )

  if (elapsedDays >= 365) {
    const years = Math.floor(elapsedDays / 365)
    return `Event dated ${years} ${pluralize(years, "year")} ago`
  }

  if (elapsedDays >= 30) {
    const months = Math.floor(elapsedDays / 30)
    return `Event dated ${months} ${pluralize(months, "month")} ago`
  }

  if (elapsedDays >= 1) {
    return `Event dated ${elapsedDays} ${pluralize(elapsedDays, "day")} ago`
  }

  return "Event dated today"
}

function signalValue<T>(
  signal: ShopperTrustSignal<T> | undefined,
  isHydrating: boolean,
  format: (value: T) => string,
  qualifiers: (value: T) => string[] = () => []
): SignalValue {
  if (!signal) {
    return { primary: isHydrating ? "Loading" : "Unavailable" }
  }

  if (signal.state === "unavailable" || signal.value === null) {
    return { primary: "Unavailable" }
  }

  const primary = format(signal.value)
  const valueQualifiers = qualifiers(signal.value)
  if (signal.state === "partial") {
    return {
      primary,
      qualifiers: [...valueQualifiers, "Partial observation"],
    }
  }
  if (signal.state === "stale") {
    return {
      primary,
      qualifiers: [...valueQualifiers, "Cached, may be stale"],
    }
  }

  return {
    primary,
    qualifiers: valueQualifiers.length > 0 ? valueQualifiers : undefined,
  }
}

function SignalRow({ label, value }: { label: string; value: SignalValue }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(7rem,auto)] items-start gap-3 py-2.5">
      <dt className="text-xs leading-5 text-[var(--text-secondary)]">
        {label}
      </dt>
      <dd className="min-w-0 text-right text-xs font-medium leading-5 text-[var(--text-primary)]">
        <span className="block tabular-nums">{value.primary}</span>
        {value.qualifiers?.map((qualifier) => (
          <span
            key={qualifier}
            className="block font-normal text-[var(--text-muted)]"
          >
            {qualifier}
          </span>
        ))}
      </dd>
    </div>
  )
}

function nip05Display(
  profile: Profile | undefined,
  profileState: ShopperTrustCardProps["profileState"],
  status: Nip05TrustStatus
): string {
  const identifier = profile?.nip05?.trim()
  if (profileState === "loading" && !identifier) return "Profile loading"
  if (profileState === "unavailable" && !identifier) {
    return "Profile unavailable; NIP-05 not checked"
  }

  switch (status) {
    case "valid":
      return identifier ? `${identifier} · NIP-05 matches` : "NIP-05 matches"
    case "invalid":
      return identifier
        ? `${identifier} · NIP-05 does not match`
        : "NIP-05 does not match"
    case "checking":
      return identifier ? `${identifier} · Checking NIP-05` : "Checking NIP-05"
    case "unknown":
      return identifier
        ? `${identifier} · NIP-05 status unavailable`
        : "NIP-05 status unavailable"
    case "absent":
      return "No NIP-05 identifier in observed profile"
  }
}

export function ShopperTrustCard({
  shopperPubkey,
  profile,
  profileState,
  evidence,
  isHydrating,
  nip05Status,
  statusDisplay,
  messageCount,
  messageLabel,
  onRefresh,
  onOpenMessages,
}: ShopperTrustCardProps) {
  const buyerName = getProfileName(profile) || formatNpub(shopperPubkey, 8)
  const oldestEvent = signalValue(
    evidence?.oldestEvent,
    isHydrating,
    ({ timestamp }) =>
      timestamp === null
        ? "Not found in this relay scan"
        : formatEventAge(timestamp),
    ({ timestamp }) => (timestamp === null ? [] : ["Author-provided timestamp"])
  )
  const followersObserved = signalValue(
    evidence?.followersObserved,
    isHydrating,
    ({ count }) => count.toLocaleString()
  )
  const followsInCommon = signalValue(
    evidence?.followsInCommon,
    isHydrating,
    ({ count }) => count.toLocaleString()
  )
  const zapsSent = signalValue(evidence?.zapsSent, isHydrating, ({ count }) =>
    count.toLocaleString()
  )
  const zapsReceived = signalValue(
    evidence?.zapsReceived,
    isHydrating,
    ({ count }) => count.toLocaleString()
  )
  const reportsFromNetwork = signalValue(
    evidence?.reportsFromNetwork,
    isHydrating,
    ({ count, reporterCount }) => {
      if (count === 0) return "No reports found in this relay scan"
      return `${count.toLocaleString()} ${pluralize(count, "report")} from ${reporterCount.toLocaleString()} ${pluralize(reporterCount, "profile")} in your network`
    }
  )
  const evidenceSignals = evidence
    ? [
        evidence.oldestEvent,
        evidence.followersObserved,
        evidence.followsInCommon,
        evidence.zapsSent,
        evidence.zapsReceived,
        evidence.reportsFromNetwork,
      ]
    : []
  const observationsUnavailable =
    evidenceSignals.length === 0 ||
    evidenceSignals.every(({ state }) => state === "unavailable")
  const titleId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={titleId}
          className="text-balance text-sm font-semibold text-[var(--text-primary)]"
        >
          Buyer context
        </h3>
        <StatusPill
          variant={statusDisplay.tone}
          className="max-w-full justify-center text-center capitalize"
        >
          {statusDisplay.label}
        </StatusPill>
      </div>

      <div className="mt-4 flex min-w-0 items-center gap-3">
        <BuyerAvatar
          name={buyerName}
          picture={profile?.picture}
          size="md"
          decorative
        />
        <div className="min-w-0 flex-1">
          <a
            href={getProfileUrl(shopperPubkey)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm font-medium text-[var(--text-primary)] underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            {buyerName}
          </a>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {formatNpub(shopperPubkey, 8)}
          </p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {nip05Display(profile, profileState, nip05Status)}
          </p>
        </div>
      </div>

      <dl className="mt-4 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <SignalRow label="Oldest signed event" value={oldestEvent} />
        <SignalRow label="Followers observed" value={followersObserved} />
        <SignalRow label="Follows in common" value={followsInCommon} />
        <SignalRow label="Zap requests observed sent" value={zapsSent} />
        <SignalRow
          label="Zap requests observed received"
          value={zapsReceived}
        />
        <SignalRow
          label="Reports from your network"
          value={reportsFromNetwork}
        />
      </dl>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {isHydrating
          ? "Buyer context is updating"
          : observationsUnavailable
            ? "Buyer context observations unavailable"
            : evidence?.degraded
              ? "Buyer context observations loaded with partial or stale coverage"
              : "Buyer context observations loaded"}
      </p>

      <details className="mt-3 text-xs text-[var(--text-secondary)]">
        <summary className="cursor-pointer rounded-sm py-1 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
          About these observations
        </summary>
        <p className="mt-2 text-pretty leading-5">
          These are bounded observations from the relays Conduit checked. They
          can be incomplete or stale. Event timestamps are author-provided and
          can be backdated. They are not proof of account creation or account
          age. Zap rows count signed requests embedded in invoice-bound events,
          not proof of payment or wallet-provider authority. Review each signal
          in context.
        </p>
      </details>

      <div className="mt-4 grid gap-2">
        {observationsUnavailable && !isHydrating && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onRefresh}
          >
            Retry observations
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onOpenMessages}
        >
          {messageLabel} ({messageCount.toLocaleString()})
        </Button>
      </div>
    </section>
  )
}
