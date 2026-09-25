import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  buildDirectMessageRumor,
  buildEventMarketCalendarDraft,
  buildEventMarketSeriesDraft,
  decodeEventMarketReference,
  EVENT_KINDS,
  getNdk,
  encodeEventMarketNaddr,
  listPendingEventMarketMerchantDecisions,
  loadRetainedSignedEventMarketEvidence,
  normalizePubkey,
  publishEventMarketMerchantDecision,
  publishEventMarketRoster,
  publishPrivateMessage,
  previewEventMarketMerchantProducts,
  publishFutureEventMarketCalendar,
  publishFutureEventMarketOccurrenceRevision,
  publishFutureEventMarketSeries,
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
  type EventMarketCalendarDraftInput,
  type EventMarketSchedule,
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
  getOrganizerEventStartMinimum,
  localDateTimeToEpochSeconds,
} from "../lib/event-market-form"
import { getMerchantEventParticipationUrl } from "../lib/market-links"

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The signed change could not be completed."
}

function formatOrganizerOccurrenceDate(
  calendar: ParsedEventMarketCalendar,
  timestamp = calendar.start
): string {
  if (calendar.kind === 31922)
    return timestamp === calendar.start
      ? (calendar.startDate ?? new Date(timestamp).toISOString().slice(0, 10))
      : (calendar.endDate ?? new Date(timestamp).toISOString().slice(0, 10))
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: calendar.startTzid ?? "UTC",
    timeZoneName: "short",
  }).format(timestamp)
}

type FrozenSeriesMutation =
  | {
      version: 1
      action: "edit"
      marketCoordinate: string
      occurrenceCoordinate: string
      expectedPreviousEventId: string
      expectedPreviousCreatedAt: number
      calendar: EventMarketCalendarDraftInput
    }
  | {
      version: 1
      action: "add" | "remove"
      marketCoordinate: string
      expectedPreviousEventId: string
      expectedPreviousCreatedAt: number
      scheduleDTag: string
      title: string
      retainedMemberCoordinates: string[]
      removedMemberCoordinates: string[]
      newOccurrences: EventMarketCalendarDraftInput[]
    }

function mutationStorageKey(marketCoordinate: string): string {
  return `conduit:future-event-market-series-edit:1:${marketCoordinate}`
}

function readSeriesMutation(
  marketCoordinate: string
): FrozenSeriesMutation | null {
  if (typeof localStorage === "undefined") return null
  const raw = localStorage.getItem(mutationStorageKey(marketCoordinate))
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error("Saved date edit could not be read.", { cause })
  }
  const value = parsed as Record<string, unknown>
  if (
    !value ||
    value.version !== 1 ||
    value.marketCoordinate !== marketCoordinate ||
    (value.action !== "edit" &&
      value.action !== "add" &&
      value.action !== "remove") ||
    typeof value.expectedPreviousEventId !== "string" ||
    typeof value.expectedPreviousCreatedAt !== "number" ||
    !Number.isFinite(value.expectedPreviousCreatedAt) ||
    (value.action === "edit" &&
      (typeof value.occurrenceCoordinate !== "string" || !value.calendar)) ||
    (value.action !== "edit" &&
      (typeof value.scheduleDTag !== "string" ||
        typeof value.title !== "string" ||
        !Array.isArray(value.retainedMemberCoordinates) ||
        !Array.isArray(value.removedMemberCoordinates) ||
        !Array.isArray(value.newOccurrences)))
  ) {
    throw new Error("Saved date edit needs organizer review before resuming.")
  }
  return value as FrozenSeriesMutation
}

