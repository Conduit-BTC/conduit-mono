import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react"
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react"
import {
  countAccountNetworkChangedKinds,
  getAccountNetworkRemovalInstruction,
  orderAccountNetworkRelayRows,
  tryNormalizeRelayUrl,
  validateAccountNetworkDesiredRoles,
  type AccountNetworkDesiredRelayRoles,
  type AccountNetworkRelayRowView,
  type AccountNetworkRole,
  type AccountNetworkSettingsController,
  type AccountNetworkSettingsOperationPhase,
} from "@conduit/core"
import { cn } from "../utils"
import { Badge } from "./Badge"
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
import { MediaServerPreferencesSection } from "./MediaServerPreferencesSection"
import { StatusPill } from "./StatusPill"

export interface RelaySettingsPanelProps {
  controller: AccountNetworkSettingsController
  className?: string
}

function desiredRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readEnabled,
    publishEnabled: row.publishEnabled,
    privateInboxEnabled: row.privateInboxEnabled,
  }))
}

function baselineRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readState === "published" || row.readState === "pending",
    publishEnabled:
      row.publishState === "published" || row.publishState === "pending",
    privateInboxEnabled:
      row.privateInboxState === "published" ||
      row.privateInboxState === "pending",
  }))
}

function hasSignedOrPendingMembership(
  row: AccountNetworkRelayRowView
): boolean {
  return [row.readState, row.publishState, row.privateInboxState].some(
    (state) => state === "published" || state === "pending"
  )
}

function discardReviewRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkRelayRowView[] {
  const baseline = new Map(
    baselineRolesFromRows(rows).map((entry) => [entry.url, entry])
  )
  return rows.map((row) => ({
    ...row,
    readEnabled: baseline.get(row.url)?.readEnabled ?? false,
    publishEnabled: baseline.get(row.url)?.publishEnabled ?? false,
    privateInboxEnabled: baseline.get(row.url)?.privateInboxEnabled ?? false,
  }))
}

function roleEnabled(
  row: AccountNetworkRelayRowView,
  role: AccountNetworkRole
) {
  if (role === "read") return row.readEnabled
  if (role === "publish") return row.publishEnabled
  return row.privateInboxEnabled
}

function roleLabel(role: AccountNetworkRole): string {
  if (role === "read") return "Read"
  if (role === "publish") return "Publish"
  return "Private inbox"
}

