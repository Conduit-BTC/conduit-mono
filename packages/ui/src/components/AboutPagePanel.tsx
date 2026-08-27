import {
  Check,
  Copy,
  ExternalLink,
  Fingerprint,
  GitCommitHorizontal,
  GitFork,
  Globe2,
  Info,
  KeyRound,
  LockKeyhole,
  Radio,
  ShieldCheck,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Button } from "./Button"
import { Card } from "./Card"
import { cn } from "../utils"

export interface AboutPageBuildInfo {
  commitSha: string | null
  shortCommitSha: string | null
  buildTime: string | null
  sourceUrl: string
  releaseChannel: string
}

export interface AboutPageIdentity {
  sourceName: string
  handlerAddress: string | null
  handlerPubkey: string | null
  handlerNpub?: string | null
  dTag: string
  relayHint: string
  supportedKinds: number[]
}

export interface AboutPageContributor {
  login: string
  mergedPullRequests: number
  commits: number
  avatarUrl: string
  profileUrl: string
}

export interface AboutPageContributorSnapshot {
  status: "available" | "unavailable"
  methodology: "merged-pr-activity-v1"
  generatedAt: string | null
  sourceRevision: string | null
  contributors: readonly AboutPageContributor[]
}

export interface AboutPagePanelProps {
  appName: string
  appDescription: string
  buildInfo: AboutPageBuildInfo
  commitUrl: string | null
  identity: AboutPageIdentity
  contributors: AboutPageContributorSnapshot
  supportUrl: string
  logoSrc?: string
  repositoryLabel?: string
  className?: string
}

const DEFAULT_REPOSITORY_LABEL = "Conduit-BTC/conduit-mono"
const DEFAULT_LOGO_SRC = "/images/logo/logo-icon.svg"
const UTC_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
})