function saveSeriesMutation(mutation: FrozenSeriesMutation): void {
  if (typeof localStorage === "undefined") {
    throw new Error("Local storage is required to resume date publishing.")
  }
  const key = mutationStorageKey(mutation.marketCoordinate)
  const serialized = JSON.stringify(mutation)
  try {
    if (localStorage.getItem(key)) {
      throw new Error("A saved date change is already awaiting publication.")
    }
    localStorage.setItem(key, serialized)
    if (localStorage.getItem(key) !== serialized) {
      throw new Error("The date change was not saved.")
    }
  } catch (cause) {
    throw new Error("Save the date change locally before signing.", { cause })
  }
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

function SeriesDateManager({
  market,
  schedule,
  scheduleCoverage,
  selectedOccurrence,
  onSelectOccurrence,
  authenticatedPubkey,
  onChanged,
}: {
  market: ParsedEventMarketRoster
  schedule: Extract<EventMarketSchedule, { kind: "series" }>
  scheduleCoverage?: "complete" | "partial" | "stale" | "unavailable"
  selectedOccurrence?: string
  onSelectOccurrence?: (coordinate: string) => void
  authenticatedPubkey: string
  onChanged: () => void
}) {
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const [localSelection, setLocalSelection] = useState<string | undefined>()
  const fallback =
    schedule.occurrences.find((entry) => entry.occurrence.end > Date.now()) ??
    schedule.occurrences.at(-1)
  const chosenCoordinate =
    selectedOccurrence ?? localSelection ?? fallback?.occurrence.coordinate
  const chosen = schedule.occurrences.find(
    (entry) => entry.occurrence.coordinate === chosenCoordinate
  )
  const seed = chosen?.occurrence ?? fallback?.occurrence
  const timezone = seed?.startTzid || "UTC"
  const [title, setTitle] = useState(seed?.title ?? schedule.series.title)
  const [location, setLocation] = useState(seed?.locations[0] ?? "")
  const [start, setStart] = useState(
    seed?.kind === 31922
      ? (seed.startDate ?? "")
      : seed
        ? epochSecondsToLocalDateTime(seed.start / 1_000, timezone)
        : ""
  )
  const [end, setEnd] = useState(
    seed?.kind === 31922
      ? (seed.endDate ?? "")
      : seed
        ? epochSecondsToLocalDateTime(seed.end / 1_000, timezone)
        : ""
  )
  const [newKind, setNewKind] = useState<31922 | 31923>(
    seed?.kind === 31922 ? 31922 : 31923
  )
  const [newTitle, setNewTitle] = useState(seed?.title ?? schedule.series.title)
  const [newLocation, setNewLocation] = useState(seed?.locations[0] ?? "")
  const [newStart, setNewStart] = useState("")
  const [newEnd, setNewEnd] = useState("")
  const [newTimezone, setNewTimezone] = useState(timezone)
  const [pendingMutation, setPendingMutation] =
    useState<FrozenSeriesMutation | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [step, setStep] = useState("")
  const [deliveryOutcomes, setDeliveryOutcomes] = useState<
    Record<string, string>
  >({})

  useEffect(() => {
    try {
      setPendingMutation(readSeriesMutation(market.coordinate))
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [market.coordinate])

  function choose(coordinate: string): void {
    setLocalSelection(coordinate)
    onSelectOccurrence?.(coordinate)
  }

  function calendarDraft(input: {
    source: ParsedEventMarketCalendar
    dTag: string
    kind: 31922 | 31923
    title: string
    location: string
    start: string
    end: string
    timezone: string
  }): EventMarketCalendarDraftInput {
    const common = {
      dTag: input.dTag,
      title: input.title.trim(),
      content: input.source.signedEvent?.content ?? "",
      summary: input.source.summary,
      image: input.source.image,
      locations: [input.location.trim(), ...input.source.locations.slice(1)],
      geohash: input.source.geohash,
    }
    return input.kind === 31922
      ? { ...common, kind: 31922, start: input.start, end: input.end }
      : {
          ...common,
          kind: 31923,
          start: localDateTimeToEpochSeconds(input.start, input.timezone),
          end: localDateTimeToEpochSeconds(input.end, input.timezone),
          startTzid: input.timezone,
          endTzid: input.timezone,
        }
  }

  async function runMutation(mutation: FrozenSeriesMutation): Promise<void> {
    setPending(true)
    setError("")
    try {
      const signed = await loadRetainedSignedEventMarketEvidence(
        market.coordinate
      )
      const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
      if (mutation.action === "edit") {
        const expected = buildEventMarketCalendarDraft(mutation.calendar)
        const saved = signed.filter(
          (event) =>
            event.id !== mutation.expectedPreviousEventId &&
            event.created_at >
              Math.floor(mutation.expectedPreviousCreatedAt / 1_000) &&
            `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
              mutation.occurrenceCoordinate &&
            JSON.stringify(event.tags) === JSON.stringify(expected.tags) &&
            event.content === expected.content
        )
        if (saved.length > 1) {
          throw new Error("Multiple saved revisions need organizer review.")
        }
        const current = schedule.occurrences.find(
          (entry) =>
            entry.occurrence.coordinate === mutation.occurrenceCoordinate
        )
        if (saved[0] && current?.occurrence.eventId === saved[0].id) {
          setStep("Signed date is already current.")
        } else {
          setStep(saved[0] ? "Retrying saved date…" : "Signing date revision…")
          await publishFutureEventMarketOccurrenceRevision({
            marketCoordinate: market.coordinate,
            organizerPubkey: market.organizerPubkey,
            authenticatedPubkey,
            expectedPreviousEventId: mutation.expectedPreviousEventId,
            calendar: mutation.calendar,
            savedSignedEvent: saved[0],
            shouldContinue,
            onSignedLocal: (event) =>
              retainSignedEventMarketEvidence(market.coordinate, event),
            onDelivery: (delivery) =>
              setDeliveryOutcomes((current) => ({
                ...current,
                "Selected date": `${delivery.acknowledged} ACK · ${delivery.rejected} rejected · ${delivery.timedOut} timed out${delivery.otherFailed ? ` · ${delivery.otherFailed} other failure` : ""}`,
              })),
          })
        }
      } else {
        const expectedSchedule = buildEventMarketSeriesDraft({
          dTag: mutation.scheduleDTag,
          organizerPubkey: market.organizerPubkey,
          title: mutation.title,
          memberCoordinates: [
            ...mutation.retainedMemberCoordinates,
            ...mutation.newOccurrences.map(
              (calendar) =>
                `${calendar.kind}:${market.organizerPubkey}:${calendar.dTag}`
            ),
          ],
        })
        const expectedOccurrences = mutation.newOccurrences.map((calendar) => ({
          coordinate: `${calendar.kind}:${market.organizerPubkey}:${calendar.dTag}`,
          draft: buildEventMarketCalendarDraft(calendar),
        }))
        const matchingSigned = signed.filter((event) => {
          if (
            event.created_at <=
            Math.floor(mutation.expectedPreviousCreatedAt / 1_000)
          )
            return false
          const coordinate = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
          const expected =
            coordinate === schedule.coordinate
              ? expectedSchedule
              : expectedOccurrences.find(
                  (item) => item.coordinate === coordinate
                )?.draft
          return (
            !!expected &&
            JSON.stringify(event.tags) === JSON.stringify(expected.tags) &&
            event.content === expected.content
          )
        })
        const savedSchedule = matchingSigned.find(
          (event) =>
            event.kind === 31924 &&
            event.id !== mutation.expectedPreviousEventId
        )
        if (savedSchedule && schedule.series.eventId === savedSchedule.id) {
          setStep("Signed schedule is already current.")
        } else {
          await publishFutureEventMarketSeries({
            organizerPubkey: market.organizerPubkey,
            authenticatedPubkey,
            marketCoordinate: market.coordinate,
            expectedPreviousEventId: mutation.expectedPreviousEventId,
            scheduleDTag: mutation.scheduleDTag,
            title: mutation.title,
            retainedMemberCoordinates: mutation.retainedMemberCoordinates,
            removedMemberCoordinates: mutation.removedMemberCoordinates,
            newOccurrences: mutation.newOccurrences,
            savedSignedEvents: matchingSigned,
            shouldContinue,
            onSignedLocal: (event) =>
              retainSignedEventMarketEvidence(market.coordinate, event),
            onProgress: (progress) => {
              const record =
                progress.record === "schedule"
                  ? "Schedule"
                  : `Date ${progress.index} of ${progress.total}`
              setStep(`${record}: ${progress.phase}`)
            },
            onDelivery: ({ record, index, delivery }) => {
              const label = record === "schedule" ? "Schedule" : `Date ${index}`
              setDeliveryOutcomes((current) => ({
                ...current,
                [label]: `${delivery.acknowledged} ACK · ${delivery.rejected} rejected · ${delivery.timedOut} timed out${delivery.otherFailed ? ` · ${delivery.otherFailed} other failure` : ""}`,
              }))
            },
          })
        }
      }
      localStorage.removeItem(mutationStorageKey(market.coordinate))
      setPendingMutation(null)
      onChanged()
    } catch (cause) {
      setError(errorText(cause))
      onChanged()
    } finally {
      setPending(false)
    }
  }

  function startMutation(mutation: FrozenSeriesMutation): void {
    try {
      setDeliveryOutcomes({})
      saveSeriesMutation(mutation)
      setPendingMutation(mutation)
      void runMutation(mutation)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  function editDate(): void {
    if (
      !chosen ||
      chosen.coverage !== "complete" ||
      chosen.occurrence.end <= Date.now()
    )
      return
    try {
      const calendar = calendarDraft({
        source: chosen.occurrence,
        dTag: chosen.occurrence.dTag,
        kind: chosen.occurrence.kind,
        title,
        location,
        start,
        end,
        timezone,
      })
      buildEventMarketCalendarDraft(calendar)
      startMutation({
        version: 1,
        action: "edit",
        marketCoordinate: market.coordinate,
        occurrenceCoordinate: chosen.occurrence.coordinate,
        expectedPreviousEventId: chosen.occurrence.eventId,
        expectedPreviousCreatedAt: chosen.occurrence.createdAt,
        calendar,
      })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  function addDate(): void {
    if (!seed) return
    try {
      const calendar = calendarDraft({
        source: seed,
        dTag: `${market.coordinate.split(":").slice(2).join(":")}-date-${crypto.randomUUID().slice(0, 8)}`,
        kind: newKind,
        title: newTitle,
        location: newLocation,
        start: newStart,
        end: newEnd,
        timezone: newTimezone,
      })
      buildEventMarketCalendarDraft(calendar)
      if (
        calendar.kind === 31922
          ? calendar.start < getOrganizerEventStartMinimum("date")
          : calendar.start * 1_000 <= Date.now()
      ) {
        throw new Error("New date must start in the future.")
      }
      startMutation({
        version: 1,
        action: "add",
        marketCoordinate: market.coordinate,
        expectedPreviousEventId: schedule.series.eventId,
        expectedPreviousCreatedAt: schedule.series.createdAt,
        scheduleDTag: schedule.coordinate.split(":").slice(2).join(":"),
        title: schedule.series.title,
        retainedMemberCoordinates: schedule.series.memberCoordinates,
        removedMemberCoordinates: [],
        newOccurrences: [calendar],
      })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  function removeDate(): void {
    if (!chosen || chosen.occurrence.end <= Date.now()) return
    startMutation({
      version: 1,
      action: "remove",
      marketCoordinate: market.coordinate,
      expectedPreviousEventId: schedule.series.eventId,
      expectedPreviousCreatedAt: schedule.series.createdAt,
      scheduleDTag: schedule.coordinate.split(":").slice(2).join(":"),
      title: schedule.series.title,
      retainedMemberCoordinates: schedule.series.memberCoordinates.filter(
        (coordinate) => coordinate !== chosen.occurrence.coordinate
      ),
      removedMemberCoordinates: [chosen.occurrence.coordinate],
      newOccurrences: [],
    })
  }

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

  const selectedFuture = !!chosen && chosen.occurrence.end > Date.now()
  const editReady = selectedFuture && chosen?.coverage === "complete"
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event dates</CardTitle>
        <CardDescription>
          {schedule.series.memberCoordinates.length} dates belong to this signed
          schedule. Adding or removing a date keeps the other members and
          approved merchants in place. Existing orders keep their signed terms.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          type="button"
          variant="outline"
          disabled={pending || !!pendingMutation}
          onClick={() => void changeOpenState()}
        >
          {market.state === "open"
            ? "Close Event Market"
            : "Reopen Event Market"}
        </Button>
        {scheduleCoverage !== "complete" ||
        schedule.unresolvedCoordinates.length > 0 ? (
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            {schedule.occurrences.length} of{" "}
            {schedule.series.memberCoordinates.length} dates are verified in
            this read. Missing or partial date evidence does not remove a signed
            schedule member. Refresh before editing an unavailable date.
          </p>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="future-series-date-choice">Choose date</Label>
          <Select value={chosenCoordinate} onValueChange={choose}>
            <SelectTrigger id="future-series-date-choice">
              <SelectValue placeholder="Choose a date" />
            </SelectTrigger>
            <SelectContent>
              {schedule.series.memberCoordinates.map((coordinate) => {
                const entry = schedule.occurrences.find(
                  (item) => item.occurrence.coordinate === coordinate
                )
                return (
                  <SelectItem key={coordinate} value={coordinate}>
                    {entry
                      ? formatOrganizerOccurrenceDate(entry.occurrence)
                      : "Date details unavailable"}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </div>
        {chosen ? (
          <p className="text-sm text-[var(--text-secondary)]">
            {formatOrganizerOccurrenceDate(chosen.occurrence)} –{" "}
            {formatOrganizerOccurrenceDate(
              chosen.occurrence,
              chosen.occurrence.end
            )}{" "}
            · {chosen.coverage} evidence
          </p>
        ) : chosenCoordinate ? (
          <p role="status">
            The selected date is not verified in the current signed schedule.
          </p>
        ) : null}
        {pendingMutation ? (
          <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
            <p role="status">
              A signed {pendingMutation.action} change is saved for exact retry.
              Review the current schedule before starting another change.
            </p>
            <Button
              type="button"
              disabled={pending}
              onClick={() => void runMutation(pendingMutation)}
            >
              Resume publishing
            </Button>
          </div>
        ) : null}
        {editReady && chosen ? (
          <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
            <h3 className="font-medium">Edit selected date</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="series-edit-title">Title</Label>
                <Input
                  id="series-edit-title"
                  value={title}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-edit-location">Location</Label>
                <Input
                  id="series-edit-location"
                  value={location}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setLocation(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-edit-start">
                  Start{" "}
                  {chosen.occurrence.kind === 31923 ? `(${timezone})` : ""}
                </Label>
                <Input
                  id="series-edit-start"
                  type={
                    chosen.occurrence.kind === 31922 ? "date" : "datetime-local"
                  }
                  value={start}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setStart(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-edit-end">
                  End {chosen.occurrence.kind === 31923 ? `(${timezone})` : ""}
                </Label>
                <Input
                  id="series-edit-end"
                  type={
                    chosen.occurrence.kind === 31922 ? "date" : "datetime-local"
                  }
                  value={end}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={
                  pending ||
                  !!pendingMutation ||
                  !title.trim() ||
                  !location.trim()
                }
                onClick={editDate}
              >
                Save selected date
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  !!pendingMutation ||
                  schedule.series.memberCoordinates.length <= 1
                }
                onClick={removeDate}
              >
                Remove future date
              </Button>
            </div>
          </div>
        ) : null}
        {chosen && !editReady ? (
          <p className="text-sm text-[var(--text-secondary)]">
            Past or partially verified dates remain visible but cannot be edited
            or removed.
          </p>
        ) : null}
        {seed ? (
          <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
            <h3 className="font-medium">Add date</h3>
            <div className="space-y-1">
              <Label htmlFor="series-new-kind">Date type</Label>
              <Select
                value={String(newKind)}
                onValueChange={(value) =>
                  setNewKind(Number(value) as 31922 | 31923)
                }
              >
                <SelectTrigger id="series-new-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="31923">Timed event</SelectItem>
                  <SelectItem value="31922">All-day event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="series-new-title">Title</Label>
                <Input
                  id="series-new-title"
                  value={newTitle}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setNewTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-new-location">Location</Label>
                <Input
                  id="series-new-location"
                  value={newLocation}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setNewLocation(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-new-start">Start</Label>
                <Input
                  id="series-new-start"
                  type={newKind === 31922 ? "date" : "datetime-local"}
                  value={newStart}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setNewStart(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="series-new-end">End</Label>
                <Input
                  id="series-new-end"
                  type={newKind === 31922 ? "date" : "datetime-local"}
                  value={newEnd}
                  disabled={pending || !!pendingMutation}
                  onChange={(event) => setNewEnd(event.target.value)}
                />
              </div>
              {newKind === 31923 ? (
                <div className="space-y-1">
                  <Label htmlFor="series-new-timezone">Time zone</Label>
                  <Input
                    id="series-new-timezone"
                    value={newTimezone}
                    disabled={pending || !!pendingMutation}
                    onChange={(event) => setNewTimezone(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
            <Button
              type="button"
              disabled={
                pending ||
                !!pendingMutation ||
                !newTitle.trim() ||
                !newLocation.trim() ||
                !newStart ||
                !newEnd
              }
              onClick={addDate}
            >
              Add signed date
            </Button>
          </div>
        ) : null}
        {step ? <p role="status">{step}</p> : null}
        {Object.keys(deliveryOutcomes).length > 0 ? (
          <ul
            aria-label="Date publication outcomes"
            className="space-y-1 text-sm text-[var(--text-secondary)]"
          >
            {Object.entries(deliveryOutcomes).map(([record, outcome]) => (
              <li key={record}>
                {record}: {outcome}
              </li>
            ))}
          </ul>
        ) : null}
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

export function FutureEventMarketManager({
  reference,
  selectedOccurrence,
  onSelectOccurrence,
}: {
  reference: string
  selectedOccurrence?: string
  onSelectOccurrence?: (coordinate: string) => void
}) {
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
  const series = result?.schedule?.kind === "series" ? result.schedule : null
  const selectedCalendar = series
    ? (series.occurrences.find(
        (entry) => entry.occurrence.coordinate === selectedOccurrence
      )?.occurrence ?? (selectedOccurrence ? null : calendar))
    : calendar
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
      {market && (calendar || series) ? (
        <>
          <header className="space-y-2">
            <h1 className="text-3xl font-semibold">
              {series?.series.title ?? calendar?.title}
            </h1>
            <p className="text-sm text-[var(--text-muted)]">
              {market.state === "open" ? "Open" : "Closed"} ·{" "}
              {selectedCalendar?.locations.join(", ") ||
                "Selected date details unavailable"}
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
          {canManage && authenticatedPubkey && !series && calendar ? (
            <MarketLifecycleEditor
              key={`${calendar.eventId}:${market.eventId}`}
              market={market}
              calendar={calendar}
              authenticatedPubkey={authenticatedPubkey}
              onChanged={() => void query.refetch()}
            />
          ) : null}
          {canManage && authenticatedPubkey && series ? (
            <SeriesDateManager
              key={`${series.series.eventId}:${selectedOccurrence ?? "default"}`}
              market={market}
              schedule={series}
              scheduleCoverage={result?.scheduleCoverage}
              selectedOccurrence={selectedOccurrence}
              onSelectOccurrence={onSelectOccurrence}
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
            title={`Signs for ${series?.series.title ?? calendar?.title ?? "Event Market"}`}
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
