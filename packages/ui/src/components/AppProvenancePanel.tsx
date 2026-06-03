import {
  BadgeCheck,
  Boxes,
  Clock3,
  ExternalLink,
  GitCommitHorizontal,
  Radio,
  ShieldCheck,
} from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "./Button"
import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { cn } from "../utils"

export interface AppProvenanceBuildInfo {
  appVersion: string
  commitSha: string | null
  shortCommitSha: string | null
  branch: string | null
  buildTime: string | null
  sourceUrl: string
  releaseChannel: string
}

export interface AppProvenanceIdentity {
  sourceName: string
  handlerAddress: string | null
  handlerPubkey: string | null
  dTag: string
  relayHint: string
  supportedKinds: number[]
  webHandlers?: Array<{ url: string; entity?: string }>
}

export interface AppProvenancePanelProps {
  appName: string
  appDescription: string
  buildInfo: AppProvenanceBuildInfo
  commitUrl: string | null
  identity: AppProvenanceIdentity
  className?: string
}

function formatBuildTime(value: string | null): string {
  if (!value) return "Unknown"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString()
}

function MetadataRow({
  label,
  value,
  href,
  icon,
}: {
  label: string
  value: ReactNode
  href?: string | null
  icon: ReactNode
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
      <div className="mt-0.5 text-[var(--text-muted)]">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
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
          <div className="mt-1 break-all text-sm font-medium text-[var(--text-primary)]">
            {value}
          </div>
        )}
      </div>
    </div>
  )
}

export function AppProvenancePanel({
  appName,
  appDescription,
  buildInfo,
  commitUrl,
  identity,
  className,
}: AppProvenancePanelProps) {
  return (
    <div className={cn("space-y-6", className)}>
      <section className="rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              App provenance
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
              {appName}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
              {appDescription}
            </p>
          </div>
          <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            {buildInfo.releaseChannel}
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Build</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <MetadataRow
              label="Version"
              value={buildInfo.appVersion}
              icon={<Boxes className="h-4 w-4" />}
            />
            <MetadataRow
              label="Commit"
              value={buildInfo.shortCommitSha ?? "Unknown"}
              href={commitUrl}
              icon={<GitCommitHorizontal className="h-4 w-4" />}
            />
            <MetadataRow
              label="Branch"
              value={buildInfo.branch ?? "Unknown"}
              icon={<Radio className="h-4 w-4" />}
            />
            <MetadataRow
              label="Build time"
              value={formatBuildTime(buildInfo.buildTime)}
              icon={<Clock3 className="h-4 w-4" />}
            />
            <div className="pt-2">
              <Button asChild variant="outline">
                <a href={buildInfo.sourceUrl} target="_blank" rel="noreferrer">
                  View source
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>App Identity</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <MetadataRow
              label="NIP-89 source"
              value={identity.sourceName}
              icon={<BadgeCheck className="h-4 w-4" />}
            />
            <MetadataRow
              label="Handler pubkey"
              value={identity.handlerPubkey ?? "Not configured in this build"}
              icon={<ShieldCheck className="h-4 w-4" />}
            />
            <MetadataRow
              label="Handler address"
              value={identity.handlerAddress ?? "Not configured in this build"}
              icon={<GitCommitHorizontal className="h-4 w-4" />}
            />
            <MetadataRow
              label="Handler d tag"
              value={identity.dTag}
              icon={<BadgeCheck className="h-4 w-4" />}
            />
            <MetadataRow
              label="Relay hint"
              value={identity.relayHint || "Not configured"}
              icon={<Radio className="h-4 w-4" />}
            />
            <MetadataRow
              label="Supported event kinds"
              value={identity.supportedKinds.join(", ")}
              icon={<Boxes className="h-4 w-4" />}
            />
          </CardContent>
        </Card>
      </div>

      {identity.webHandlers?.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Web Handlers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {identity.webHandlers.map((handler) => (
              <MetadataRow
                key={`${handler.entity ?? "default"}:${handler.url}`}
                label={handler.entity ?? "handler"}
                value={handler.url}
                icon={<ExternalLink className="h-4 w-4" />}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
