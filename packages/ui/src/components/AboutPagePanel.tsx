import {
  Boxes,
  Check,
  Copy,
  ExternalLink,
  Fingerprint,
  GitCommitHorizontal,
  GitFork,
  Info,
  Radio,
  ShieldCheck,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Button } from "./Button"
import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { cn } from "../utils"

export interface AboutPageBuildInfo {
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
  contributions: number
  avatarUrl: string
  profileUrl: string
}

export interface AboutPagePanelProps {
  appName: string
  appDescription: string
  buildInfo: AboutPageBuildInfo
  commitUrl: string | null
  identity: AboutPageIdentity
  layout?: "grid" | "stacked"
  logoSrc?: string
  repositoryLabel?: string
  contributors?: AboutPageContributor[]
  className?: string
}

const DEFAULT_REPOSITORY_LABEL = "Conduit-BTC/conduit-mono"
const DEFAULT_LOGO_SRC = "/images/logo/logo-icon.svg"
const DEFAULT_CONTRIBUTORS: AboutPageContributor[] = [
  {
    login: "dylangolow",
    contributions: 192,
    avatarUrl: "https://avatars.githubusercontent.com/u/24441906?v=4",
    profileUrl: "https://github.com/dylangolow",
  },
  {
    login: "ericfj2140",
    contributions: 10,
    avatarUrl: "https://avatars.githubusercontent.com/u/25217030?v=4",
    profileUrl: "https://github.com/ericfj2140",
  },
  {
    login: "d3vv3",
    contributions: 5,
    avatarUrl: "https://avatars.githubusercontent.com/u/43572680?v=4",
    profileUrl: "https://github.com/d3vv3",
  },
  {
    login: "dependabot[bot]",
    contributions: 2,
    avatarUrl: "https://avatars.githubusercontent.com/in/29110?v=4",
    profileUrl: "https://github.com/apps/dependabot",
  },
  {
    login: "5t34k",
    contributions: 1,
    avatarUrl: "https://avatars.githubusercontent.com/u/261338165?v=4",
    profileUrl: "https://github.com/5t34k",
  },
  {
    login: "m0wer",
    contributions: 1,
    avatarUrl: "https://avatars.githubusercontent.com/u/25278081?v=4",
    profileUrl: "https://github.com/m0wer",
  },
]

function formatCommitLabel(value: string | null): string {
  return value ?? "Unknown"
}

function formatTimestamp(value: string | null): string {
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
}: {
  label: string
  value: ReactNode
  href?: string | null
  copyValue?: string | null
  icon: ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
      <div className="mt-0.5 text-[var(--text-muted)]">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-[var(--text-muted)]">
          {label}
        </div>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex min-w-0 max-w-full items-center gap-1 break-all text-sm font-medium text-primary-500 underline-offset-4 hover:underline"
          >
            <span className="min-w-0 truncate">{value}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        ) : (
          <div
            className={cn(
              "mt-1 min-w-0 break-all text-sm font-medium",
              muted
                ? "text-[var(--text-secondary)]"
                : "text-[var(--text-primary)]"
            )}
          >
            {value}
          </div>
        )}
      </div>
      {copyValue ? <CopyControl label={label} value={copyValue} /> : null}
    </div>
  )
}

function CopyControl({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
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
      setCopied(true)
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
      }
      resetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        resetTimeoutRef.current = null
      }, 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      onClick={() => void handleCopy()}
    >
      {copied ? (
        <Check className="h-4 w-4 text-[var(--success)]" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  )
}

function PublicKeyBlock({
  npub,
  hex,
}: {
  npub: string | null | undefined
  hex: string | null | undefined
}) {
  if (!hex) {
    return (
      <FieldRow
        label="App public key"
        value="Not configured in this build"
        icon={<ShieldCheck className="h-4 w-4" />}
        muted
      />
    )
  }

  return (
    <div className="grid gap-3">
      <FieldRow
        label="App npub"
        value={npub ?? "Unable to encode npub"}
        copyValue={npub ?? undefined}
        icon={<ShieldCheck className="h-4 w-4" />}
      />
      <FieldRow
        label="App hex key"
        value={hex}
        copyValue={hex}
        icon={<Fingerprint className="h-4 w-4" />}
      />
    </div>
  )
}

function LogoMark({ src, appName }: { src: string; appName: string }) {
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
      <img
        src={src}
        alt={`${appName} logo`}
        className="h-full w-full object-contain"
      />
    </div>
  )
}

