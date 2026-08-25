import { useEffect, useMemo, useState } from "react"
import { Inbox, RefreshCw, ShieldCheck, Upload } from "lucide-react"
import {
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  type InboxRelayCandidate,
} from "@conduit/core"
import { cn } from "../utils"
import { Badge } from "./Badge"
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
  | "distribution_pending"
  | "not_observed"
  | "signed_empty"
  | "malformed"
  | "lookup_partial"
  | "lookup_unavailable"

export const MAX_INBOX_RELAY_SELECTION = MAX_DECLARED_INBOX_WRITE_RELAYS

export interface PrivateInboxSectionProps {
  status: PrivateInboxStatus
  /** True when readiness comes from a cached declaration during a degraded lookup. */
  stale?: boolean
  /** Complete shared discovery permits an explicit redistribution or repair. */
  distributionRepairable?: boolean
  /** Typed configured/declaration/capability evidence for secure inbox relays. */
  candidateRelays: InboxRelayCandidate[]
  lookupError?: string | null
  publishing?: boolean
  publishError?: string | null
  publishSuccess?: boolean
  /** Publish succeeded but the fresh read-back was degraded. */
  publishConfirmationPending?: boolean
  onPublish: (relayUrls: string[]) => void
  onRetryLookup: () => void
  className?: string
}

function sameUrlSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((url) => bSet.has(url))
}

export interface InboxPublishGateInput {
  status: PrivateInboxStatus
  /** Readiness served from cache during a degraded lookup. */
  stale: boolean
  distributionRepairable: boolean
  selectedCount: number
  selectionChanged: boolean
}

type EvidenceTone = "neutral" | "success" | "warning" | "error" | "info"

function EvidenceTag({
  label,
  description,
  tone = "neutral",
}: {
  label: string
  description: string
  tone?: EvidenceTone
}) {
  const variant = {
    neutral: "outline",
    success: "success",
    warning: "warning",
    error: "destructive",
    info: "secondary",
  } as const

  return (
    <Badge
      variant={variant[tone]}
      className={cn(
        "font-normal",
        tone === "neutral" && "text-[var(--text-muted)]",
        tone === "info" && "text-[var(--info)]"
      )}
      aria-label={`${label}. ${description}`}
      title={description}
    >
      {label}
    </Badge>
  )
}

function InboxRelayEvidence({ candidate }: { candidate: InboxRelayCandidate }) {
  return (
    <>
      {candidate.declared ? (
        <EvidenceTag
          label="Declared"
          description="Included in the current signed private inbox declaration."
          tone="success"
        />
      ) : candidate.retained ? (
        <EvidenceTag
          label="Previously declared"
          description="Retained from the last usable signed declaration for recovery reads. It is not the current declaration."
          tone="info"
        />
      ) : null}
      <EvidenceTag
        label={
          candidate.configured
            ? candidate.enabled
              ? "Read enabled"
              : "Read off"
            : "Not configured"
        }
        description={
          candidate.configured
            ? candidate.enabled
              ? "Enabled for reads in Conduit. This does not prove private inbox delivery."
              : "Configured in Conduit, but Read is not enabled."
            : "Declared by the account, but not present in this device's relay settings."
        }
        tone={candidate.enabled ? "info" : "neutral"}
      />
      {candidate.relayInfoProbe === "succeeded" ? (
        <EvidenceTag
          label="Relay info reached"
          description="A runtime relay-info request succeeded. Reachability is evidence, not recipient pickup."
          tone="success"
        />
      ) : candidate.relayInfoProbe === "failed" ? (
        <EvidenceTag
          label="Relay unreachable"
          description="The latest relay-info request failed. Prior declaration and capability evidence is retained."
          tone="error"
        />
      ) : (
        <EvidenceTag
          label="Reachability unknown"
          description="No successful or failed runtime relay-info request is recorded."
        />
      )}
      {candidate.protectedMessageCapabilityEvidence === "advertised" ? (
        <EvidenceTag
          label="NIP-59 advertised"
          description="The relay information document advertises NIP-59 support. Advertisement is not proof of delivery."
          tone="info"
        />
      ) : candidate.protectedMessageCapabilityEvidence === "known" ? (
        <EvidenceTag
          label="Protected messages known"
          description="A configured Conduit capability profile recognizes protected-message support."
          tone="info"
        />
      ) : (
        <EvidenceTag
          label="Advertisement unknown"
          description="No NIP-59 advertisement or configured protected-message capability profile is recorded."
        />
      )}
      {candidate.protectedMessageRuntimeEvidence === "probe_passed" ? (
        <EvidenceTag
          label="Protected-message probe passed"
          description="A bounded protected-message capability probe succeeded. This is evidence only, not message storage or recipient pickup."
          tone="success"
        />
      ) : candidate.protectedMessageRuntimeEvidence === "probe_failed" ? (
        <EvidenceTag
          label="Protected-message probe failed"
          description="The latest bounded protected-message capability probe failed. Advertised or known support remains separate evidence."
          tone="warning"
        />
      ) : null}
    </>
  )
}

