import { useEffect, useState } from "react"
import {
  encodeEventMarketNaddr,
  isValidSignedPublicNostrEvent,
  loadRetainedSignedEventMarketEvidence,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  publishFutureEventMarketCalendar,
  publishFutureEventMarketSeries,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  summarizeEventMarketPublishDelivery,
  type EventMarketCalendarDraftInput,
  type SignedPublicNostrEvent,
  useAuth,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@conduit/ui"
import {
  createEmptyOrganizerEventMarketForm,
  generateOrganizerWeeklyDates,
  MAX_ORGANIZER_EVENT_DATES,
  prepareOrganizerEventMarketDates,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  type OrganizerEventDateRow,
  type OrganizerEventMarketFormValues,
  type OrganizerWeeklyDatePattern,
} from "../lib/event-market-form"

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const

const EMPTY_WEEKLY_PATTERN: OrganizerWeeklyDatePattern = {
  firstDate: "",
  throughDate: "",
  weekdays: [],
  startTime: "09:00",
  endTime: "17:00",
  timezone: "",
}

interface FrozenSeriesDraft {
  version: 1
  organizerPubkey: string
  marketDTag: string
  scheduleDTag: string
  occurrenceDTags: string[]
  form: OrganizerEventMarketFormValues
  dateRows: OrganizerEventDateRow[]
}

function seriesDraftKey(organizerPubkey: string): string {
  return `conduit:future-event-market-series-draft:1:${organizerPubkey}`
}

function readFrozenSeriesDraft(
  organizerPubkey: string
): FrozenSeriesDraft | null {
  if (typeof localStorage === "undefined") {
    throw new Error("Local storage is required to resume series publishing.")
  }
  const raw = localStorage.getItem(seriesDraftKey(organizerPubkey))
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error("The saved series draft could not be read.", { cause })
  }
  const draft = value as Partial<FrozenSeriesDraft>
  const validDTag = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9-]+$/.test(value)
  if (
    !draft ||
    draft.version !== 1 ||
    draft.organizerPubkey !== organizerPubkey ||
    !validDTag(draft.marketDTag) ||
    !validDTag(draft.scheduleDTag) ||
    !Array.isArray(draft.occurrenceDTags) ||
    !Array.isArray(draft.dateRows) ||
    draft.dateRows.length === 0 ||
    draft.dateRows.length > MAX_ORGANIZER_EVENT_DATES ||
    draft.occurrenceDTags.length !== draft.dateRows.length ||
    draft.occurrenceDTags.some((dTag) => !validDTag(dTag)) ||
    new Set(draft.occurrenceDTags).size !== draft.occurrenceDTags.length ||
    draft.dateRows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.start !== "string" ||
        typeof row.end !== "string"
    ) ||
    !draft.form ||
    (draft.form.calendarType !== "timed" &&
      draft.form.calendarType !== "date") ||
    typeof draft.form.title !== "string" ||
    typeof draft.form.timezone !== "string"
  ) {
    throw new Error("The saved series draft needs review before publishing.")
  }
  return draft as FrozenSeriesDraft
}

function saveFrozenSeriesDraft(draft: FrozenSeriesDraft): void {
  if (typeof localStorage === "undefined") {
    throw new Error("Local storage is required to resume series publishing.")
  }
  const key = seriesDraftKey(draft.organizerPubkey)
  const serialized = JSON.stringify(draft)
  try {
    if (localStorage.getItem(key)) {
      throw new Error("A saved series draft is already awaiting publication.")
    }
    localStorage.setItem(key, serialized)
    if (localStorage.getItem(key) !== serialized) {
      throw new Error("The series draft was not saved.")
    }
  } catch (cause) {
    throw new Error("Save the series draft locally before signing.", { cause })
  }
}

function clearFrozenSeriesDraft(organizerPubkey: string): void {
  localStorage.removeItem(seriesDraftKey(organizerPubkey))
}