function RoleToggle({
  row,
  role,
  disabled,
  inboxLimitReached,
  onToggle,
}: {
  row: AccountNetworkRelayRowView
  role: AccountNetworkRole
  disabled: boolean
  inboxLimitReached: boolean
  onToggle: (trigger: HTMLButtonElement) => void
}) {
  const label = roleLabel(role)
  const enabled = roleEnabled(row, role)
  const maxInboxReached =
    role === "private_inbox" && !enabled && inboxLimitReached
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} ${label} for ${row.url}`}
      title={
        maxInboxReached
          ? "Private inbox lists are limited to three relays."
          : `${enabled ? "Disable" : "Enable"} ${label}`
      }
      disabled={disabled}
      onClick={(event) => onToggle(event.currentTarget)}
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-full border px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40",
        enabled
          ? "border-primary-400 bg-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] text-[var(--primary-500)]"
          : "border-[var(--border-overlay)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  )
}

type CapabilityBadgeVariant =
  "secondary" | "success" | "outline" | "warning" | "destructive"

interface CapabilityBadgeDescriptor {
  label: string
  variant: CapabilityBadgeVariant
  title?: string
}

function capabilityBadgeDescriptors(
  row: AccountNetworkRelayRowView
): CapabilityBadgeDescriptor[] {
  const capability = row.capability
  const badges: CapabilityBadgeDescriptor[] = []
  if (capability.configuredCommerce) {
    badges.push({
      label: "Commerce configured",
      variant: "secondary",
      title:
        "Conduit's versioned configuration identifies this relay for commerce. This is not a live check.",
    })
  }
  if (capability.observedCommerce) {
    badges.push({
      label: "Commerce observed",
      variant: "success",
      title:
        "A scoped prior commerce operation recorded supporting evidence. It does not prove universal availability.",
    })
  }
  if (capability.nip11 === "advertised") {
    badges.push({
      label: "NIP-11 metadata observed",
      variant: "outline",
      title:
        "A NIP-11 relay information document was observed. Metadata is not a health check.",
    })
  } else if (capability.nip11 === "unavailable") {
    badges.push({
      label: "NIP-11 metadata unavailable",
      variant: "warning",
      title:
        "The latest bounded metadata request did not return usable NIP-11 information. Relay health was not tested.",
    })
  } else {
    badges.push({
      label: "Metadata not checked",
      variant: "outline",
      title: "No NIP-11 metadata request is recorded.",
    })
  }
  if (capability.searchAdvertised) {
    badges.push({
      label: "Search advertised",
      variant: "outline",
      title: "The relay information document advertises NIP-50 search support.",
    })
  }
  const authBadge: Record<
    AccountNetworkRelayRowView["capability"]["authEvidence"],
    CapabilityBadgeDescriptor
  > = {
    advertised: {
      label: "Auth advertised",
      variant: "outline",
      title:
        "NIP-11 metadata advertises authentication. No successful authentication is implied.",
    },
    challenge_observed: {
      label: "Auth challenge observed",
      variant: "outline",
    },
    succeeded: { label: "Auth succeeded", variant: "success" },
    rejected: { label: "Auth rejected", variant: "destructive" },
    unavailable: { label: "Auth unavailable", variant: "warning" },
    untested: { label: "Auth untested", variant: "outline" },
  }
  badges.push(authBadge[capability.authEvidence])
  return badges
}

function CapabilityBadges({ row }: { row: AccountNetworkRelayRowView }) {
  const badges = capabilityBadgeDescriptors(row)
  return (
    <div
      className="flex flex-wrap gap-1.5"
      aria-label={`Evidence for ${row.url}`}
    >
      {badges.map((badge) => (
        <Badge key={badge.label} variant={badge.variant} title={badge.title}>
          {badge.label}
        </Badge>
      ))}
    </div>
  )
}

function RelayRow({
  row,
  mutationDisabled,
  operationBusy,
  metadataDisabled,
  wholeSetupRemoval,
  inboxCount,
  refreshing,
  onToggle,
  onRefresh,
  onRemove,
}: {
  row: AccountNetworkRelayRowView
  mutationDisabled: boolean
  operationBusy: boolean
  metadataDisabled: boolean
  wholeSetupRemoval: boolean
  inboxCount: number
  refreshing: boolean
  onToggle: (role: AccountNetworkRole, trigger: HTMLButtonElement) => void
  onRefresh: () => void
  onRemove: (trigger: HTMLButtonElement) => void
}) {
  const pending =
    row.readState === "pending" ||
    row.publishState === "pending" ||
    row.privateInboxState === "pending"
  const draft =
    row.candidate || row.readState === "draft" || row.publishState === "draft"
  return (
    <li className="border-b border-[var(--border)] py-4 last:border-b-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className="min-w-0 truncate font-mono text-sm text-[var(--text-primary)]"
              title={row.url}
            >
              {row.url}
            </span>
            {pending ? (
              <StatusPill variant="warning" noIcon>
                Pending confirmation
              </StatusPill>
            ) : draft ? (
              <StatusPill variant="neutral" noIcon>
                Unpublished candidate
              </StatusPill>
            ) : (
              <StatusPill variant="success" noIcon>
                Signed
              </StatusPill>
            )}
          </div>
          {row.capability.relayName ? (
            <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
              {row.capability.relayName}
            </p>
          ) : null}
          <div className="mt-2">
            <CapabilityBadges row={row} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:max-w-[23rem] lg:justify-end">
          {(["read", "publish", "private_inbox"] as const).map((role) => (
            <RoleToggle
              key={role}
              row={row}
              role={role}
              disabled={
                mutationDisabled ||
                (role === "private_inbox" &&
                  !row.privateInboxEnabled &&
                  inboxCount >= 3)
              }
              inboxLimitReached={inboxCount >= 3}
              onToggle={(trigger) => onToggle(role, trigger)}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`Refresh advertised metadata for ${row.url}`}
            title="Refresh advertised metadata"
            disabled={metadataDisabled || refreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              wholeSetupRemoval
                ? `Remove ${row.url} from my whole setup`
                : `Discard unpublished candidate ${row.url}`
            }
            title={
              wholeSetupRemoval
                ? "Remove from my whole setup"
                : "Discard unpublished candidate"
            }
            disabled={wholeSetupRemoval ? mutationDisabled : operationBusy}
            onClick={(event) => onRemove(event.currentTarget)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  )
}

function coverageLabel(coverage: string): string {
  if (coverage === "complete") return "Complete bounded check"
  if (coverage === "partial") return "Partial check"
  if (coverage === "unavailable") return "Check unavailable"
  return "Not checked"
}

function stateLabel(state: string): string {
  switch (state) {
    case "declared":
      return "Signed preferences found"
    case "distribution_pending":
      return "Signed update pending"
    case "signed_empty":
      return "Signed empty preference"
    case "malformed":
      return "Signed preference unusable"
    case "not_observed":
      return "Not observed in this bounded check"
    case "lookup_partial":
      return "Partial check"
    case "lookup_unavailable":
      return "Check unavailable"
    default:
      return "Not checked"
  }
}

function ReconciliationSummary({
  controller,
}: {
  controller: AccountNetworkSettingsController
}) {
  const { view } = controller
  const checking = view.status === "reconciling"
  const operationBusy = operationIsBusy(controller.operation.phase)
  const failed = view.status === "error"
  return (
    <section
      aria-labelledby="network-check-heading"
      aria-busy={checking}
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="network-check-heading"
            className="text-balance text-sm font-semibold text-[var(--text-primary)]"
          >
            Signed preference check
          </h2>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Each fresh signer connection checks both signed preference objects
            across the same bounded relay set. Partial results are not treated
            as absence.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={checking || operationBusy}
          onClick={controller.retryReconciliation}
        >
          <RefreshCw
            className={cn("size-4", checking && "animate-spin")}
            aria-hidden="true"
          />
          {checking ? "Checking" : "Check again"}
        </Button>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
          <dt className="text-xs font-medium text-[var(--text-muted)]">
            Read and Publish
          </dt>
          <dd className="mt-1 text-sm text-[var(--text-primary)]">
            {stateLabel(view.relayList.state)}
          </dd>
          <dd className="mt-1 text-xs text-[var(--text-secondary)]">
            {coverageLabel(view.relayList.coverage)}
            {view.relayList.stale ? " · retained signed evidence is stale" : ""}
          </dd>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
          <dt className="text-xs font-medium text-[var(--text-muted)]">
            Private inbox
          </dt>
          <dd className="mt-1 text-sm text-[var(--text-primary)]">
            {stateLabel(view.inbox.state)}
          </dd>
          <dd className="mt-1 text-xs text-[var(--text-secondary)]">
            {coverageLabel(view.inbox.coverage)}
            {view.inbox.stale ? " · retained signed evidence is stale" : ""}
          </dd>
        </div>
      </dl>
      {failed && view.error ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {view.error}
        </p>
      ) : null}
      {view.pendingStatus === "unavailable" ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-warning">
          Signed retry storage is unavailable. Existing signed preferences are
          still shown, but this device cannot safely stage or resume an update
          until the check succeeds.
        </p>
      ) : null}
    </section>
  )
}

function PendingUpdateSummary({
  controller,
}: {
  controller: AccountNetworkSettingsController
}) {
  const checkpoints = controller.view.pendingCheckpoints
  if (checkpoints.length === 0) return null
  const retryAvailable = checkpoints.some(
    (checkpoint) => checkpoint.retryAvailable
  )
  return (
    <section
      aria-labelledby="pending-network-update-heading"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="pending-network-update-heading"
            className="text-balance text-sm font-semibold text-[var(--text-primary)]"
          >
            Signed update status
          </h2>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            The signed objects publish and confirm independently. Relay
            acceptance does not mean another client has observed them.
          </p>
        </div>
        {retryAvailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={operationIsBusy(controller.operation.phase)}
            onClick={() =>
              void controller.retryPendingUpdate().catch(() => undefined)
            }
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Retry exact signed update
          </Button>
        ) : null}
      </div>
      <ul className="mt-3 space-y-2">
        {checkpoints.map((checkpoint) => (
          <li
            key={checkpoint.kind}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {checkpoint.label}
              </span>
              <StatusPill
                variant={
                  checkpoint.state === "confirmed"
                    ? "success"
                    : checkpoint.state === "superseded"
                      ? "neutral"
                      : "warning"
                }
                noIcon
              >
                {checkpoint.state === "confirmed"
                  ? "Exact event confirmed"
                  : checkpoint.state === "superseded"
                    ? "Superseded by newer signed state"
                    : checkpoint.state === "partial"
                      ? "Partial relay outcome"
                      : "Confirmation pending"}
              </StatusPill>
            </div>
            <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
              {checkpoint.acceptedCount} accepted · {checkpoint.confirmedCount}{" "}
              exact readback · {checkpoint.rejectedCount} rejected ·{" "}
              {checkpoint.timedOutCount} timed out · {checkpoint.targetCount}{" "}
              planned
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function operationMessage(
  phase: AccountNetworkSettingsOperationPhase,
  fallback: string | null
): string | null {
  if (fallback) return fallback
  if (phase === "checking") return "Checking the current signed preferences."
  if (phase === "awaiting_signatures") {
    return "Complete each signer request. Nothing changes until every required signature is staged."
  }
  if (phase === "staging") {
    return "Storing the exact signed preferences before any relay write."
  }
  if (phase === "publishing") {
    return "Publishing each signed preference independently."
  }
  if (phase === "confirming") {
    return "Checking for the exact signed preferences on shared relays."
  }
  return null
}

function operationIsBusy(phase: AccountNetworkSettingsOperationPhase): boolean {
  return !["idle", "complete", "error"].includes(phase)
}

export function RelayRemovalDialog({
  relayUrl,
  instruction,
  errorMessage,
  busy,
  returnFocusRef,
  onCancel,
  onProceed,
}: {
  relayUrl: string | null
  instruction: string | null
  errorMessage: string | null
  busy: boolean
  returnFocusRef?: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onProceed: () => void
}) {
  return (
    <AlertDialog
      open={relayUrl !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current?.isConnected) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            Remove this relay from your whole setup?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-pretty leading-6">
            After you complete every signer request, Conduit will stop reading,
            publishing, and checking it for private messages immediately. Stale
            clients may still send messages there, and those messages can be
            missed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="break-all rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]">
          {relayUrl}
        </div>
        {instruction ? (
          <p role="alert" className="text-pretty text-sm text-warning">
            {instruction}
          </p>
        ) : null}
        {errorMessage ? (
          <p role="alert" className="text-pretty text-sm text-error">
            {errorMessage}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || Boolean(instruction)}
            onClick={onProceed}
          >
            Proceed
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function removalInstructionForReview(
  relayUrl: string | null,
  dirty: boolean,
  baselineRoles: readonly AccountNetworkDesiredRelayRoles[]
): string | null {
  if (!relayUrl) return null
  if (dirty) {
    return "Save or discard your other reviewed role changes before removing this relay."
  }
  return getAccountNetworkRemovalInstruction(baselineRoles, relayUrl)
}

function useRelaySettingsReview(controller: AccountNetworkSettingsController) {
  // RelaySettingsPanel keys this editable draft by the signed-frontier revision.
  const [rows, setRows] = useState<AccountNetworkRelayRowView[]>(
    () => controller.view.rows
  )
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [refreshingUrl, setRefreshingUrl] = useState<string | null>(null)
  const [relayPendingRemoval, setRelayPendingRemoval] = useState<string | null>(
    null
  )
  const removalTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [localActionError, setLocalActionError] = useState<string | null>(null)

  const baselineRoles = useMemo(
    () => baselineRolesFromRows(controller.view.rows),
    [controller.view.rows]
  )
  const presentationRows = useMemo(() => {
    const currentByUrl = new Map(
      controller.view.rows.map((row) => [row.url, row])
    )
    return orderAccountNetworkRelayRows(
      rows.map((row) => {
        const current = currentByUrl.get(row.url)
        const capability = controller.view.capabilityByUrl[row.url]
        return current || capability
          ? {
              ...row,
              signedPosition: current?.signedPosition ?? row.signedPosition,
              capability: capability ?? current?.capability ?? row.capability,
            }
          : row
      })
    )
  }, [controller.view.capabilityByUrl, controller.view.rows, rows])
  const desiredRoles = useMemo(
    () => desiredRolesFromRows(presentationRows),
    [presentationRows]
  )
  const wholeSetupRelayUrls = useMemo(() => {
    const relayUrls = new Set<string>()
    for (const row of controller.view.rows) {
      if (hasSignedOrPendingMembership(row)) relayUrls.add(row.url)
    }
    return relayUrls
  }, [controller.view.rows])
  const changedKindCount = countAccountNetworkChangedKinds(
    baselineRoles,
    desiredRoles
  )
  const dirty = changedKindCount > 0
  const validationError = validateAccountNetworkDesiredRoles(desiredRoles)
  const pendingRetry = controller.view.pendingCheckpoints.some(
    (checkpoint) => checkpoint.retryAvailable
  )
  const busy = operationIsBusy(controller.operation.phase)
  const metadataReady = controller.view.status === "ready" && !busy
  const mutationReady =
    metadataReady &&
    !pendingRetry &&
    controller.view.pendingStatus !== "unavailable"
  const inboxCount = rows.filter((row) => row.privateInboxEnabled).length
  const removalInstruction = removalInstructionForReview(
    relayPendingRemoval,
    dirty,
    baselineRoles
  )
  const operationText = operationMessage(
    controller.operation.phase,
    controller.operation.message
  )

  function toggleRole(
    url: string,
    role: AccountNetworkRole,
    trigger: HTMLButtonElement
  ): void {
    controller.clearOperation()
    setLocalActionError(null)
    const currentRow = rows.find((row) => row.url === url)
    if (
      currentRow &&
      wholeSetupRelayUrls.has(url) &&
      roleEnabled(currentRow, role) &&
      Number(currentRow.readEnabled) +
        Number(currentRow.publishEnabled) +
        Number(currentRow.privateInboxEnabled) ===
        1
    ) {
      removalTriggerRef.current = trigger
      setRelayPendingRemoval(url)
      return
    }
    setRows((current) =>
      orderAccountNetworkRelayRows(
        current.map((row) => {
          if (row.url !== url) return row
          if (role === "read") {
            return { ...row, readEnabled: !row.readEnabled }
          }
          if (role === "publish") {
            return { ...row, publishEnabled: !row.publishEnabled }
          }
          return { ...row, privateInboxEnabled: !row.privateInboxEnabled }
        })
      )
    )
  }

  async function addRelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newRelayUrl.trim() || isAdding) return
    setAddError(null)
    const normalized = tryNormalizeRelayUrl(newRelayUrl)
    if (!normalized.ok) {
      setAddError(normalized.error)
      return
    }
    if (rows.some((row) => row.url === normalized.url)) {
      setAddError("This relay is already in your Network review.")
      return
    }
    setIsAdding(true)
    try {
      const added = await controller.addRelay(normalized.url)
      setRows((current) =>
        current.some((row) => row.url === added.url)
          ? current
          : orderAccountNetworkRelayRows([...current, added])
      )
      setNewRelayUrl("")
      controller.clearOperation()
    } catch (error) {
      setAddError(
        error instanceof Error ? error.message : "Unable to add this relay."
      )
    } finally {
      setIsAdding(false)
    }
  }

  async function refreshRelay(row: AccountNetworkRelayRowView): Promise<void> {
    setRefreshingUrl(row.url)
    setLocalActionError(null)
    try {
      const refreshed = await controller.refreshRelay(row)
      setRows((current) =>
        orderAccountNetworkRelayRows(
          current.map((candidate) =>
            candidate.url === row.url ? refreshed : candidate
          )
        )
      )
    } catch (error) {
      setLocalActionError(
        error instanceof Error
          ? error.message
          : "Unable to refresh advertised metadata."
      )
    } finally {
      setRefreshingUrl(null)
    }
  }

  function requestRelayRemoval(
    row: AccountNetworkRelayRowView,
    trigger: HTMLButtonElement
  ): void {
    if (!wholeSetupRelayUrls.has(row.url)) {
      setRows((current) =>
        current.filter((candidate) => candidate.url !== row.url)
      )
      setLocalActionError(null)
      controller.clearOperation()
      return
    }
    controller.clearOperation()
    removalTriggerRef.current = trigger
    setRelayPendingRemoval(row.url)
  }

  async function saveReview(): Promise<void> {
    setLocalActionError(null)
    if (validationError) {
      setLocalActionError(validationError)
      return
    }
    try {
      await controller.save(desiredRoles)
    } catch {
      // The controller exposes the actionable error beside this action.
    }
  }

  function discardReview(): void {
    setRows(discardReviewRows(controller.view.rows))
    setLocalActionError(null)
    controller.clearOperation()
  }

  function cancelRemoval(): void {
    setRelayPendingRemoval(null)
  }

  async function proceedRemoval(): Promise<void> {
    if (!relayPendingRemoval) return
    try {
      await controller.removeRelay(relayPendingRemoval)
      setRelayPendingRemoval(null)
    } catch {
      // The controller exposes the actionable error beside this action.
    }
  }

  return {
    rows: presentationRows,
    newRelayUrl,
    addError,
    localActionError,
    isAdding,
    refreshingUrl,
    relayPendingRemoval,
    removalTriggerRef,
    wholeSetupRelayUrls,
    changedKindCount,
    dirty,
    validationError,
    busy,
    metadataReady,
    mutationReady,
    inboxCount,
    removalInstruction,
    operationText,
    setNewRelayUrl,
    toggleRole,
    addRelay,
    refreshRelay,
    requestRelayRemoval,
    saveReview,
    discardReview,
    cancelRemoval,
    proceedRemoval,
  }
}

type RelaySettingsReview = ReturnType<typeof useRelaySettingsReview>

function NetworkHeader() {
  return (
    <header>
      <h1 className="text-balance font-display text-4xl font-semibold text-[var(--text-primary)] sm:text-5xl">
        Network
      </h1>
      <p className="mt-3 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
        Choose where Conduit reads, publishes, and receives private messages on
        Nostr.
      </p>
    </header>
  )
}

function ConduitRelayPrompt({
  controller,
  review,
}: {
  controller: AccountNetworkSettingsController
  review: RelaySettingsReview
}) {
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recommendation = controller.view.conduitRelayPrompt
  const hasUnpublishedCandidate = review.rows.some(
    (row) => !controller.view.rows.some((current) => current.url === row.url)
  )
  if (!recommendation || dismissed || review.dirty || hasUnpublishedCandidate) {
    return null
  }
  const busy = operationIsBusy(controller.operation.phase)
  const missingRoleLabels = recommendation.missingRoles.map(roleLabel)
  const missingRoles =
    missingRoleLabels.length === 1
      ? missingRoleLabels[0]
      : missingRoleLabels.length === 2
        ? `${missingRoleLabels[0]} and ${missingRoleLabels[1]}`
        : `${missingRoleLabels.slice(0, -1).join(", ")}, and ${missingRoleLabels.at(-1)}`

  async function accept(): Promise<void> {
    setError(null)
    try {
      await controller.addConduitRelay()
      setDismissed(true)
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The Conduit relay could not be added."
      )
    }
  }

  return (
    <section
      aria-labelledby="conduit-relay-prompt-heading"
      className="rounded-2xl border border-primary-500/50 bg-[var(--surface)] p-4"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2
            id="conduit-relay-prompt-heading"
            className="text-balance text-lg font-semibold text-[var(--text-primary)]"
          >
            Add the Conduit relay?
          </h2>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Add{" "}
            <span className="break-all font-mono">
              {recommendation.relayUrl}
            </span>{" "}
            for {missingRoles}. Your existing relays and their order stay
            unchanged. This requires {recommendation.changedKindCount} signer{" "}
            {recommendation.changedKindCount === 1 ? "request" : "requests"}.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDismissed(true)
              setError(null)
              controller.clearOperation()
            }}
          >
            Dismiss
          </Button>
          <Button type="button" disabled={busy} onClick={() => void accept()}>
            <Plus className="size-4" aria-hidden="true" />
            Add the Conduit relay
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function LegacyInboxRecoverySection({
  controller,
  busy,
}: {
  controller: AccountNetworkSettingsController
  busy: boolean
}) {
  if (!controller.exactInboxRedistributionAvailable) return null
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-balance text-sm font-semibold text-[var(--text-primary)]">
            Finish private inbox distribution
          </h2>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Retry the exact signed declaration already retained on this device.
            This does not create a new event or ask your signer.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void controller
              .redistributeExactInboxDeclaration()
              .catch(() => undefined)
          }
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Retry exact declaration
        </Button>
      </div>
    </section>
  )
}

function AddRelaySection({ review }: { review: RelaySettingsReview }) {
  return (
    <form
      onSubmit={(event) => void review.addRelay(event)}
      className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <label
        htmlFor="account-network-relay-url"
        className="text-sm font-medium text-[var(--text-primary)]"
      >
        Add Relay
      </label>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <Input
          id="account-network-relay-url"
          aria-describedby={
            review.addError
              ? "account-network-relay-help account-network-relay-error"
              : "account-network-relay-help"
          }
          aria-invalid={review.addError ? true : undefined}
          value={review.newRelayUrl}
          onChange={(event) => review.setNewRelayUrl(event.target.value)}
          placeholder="wss://relay.example.com"
          className="h-12 rounded-2xl bg-[var(--surface-elevated)] font-mono"
        />
        <Button
          type="submit"
          disabled={
            !review.metadataReady ||
            review.isAdding ||
            !review.newRelayUrl.trim()
          }
          className="h-12 rounded-2xl px-5"
        >
          <Plus className="size-4" aria-hidden="true" />
          {review.isAdding ? "Reading metadata" : "Add Relay"}
        </Button>
      </div>
      <p
        id="account-network-relay-help"
        className="mt-3 text-pretty text-sm leading-6 text-[var(--text-muted)]"
      >
        Adding a relay only reads its advertised metadata. It remains an
        unpublished candidate until you choose roles and save.
      </p>
      {review.addError ? (
        <p
          id="account-network-relay-error"
          role="alert"
          className="mt-2 text-pretty text-sm text-error"
        >
          {review.addError}
        </p>
      ) : null}
    </form>
  )
}

function RelayListSection({ review }: { review: RelaySettingsReview }) {
  return (
    <section aria-labelledby="relay-list-heading">
      <div>
        <h2
          id="relay-list-heading"
          className="text-balance text-lg font-semibold text-[var(--text-primary)]"
        >
          Relays
        </h2>
        <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          Each relay appears once. Conduit orders this list automatically from
          configured, observed, and advertised evidence; signed order is the
          stable tie-breaker.
        </p>
      </div>
      <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4">
        {review.rows.length > 0 ? (
          <ul>
            {review.rows.map((row) => (
              <RelayRow
                key={row.url}
                row={row}
                mutationDisabled={!review.mutationReady}
                operationBusy={review.busy}
                metadataDisabled={!review.metadataReady}
                wholeSetupRemoval={review.wholeSetupRelayUrls.has(row.url)}
                inboxCount={review.inboxCount}
                refreshing={review.refreshingUrl === row.url}
                onToggle={(role, trigger) =>
                  review.toggleRole(row.url, role, trigger)
                }
                onRefresh={() => void review.refreshRelay(row)}
                onRemove={(trigger) => review.requestRelayRemoval(row, trigger)}
              />
            ))}
          </ul>
        ) : (
          <div className="py-8 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            No signed relay membership was observed in this bounded check. Add
            at least two relays, including one Private inbox, to prepare a safe
            account setup.
          </div>
        )}
      </div>
    </section>
  )
}

function OperationNotice({
  controller,
  message,
}: {
  controller: AccountNetworkSettingsController
  message: string | null
}) {
  if (!message) return null
  const phase = controller.operation.phase
  const error = phase === "error"
  const complete = phase === "complete"
  return (
    <div
      role={error ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "mt-3 flex items-start gap-2 text-pretty text-sm leading-6",
        error
          ? "text-error"
          : complete
            ? "text-success"
            : "text-[var(--text-secondary)]"
      )}
    >
      {error ? (
        <AlertCircle className="mt-1 size-4 shrink-0" aria-hidden="true" />
      ) : complete ? (
        <CheckCircle2 className="mt-1 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />
      )}
      <span>{message}</span>
    </div>
  )
}

function NetworkReviewSection({
  controller,
  review,
}: {
  controller: AccountNetworkSettingsController
  review: RelaySettingsReview
}) {
  const validationVisible = Boolean(review.validationError && review.dirty)
  return (
    <section
      aria-labelledby="network-review-heading"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="network-review-heading"
            className="text-balance text-sm font-semibold text-[var(--text-primary)]"
          >
            Review Network changes
          </h2>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            One update may require {review.changedKindCount || "one or two"}{" "}
            signer {review.changedKindCount === 1 ? "request" : "requests"}. The
            two signed preferences still publish and confirm independently.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {review.dirty ? (
              <Button
                type="button"
                variant="ghost"
                disabled={review.busy}
                onClick={review.discardReview}
              >
                Discard edits
              </Button>
            ) : null}
            <Button
              type="button"
              aria-describedby={
                validationVisible ? "network-review-validation" : undefined
              }
              disabled={
                !review.mutationReady ||
                !review.dirty ||
                Boolean(review.validationError)
              }
              onClick={() => void review.saveReview()}
            >
              Save Network changes
            </Button>
          </div>
          {validationVisible ? (
            <p
              id="network-review-validation"
              className="max-w-sm text-pretty text-right text-xs text-warning"
            >
              {review.validationError}
            </p>
          ) : null}
        </div>
      </div>
      {review.localActionError ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {review.localActionError}
        </p>
      ) : null}
      <OperationNotice controller={controller} message={review.operationText} />
    </section>
  )
}

function RelaySettingsPanelContent({
  controller,
  className,
}: RelaySettingsPanelProps) {
  const review = useRelaySettingsReview(controller)
  return (
    <section
      className={cn(
        "rounded-[2rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 shadow-lg sm:p-7",
        className
      )}
    >
      <div className="space-y-6">
        <NetworkHeader />
        <ReconciliationSummary controller={controller} />
        <ConduitRelayPrompt controller={controller} review={review} />
        <PendingUpdateSummary controller={controller} />
        <LegacyInboxRecoverySection
          controller={controller}
          busy={review.busy}
        />
        <AddRelaySection review={review} />
        <RelayListSection review={review} />
        <NetworkReviewSection controller={controller} review={review} />
        {controller.mediaServers ? (
          <MediaServerPreferencesSection {...controller.mediaServers} />
        ) : null}
      </div>
      <RelayRemovalDialog
        relayUrl={review.relayPendingRemoval}
        instruction={review.removalInstruction}
        errorMessage={
          controller.operation.kind === "remove" &&
          controller.operation.phase === "error"
            ? (controller.operation.message ??
              "The relay could not be removed. Retry or cancel this removal.")
            : null
        }
        busy={review.busy}
        returnFocusRef={review.removalTriggerRef}
        onCancel={review.cancelRemoval}
        onProceed={() => void review.proceedRemoval()}
      />
    </section>
  )
}

export function RelaySettingsPanel(props: RelaySettingsPanelProps) {
  return (
    <RelaySettingsPanelContent
      key={props.controller.view.revision}
      {...props}
    />
  )
}
