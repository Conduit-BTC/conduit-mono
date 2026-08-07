import { useEffect, useMemo, useState } from "react"
import { Inbox, RefreshCw, ShieldCheck, Upload } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"
import { Checkbox } from "./Checkbox"
import { SignedActionStatus } from "./SignedActionStatus"

/**
 * Network-owned NIP-17 private inbox setup and repair (CND-208).
 *
 * This section is the single surface that publishes the kind-10050 inbox
 * relay declaration. Publishing is always an explicit signed action.
 * Degraded lookups (partial/unavailable) never present as "missing" and
 * never allow overwriting a declaration that could not be read.
 */

export type PrivateInboxStatus =
  | "loading"
  | "ready"
  | "not_declared"
  | "malformed"
  | "lookup_partial"
  | "lookup_unavailable"

export const MAX_INBOX_RELAY_SELECTION = 3

export interface PrivateInboxSectionProps {
  status: PrivateInboxStatus
  /** True when readiness comes from a cached declaration during a degraded lookup. */
  stale?: boolean
  /** Relays in the current kind-10050 declaration (empty when none). */
  declaredRelayUrls: string[]
  /** Enabled, reachable, secure IN relays eligible as inbox targets. */
  candidateRelayUrls: string[]
  lookupError?: string | null
  publishing?: boolean
  publishError?: string | null
  publishSuccess?: boolean
  onPublish: (relayUrls: string[]) => void
  onRetryLookup: () => void
  className?: string
}

function sameUrlSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((url) => bSet.has(url))
}

export function PrivateInboxSection({
  status,
  stale = false,
  declaredRelayUrls,
  candidateRelayUrls,
  lookupError = null,
  publishing = false,
  publishError = null,
  publishSuccess = false,
  onPublish,
  onRetryLookup,
  className,
}: PrivateInboxSectionProps) {
  const selectableUrls = useMemo(() => {
    const seen = new Set<string>()
    const urls: string[] = []
    for (const url of [...declaredRelayUrls, ...candidateRelayUrls]) {
      if (seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
    return urls
  }, [declaredRelayUrls, candidateRelayUrls])

  const defaultSelection = useMemo(() => {
    const base =
      declaredRelayUrls.length > 0 ? declaredRelayUrls : selectableUrls
    return base.slice(0, MAX_INBOX_RELAY_SELECTION)
  }, [declaredRelayUrls, selectableUrls])

  const [selectedUrls, setSelectedUrls] = useState<string[]>(defaultSelection)

  useEffect(() => {
    setSelectedUrls(defaultSelection)
  }, [defaultSelection])

  const lookupDegraded =
    status === "lookup_partial" || status === "lookup_unavailable"
  const selectionChanged = !sameUrlSet(selectedUrls, declaredRelayUrls)
  const canPublish =
    !lookupDegraded &&
    status !== "loading" &&
    selectedUrls.length > 0 &&
    selectedUrls.length <= MAX_INBOX_RELAY_SELECTION &&
    (status !== "ready" || selectionChanged)

  function toggleUrl(url: string, checked: boolean): void {
    setSelectedUrls((current) => {
      if (!checked) return current.filter((entry) => entry !== url)
      if (current.includes(url)) return current
      if (current.length >= MAX_INBOX_RELAY_SELECTION) return current
      return [...current, url]
    })
  }

  const headline =
    status === "ready"
      ? "Private inbox ready"
      : status === "malformed"
        ? "Repair your private inbox"
        : lookupDegraded
          ? "Private inbox status unknown"
          : status === "loading"
            ? "Checking private inbox"
            : "Finish private inbox setup"

  const description =
    status === "ready"
      ? stale
        ? "Using your last confirmed inbox declaration. The latest lookup was degraded, so this may be out of date."
        : "Your signed NIP-17 inbox declaration tells other clients where to deliver orders and encrypted messages."
      : status === "malformed"
        ? "Your published declaration contains no usable relays, so senders cannot deliver to you. Publish a repaired declaration below."
        : status === "lookup_partial"
          ? "Some relays did not respond, so your declaration could not be fully confirmed. This does not mean it is missing."
          : status === "lookup_unavailable"
            ? "No relay responded to the declaration lookup. Retry when your connection recovers."
            : status === "loading"
              ? "Looking up your inbox relay declaration."
              : "Orders and encrypted messages need a signed inbox relay declaration (NIP-17). Pick up to three IN relays below and publish."

  return (
    <div
      className={cn(
        "rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4",
        className
      )}
    >
      <div className="flex items-start gap-3">
        {status === "ready" ? (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[var(--success)]" />
        ) : (
          <Inbox className="mt-0.5 size-5 shrink-0 text-[var(--warning)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {headline}
          </div>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            {description}
          </p>
          {lookupError && lookupDegraded ? (
            <p className="mt-1 text-sm text-error">{lookupError}</p>
          ) : null}
        </div>
        {lookupDegraded ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetryLookup}
          >
            <RefreshCw className="mr-1 size-3.5" />
            Retry
          </Button>
        ) : null}
      </div>

      {!lookupDegraded && status !== "loading" ? (
        <div className="mt-4 space-y-3">
          {selectableUrls.length === 0 ? (
            <p className="text-sm leading-6 text-[var(--text-muted)]">
              No eligible inbox relays yet. Add a relay above and enable IN on
              it to make it an inbox candidate.
            </p>
          ) : (
            <ul className="space-y-2">
              {selectableUrls.map((url) => {
                const checked = selectedUrls.includes(url)
                const declared = declaredRelayUrls.includes(url)
                return (
                  <li key={url} className="flex items-center gap-3">
                    <Checkbox
                      id={`inbox-relay-${url}`}
                      checked={checked}
                      disabled={
                        publishing ||
                        (!checked &&
                          selectedUrls.length >= MAX_INBOX_RELAY_SELECTION)
                      }
                      onCheckedChange={(value) =>
                        toggleUrl(url, value === true)
                      }
                    />
                    <label
                      htmlFor={`inbox-relay-${url}`}
                      className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--text-primary)]"
                    >
                      {url}
                    </label>
                    {declared ? (
                      <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                        declared
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          {selectableUrls.length > 0 ? (
            <>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
                Publishing signs a NIP-17 inbox declaration (kind 10050) with{" "}
                {selectedUrls.length} relay{" "}
                {selectedUrls.length === 1 ? "tag" : "tags"}. It replaces your
                previous declaration everywhere.
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canPublish || publishing}
                  onClick={() => onPublish(selectedUrls)}
                >
                  <Upload className="h-4 w-4" />
                  {publishing
                    ? "Waiting for signer..."
                    : status === "ready"
                      ? "Update inbox declaration"
                      : "Publish inbox declaration"}
                </Button>
              </div>
              <SignedActionStatus
                state={
                  publishing
                    ? "awaiting_signature"
                    : publishError
                      ? "error"
                      : publishSuccess
                        ? "success"
                        : "idle"
                }
                awaitingSignatureMessage="Confirm the inbox declaration in your signer. It will show as ready after it is read back from relays."
                successMessage="Inbox declaration published and confirmed."
                errorMessage={publishError ?? undefined}
                className="justify-end"
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