function preparedCalendarDraft(
  calendar: ReturnType<typeof prepareOrganizerEventMarketForm>["calendar"],
  dTag: string
): EventMarketCalendarDraftInput {
  const common = {
    dTag,
    title: calendar.title,
    summary: calendar.summary,
    image: calendar.imageUrl,
    locations: [calendar.location],
    geohash: calendar.geohash,
  }
  return calendar.kind === 31922
    ? {
        ...common,
        kind: 31922,
        start: calendar.start as string,
        end: calendar.end as string | undefined,
      }
    : {
        ...common,
        kind: 31923,
        start: calendar.start as number,
        end: calendar.end as number | undefined,
        startTzid: calendar.timezone,
        endTzid: calendar.timezone,
      }
}

function signedRecordsForDraft(
  events: readonly SignedPublicNostrEvent[],
  draft: FrozenSeriesDraft
): SignedPublicNostrEvent[] {
  const expectedKinds = new Map<string, number>([
    [draft.marketDTag, 30409],
    [draft.scheduleDTag, 31924],
    ...draft.occurrenceDTags.map((dTag): [string, number] => [
      dTag,
      draft.form.calendarType === "timed" ? 31923 : 31922,
    ]),
  ])
  const matching = events.filter(
    (event) =>
      isValidSignedPublicNostrEvent(event) &&
      event.pubkey === draft.organizerPubkey &&
      expectedKinds.get(event.tags.find((tag) => tag[0] === "d")?.[1] ?? "") ===
        event.kind
  )
  const byCoordinate = new Map<string, SignedPublicNostrEvent>()
  for (const event of matching) {
    const coordinate = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
    const previous = byCoordinate.get(coordinate)
    if (previous && previous.id !== event.id) {
      throw new Error(
        "Saved series signatures conflict. Review before resuming."
      )
    }
    byCoordinate.set(coordinate, event)
  }
  return [...byCoordinate.values()]
}