function ContributorCard({
  contributor,
}: {
  contributor: AboutPageContributor
}) {
  const contributionLabel =
    contributor.contributions === 1
      ? "1 commit"
      : `${contributor.contributions} commits`

  return (
    <a
      href={contributor.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3 transition-colors hover:border-primary-500/60 hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <Avatar className="h-11 w-11 border border-[var(--border)] bg-[var(--surface)]">
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
        <div className="text-xs text-[var(--text-secondary)]">
          {contributionLabel}
        </div>
      </div>
      <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  )
}

export function AboutPagePanel({
  appName,
  appDescription,
  buildInfo,
  commitUrl,
  identity,
  layout = "grid",
  logoSrc = DEFAULT_LOGO_SRC,
  repositoryLabel,
  contributors = DEFAULT_CONTRIBUTORS,
  className,
}: AboutPagePanelProps) {
  const repositoryUrl = normalizeRepositoryUrl(buildInfo.sourceUrl)
  const repositoryDisplayLabel =
    repositoryLabel ?? getRepositoryLabel(repositoryUrl)
  const contributorsUrl = `${repositoryUrl}/graphs/contributors`
  const sectionGridClass =
    layout === "stacked"
      ? "grid gap-5"
      : "grid gap-5 lg:grid-cols-[0.95fr_1.05fr]"
  const contributorGridClass =
    layout === "stacked" ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"

  return (
    <article className={cn("space-y-6", className)}>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            <LogoMark src={logoSrc} appName={appName} />
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
                About
              </h1>
              <p className="mt-2 max-w-3xl text-base font-medium text-[var(--text-secondary)]">
                App information and verification
              </p>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
                <span className="font-medium text-[var(--text-primary)]">
                  {appName}.
                </span>{" "}
                {appDescription}
              </p>
            </div>
          </div>
          <div className="inline-flex w-fit rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-semibold text-[var(--text-secondary)]">
            {buildInfo.releaseChannel}
          </div>
        </div>
      </section>

      <div className={sectionGridClass}>
        <Card>
          <CardHeader>
            <CardTitle>About Conduit</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm leading-6 text-[var(--text-secondary)]">
              Conduit is an open-source Nostr commerce client for discovering
              storefronts, publishing merchant data, and verifying the app
              identities that sign protocol events.
            </p>
            <FieldRow
              label="Repository"
              value={repositoryDisplayLabel}
              href={repositoryUrl}
              icon={<GitFork className="h-4 w-4" />}
            />
            <FieldRow
              label="Source commit"
              value={formatCommitLabel(buildInfo.shortCommitSha)}
              href={commitUrl}
              icon={<GitCommitHorizontal className="h-4 w-4" />}
            />
            <FieldRow
              label="Built"
              value={formatTimestamp(buildInfo.buildTime)}
              icon={<Info className="h-4 w-4" />}
            />
            <div className="pt-1">
              <Button asChild variant="outline">
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open source
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Authenticity verification</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FieldRow
              label="NIP-89 source"
              value={identity.sourceName}
              icon={<ShieldCheck className="h-4 w-4" />}
            />
            <PublicKeyBlock
              npub={identity.handlerNpub}
              hex={identity.handlerPubkey}
            />
            <FieldRow
              label="NIP-89 address"
              value={identity.handlerAddress ?? "Not configured in this build"}
              copyValue={identity.handlerAddress}
              icon={<GitCommitHorizontal className="h-4 w-4" />}
              muted={!identity.handlerAddress}
            />
            <FieldRow
              label="Handler d tag"
              value={identity.dTag}
              copyValue={identity.dTag}
              icon={<Fingerprint className="h-4 w-4" />}
            />
          </CardContent>
        </Card>
      </div>

      <div className={sectionGridClass}>
        <Card>
          <CardHeader>
            <CardTitle>App instance</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FieldRow
              label="App relay"
              value={identity.relayHint || "Not configured"}
              copyValue={identity.relayHint || undefined}
              icon={<Radio className="h-4 w-4" />}
              muted={!identity.relayHint}
            />
            <FieldRow
              label="Supported event kinds"
              value={identity.supportedKinds.join(", ")}
              icon={<Boxes className="h-4 w-4" />}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contributors</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm leading-6 text-[var(--text-secondary)]">
              People who have contributed to the public Conduit repository.
            </p>
            <div className={contributorGridClass}>
              {contributors.map((contributor) => (
                <ContributorCard
                  key={contributor.login}
                  contributor={contributor}
                />
              ))}
            </div>
            <Button asChild variant="outline" className="w-fit">
              <a
                href={contributorsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View contributor graph
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </article>
  )
}
