import { Link } from "@tanstack/react-router"
import {
  getEventActorProvenance,
  type EventActorIdentityView,
} from "../lib/event-actor-identity"
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
  const provenance = getEventActorProvenance(pubkey)

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2 font-mono text-[var(--text-muted)] ${className}`}
    >
      <Link
        to="/u/$profileRef"
        params={{ profileRef: provenance.profileRef }}
        className="truncate underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
      >
        {provenance.displayNpub}
      </Link>
      <CopyButton value={provenance.copyValue} label={copyLabel} />
    </span>
  )
}
