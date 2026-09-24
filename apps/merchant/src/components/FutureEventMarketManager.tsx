import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  buildDirectMessageRumor,
  decodeEventMarketReference,
  EVENT_KINDS,
  getNdk,
  encodeEventMarketNaddr,
  listPendingEventMarketMerchantDecisions,
  normalizePubkey,
  publishEventMarketMerchantDecision,
  publishEventMarketRoster,
  publishPrivateMessage,
  previewEventMarketMerchantProducts,
  publishFutureEventMarketCalendar,
  readEventMarketAuthorization,
  readEventMarketRoster,
  retainSignedEventMarketEvidence,
  retryEventMarketAuthorizationDelivery,
  retryEventMarketMerchantDecisionDelivery,
  retryEventMarketRosterDelivery,
  useAuth,
  useConduitSession,
  type EventMarketMerchantMode,
  type EventMarketMerchantRow,
  type ParsedEventMarketCalendar,
  type ParsedEventMarketRoster,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  QRCodeSVG,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { buildFutureEventQrSignSheets } from "../lib/event-signage"
import { EventQrPrintPreview } from "./EventQrPrintPreview"
import { FutureOrganizerClaimQueue } from "./FutureOrganizerClaimQueue"
import {
  epochSecondsToLocalDateTime,
  localDateTimeToEpochSeconds,
} from "../lib/event-market-form"
import { getMerchantEventParticipationUrl } from "../lib/market-links"

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The signed change could not be completed."
}

