import {
  ArrowDown,
  ArrowUp,
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
  PreferenceSectionBody,
  PreferenceSectionCard,
  PreferenceSectionDivider,
  PreferenceSectionFooter,
} from "./PreferenceSectionCard"
import {
  SignedActionStatus,
  type SignedActionStatusState,
} from "./SignedActionStatus"

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
  const date = new Date(seconds * 1_000)
  return Number.isFinite(date.getTime()) ? dateTimeFormatter.format(date) : null
}

function formatObservedTime(milliseconds: number | null): string | null {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? dateTimeFormatter.format(date) : null
}

function publishedPreferenceMessage(
  view: MediaServerPreferencesView
): string | null {
  const hasPublishedPreference =
    view.publishedCreatedAt !== null || view.publishedServerUrls.length > 0

  switch (view.status) {
    case "loading":
      return hasPublishedPreference ? null : "Refreshing published preference."
    case "published":
      return hasPublishedPreference ? null : "No published preference found."
    case "not_observed":
      return hasPublishedPreference ? null : "No published preference found."
    case "empty":
      return "The published preference is empty. Add a media server to replace it."
    case "malformed":
      return "The published preference needs repair. Add a valid media server to replace it."
    case "lookup_partial":
      return hasPublishedPreference
        ? null
        : "No published preference was found in the relay responses received."
    case "lookup_unavailable":
    default:
      return hasPublishedPreference
        ? null
        : "Published preference could not be refreshed."
  }
}

function observedSourceLabel(sourceRelayCount: number): string {
  if (sourceRelayCount === 0) return "Source not recorded"
  return `Seen on ${sourceRelayCount} relay${sourceRelayCount === 1 ? "" : "s"}`
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
  const publishedMessage = publishedPreferenceMessage(view)
  const publishedAt = formatEventTime(view.publishedCreatedAt)
  const observedAt = formatObservedTime(view.observedAt)
  const actionStatus = getActionStatusState(view)
  const checking = view.isLoading || view.isRefetching

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
    <PreferenceSectionCard
      headingId="media-server-preferences-heading"
      title="Media servers"
      description="Choose the preferred order for Blossom media servers."
      headerAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={checking}
          onClick={onRetryLookup}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {checking ? "Refreshing" : "Refresh"}
        </Button>
      }
      aria-busy={view.isLoading || view.isRefetching || undefined}
      className={className}
    >
      <PreferenceSectionBody className="pt-0 sm:pt-0">
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5 sm:px-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <span className="ml-1">Published preference</span>
          </summary>
          <div className="mt-3 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            {publishedAt ? (
              <p className="flex flex-wrap gap-x-2 text-xs leading-5">
                <span className="tabular-nums">Published {publishedAt}</span>
                {observedAt ? (
                  <span className="tabular-nums">Last seen {observedAt}</span>
                ) : null}
                <span className="tabular-nums">
                  {observedSourceLabel(view.sourceRelayCount)}
                </span>
              </p>
            ) : null}
            {publishedMessage ? <p>{publishedMessage}</p> : null}
            {view.publishedServerUrls.length > 0 ? (
              <ol className="mt-3 list-decimal space-y-1 pl-5 font-mono text-xs text-[var(--text-primary)]">
                {view.publishedServerUrls.map((serverUrl) => (
                  <li key={serverUrl} className="break-all pl-1">
                    {serverUrl}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </details>
      </PreferenceSectionBody>

      <PreferenceSectionDivider />

      <PreferenceSectionBody>
        {view.localServerUrls.length > 0 ? (
          <ol className="space-y-2" aria-label="Ordered media servers">
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
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] text-xs font-semibold tabular-nums text-[var(--primary-500)]"
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
                    className="min-h-11 min-w-11"
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
                    className="min-h-11 min-w-11"
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
                    className="min-h-11 min-w-11"
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
      </PreferenceSectionBody>

      <PreferenceSectionDivider />

      <PreferenceSectionBody>
        <form onSubmit={handleAdd}>
          <label
            htmlFor="media-server-url"
            className="text-sm font-medium text-[var(--text-primary)]"
          >
            Add media server
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
              placeholder="https://media.your-domain.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={
                validationError ? "media-server-url-error" : undefined
              }
              className="h-11 rounded-xl bg-[var(--surface-elevated)] font-mono"
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
          {validationError ? (
            <p
              id="media-server-url-error"
              role="alert"
              className="mt-2 text-sm text-[var(--error)]"
            >
              {validationError}
            </p>
          ) : null}
        </form>
      </PreferenceSectionBody>

      <PreferenceSectionDivider />

      <PreferenceSectionFooter
        attention={view.dirty}
        className="flex flex-col items-stretch gap-3"
      >
        {view.pendingSignedListDiffers ? (
          <p className="rounded-xl border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-3 py-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Retry will send the exact previously signed list. Your newer local
            edits will remain unpublished and will not be silently substituted.
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            {actionStatus === "idle" && !view.publishMessage ? (
              <div>
                <p className="text-sm font-semibold text-[var(--text-secondary)]">
                  No unpublished changes
                </p>
                <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-muted)]">
                  Edit the order or add a media server to prepare an update.
                </p>
              </div>
            ) : (
              <SignedActionStatus
                state={actionStatus}
                message={view.publishMessage}
                dirtyMessage="Draft saved on this device; not published."
                publishingMessage={
                  view.publishPhase === "checking"
                    ? "Rechecking the current replacement frontier before signing."
                    : view.publishPhase === "confirming"
                      ? "Relay acceptance was received. Running a fresh exact-event read-back."
                      : undefined
                }
              />
            )}
            {view.publishDisabledReason && view.dirty ? (
              <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-muted)]">
                {view.publishDisabledReason}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {view.retryAvailable ? (
              <Button
                type="button"
                variant="outline"
                disabled={
                  view.publishPhase === "publishing" ||
                  view.publishPhase === "confirming"
                }
                className="min-h-11"
                onClick={() => void onRetryPublish()}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Retry signed update
              </Button>
            ) : null}
            <Button
              ref={publishButtonRef}
              type="button"
              variant={view.dirty ? "primary" : "outline"}
              disabled={!view.canPublish}
              title={view.publishDisabledReason ?? undefined}
              className="min-h-11"
              onClick={() => setPublishDialogOpen(true)}
            >
              <Upload className="size-4" aria-hidden="true" />
              Review and publish
            </Button>
          </div>
        </div>
      </PreferenceSectionFooter>

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
              className="min-h-11"
              onClick={closePublishDialog}
            >
              Keep editing
            </Button>
            <Button type="button" className="min-h-11" onClick={confirmPublish}>
              <Upload className="size-4" aria-hidden="true" />
              Sign and publish
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PreferenceSectionCard>
  )
}