export function FutureEventMarketCreate({
  onPublished,
}: {
  onPublished: (reference: string) => void
}) {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const [form, setForm] = useState<OrganizerEventMarketFormValues>(
    createEmptyOrganizerEventMarketForm
  )
  const [scheduleMode, setScheduleMode] = useState<"one" | "multiple">("one")
  const [dateRows, setDateRows] = useState<OrganizerEventDateRow[]>([])
  const [generatedBaseline, setGeneratedBaseline] = useState<
    OrganizerEventDateRow[]
  >([])
  const [weekly, setWeekly] =
    useState<OrganizerWeeklyDatePattern>(EMPTY_WEEKLY_PATTERN)
  const [showWeekly, setShowWeekly] = useState(false)
  const [frozenDraft, setFrozenDraft] = useState<FrozenSeriesDraft | null>(null)
  const [savedSignatureCount, setSavedSignatureCount] = useState(0)
  const [recordProgress, setRecordProgress] = useState<Record<string, string>>(
    {}
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [step, setStep] = useState("")
  const organizerPubkey = accountPubkey ?? ""
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null

  useEffect(() => {
    let active = true
    if (!organizerPubkey) {
      setFrozenDraft(null)
      setSavedSignatureCount(0)
      return
    }
    try {
      const saved = readFrozenSeriesDraft(organizerPubkey)
      setFrozenDraft(saved)
      if (saved) {
        setForm(saved.form)
        setDateRows(saved.dateRows)
        setScheduleMode("multiple")
        setShowWeekly(false)
        const marketCoordinate = `30409:${organizerPubkey}:${saved.marketDTag}`
        void loadRetainedSignedEventMarketEvidence(marketCoordinate)
          .then((events) => {
            if (active) {
              setSavedSignatureCount(
                signedRecordsForDraft(events, saved).length
              )
            }
          })
          .catch((cause) => {
            if (active)
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Saved series signatures could not be loaded."
              )
          })
      } else {
        setSavedSignatureCount(0)
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Saved series draft is invalid."
      )
    }
    return () => {
      active = false
    }
  }, [organizerPubkey])

  function update<K extends keyof OrganizerEventMarketFormValues>(
    key: K,
    value: OrganizerEventMarketFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function chooseScheduleMode(mode: "one" | "multiple"): void {
    if (mode === "multiple" && dateRows.length === 0) {
      setDateRows([
        { id: crypto.randomUUID(), start: form.start, end: form.end },
      ])
    }
    setScheduleMode(mode)
    setError("")
  }

  function updateDateRow(
    id: string,
    field: "start" | "end",
    value: string
  ): void {
    setDateRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    )
  }

  function addDate(): void {
    if (dateRows.length >= MAX_ORGANIZER_EVENT_DATES) {
      setError(`Add at most ${MAX_ORGANIZER_EVENT_DATES} dates.`)
      return
    }
    setDateRows((current) => [
      ...current,
      { id: crypto.randomUUID(), start: "", end: "" },
    ])
    setError("")
  }

  function generateWeekly(): void {
    try {
      const generated = generateOrganizerWeeklyDates({
        ...weekly,
        timezone: form.timezone,
      }).map((row) => ({ ...row, id: crypto.randomUUID() }))
      const existingStarts = new Set(
        dateRows.filter((row) => row.start).map((row) => row.start)
      )
      if (generated.some((row) => existingStarts.has(row.start))) {
        throw new Error("Generated dates overlap dates already in the list.")
      }
      const existing = dateRows.filter((row) => row.start || row.end)
      if (existing.length + generated.length > MAX_ORGANIZER_EVENT_DATES) {
        throw new Error(
          `Keep the list to at most ${MAX_ORGANIZER_EVENT_DATES} dates.`
        )
      }
      setDateRows([...existing, ...generated])
      setGeneratedBaseline((current) => [...current, ...generated])
      setWeekly(EMPTY_WEEKLY_PATTERN)
      setShowWeekly(false)
      setError("")
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not generate dates."
      )
    }
  }

  const starts = dateRows
    .map((row) => row.start)
    .filter(Boolean)
    .sort()
  const generatedById = new Map(generatedBaseline.map((row) => [row.id, row]))
  const generatedCurrentIds = new Set(dateRows.map((row) => row.id))
  const changedGenerated = dateRows.filter((row) => {
    const original = generatedById.get(row.id)
    return (
      original && (row.start !== original.start || row.end !== original.end)
    )
  }).length
  const removedGenerated = generatedBaseline.filter(
    (row) => !generatedCurrentIds.has(row.id)
  ).length
  const addedDates = dateRows.filter((row) => !generatedById.has(row.id)).length

  async function publish(): Promise<void> {
    if (!authenticatedPubkey || pending) return
    setPending(true)
    setError("")
    setRecordProgress({})
    try {
      if (scheduleMode === "multiple") {
        let draft = readFrozenSeriesDraft(organizerPubkey)
        if (!draft) {
          prepareOrganizerEventMarketDates(form, dateRows, {
            requireFutureStart: true,
          })
          const marketDTag = `${slugifyEventMarketTitle(form.title)}-${crypto.randomUUID().slice(0, 8)}`
          draft = {
            version: 1,
            organizerPubkey,
            marketDTag,
            scheduleDTag: `${marketDTag}-schedule`,
            occurrenceDTags: dateRows.map(
              (_, index) => `${marketDTag}-date-${index + 1}`
            ),
            form: structuredClone(form),
            dateRows: structuredClone(dateRows),
          }
          saveFrozenSeriesDraft(draft)
        }
        setFrozenDraft(draft)
        const preparedDates = prepareOrganizerEventMarketDates(
          draft.form,
          draft.dateRows
        )
        const marketCoordinate = `30409:${organizerPubkey}:${draft.marketDTag}`
        const scheduleCoordinate = `31924:${organizerPubkey}:${draft.scheduleDTag}`
        const savedSignedEvents = signedRecordsForDraft(
          await loadRetainedSignedEventMarketEvidence(marketCoordinate),
          draft
        )
        setSavedSignatureCount(savedSignedEvents.length)
        const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
        const newOccurrences = preparedDates.map((date, index) =>
          preparedCalendarDraft(date.calendar, draft.occurrenceDTags[index]!)
        )
        setStep("Preparing signed dates…")
        const series = await publishFutureEventMarketSeries({
          organizerPubkey,
          authenticatedPubkey,
          scheduleDTag: draft.scheduleDTag,
          title: draft.form.title.trim(),
          newOccurrences,
          shouldContinue,
          savedSignedEvents,
          onSignedLocal: async (event) => {
            await retainSignedEventMarketEvidence(marketCoordinate, event)
            setSavedSignatureCount((count) => count + 1)
          },
          onProgress: (progress) => {
            const record =
              progress.record === "occurrence"
                ? `Date ${progress.index} of ${progress.total}`
                : "Schedule"
            const action = {
              signing: "Requesting signature",
              signed: "Signed locally",
              publishing: "Publishing",
              acknowledged: "Acknowledged by a relay",
            }[progress.phase]
            setStep(`${record}: ${action}`)
            if (progress.phase !== "acknowledged")
              setRecordProgress((current) => ({
                ...current,
                [record]: action,
              }))
          },
          onDelivery: ({ record, index, delivery }) => {
            const label =
              record === "occurrence"
                ? `Date ${index} of ${newOccurrences.length}`
                : "Schedule"
            setRecordProgress((current) => ({
              ...current,
              [label]: `${delivery.acknowledged} ACK · ${delivery.rejected} rejected · ${delivery.timedOut} timed out${delivery.otherFailed ? ` · ${delivery.otherFailed} other failure` : ""}`,
            }))
          },
        })
        const savedRoster = savedSignedEvents.find(
          (event) => event.kind === 30409
        )
        setStep("Publishing signed Event Market…")
        setRecordProgress((current) => ({
          ...current,
          "Event Market": savedRoster
            ? "Retrying saved signature"
            : "Requesting signature",
        }))
        const rosterDelivery = savedRoster
          ? await (async () => {
              const parsed = parseEventMarketRosterEvent(savedRoster)
              if (
                !parsed ||
                parsed.coordinate !== marketCoordinate ||
                parsed.calendarCoordinate !== scheduleCoordinate
              ) {
                throw new Error(
                  "Saved Event Market roster differs from the series draft."
                )
              }
              return retryEventMarketRosterDelivery({
                signedEvent: savedRoster,
                authenticatedPubkey,
                shouldContinue,
              })
            })()
          : (
              await publishEventMarketRoster({
                organizerPubkey,
                authenticatedPubkey,
                dTag: draft.marketDTag,
                calendarCoordinate: scheduleCoordinate,
                state: "open",
                merchants: [],
                shouldContinue,
                onSignedLocal: async (event) => {
                  await retainSignedEventMarketEvidence(marketCoordinate, event)
                  setSavedSignatureCount((count) => count + 1)
                },
                onDelivery: (delivery) =>
                  setRecordProgress((current) => ({
                    ...current,
                    "Event Market": `${delivery.acknowledged} ACK · ${delivery.rejected} rejected · ${delivery.timedOut} timed out${delivery.otherFailed ? ` · ${delivery.otherFailed} other failure` : ""}`,
                  })),
              })
            ).delivery
        if (rosterDelivery.successfulRelayUrls.length === 0) {
          throw new Error(
            "The signed Event Market was saved for exact retry but no relay acknowledged it."
          )
        }
        setRecordProgress((current) => ({
          ...current,
          "Event Market": (() => {
            const delivery = summarizeEventMarketPublishDelivery(rosterDelivery)
            return `${delivery.acknowledged} ACK · ${delivery.rejected} rejected · ${delivery.timedOut} timed out${delivery.otherFailed ? ` · ${delivery.otherFailed} other failure` : ""}`
          })(),
        }))
        clearFrozenSeriesDraft(organizerPubkey)
        setFrozenDraft(null)
        setSavedSignatureCount(0)
        onPublished(
          encodeEventMarketNaddr(
            marketCoordinate,
            rosterDelivery.successfulRelayUrls.length
              ? rosterDelivery.successfulRelayUrls
              : series.schedule.delivery.successfulRelayUrls
          )
        )
        return
      }
      const prepared = prepareOrganizerEventMarketForm(form, {
        requireFutureStart: true,
      })
      const dTag = `${slugifyEventMarketTitle(form.title) || "event"}-${crypto.randomUUID().slice(0, 8)}`
      const calendarDTag = `${dTag}-calendar`
      const marketCoordinate = `30409:${organizerPubkey}:${dTag}`
      const calendarCoordinate = `${prepared.calendar.kind}:${organizerPubkey}:${calendarDTag}`
      const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
      const calendar =
        prepared.calendar.kind === 31922
          ? {
              kind: 31922 as const,
              dTag: calendarDTag,
              title: prepared.calendar.title,
              summary: prepared.calendar.summary,
              image: prepared.calendar.imageUrl,
              locations: [prepared.calendar.location],
              geohash: prepared.calendar.geohash,
              start: prepared.calendar.start as string,
              end: prepared.calendar.end as string | undefined,
            }
          : {
              kind: 31923 as const,
              dTag: calendarDTag,
              title: prepared.calendar.title,
              summary: prepared.calendar.summary,
              image: prepared.calendar.imageUrl,
              locations: [prepared.calendar.location],
              geohash: prepared.calendar.geohash,
              start: prepared.calendar.start as number,
              end: prepared.calendar.end as number | undefined,
              startTzid: prepared.calendar.timezone,
              endTzid: prepared.calendar.timezone,
            }
      setStep("Publishing signed calendar…")
      await publishFutureEventMarketCalendar({
        organizerPubkey,
        authenticatedPubkey,
        calendar,
        shouldContinue,
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(marketCoordinate, event),
      })
      setStep("Publishing signed Event Market…")
      const result = await publishEventMarketRoster({
        organizerPubkey,
        authenticatedPubkey,
        dTag,
        calendarCoordinate,
        state: "open",
        merchants: [],
        shouldContinue,
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(marketCoordinate, event),
      })
      onPublished(
        encodeEventMarketNaddr(
          marketCoordinate,
          result.delivery.successfulRelayUrls
        )
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Event Market publication failed."
      )
    } finally {
      setPending(false)
      setStep("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Event Market</CardTitle>
        <CardDescription>
          Create an organizer-signed Event Market. Approved merchants associate
          their products once; product stock is shared across listed dates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {frozenDraft ? (
          <p className="text-sm text-[var(--text-secondary)]">
            This series has a saved publishing plan. Resume it with the same
            dates and signatures.{" "}
            {Math.max(0, frozenDraft.dateRows.length + 2 - savedSignatureCount)}{" "}
            signer confirmations remain.
          </p>
        ) : null}
        <fieldset
          disabled={Boolean(frozenDraft) || pending}
          className="space-y-5"
        >
          <div className="space-y-1">
            <Label htmlFor="future-title">Event title</Label>
            <Input
              id="future-title"
              value={form.title}
              onChange={(event) => update("title", event.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-summary">Description</Label>
            <Textarea
              id="future-summary"
              value={form.summary}
              onChange={(event) => update("summary", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-image">Banner URL</Label>
            <Input
              id="future-image"
              type="url"
              value={form.imageUrl}
              onChange={(event) => update("imageUrl", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-location">Location</Label>
            <Input
              id="future-location"
              value={form.eventLocation}
              onChange={(event) => update("eventLocation", event.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-schedule-mode">Dates</Label>
            <Select
              value={scheduleMode}
              onValueChange={(value) =>
                chooseScheduleMode(value as "one" | "multiple")
              }
            >
              <SelectTrigger id="future-schedule-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one">One date</SelectItem>
                <SelectItem value="multiple">Multiple dates</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-calendar-type">Schedule</Label>
            <Select
              value={form.calendarType}
              onValueChange={(value) =>
                update("calendarType", value as "date" | "timed")
              }
            >
              <SelectTrigger id="future-calendar-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="timed">Timed event</SelectItem>
                <SelectItem value="date">All-day event</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scheduleMode === "one" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="future-start">Start</Label>
                <Input
                  id="future-start"
                  type={
                    form.calendarType === "timed" ? "datetime-local" : "date"
                  }
                  value={form.start}
                  onChange={(event) => update("start", event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="future-end">End</Label>
                <Input
                  id="future-end"
                  type={
                    form.calendarType === "timed" ? "datetime-local" : "date"
                  }
                  value={form.end}
                  onChange={(event) => update("end", event.target.value)}
                  required
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p
                aria-live="polite"
                className="text-sm text-[var(--text-secondary)]"
              >
                {dateRows.length} of {MAX_ORGANIZER_EVENT_DATES} dates
                {starts.length
                  ? ` · First ${starts[0].slice(0, 10)} · Last ${starts[starts.length - 1].slice(0, 10)}`
                  : ""}
                {generatedBaseline.length
                  ? ` · Exceptions: ${changedGenerated} edited, ${removedGenerated} removed, ${addedDates} added`
                  : ""}
                {` · About ${dateRows.length + 2} signer confirmations to create`}
              </p>
              {dateRows.map((row, index) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-[var(--border)] p-3 space-y-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium">Date {index + 1}</h3>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`Remove date ${index + 1}`}
                      disabled={pending}
                      onClick={() =>
                        setDateRows((current) =>
                          current.filter((item) => item.id !== row.id)
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor={`future-date-${row.id}-start`}>
                        Start
                      </Label>
                      <Input
                        id={`future-date-${row.id}-start`}
                        type={
                          form.calendarType === "timed"
                            ? "datetime-local"
                            : "date"
                        }
                        value={row.start}
                        onChange={(event) =>
                          updateDateRow(row.id, "start", event.target.value)
                        }
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`future-date-${row.id}-end`}>End</Label>
                      <Input
                        id={`future-date-${row.id}-end`}
                        type={
                          form.calendarType === "timed"
                            ? "datetime-local"
                            : "date"
                        }
                        value={row.end}
                        onChange={(event) =>
                          updateDateRow(row.id, "end", event.target.value)
                        }
                        required
                      />
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    pending || dateRows.length >= MAX_ORGANIZER_EVENT_DATES
                  }
                  onClick={addDate}
                >
                  Add date
                </Button>
                {form.calendarType === "timed" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setShowWeekly((current) => !current)}
                  >
                    Generate weekly dates
                  </Button>
                ) : null}
              </div>
              {showWeekly && form.calendarType === "timed" ? (
                <div
                  className="space-y-3 rounded-lg border border-[var(--border)] p-3"
                  aria-label="Weekly date generator"
                >
                  <p className="text-sm text-[var(--text-secondary)]">
                    Generate concrete dates. You can edit or remove any date
                    before publishing.
                  </p>
                  <fieldset className="space-y-2">
                    <legend className="font-medium">Weekdays</legend>
                    <div className="flex flex-wrap gap-3">
                      {WEEKDAYS.map((day) => (
                        <label
                          key={day.value}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={weekly.weekdays.includes(day.value)}
                            onCheckedChange={(checked) =>
                              setWeekly((current) => ({
                                ...current,
                                weekdays:
                                  checked === true
                                    ? [...current.weekdays, day.value]
                                    : current.weekdays.filter(
                                        (value) => value !== day.value
                                      ),
                              }))
                            }
                          />
                          {day.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="weekly-first">First date</Label>
                      <Input
                        id="weekly-first"
                        type="date"
                        value={weekly.firstDate}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            firstDate: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="weekly-through">Through date</Label>
                      <Input
                        id="weekly-through"
                        type="date"
                        value={weekly.throughDate}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            throughDate: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="weekly-start">Start hour</Label>
                      <Input
                        id="weekly-start"
                        type="time"
                        value={weekly.startTime}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            startTime: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="weekly-end">End hour</Label>
                      <Input
                        id="weekly-end"
                        type="time"
                        value={weekly.endTime}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            endTime: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Time zone: {form.timezone || "Choose a time zone below"}
                  </p>
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={generateWeekly}
                  >
                    Generate dates
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          {form.calendarType === "timed" ? (
            <div className="space-y-1">
              <Label htmlFor="future-timezone">Time zone</Label>
              <Input
                id="future-timezone"
                value={form.timezone}
                onChange={(event) => update("timezone", event.target.value)}
                required
              />
            </div>
          ) : null}
        </fieldset>
        {step ? <p role="status">{step}</p> : null}
        {Object.keys(recordProgress).length > 0 ? (
          <ul
            className="space-y-1 text-sm text-[var(--text-secondary)]"
            aria-label="Publishing progress"
          >
            {Object.entries(recordProgress).map(([record, status]) => (
              <li key={record}>
                {record}: {status}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={!authenticatedPubkey || pending}
          onClick={() => void publish()}
        >
          {frozenDraft ? "Resume publishing" : "Publish Event Market"}
        </Button>
        {!authenticatedPubkey ? (
          <p className="text-sm text-[var(--text-muted)]">
            Connect the organizer signer to publish.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