function MarketLifecycleEditor({
  market,
  calendar,
  authenticatedPubkey,
  onChanged,
}: {
  market: ParsedEventMarketRoster
  calendar: ParsedEventMarketCalendar
  authenticatedPubkey: string
  onChanged: () => void
}) {
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const timezone = calendar.startTzid || "UTC"
  const [title, setTitle] = useState(calendar.title)
  const [location, setLocation] = useState(calendar.locations[0] ?? "")
  const [start, setStart] = useState(
    calendar.kind === 31922
      ? (calendar.startDate ?? "")
      : epochSecondsToLocalDateTime(calendar.start / 1_000, timezone)
  )
  const [end, setEnd] = useState(
    calendar.kind === 31922
      ? (calendar.endDate ?? "")
      : epochSecondsToLocalDateTime(calendar.end / 1_000, timezone)
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  async function changeOpenState(): Promise<void> {
    setPending(true)
    setError("")
    try {
      await publishEventMarketRoster({
        organizerPubkey: market.organizerPubkey,
        authenticatedPubkey,
        dTag: market.coordinate.split(":").slice(2).join(":"),
        calendarCoordinate: market.calendarCoordinate,
        state: market.state === "open" ? "closed" : "open",
        merchants: market.merchants,
        expectedPreviousEventId: market.eventId,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(market.coordinate, event),
      })
      onChanged()
    } catch (cause) {
      setError(errorText(cause))
      onChanged()
    } finally {
      setPending(false)
    }
  }
  async function saveCalendar(): Promise<void> {
    setPending(true)
    setError("")
    try {
      const draft =
        calendar.kind === 31922
          ? {
              kind: 31922 as const,
              dTag: calendar.dTag,
              title: title.trim(),
              summary: calendar.summary,
              image: calendar.image,
              locations: [location.trim()],
              start,
              end,
            }
          : {
              kind: 31923 as const,
              dTag: calendar.dTag,
              title: title.trim(),
              summary: calendar.summary,
              image: calendar.image,
              locations: [location.trim()],
              start: localDateTimeToEpochSeconds(start, timezone),
              end: localDateTimeToEpochSeconds(end, timezone),
              startTzid: timezone,
              endTzid: timezone,
            }
      await publishFutureEventMarketCalendar({
        organizerPubkey: market.organizerPubkey,
        authenticatedPubkey,
        calendar: draft,
        marketCoordinate: market.coordinate,
        expectedPreviousEventId: calendar.eventId,
        previousCreatedAt: Math.floor(calendar.createdAt / 1_000),
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(market.coordinate, event),
      })
      onChanged()
    } catch (cause) {
      setError(errorText(cause))
      onChanged()
    } finally {
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event controls</CardTitle>
        <CardDescription>
          Open or close new purchases, and edit the signed calendar. Existing
          orders keep their original terms.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void changeOpenState()}
        >
          {market.state === "open"
            ? "Close Event Market"
            : "Reopen Event Market"}
        </Button>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="future-edit-title">Title</Label>
            <Input
              id="future-edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-edit-location">Location</Label>
            <Input
              id="future-edit-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-edit-start">
              Start {calendar.kind === 31923 ? `(${timezone})` : ""}
            </Label>
            <Input
              id="future-edit-start"
              type={calendar.kind === 31922 ? "date" : "datetime-local"}
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-edit-end">
              End {calendar.kind === 31923 ? `(${timezone})` : ""}
            </Label>
            <Input
              id="future-edit-end"
              type={calendar.kind === 31922 ? "date" : "datetime-local"}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
        </div>
        <Button
          type="button"
          disabled={pending || !title.trim() || !location.trim()}
          onClick={() => void saveCalendar()}
        >
          Save event details
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MerchantAuthorityRow({
  coordinate,
  merchant,
  row,
  calendarCoordinate,
  marketEventId,
  marketState,
  allRows,
  decisionPending,
  authenticatedPubkey,
  onChanged,
}: {
  coordinate: string
  merchant: string
  row?: EventMarketMerchantRow
  calendarCoordinate: string
  marketEventId: string
  marketState: "open" | "closed"
  allRows: EventMarketMerchantRow[]
  decisionPending: boolean
  authenticatedPubkey: string | null
  onChanged: () => void
}) {
  const organizerPubkey = coordinate.split(":")[1] ?? ""
  const { isAuthGenerationCurrent, authGeneration } = useAuth()
  const [mode, setMode] = useState<EventMarketMerchantMode>(
    row?.mode ?? "merchant_present"
  )
  const [assignment, setAssignment] = useState(row?.assignment ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [confirmReapproval, setConfirmReapproval] = useState(false)
  const [invitationSent, setInvitationSent] = useState(false)
  const auth = useQuery({
    queryKey: [
      "future-market-authorization",
      coordinate,
      merchant,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readEventMarketAuthorization({
        marketCoordinate: coordinate,
        merchantPubkey: merchant,
        authenticatedPubkey,
        signal,
      }),
    enabled: !!authenticatedPubkey,
    retry: false,
  })
  const resolution = auth.data?.resolution
  const authState = resolution?.state ?? "checking"
  const isApproved =
    !!row && authState === "active" && auth.data?.actionable === true
  const canChange =
    !!authenticatedPubkey &&
    !pending &&
    !decisionPending &&
    !auth.isFetching &&
    auth.data?.retained === true &&
    auth.data.coverage === "complete" &&
    ["active", "revoked", "missing"].includes(authState)
  const expectedTipIds =
    resolution &&
    (resolution.state === "active" || resolution.state === "revoked")
      ? [resolution.tip.eventId]
      : []
  const reapproval = authState === "revoked"
  const reapprovalPreview = useQuery({
    queryKey: [
      "future-market-reapproval-preview",
      coordinate,
      merchant,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      previewEventMarketMerchantProducts({
        marketCoordinate: coordinate,
        merchantPubkey: merchant,
        authenticatedPubkey,
        signal,
      }),
    enabled: confirmReapproval && reapproval && !!authenticatedPubkey,
    retry: false,
  })

  async function invite(): Promise<void> {
    if (
      !authenticatedPubkey ||
      pending ||
      !isAuthGenerationCurrent(authGeneration)
    )
      return
    setPending(true)
    setError("")
    try {
      const ndk = getNdk()
      if (!ndk.signer)
        throw new Error("Connect the organizer signer to send an invitation.")
      const marketReference = encodeEventMarketNaddr(coordinate)
      const content = `You are invited to sell at this Event Market: ${getMerchantEventParticipationUrl(marketReference)}. Open the event in Merchant to review it. Organizer approval of your merchant account, with a public assignment, is required before your tagged products appear.`
      const rumor = buildDirectMessageRumor({
        senderPubkey: organizerPubkey,
        recipientPubkey: merchant,
        content,
        appId: "merchant",
        createdAt: Math.floor(Date.now() / 1_000),
      })
      await publishPrivateMessage({
        rumor,
        senderPubkey: organizerPubkey,
        accountPubkey: organizerPubkey,
        authenticatedPubkey: organizerPubkey,
        recipientPubkey: merchant,
        signer: ndk.signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        signerInteraction: "external",
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      setInvitationSent(true)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  async function save(action: "approve" | "edit" | "revoke"): Promise<void> {
    if (
      !canChange ||
      !authenticatedPubkey ||
      !isAuthGenerationCurrent(authGeneration)
    )
      return
    if (action !== "revoke" && !assignment.trim()) {
      setError("A public booth or pickup assignment is required.")
      return
    }
    if (action === "approve" && reapproval && !confirmReapproval) {
      setConfirmReapproval(true)
      return
    }
    setPending(true)
    setError("")
    try {
      const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
      if (action === "edit") {
        await publishEventMarketRoster({
          organizerPubkey,
          authenticatedPubkey,
          dTag: coordinate.split(":").slice(2).join(":"),
          calendarCoordinate,
          state: marketState,
          merchants: [
            ...allRows.filter((entry) => entry.pubkey !== merchant),
            { pubkey: merchant, mode, assignment: assignment.trim() },
          ],
          expectedPreviousEventId: marketEventId,
          shouldContinue,
          onSignedLocal: (event) =>
            retainSignedEventMarketEvidence(coordinate, event),
        })
      } else {
        await publishEventMarketMerchantDecision({
          organizerPubkey,
          authenticatedPubkey,
          dTag: coordinate.split(":").slice(2).join(":"),
          calendarCoordinate,
          merchantPubkey: merchant,
          action,
          ...(action === "approve"
            ? { row: { pubkey: merchant, mode, assignment: assignment.trim() } }
            : {}),
          expectedPreviousEventId: marketEventId,
          expectedAuthorizationTipIds: expectedTipIds,
          shouldContinue,
          onSignedLocal: async (decision) => {
            retainSignedEventMarketEvidence(coordinate, decision.roster)
            retainSignedEventMarketEvidence(coordinate, decision.authorization)
          },
        })
      }
      setConfirmReapproval(false)
      await auth.refetch()
      onChanged()
    } catch (cause) {
      setError(errorText(cause))
      await auth.refetch()
      onChanged()
    } finally {
      setPending(false)
    }
  }

  async function retryAuthorization(): Promise<void> {
    if (
      !authenticatedPubkey ||
      pending ||
      !resolution ||
      (resolution.state !== "active" && resolution.state !== "revoked")
    )
      return
    setPending(true)
    setError("")
    try {
      await retryEventMarketAuthorizationDelivery({
        signedEvent: resolution.tip.signedEvent,
        authenticatedPubkey,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      await auth.refetch()
      onChanged()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-all text-base">
          {merchant.slice(0, 16)}…
        </CardTitle>
        <CardDescription>
          {isApproved
            ? "Approved"
            : authState === "revoked"
              ? "Revoked"
              : authState === "conflicting"
                ? "Conflicting signed authorization"
                : authState === "missing"
                  ? "Invitation ready"
                  : authState === "active"
                    ? "Grant signed; roster update needed"
                    : "Authorization needs review"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`mode-${merchant}`}>Handoff mode</Label>
            <Select
              value={mode}
              onValueChange={(value) =>
                setMode(value as EventMarketMerchantMode)
              }
            >
              <SelectTrigger id={`mode-${merchant}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="merchant_present">Merchant booth</SelectItem>
                <SelectItem value="organizer_handoff">
                  Organizer pickup
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`assignment-${merchant}`}>Public assignment</Label>
            <Input
              id={`assignment-${merchant}`}
              value={assignment}
              onChange={(event) => setAssignment(event.target.value)}
              placeholder="Booth 12 or pickup desk"
            />
          </div>
        </div>
        {confirmReapproval ? (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-[var(--warning)]/40 p-3 text-sm"
          >
            <p>
              Reapproving this merchant makes all still-tagged products reappear
              if their current signed listings are eligible.
            </p>
            {reapprovalPreview.isPending ? (
              <p>Checking current signed listings…</p>
            ) : null}
            {reapprovalPreview.data ? (
              <>
                <p>
                  {reapprovalPreview.data.products.length} currently eligible{" "}
                  {reapprovalPreview.data.products.length === 1
                    ? "listing"
                    : "listings"}{" "}
                  found.
                </p>
                <ul className="list-disc pl-5">
                  {reapprovalPreview.data.products.map((product) => (
                    <li key={product.coordinate}>{product.title}</li>
                  ))}
                </ul>
                {reapprovalPreview.data.coverage !== "complete" ? (
                  <p>
                    Relay evidence is incomplete; more tagged products may
                    reappear after approval.
                  </p>
                ) : null}
              </>
            ) : null}
            {reapprovalPreview.isError ? (
              <p>
                Current listings could not be checked. Refresh before
                confirming.
              </p>
            ) : null}
          </div>
        ) : null}
        {authState === "conflicting" ||
        authState === "missing_parent" ||
        authState === "deleted" ? (
          <p role="alert" className="text-sm text-[var(--warning)]">
            Signed authorization is stale or divergent. Refresh and reconcile
            its transitions before changing admission.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!authenticatedPubkey || pending}
            onClick={() => void invite()}
          >
            {invitationSent ? "Resend invitation" : "Send private invitation"}
          </Button>
          {row ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canChange}
              onClick={() => void save("edit")}
            >
              Save assignment
            </Button>
          ) : null}
          {!isApproved ? (
            <Button
              type="button"
              disabled={
                !canChange ||
                (confirmReapproval &&
                  (reapprovalPreview.isPending || reapprovalPreview.isError))
              }
              onClick={() => void save("approve")}
            >
              {confirmReapproval ? "Confirm reapproval" : "Approve merchant"}
            </Button>
          ) : null}
          {row ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canChange}
              onClick={() => void save("revoke")}
            >
              Revoke
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={auth.isFetching}
            onClick={() => void auth.refetch()}
          >
            Refresh authorization
          </Button>
          {(auth.data?.coverage === "stale" ||
            auth.data?.coverage === "partial") &&
          (authState === "active" || authState === "revoked") ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending || !authenticatedPubkey}
              onClick={() => void retryAuthorization()}
            >
              Retry signed authorization
            </Button>
          ) : null}
        </div>
        {invitationSent ? (
          <p role="status" className="text-sm">
            Private invitation submitted. Admission still requires signed
            organizer approval.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function FutureEventMarketManager({ reference }: { reference: string }) {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const session = useConduitSession()
  const queryClient = useQueryClient()
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  const coordinate = decodeEventMarketReference(reference, [30409])?.coordinate
  const [merchantInput, setMerchantInput] = useState("")
  const [invited, setInvited] = useState<string[]>([])
  const [printOpen, setPrintOpen] = useState(false)
  const [retryingDecision, setRetryingDecision] = useState<string | null>(null)
  const [decisionError, setDecisionError] = useState("")
  const query = useQuery({
    queryKey: [
      "future-market-manager",
      reference,
      session.relayScope,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readEventMarketRoster({ reference, authenticatedPubkey, signal }),
    enabled: session.relaySettingsReady,
    retry: false,
  })
  const result = query.data
  const pendingDecisions = useQuery({
    queryKey: ["future-market-pending-decisions", coordinate],
    queryFn: () => listPendingEventMarketMerchantDecisions(coordinate ?? ""),
    enabled: !!coordinate && !!authenticatedPubkey,
  })
  const market =
    result?.resolution.state === "current" ? result.resolution.market : null
  const calendar = result?.calendar
  const merchantIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...(market?.merchants.map((row) => row.pubkey) ?? []),
          ...invited,
        ])
      ),
    [market?.merchants, invited]
  )
  const sheets =
    market && calendar
      ? buildFutureEventQrSignSheets({
          market,
          calendar,
          relayHints: result?.observedRelayUrls,
        })
      : []
  const naddr = market
    ? encodeEventMarketNaddr(market.coordinate, result?.observedRelayUrls ?? [])
    : null
  const canManage =
    !!market &&
    market.organizerPubkey === authenticatedPubkey &&
    result?.retained &&
    result.coverage === "complete" &&
    result.calendarCoverage === "complete"

  async function retryRoster(): Promise<void> {
    if (!market || !authenticatedPubkey) return
    try {
      await retryEventMarketRosterDelivery({
        signedEvent: market.signedEvent,
        authenticatedPubkey,
      })
      await query.refetch()
    } catch {
      await query.refetch()
    }
  }

  async function retryDecision(decisionId: string): Promise<void> {
    if (!authenticatedPubkey || retryingDecision) return
    setRetryingDecision(decisionId)
    setDecisionError("")
    try {
      await retryEventMarketMerchantDecisionDelivery({
        decisionId,
        authenticatedPubkey,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      await Promise.all([pendingDecisions.refetch(), query.refetch()])
    } catch (cause) {
      setDecisionError(errorText(cause))
      await pendingDecisions.refetch()
    } finally {
      setRetryingDecision(null)
    }
  }

  function addInvitation(): void {
    const normalized = normalizePubkey(merchantInput)
    if (!normalized || merchantIds.includes(normalized)) return
    setInvited((current) => [...current, normalized])
    setMerchantInput("")
  }

  return (
    <div className="space-y-6">
      {query.isPending ? (
        <p role="status">Checking signed Event Market records…</p>
      ) : null}
      {query.isError ? (
        <p role="alert">Event Market records could not be checked.</p>
      ) : null}
      {result && result.resolution.state !== "current" ? (
        <p role="alert">
          The signed Event Market is{" "}
          {result.resolution.state.replaceAll("_", " ")}. Refresh before
          managing it.
        </p>
      ) : null}
      {pendingDecisions.data?.map((decision) => (
        <div
          key={decision.id}
          className="space-y-2 rounded-lg border border-[var(--border)] p-4"
        >
          <p className="text-sm">
            The signed {decision.action} for merchant{" "}
            {decision.merchantPubkey.slice(0, 16)}… was saved. Retry its exact
            roster and authorization delivery before starting another decision.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!!retryingDecision}
            onClick={() => void retryDecision(decision.id)}
          >
            Retry saved decision
          </Button>
        </div>
      ))}
      {decisionError ? (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {decisionError}
        </p>
      ) : null}
      {market && calendar ? (
        <>
          <header className="space-y-2">
            <h1 className="text-3xl font-semibold">{calendar.title}</h1>
            <p className="text-sm text-[var(--text-muted)]">
              {market.state === "open" ? "Open" : "Closed"} ·{" "}
              {calendar.locations.join(", ") || "Location not published"}
            </p>
          </header>
          <div className="flex flex-wrap gap-3">
            {sheets[0] ? (
              <div
                role="img"
                aria-label="Event catalog QR code"
                className="w-fit bg-white p-2"
              >
                <QRCodeSVG value={sheets[0].qrValue} size={160} level="M" />
              </div>
            ) : null}
            <div className="space-y-2">
              <p className="break-all text-xs text-[var(--text-muted)]">
                {naddr}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPrintOpen(true)}
              >
                Print event and booth signs
              </Button>
            </div>
          </div>
          {!canManage ? (
            <p
              role="status"
              className="rounded-lg border border-amber-500/50 p-4"
            >
              Current signed organizer authority is incomplete or unavailable.
              Refresh before editing.
            </p>
          ) : null}
          {market &&
          !canManage &&
          authenticatedPubkey === market.organizerPubkey ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void retryRoster()}
            >
              Retry signed market delivery
            </Button>
          ) : null}
          {canManage && authenticatedPubkey ? (
            <MarketLifecycleEditor
              key={`${calendar.eventId}:${market.eventId}`}
              market={market}
              calendar={calendar}
              authenticatedPubkey={authenticatedPubkey}
              onChanged={() => void query.refetch()}
            />
          ) : null}
          {canManage ? (
            <section className="space-y-4">
              <h2 className="text-xl font-semibold">Merchants</h2>
              <p className="text-sm text-[var(--text-muted)]">
                Add a merchant by pubkey to send a signed private invitation,
                then approve one handoff mode and public assignment. Admission
                starts only after the signed grant and roster update. Merchants
                control their own product listings and prices.
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Merchant pubkey"
                  value={merchantInput}
                  onChange={(event) => setMerchantInput(event.target.value)}
                  placeholder="Merchant npub or pubkey"
                />
                <Button type="button" onClick={addInvitation}>
                  Prepare merchant
                </Button>
              </div>
              <div className="grid gap-4">
                {merchantIds.map((merchant) => (
                  <MerchantAuthorityRow
                    key={`${merchant}:${market.merchants.find((row) => row.pubkey === merchant)?.mode ?? "new"}:${market.merchants.find((row) => row.pubkey === merchant)?.assignment ?? ""}`}
                    coordinate={market.coordinate}
                    merchant={merchant}
                    row={market.merchants.find(
                      (row) => row.pubkey === merchant
                    )}
                    calendarCoordinate={market.calendarCoordinate}
                    marketEventId={market.eventId}
                    marketState={market.state}
                    allRows={market.merchants}
                    decisionPending={
                      pendingDecisions.isPending ||
                      (pendingDecisions.data?.length ?? 0) > 0
                    }
                    authenticatedPubkey={authenticatedPubkey}
                    onChanged={() => {
                      void query.refetch()
                      void pendingDecisions.refetch()
                      void queryClient.invalidateQueries({
                        queryKey: ["future-market"],
                      })
                    }}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <EventQrPrintPreview
            open={printOpen}
            onOpenChange={setPrintOpen}
            title={`Signs for ${calendar.title}`}
            sheets={sheets}
            mode="merchant-batch"
            eventState={canManage ? "active" : "stale"}
            refreshing={query.isFetching}
            onRefresh={async () => {
              await query.refetch()
            }}
          />
        </>
      ) : null}
      {coordinate && accountPubkey === coordinate.split(":")[1] ? (
        <FutureOrganizerClaimQueue
          organizerPubkey={accountPubkey}
          marketCoordinate={coordinate}
        />
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh event records
      </Button>
    </div>
  )
}
