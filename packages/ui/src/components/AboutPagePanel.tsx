import {
  Boxes,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Fingerprint,
  GitCommitHorizontal,
  Github,
  Info,
  Radio,
  ShieldCheck,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "./Button"
import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { cn } from "../utils"

export interface AboutPageBuildInfo {
  appVersion: string
  commitSha: string | null
  shortCommitSha: string | null
  branch: string | null
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
  webHandlers?: Array<{ url: string; entity?: string }>
}

export interface AboutPagePanelProps {
  appName: string
  appDescription: string
  buildInfo: AboutPageBuildInfo
  commitUrl: string | null
  identity: AboutPageIdentity
  className?: string
}

function formatBuildTime(value: string | null): string {
  if (!value) return "Unknown"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString()
}

function normalizeRepositoryUrl(sourceUrl: string): string {
  return sourceUrl.replace(/\.git$/, "").replace(/\/$/, "")
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
            rel="noreferrer"
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

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
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

export function AboutPagePanel({
  appName,
  appDescription,
  buildInfo,
  commitUrl,
  identity,
  className,
}: AboutPagePanelProps) {
  const repositoryUrl = normalizeRepositoryUrl(buildInfo.sourceUrl)
  const contributorsUrl = `${repositoryUrl}/graphs/contributors`
  const webHandlers = identity.webHandlers ?? []

  return (
    <article className={cn("space-y-6", className)}>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]">
              <Info className="h-4 w-4" />
              About
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
              {appName}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
              {appDescription}
            </p>
          </div>
          <div className="inline-flex w-fit rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-semibold text-[var(--text-secondary)]">
            {buildInfo.releaseChannel}
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <Card>
          <CardHeader>
            <CardTitle>Source and build</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FieldRow
              label="Repository"
              value="Conduit-BTC/conduit-mono"
              href={repositoryUrl}
              icon={<Github className="h-4 w-4" />}
            />
            <FieldRow
              label="Contributors"
              value="View contributors"
              href={contributorsUrl}
              icon={<Github className="h-4 w-4" />}
            />
            <FieldRow
              label="Version"
              value={buildInfo.appVersion}
              icon={<Boxes className="h-4 w-4" />}
            />
            <FieldRow
              label="Commit"
              value={buildInfo.shortCommitSha ?? "Unknown"}
              href={commitUrl}
              icon={<GitCommitHorizontal className="h-4 w-4" />}
            />
            <FieldRow
              label="Branch"
              value={buildInfo.branch ?? "Unknown"}
              icon={<Radio className="h-4 w-4" />}
            />
            <FieldRow
              label="Build time"
              value={formatBuildTime(buildInfo.buildTime)}
              icon={<Clock3 className="h-4 w-4" />}
            />
            <div className="pt-1">
              <Button asChild variant="outline">
                <a href={repositoryUrl} target="_blank" rel="noreferrer">
                  Open source
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Nostr identity</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
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
      </div>

      {webHandlers.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Web handlers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {webHandlers.map((handler) => (
              <FieldRow
                key={`${handler.entity ?? "handler"}:${handler.url}`}
                label={handler.entity ?? "Handler"}
                value={handler.url}
                copyValue={handler.url}
                icon={<ExternalLink className="h-4 w-4" />}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </article>
  )
}