function formatHumanTimestamp(value: string | null): string {
  if (!value) return "Unknown"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${UTC_TIMESTAMP_FORMATTER.format(parsed)} UTC`
}

function formatExactTimestamp(value: string | null): string {
  if (!value) return "Unknown"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString()
}

function normalizeRepositoryUrl(sourceUrl: string): string {
  return sourceUrl.replace(/\.git$/, "").replace(/\/$/, "")
}

function getRepositoryLabel(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl)
    const [owner, repo] = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)

    if (owner && repo) return `${owner}/${repo}`
  } catch {
    const match = sourceUrl
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .match(/([^/:]+\/[^/]+)$/)

    if (match) return match[1]
  }

  return DEFAULT_REPOSITORY_LABEL
}

function FieldRow({
  label,
  value,
  href,
  copyValue,
  icon,
  muted = false,
  technical = false,
}: {
  label: string
  value: ReactNode
  href?: string | null
  copyValue?: string | null
  icon: ReactNode
  muted?: boolean
  technical?: boolean
}) {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
      <div className="mt-0.5 text-[var(--text-muted)]" aria-hidden="true">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-semibold text-[var(--text-muted)]">
          {label}
        </dt>
        <dd
          className={cn(
            "mt-1 min-w-0 [overflow-wrap:anywhere] text-sm font-medium",
            muted
              ? "text-[var(--text-secondary)]"
              : "text-[var(--text-primary)]",
            technical && "font-mono text-xs tabular-nums"
          )}
        >
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary-500 underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            value
          )}
        </dd>
      </div>
      {copyValue ? <CopyControl label={label} value={copyValue} /> : null}
    </div>
  )
}

function CopyControl({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle")
  const resetTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setStatus("copied")
    } catch {
      setStatus("error")
    }

    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current)
    }
    resetTimeoutRef.current = window.setTimeout(() => {
      setStatus("idle")
      resetTimeoutRef.current = null
    }, 1600)
  }

  const statusText =
    status === "copied" ? "Copied" : status === "error" ? "Copy failed" : ""

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={status === "copied" ? `${label} copied` : `Copy ${label}`}
        title={status === "copied" ? "Copied" : `Copy ${label}`}
        onClick={() => void handleCopy()}
      >
        {status === "copied" ? (
          <Check className="size-4 text-[var(--success)]" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "min-h-4 text-xs",
          status === "error"
            ? "text-[var(--error)]"
            : "text-[var(--text-muted)]"
        )}
      >
        {statusText}
      </span>
    </div>
  )
}

function LogoMark({ src, appName }: { src: string; appName: string }) {
  return (
    <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-primary-500 p-3 shadow-sm">
      <img
        src={src}
        alt={`${appName} logo`}
        className="size-full object-contain"
      />
    </div>
  )
}

function ContributorCard({
  contributor,
}: {
  contributor: AboutPageContributor
}) {
  const pullRequestLabel =
    contributor.mergedPullRequests === 1
      ? "1 merged PR"
      : `${contributor.mergedPullRequests} merged PRs`
  const commitLabel =
    contributor.commits === 1
      ? "1 commit in those PRs"
      : `${contributor.commits} commits in those PRs`

  return (
    <a
      href={contributor.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3 transition-colors hover:border-primary-500/60 hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <Avatar className="size-11 border border-[var(--border)] bg-[var(--surface)]">
        <AvatarImage
          src={contributor.avatarUrl}
          alt={`${contributor.login} GitHub avatar`}
          className="object-cover"
        />
        <AvatarFallback>
          {contributor.login.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-[var(--text-primary)] group-hover:text-primary-500">
          {contributor.login}
        </div>
        <div className="text-xs tabular-nums text-[var(--text-secondary)]">
          {pullRequestLabel}
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-[var(--text-muted)]">
          {commitLabel}
        </div>
      </div>
      <ExternalLink
        className="ml-auto size-3.5 shrink-0 text-[var(--text-muted)]"
        aria-hidden="true"
      />
    </a>
  )
}

function ReleaseChannelBadge({ channel }: { channel: string }) {
  const normalized = channel.trim().toLowerCase()
  if (!normalized || normalized === "production" || normalized === "unknown") {
    return null
  }

  return (
    <div className="inline-flex w-fit rounded-lg border border-[var(--warning)] px-3 py-1 text-xs font-semibold text-[var(--warning)]">
      {channel} build
    </div>
  )
}

function AboutHero({
  appName,
  appDescription,
  logoSrc,
  releaseChannel,
}: {
  appName: string
  appDescription: string
  logoSrc: string
  releaseChannel: string
}) {
  return (
    <header className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
          <LogoMark src={logoSrc} appName={appName} />
          <div className="min-w-0">
            <h1 className="max-w-3xl text-balance text-3xl font-semibold text-[var(--text-primary)] sm:text-4xl">
              About {appName}
            </h1>
            <p className="mt-3 max-w-3xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
              {appDescription}
            </p>
          </div>
        </div>
        <ReleaseChannelBadge channel={releaseChannel} />
      </div>
    </header>
  )
}

function HowConduitWorks() {
  return (
    <section aria-labelledby="how-conduit-works" className="space-y-4">
      <div>
        <h2
          id="how-conduit-works"
          className="text-balance text-2xl font-semibold text-[var(--text-primary)]"
        >
          How Conduit works
        </h2>
        <p className="mt-2 max-w-3xl text-pretty text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
          Conduit uses open protocols while keeping the important control points
          with shoppers and merchants.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <Globe2 className="size-5 text-primary-500" aria-hidden="true" />
          <h3 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
            Multiple relays
          </h3>
          <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Conduit reads from and publishes to multiple Nostr relays based on
            the task, user choices, and published relay preferences.
            relay.conduit.market is one Conduit-operated default, not a central
            authority.
          </p>
        </Card>

        <Card className="p-5">
          <LockKeyhole className="size-5 text-primary-500" aria-hidden="true" />
          <h3 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
            Public and private data
          </h3>
          <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Storefront profiles and product listings are public signed records.
            Orders and conversations are encrypted before they are sent through
            relays.
          </p>
        </Card>

        <Card className="p-5">
          <KeyRound className="size-5 text-primary-500" aria-hidden="true" />
          <h3 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
            You stay in control
          </h3>
          <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Your durable Nostr identity key remains in your external signer.
            Payments stay non-custodial, and wallet credentials or recovery
            material remain within their device or wallet boundary.
          </p>
        </Card>
      </div>
    </section>
  )
}

function SourceAndSupportCard({
  buildInfo,
  commitUrl,
  repositoryUrl,
  repositoryLabel,
  supportUrl,
}: {
  buildInfo: AboutPageBuildInfo
  commitUrl: string | null
  repositoryUrl: string
  repositoryLabel: string
  supportUrl: string
}) {
  return (
    <Card className="p-6">
      <h2 className="text-balance text-xl font-semibold text-[var(--text-primary)]">
        Open source and support
      </h2>
      <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
        Inspect the public source, identify the revision this deployment
        reports, or include that revision when reporting a problem.
      </p>

      <dl className="mt-5 grid gap-3">
        <FieldRow
          label="Repository"
          value={repositoryLabel}
          href={repositoryUrl}
          icon={<GitFork className="size-4" />}
        />
        <FieldRow
          label="Source revision"
          value={buildInfo.shortCommitSha ?? "Unknown"}
          href={commitUrl}
          icon={<GitCommitHorizontal className="size-4" />}
          technical
          muted={!buildInfo.shortCommitSha}
        />
        <FieldRow
          label="Built"
          value={
            buildInfo.buildTime ? (
              <time dateTime={buildInfo.buildTime}>
                {formatHumanTimestamp(buildInfo.buildTime)}
              </time>
            ) : (
              "Unknown"
            )
          }
          icon={<Info className="size-4" />}
          muted={!buildInfo.buildTime}
        />
      </dl>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a href={repositoryUrl} target="_blank" rel="noopener noreferrer">
            View source
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </Button>
        <Button asChild variant="outline">
          <a href={supportUrl} target="_blank" rel="noopener noreferrer">
            Report a problem
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </Button>
      </div>

      <details className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)]">
        <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          Build details
        </summary>
        <dl className="grid gap-3 border-t border-[var(--border)] p-4">
          <FieldRow
            label="Full source revision"
            value={buildInfo.commitSha ?? "Unknown"}
            copyValue={buildInfo.commitSha}
            icon={<GitCommitHorizontal className="size-4" />}
            technical
            muted={!buildInfo.commitSha}
          />
          <FieldRow
            label="Exact build time"
            value={formatExactTimestamp(buildInfo.buildTime)}
            copyValue={buildInfo.buildTime}
            icon={<Info className="size-4" />}
            technical
            muted={!buildInfo.buildTime}
          />
        </dl>
      </details>
    </Card>
  )
}

function TechnicalDetailsCard({ identity }: { identity: AboutPageIdentity }) {
  return (
    <Card className="p-6">
      <h2 className="text-balance text-xl font-semibold text-[var(--text-primary)]">
        Technical details
      </h2>
      <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
        Conduit publishes public Nostr handler metadata so compatible software
        can identify event types this app knows how to handle.
      </p>

      <details className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)]">
        <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          Nostr app handler metadata
        </summary>
        <div className="border-t border-[var(--border)] p-4">
          <p className="text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            This is public NIP-89 discovery information, not proof of the
            deployed build. The relay is a lookup hint for the handler record,
            not the only relay Conduit uses.
          </p>
          <dl className="mt-4 grid gap-3">
            <FieldRow
              label="Handler name"
              value={identity.sourceName}
              icon={<ShieldCheck className="size-4" />}
            />
            <FieldRow
              label="Handler npub"
              value={identity.handlerNpub ?? "Not configured in this build"}
              copyValue={identity.handlerNpub}
              icon={<ShieldCheck className="size-4" />}
              technical
              muted={!identity.handlerNpub}
            />
            <FieldRow
              label="Handler public key"
              value={identity.handlerPubkey ?? "Not configured in this build"}
              copyValue={identity.handlerPubkey}
              icon={<Fingerprint className="size-4" />}
              technical
              muted={!identity.handlerPubkey}
            />
            <FieldRow
              label="NIP-89 address"
              value={identity.handlerAddress ?? "Not configured in this build"}
              copyValue={identity.handlerAddress}
              icon={<GitCommitHorizontal className="size-4" />}
              technical
              muted={!identity.handlerAddress}
            />
            <FieldRow
              label="Handler d tag"
              value={identity.dTag || "Not configured"}
              copyValue={identity.dTag || undefined}
              icon={<Fingerprint className="size-4" />}
              technical
              muted={!identity.dTag}
            />
            <FieldRow
              label="Descriptor relay hint"
              value={identity.relayHint || "Not configured"}
              copyValue={identity.relayHint || undefined}
              icon={<Radio className="size-4" />}
              technical
              muted={!identity.relayHint}
            />
            <FieldRow
              label="Advertised event kinds"
              value={identity.supportedKinds.join(", ") || "None configured"}
              icon={<Fingerprint className="size-4" />}
              technical
              muted={identity.supportedKinds.length === 0}
            />
          </dl>
        </div>
      </details>
    </Card>
  )
}

function ContributorsCard({
  contributors,
  contributorsUrl,
}: {
  contributors: AboutPageContributorSnapshot
  contributorsUrl: string
}) {
  const contributorDataAvailable =
    contributors.status === "available" && contributors.contributors.length > 0

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-balance text-xl font-semibold text-[var(--text-primary)]">
            Contributors
          </h2>
          <p className="mt-2 max-w-3xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Human contributors are credited for pull requests they authored and
            that were merged into the public repository.
          </p>
        </div>
        {contributors.generatedAt ? (
          <time
            dateTime={contributors.generatedAt}
            className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]"
          >
            Activity data: {formatHumanTimestamp(contributors.generatedAt)}
          </time>
        ) : null}
      </div>

      {contributorDataAvailable ? (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {contributors.contributors.map((contributor) => (
            <li key={contributor.login}>
              <ContributorCard contributor={contributor} />
            </li>
          ))}
        </ul>
      ) : (
        <div
          role="status"
          className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            Contributor details could not be refreshed for this build.
          </p>
        </div>
      )}

      <p className="mt-4 max-w-4xl text-pretty text-xs leading-5 text-[var(--text-muted)]">
        Commit totals count unique, non-merge commits inside each contributor’s
        merged pull requests. They include work that may be squashed on the
        default branch and do not measure the quality or amount of someone’s
        contribution.
      </p>

      <Button asChild variant="outline" className="mt-5 w-fit">
        <a href={contributorsUrl} target="_blank" rel="noopener noreferrer">
          View contributor graph
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </Button>
    </Card>
  )
}

export function AboutPagePanel({
  appName,
  appDescription,
  buildInfo,
  commitUrl,
  identity,
  contributors,
  supportUrl,
  logoSrc = DEFAULT_LOGO_SRC,
  repositoryLabel,
  className,
}: AboutPagePanelProps) {
  const repositoryUrl = normalizeRepositoryUrl(buildInfo.sourceUrl)
  const repositoryDisplayLabel =
    repositoryLabel ?? getRepositoryLabel(repositoryUrl)
  const contributorsUrl = `${repositoryUrl}/graphs/contributors`

  return (
    <article className={cn("space-y-6", className)}>
      <AboutHero
        appName={appName}
        appDescription={appDescription}
        logoSrc={logoSrc}
        releaseChannel={buildInfo.releaseChannel}
      />
      <HowConduitWorks />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <SourceAndSupportCard
          buildInfo={buildInfo}
          commitUrl={commitUrl}
          repositoryUrl={repositoryUrl}
          repositoryLabel={repositoryDisplayLabel}
          supportUrl={supportUrl}
        />
        <TechnicalDetailsCard identity={identity} />
      </div>
      <ContributorsCard
        contributors={contributors}
        contributorsUrl={contributorsUrl}
      />
    </article>
  )
}
