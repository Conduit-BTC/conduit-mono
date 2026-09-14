import { useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import {
  formatNpub,
  pubkeyToNpub,
  type EventMarketHandoffMode,
  type Profile,
} from "@conduit/core"
import { Button } from "@conduit/ui"
import { getEventActorDisplayName } from "../lib/event-actor-identity"
import { getProfileUrl } from "../lib/market-links"

export function EventActorName({
  pubkey,
  profile,
  className = "",
}: {
  pubkey: string
  profile?: Profile
  className?: string
}) {
  return (
    <span
      className={`break-words font-medium text-[var(--text-primary)] [overflow-wrap:anywhere] ${className}`}
    >
      {getEventActorDisplayName(pubkey, profile)}
    </span>
  )
}

export function EventActorProvenance({
  pubkey,
  copyLabel,
  className = "",
}: {
  pubkey: string
  copyLabel: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const npub = pubkeyToNpub(pubkey)

  async function copyNpub(): Promise<void> {
    try {
      await navigator.clipboard.writeText(npub)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 font-mono text-[var(--text-muted)] ${className}`}
    >
      <a
        href={getProfileUrl(pubkey)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
      >
        <span className="truncate">{formatNpub(pubkey, 8)}</span>
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
      </a>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0 text-[var(--text-muted)]"
        aria-label={copied ? "Npub copied" : copyLabel}
        title={copied ? "Copied" : copyLabel}
        onClick={() => void copyNpub()}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </span>
  )
}

export function EventPickupHandlerIdentity({
  handoffMode,
  handlerPubkey,
  profile,
}: {
  handoffMode: EventMarketHandoffMode
  handlerPubkey: string
  profile?: Profile
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1">
      <span>
        {handoffMode === "organizer_handoff"
          ? "Organizer hands out"
          : "Merchant hands out"}
      </span>
      <span aria-hidden="true">{"\u00b7"}</span>
      <EventActorName
        pubkey={handlerPubkey}
        profile={profile}
        className="text-xs"
      />
      <EventActorProvenance
        pubkey={handlerPubkey}
        copyLabel="Copy pickup handler npub"
        className="text-[11px]"
      />
    </span>
  )
}
