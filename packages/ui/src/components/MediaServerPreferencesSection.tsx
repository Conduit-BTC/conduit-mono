import {
  ArrowDown,
  ArrowUp,
  Image,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { type FormEvent, useRef, useState } from "react"
import {
  type MediaServerDraftActionResult,
  type MediaServerPreferencesView,
} from "@conduit/core"
import { cn } from "../utils"
import { Button } from "./Button"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./Dialog"
import { Input } from "./Input"
import {
  SignedActionStatus,
  type SignedActionStatusState,
} from "./SignedActionStatus"
import { StatusPill } from "./StatusPill"

export interface MediaServerPreferencesSectionProps {
  view: MediaServerPreferencesView
  onAddServer: (url: string) => MediaServerDraftActionResult
  onRemoveServer: (url: string) => void
  onMoveServer: (fromIndex: number, toIndex: number) => void
  onPublish: () => void | Promise<void>
  onRetryPublish: () => void | Promise<void>
  onRetryLookup: () => void
  className?: string
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatEventTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  return dateTimeFormatter.format(new Date(seconds * 1_000))
}

function getStatusMeta(view: MediaServerPreferencesView): {
  label: string
  variant: "success" | "warning" | "error" | "info" | "neutral"
  description: string
} {
  switch (view.status) {
    case "loading":
      return {
        label: "Checking",
        variant: "info",
        description: "Conduit is running a bounded signed-event lookup.",
      }
    case "published":
      return view.stale
        ? {
            label: "Published evidence retained",
            variant: "warning",
            description:
              "A signed list is retained, but the latest lookup did not freshly confirm the same replacement frontier.",
          }
        : {
            label: "Published list observed",
            variant: "success",
            description:
              "The latest valid owner-authored list was observed during a complete bounded lookup.",
          }
    case "not_observed":
      return {
        label: "No list observed",
        variant: "neutral",
        description:
          "The completed bounded lookup did not observe a kind 10063 preference. This is not proof of global absence.",
      }
    case "empty":
      return {
        label: "Signed list is empty",
        variant: "error",
        description:
          "The newest observed replacement has no usable server tags and can be repaired explicitly.",
      }
    case "malformed":
      return {
        label: "Signed list needs repair",
        variant: "error",
        description:
          "The newest observed replacement contains unsafe or malformed server tags.",
      }
    case "lookup_partial":
      return {
        label: "Lookup incomplete",
        variant: "warning",
        description:
          "Some planned relay reads did not complete. Retained evidence and partial coverage remain visible before an explicit publish.",
      }
    case "lookup_unavailable":
    default:
      return {
        label: "Lookup unavailable",
        variant: "warning",
        description:
          "No planned relay read completed. Local edits remain available, but signing is blocked.",
      }
  }
}

function getActionStatusState(
  view: MediaServerPreferencesView
): SignedActionStatusState {
  switch (view.publishPhase) {
    case "awaiting_signature":
      return "awaiting_signature"
    case "checking":
    case "publishing":
    case "confirming":
      return "publishing"
    case "confirmed":
      return "success"
    case "partial":
      return "partial"
    case "confirmation_pending":
      return "confirmation_pending"
    case "cancelled":
      return "cancelled"
    case "error":
      return "error"
    case "idle":
    default:
      return view.dirty ? "dirty" : "idle"
  }
}

export function MediaServerPreferencesSection({
  view,
  onAddServer,
  onRemoveServer,
  onMoveServer,
  onPublish,
  onRetryPublish,
  onRetryLookup,
  className,
}: MediaServerPreferencesSectionProps) {
  const [newServerUrl, setNewServerUrl] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  const publishButtonRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const statusMeta = getStatusMeta(view)
  const publishedAt = formatEventTime(view.publishedCreatedAt)
  const actionStatus = getActionStatusState(view)
  const lookupNeedsRetry =
    view.status === "lookup_partial" ||
    view.status === "lookup_unavailable" ||
    view.stale

  function focusRowOrInput(serverUrl?: string): void {
    requestAnimationFrame(() => {
      const row = serverUrl ? rowRefs.current.get(serverUrl) : null
      const control = row?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)"
      )
      ;(control ?? addInputRef.current)?.focus({ preventScroll: true })
    })
  }

  function handleAdd(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const result = onAddServer(newServerUrl)
    if (!result.ok) {
      setValidationError(
        result.error ?? "That media server could not be added."
      )
      return
    }
    setNewServerUrl("")
    setValidationError(null)
    requestAnimationFrame(() =>
      addInputRef.current?.focus({ preventScroll: true })
    )
  }

  function moveServer(index: number, nextIndex: number): void {
    const serverUrl = view.localServerUrls[index]
    if (!serverUrl) return
    onMoveServer(index, nextIndex)
    focusRowOrInput(serverUrl)
  }

  function removeServer(index: number): void {
    const serverUrl = view.localServerUrls[index]
    if (!serverUrl) return
    const focusTarget =
      view.localServerUrls[index + 1] ?? view.localServerUrls[index - 1]
    onRemoveServer(serverUrl)
    focusRowOrInput(focusTarget)
  }

  function closePublishDialog(): void {
    setPublishDialogOpen(false)
    requestAnimationFrame(() =>
      publishButtonRef.current?.focus({ preventScroll: true })
    )
  }

  function confirmPublish(): void {
    closePublishDialog()
    void onPublish()
  }

  return (
    <section
      aria-labelledby="media-server-preferences-heading"
      aria-busy={view.isLoading || view.isRefetching || undefined}
      className={cn(
        "rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)] sm:p-5",
        className
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[var(--secondary-500)]">
            <Image className="size-4" aria-hidden="true" />
            <h2
              id="media-server-preferences-heading"
              className="text-sm font-semibold uppercase tracking-[0.2em]"
            >
              Media servers
            </h2>
          </div>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Keep an ordered list of Blossom HTTP media servers. These are
            separate from Nostr relays and private-inbox relays. Changes stay on
            this device until you explicitly sign and publish kind 10063.
          </p>
        </div>
        <StatusPill
          variant={statusMeta.variant}
          className="shrink-0"
          title={statusMeta.description}
        >
          {statusMeta.label}
        </StatusPill>
      </div>

      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Local ordered list
            </h3>
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              Earlier entries have higher preference. Up and down controls
              preserve the signed order for keyboard and pointer users.
            </p>
          </div>
          <StatusPill variant={view.dirty ? "warning" : "neutral"} noIcon>
            {view.dirty ? "Unpublished local edits" : "Matches observed list"}
          </StatusPill>
        </div>

        {view.localServerUrls.length > 0 ? (
          <ol className="mt-3 space-y-2" aria-label="Ordered media servers">
            {view.localServerUrls.map((serverUrl, index) => (
              <li
                key={serverUrl}
                ref={(node) => {
                  if (node) rowRefs.current.set(serverUrl, node)
                  else rowRefs.current.delete(serverUrl)
                }}
                className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2"
              >
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--secondary-500)_12%,transparent)] text-xs font-semibold tabular-nums text-[var(--secondary-500)]"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--text-primary)]"
                  title={serverUrl}
                >
                  {serverUrl}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label={"Move " + serverUrl + " earlier"}
                    title="Move earlier"
                    onClick={() => moveServer(index, index - 1)}
                  >
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index === view.localServerUrls.length - 1}
                    aria-label={"Move " + serverUrl + " later"}
                    title="Move later"
                    onClick={() => moveServer(index, index + 1)}
                  >
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={"Remove " + serverUrl}
                    title="Remove from the local list"
                    onClick={() => removeServer(index)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-sm leading-6 text-[var(--text-secondary)]">
            No media server preference is saved locally. Later Conduit media
            upload will visibly default to{" "}
            <span className="font-mono text-[var(--text-primary)]">
              https://blossom.nostr.build
            </span>
            . Conduit will not add or publish that fallback for you.
          </div>
        )}

        <form onSubmit={handleAdd} className="mt-4">
          <label
            htmlFor="media-server-url"
            className="text-sm font-medium text-[var(--text-primary)]"
          >
            Add media server root
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              ref={addInputRef}
              id="media-server-url"
              value={newServerUrl}
              onChange={(event) => {
                setNewServerUrl(event.target.value)
                if (validationError) setValidationError(null)
              }}
              placeholder="https://media.example.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={validationError ? true : undefined}
              aria-describedby="media-server-url-help media-server-url-error"
              className="h-11 rounded-xl bg-[var(--surface)] font-mono"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!newServerUrl.trim()}
              className="h-11 shrink-0"
            >
              <Plus className="size-4" aria-hidden="true" />
              Add server
            </Button>
          </div>
          <p
            id="media-server-url-help"
            className="mt-2 text-pretty text-xs leading-5 text-[var(--text-muted)]"
          >
            Enter a public HTTPS origin only. Credentials, paths, query
            parameters, fragments, loopback, private, and special-use targets
            are rejected. Access-controlled public roots may be entered; the
            server decides admission later.
          </p>
          {validationError ? (
            <p
              id="media-server-url-error"
              role="alert"
              className="mt-2 text-sm text-[var(--error)]"
            >
              {validationError}
            </p>
          ) : (
            <span id="media-server-url-error" />
          )}
        </form>
      </div>

      <details className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
          Last observed published event
        </summary>
        <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          <p>{statusMeta.description}</p>
          {view.publishedServerUrls.length > 0 ? (
            <ol className="mt-3 list-decimal space-y-1 pl-5 font-mono text-xs text-[var(--text-primary)]">
              {view.publishedServerUrls.map((serverUrl) => (
                <li key={serverUrl} className="break-all pl-1">
                  {serverUrl}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[var(--text-muted)]">
              No usable owner-authored server list is currently available.
            </p>
          )}
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[var(--text-muted)]">Signed revision</dt>
              <dd className="mt-0.5 text-[var(--text-primary)]">
                {publishedAt ?? "Not observed"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Observed sources</dt>
              <dd className="mt-0.5 tabular-nums text-[var(--text-primary)]">
                {view.sourceRelayCount} relay
                {view.sourceRelayCount === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Lookup coverage</dt>
              <dd className="mt-0.5 capitalize text-[var(--text-primary)]">
                {view.coverage}
              </dd>
            </div>
          </dl>
        </div>
      </details>

      {view.pendingSignedListDiffers ? (
        <p className="mt-4 rounded-xl border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-3 py-2 text-sm leading-6 text-[var(--text-secondary)]">
          Retry will send the exact previously signed list. Your newer local
          edits will remain unpublished and will not be silently substituted.
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap justify-end gap-2">
          {lookupNeedsRetry ? (
            <Button
              type="button"
              variant="ghost"
              disabled={view.isLoading || view.isRefetching}
              onClick={onRetryLookup}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {view.isRefetching ? "Checking..." : "Retry lookup"}
            </Button>
          ) : null}
          {view.retryAvailable ? (
            <Button
              type="button"
              variant="outline"
              disabled={
                view.publishPhase === "publishing" ||
                view.publishPhase === "confirming"
              }
              onClick={() => void onRetryPublish()}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Retry signed update
            </Button>
          ) : null}
          <Button
            ref={publishButtonRef}
            type="button"
            disabled={!view.canPublish}
            title={view.publishDisabledReason ?? undefined}
            onClick={() => setPublishDialogOpen(true)}
          >
            <Upload className="size-4" aria-hidden="true" />
            Review and publish
          </Button>
        </div>
        {view.publishDisabledReason && view.dirty ? (
          <p className="text-right text-xs leading-5 text-[var(--text-muted)]">
            {view.publishDisabledReason}
          </p>
        ) : null}
        <SignedActionStatus
          state={actionStatus}
          message={view.publishMessage}
          dirtyMessage="Local edits are saved on this device and have not been signed or published."
          publishingMessage={
            view.publishPhase === "checking"
              ? "Rechecking the current replacement frontier before signing."
              : view.publishPhase === "confirming"
                ? "Relay acceptance was received. Running a fresh exact-event read-back."
                : undefined
          }
          className="justify-end"
        />
      </div>

      <AlertDialog
        open={publishDialogOpen}
        onOpenChange={(open) => {
          if (open) setPublishDialogOpen(true)
          else closePublishDialog()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish this ordered media server list?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty leading-6">
              Your external signer will create one replaceable kind 10063 event.
              It replaces the prior event for this account; it does not upload
              media, contact these HTTP servers, or modify your Nostr relay
              settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ol className="max-h-56 list-decimal space-y-2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 pl-9 font-mono text-xs text-[var(--text-primary)]">
            {view.localServerUrls.map((serverUrl) => (
              <li key={serverUrl} className="break-all pl-1">
                {serverUrl}
              </li>
            ))}
          </ol>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closePublishDialog}
            >
              Keep editing
            </Button>
            <Button type="button" onClick={confirmPublish}>
              <Upload className="size-4" aria-hidden="true" />
              Sign and publish
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