/**
 * Publish gate: block while loading or when the current declaration could not
 * be read (degraded lookup, or ready served stale from cache) so a device
 * with an out-of-date view can never overwrite a newer declaration.
 */
export function canPublishInboxDeclaration(
  input: InboxPublishGateInput
): boolean {
  if (input.status === "loading") return false
  if (input.status === "lookup_partial") return false
  if (input.status === "lookup_unavailable") return false
  if (input.stale && !input.distributionRepairable) return false
  if (input.selectedCount < 1) return false
  if (input.selectedCount > MAX_INBOX_RELAY_SELECTION) return false
  if (input.status === "distribution_pending") {
    return input.distributionRepairable && !input.selectionChanged
  }
  if (input.status !== "ready") return true
  return input.distributionRepairable
    ? !input.selectionChanged
    : input.selectionChanged
}

export function PrivateInboxSection({
  status,
  stale = false,
  distributionRepairable = false,
  candidateRelays,
  lookupError = null,
  publishing = false,
  publishError = null,
  publishSuccess = false,
  publishConfirmationPending = false,
  onPublish,
  onRetryLookup,
  className,
}: PrivateInboxSectionProps) {
  // Key selection state on relay-url values, not array identity: parent
  // re-renders pass fresh arrays every time and must not clobber an
  // in-progress checkbox selection.
  const declaredRelayUrls: string[] = []
  const selectableCandidateUrls: string[] = []
  for (const candidate of candidateRelays) {
    if (candidate.declared) declaredRelayUrls.push(candidate.url)
    if (candidate.selectable) selectableCandidateUrls.push(candidate.url)
  }
  const declaredKey = declaredRelayUrls.join("\n")
  const selectableCandidateKey = selectableCandidateUrls.join("\n")

  const defaultSelection = useMemo(() => {
    const declared = declaredKey ? declaredKey.split("\n") : []
    const selectableCandidates = selectableCandidateKey
      ? selectableCandidateKey.split("\n")
      : []
    const base = declared.length > 0 ? declared : selectableCandidates
    return base.slice(0, MAX_INBOX_RELAY_SELECTION)
  }, [declaredKey, selectableCandidateKey])

  const [selectedUrls, setSelectedUrls] = useState<string[]>(defaultSelection)

  useEffect(() => {
    setSelectedUrls(defaultSelection)
  }, [defaultSelection])

  const lookupDegraded =
    status === "lookup_partial" || status === "lookup_unavailable"
  const retryRequired = lookupDegraded || (stale && !distributionRepairable)
  const effectiveDeclaredRelayUrls = declaredRelayUrls.slice(
    0,
    MAX_INBOX_RELAY_SELECTION
  )
  const selectionChanged = !sameUrlSet(selectedUrls, effectiveDeclaredRelayUrls)
  const exactRedistribution =
    distributionRepairable &&
    (status === "ready" || status === "distribution_pending")
  const canPublish = canPublishInboxDeclaration({
    status,
    stale,
    distributionRepairable,
    selectedCount: selectedUrls.length,
    selectionChanged,
  })

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
      ? distributionRepairable
        ? "Redistribute your private inbox"
        : "Private inbox ready"
      : status === "distribution_pending"
        ? "Finish distributing your private inbox"
        : status === "signed_empty"
          ? "Restore your private inbox"
          : status === "malformed"
            ? "Repair your private inbox"
            : lookupDegraded
              ? "Private inbox status unknown"
              : status === "loading"
                ? "Checking private inbox"
                : "Finish private inbox setup"

  const description =
    status === "ready"
      ? distributionRepairable
        ? "Your last valid signed declaration was not found on the shared discovery set. Redistribute the unchanged relay set so another Conduit client can discover it."
        : stale
          ? "Using your last confirmed inbox declaration. The latest lookup was degraded, so this may be out of date. Retry the lookup before publishing changes."
          : "Your signed NIP-17 inbox declaration tells other clients where to deliver orders and encrypted messages."
      : status === "distribution_pending"
        ? distributionRepairable
          ? "Your exact signed declaration is retained for retry, but shared relays have not confirmed it yet. Retry sends the same signed event without asking your signer again."
          : "Your signed declaration has not been confirmed on shared relays, and shared discovery is incomplete. Retry the lookup before changing or redistributing it."
        : status === "signed_empty"
          ? stale && !distributionRepairable
            ? "A signed empty declaration is retained, but the latest shared lookup was degraded. Retry before publishing a repair."
            : "Your current signed declaration lists no secure inbox relays, so senders cannot deliver new messages. Choose relays below to restore it."
          : status === "malformed"
            ? stale && !distributionRepairable
              ? "A malformed signed declaration is retained, but the latest shared lookup was degraded. Retry before publishing a repair."
              : "A signed declaration was found, but its relay tags could not be used safely. This is not the same as choosing an empty inbox. Publish a repaired declaration below."
            : status === "lookup_partial"
              ? "Some relays did not respond, so your declaration could not be fully confirmed. This does not mean it is missing."
              : status === "lookup_unavailable"
                ? "No relay responded to the declaration lookup. Retry when your connection recovers."
                : status === "loading"
                  ? "Looking up your inbox relay declaration."
                  : "No usable signed declaration was observed within this bounded lookup. That does not prove one is absent everywhere. Pick up to three Read-enabled relays below and publish."

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
        {retryRequired ? (
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
          {candidateRelays.length === 0 ? (
            <p className="text-sm leading-6 text-[var(--text-muted)]">
              No eligible inbox relays yet. Add a relay above and enable Read on
              it to make it an inbox candidate.
            </p>
          ) : (
            <ul className="space-y-2">
              {candidateRelays.map((candidate, index) => {
                const checked = selectedUrls.includes(candidate.url)
                const inputId = `inbox-relay-${index}`
                const evidenceId = `${inputId}-evidence`
                return (
                  <li
                    key={candidate.url}
                    className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                  >
                    <Checkbox
                      id={inputId}
                      aria-describedby={evidenceId}
                      checked={checked}
                      disabled={
                        publishing ||
                        status === "distribution_pending" ||
                        (distributionRepairable && status === "ready") ||
                        !candidate.selectable ||
                        (!checked &&
                          selectedUrls.length >= MAX_INBOX_RELAY_SELECTION)
                      }
                      onCheckedChange={(value) =>
                        toggleUrl(candidate.url, value === true)
                      }
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={inputId}
                        className="block truncate font-mono text-sm text-[var(--text-primary)]"
                      >
                        {candidate.url}
                      </label>
                      <div
                        id={evidenceId}
                        className="mt-1.5 flex flex-wrap gap-1.5"
                      >
                        <InboxRelayEvidence candidate={candidate} />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {candidateRelays.length > 0 ? (
            <>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
                {exactRedistribution
                  ? "Retrying republishes the exact signed inbox declaration already stored on this device. It does not ask the signer to create another event."
                  : `Publishing signs a NIP-17 inbox declaration (kind 10050) with ${selectedUrls.length} relay ${selectedUrls.length === 1 ? "tag" : "tags"}. It replaces your previous declaration on relays that accept this publish.`}
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
                    ? exactRedistribution
                      ? "Redistributing declaration..."
                      : "Waiting for signer..."
                    : status === "distribution_pending"
                      ? "Retry inbox declaration"
                      : status === "ready"
                        ? distributionRepairable
                          ? "Redistribute inbox declaration"
                          : "Update inbox declaration"
                        : "Publish inbox declaration"}
                </Button>
              </div>
              <SignedActionStatus
                state={
                  publishing
                    ? exactRedistribution
                      ? "publishing"
                      : "awaiting_signature"
                    : publishError
                      ? "error"
                      : publishSuccess
                        ? "success"
                        : "idle"
                }
                awaitingSignatureMessage={
                  "Confirm the inbox declaration in your signer. It will show as ready after it is read back from relays."
                }
                publishingMessage="Redistributing the exact stored declaration. It will show as ready after shared relays return it."
                successMessage={
                  publishConfirmationPending
                    ? "Inbox declaration published. Relay confirmation is still pending; retry the lookup to confirm."
                    : "Inbox declaration published and confirmed."
                }
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
