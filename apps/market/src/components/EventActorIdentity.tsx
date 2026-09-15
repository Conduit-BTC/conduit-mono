import { Link } from "@tanstack/react-router"
import { formatNpub, pubkeyToNpub } from "@conduit/core"
import { type EventActorIdentityView } from "../lib/event-actor-identity"
import { CopyButton } from "./CopyButton"

export function EventActorName({
  identity,
  className = "",
}: {
  identity: EventActorIdentityView
  className?: string
}) {
  return (
    <span
      className={`break-words font-medium text-[var(--text-primary)] [overflow-wrap:anywhere] ${className}`}
    >
      {identity.displayName}
    </span>
  )
}

export type { EventActorIdentityView } from "../lib/event-actor-identity"

export function EventActorProvenance({
  pubkey,
  copyLabel,
  className = "",
}: {
  pubkey: string
  copyLabel: string
  className?: string
}) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2 font-mono text-[var(--text-muted)] ${className}`}
    >
      <Link
        to="/u/$profileRef"
        params={{ profileRef: pubkeyToNpub(pubkey) }}
        className="truncate underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
      >
        {formatNpub(pubkey, 8)}
      </Link>
      <CopyButton value={pubkey} label={copyLabel} />
    </span>
  )
}
