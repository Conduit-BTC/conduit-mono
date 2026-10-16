import { useEffect, useMemo, useRef, useState } from "react"
import {
  encodeEventMarketNaddr,
  admitPublicEvent,
  loadRetainedSignedEventMarketEvidence,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  publishFutureEventMarketSeries,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  summarizeEventMarketPublishDelivery,
  type EventMarketCalendarDraftInput,
  type SignedPublicNostrEvent,
  type VerifiedNostrEvent,
  useAuth,
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
  Textarea,
} from "@conduit/ui"
import {
  createEmptyOrganizerEventMarketForm,
  generateOrganizerRecurringDates,
  fromStoredOrganizerEventForm,
  toStoredOrganizerEventForm,
  MAX_ORGANIZER_EVENT_DATES,
  prepareOrganizerEventMarketDates,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  type OrganizerEventDateRow,
  type OrganizerEventMarketFormValues,
  type OrganizerEventRepeat,
} from "../lib/event-market-form"

import {
  loadFutureEventMarketCreation,
  publishFutureEventMarketCreation,
  saveNewFutureEventMarketCreation,
} from "../lib/event-market-creation-retry"

import { EventBannerField } from "./EventAuthoringFields"
import {
  EventScheduleFields,
  type EventRepeatMode,
} from "./EventScheduleFields"

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

async function signedRecordsForDraft(
  events: readonly SignedPublicNostrEvent[],
  draft: FrozenSeriesDraft
): Promise<VerifiedNostrEvent[]> {
  const expectedKinds = new Map<string, number>([
    [draft.marketDTag, 30409],
    [draft.scheduleDTag, 31924],
    ...draft.occurrenceDTags.map((dTag): [string, number] => [
      dTag,
      draft.form.calendarType === "timed" ? 31923 : 31922,
    ]),
  ])
  const admitted: VerifiedNostrEvent[] = []
  for (let offset = 0; offset < events.length; offset += 64) {
    const results = await Promise.all(
      events.slice(offset, offset + 64).map((event) => admitPublicEvent(event))
    )
    for (const result of results) {
      if (result.status === "verified") admitted.push(result.event)
      else if (result.status === "unavailable")
        throw new Error(
          "Saved Event Market signature verification is unavailable."
        )
      else if (result.status === "cancelled")
        throw new DOMException(
          "Event Market creation was cancelled.",
          "AbortError"
        )
    }
  }
  const matching = admitted.filter(
    (event) =>
      event.pubkey === draft.organizerPubkey &&
      expectedKinds.get(event.tags.find((tag) => tag[0] === "d")?.[1] ?? "") ===
        event.kind
  )
  const byCoordinate = new Map<string, VerifiedNostrEvent>()
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
  const organizerPubkey = accountPubkey ?? ""
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  return (
    <FutureEventMarketCreateForm
      key={organizerPubkey}
      organizerPubkey={organizerPubkey}
      authenticatedPubkey={authenticatedPubkey}
      shouldContinue={() => isAuthGenerationCurrent(authGeneration)}
      onPublished={onPublished}
    />
  )
}

function FutureEventMarketCreateForm({
  organizerPubkey,
  authenticatedPubkey,
  shouldContinue,
  onPublished,
}: {
  organizerPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  onPublished: (reference: string) => void
}) {
  const [restored] = useState(() => {
    try {
      return {
        creation: organizerPubkey
          ? loadFutureEventMarketCreation(organizerPubkey)
          : null,
        error: "",
      }
    } catch (cause) {
      return {
        creation: null,
        error:
          cause instanceof Error
            ? cause.message
            : "Saved creation could not be loaded.",
      }
    }
  })
  const [creation, setCreation] = useState(restored.creation)
  const [bannerScope] = useState(
    () => `event-create:${organizerPubkey}:${crypto.randomUUID()}`
  )
  const publishing = useRef(false)
  const [form, setForm] = useState<OrganizerEventMarketFormValues>(() =>
    restored.creation
      ? fromStoredOrganizerEventForm(restored.creation.form)
      : createEmptyOrganizerEventMarketForm()
  )
  const [repeatMode, setRepeatMode] = useState<EventRepeatMode>("none")
  const [dateRows, setDateRows] = useState<OrganizerEventDateRow[]>([])
  const [repeat, setRepeat] = useState<OrganizerEventRepeat>({
    frequency: "weekly",
    weekdays: [],
    ends: "after_count",
    throughDate: "",
    count: 4,
  })
  const generated = useMemo(() => {
    if (repeatMode !== "weekly" && repeatMode !== "monthly")
      return { rows: [], error: "" }
    try {
      return {
        rows: generateOrganizerRecurringDates(form, {
          ...repeat,
          frequency: repeatMode,
        }),
        error: "",
      }
    } catch (cause) {
      return {
        rows: [],
        error:
          cause instanceof Error ? cause.message : "Check the repeating dates.",
      }
    }
  }, [form, repeat, repeatMode])
  const activeDateRows = repeatMode === "custom" ? dateRows : generated.rows
  const [frozenDraft, setFrozenDraft] = useState<FrozenSeriesDraft | null>(null)
  const [savedSignatureCount, setSavedSignatureCount] = useState(0)
  const [recordProgress, setRecordProgress] = useState<Record<string, string>>(
    {}
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(restored.error)
  const [step, setStep] = useState("")
  const [bannerBusy, setBannerBusy] = useState(false)

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
        setForm(fromStoredOrganizerEventForm(saved.form))
        setDateRows(
          saved.dateRows.map((row) => ({
            ...row,
            end: fromStoredOrganizerEventForm({
              ...saved.form,
              start: row.start,
              end: row.end,
            }).end,
          }))
        )
        setRepeatMode("custom")
        const marketCoordinate = `30409:${organizerPubkey}:${saved.marketDTag}`
        void loadRetainedSignedEventMarketEvidence(marketCoordinate)
          .then(async (events) => {
            const signed = await signedRecordsForDraft(events, saved)
            if (active) setSavedSignatureCount(signed.length)
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

  async function publish(): Promise<void> {
    if (
      !authenticatedPubkey ||
      publishing.current ||
      restored.error ||
      bannerBusy
    )
      return
    publishing.current = true
    setPending(true)
    setError("")
    setRecordProgress({})
    try {
      if (!shouldContinue()) throw new Error("Organizer session changed.")
      if (repeatMode !== "none") {
        let draft = readFrozenSeriesDraft(organizerPubkey)
        if (!draft) {
          prepareOrganizerEventMarketDates(form, activeDateRows, {
            requireFutureStart: true,
          })
          const marketDTag = `${slugifyEventMarketTitle(form.title)}-${crypto.randomUUID().slice(0, 8)}`
          draft = {
            version: 1,
            organizerPubkey,
            marketDTag,
            scheduleDTag: `${marketDTag}-schedule`,
            occurrenceDTags: activeDateRows.map(
              (_, index) => `${marketDTag}-date-${index + 1}`
            ),
            form: toStoredOrganizerEventForm({
              ...form,
              start: activeDateRows[0]!.start,
              end: activeDateRows[0]!.end,
            }),
            dateRows: activeDateRows.map((row) => ({
              ...row,
              end: toStoredOrganizerEventForm({
                ...form,
                start: row.start,
                end: row.end,
              }).end,
            })),
          }
          saveFrozenSeriesDraft(draft)
        }
        setFrozenDraft(draft)
        const preparedDates = prepareOrganizerEventMarketDates(
          draft.form,
          draft.dateRows,
          { endDateIsExclusive: true }
        )
        const marketCoordinate = `30409:${organizerPubkey}:${draft.marketDTag}`
        const scheduleCoordinate = `31924:${organizerPubkey}:${draft.scheduleDTag}`
        const savedSignedEvents = await signedRecordsForDraft(
          await loadRetainedSignedEventMarketEvidence(marketCoordinate),
          draft
        )
        setSavedSignatureCount(savedSignedEvents.length)
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
      const saved =
        loadFutureEventMarketCreation(organizerPubkey) ??
        saveNewFutureEventMarketCreation(organizerPubkey, form)
      setCreation(saved)
      const result = await publishFutureEventMarketCreation({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        onSaved: setCreation,
        onStep: setStep,
      })
      onPublished(
        encodeEventMarketNaddr(
          result.marketCoordinate,
          result.successfulRelayUrls
        )
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Event Market publication failed."
      )
    } finally {
      publishing.current = false
      setPending(false)
      setStep("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create event</CardTitle>
        <CardDescription>
          Add your event details and dates. You can invite merchants after
          publishing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {creation ? (
          <p role="status" className="text-sm text-[var(--text-muted)]">
            A saved creation is waiting to finish. Retry the same Event Market
            before creating another; its signed records may already be public.
          </p>
        ) : null}
        {frozenDraft ? (
          <p className="text-sm text-[var(--text-secondary)]">
            This series has a saved publishing plan. Resume it with the same
            dates and signatures.{" "}
            {Math.max(0, frozenDraft.dateRows.length + 2 - savedSignatureCount)}{" "}
            signer confirmations remain.
          </p>
        ) : null}
        <fieldset
          disabled={Boolean(frozenDraft) || !!creation || pending}
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
          <div className="grid gap-1 [&>p]:mt-1">
            <Label htmlFor="future-summary">Description · Required</Label>
            <Textarea
              id="future-summary"
              required
              aria-describedby="future-summary-help"
              value={form.summary}
              onChange={(event) => update("summary", event.target.value)}
            />
            <p
              id="future-summary-help"
              className="text-xs text-[var(--text-muted)]"
            >
              Tell visitors what to expect and where to meet. This description
              is public.
            </p>
          </div>
          <EventBannerField
            id="future-image"
            value={form.imageUrl}
            title={form.title}
            scopeId={bannerScope}
            disabled={pending || !!creation || !!frozenDraft}
            onChange={(url) => update("imageUrl", url)}
            onBusyChange={setBannerBusy}
          />
          <div className="space-y-1">
            <Label htmlFor="future-location">Location</Label>
            <Input
              id="future-location"
              value={form.eventLocation}
              onChange={(event) => update("eventLocation", event.target.value)}
              required
            />
          </div>
          <EventScheduleFields
            form={form}
            onFormChange={setForm}
            mode={repeatMode}
            onModeChange={(mode) => {
              setRepeatMode(mode)
              setError("")
            }}
            repeat={repeat}
            onRepeatChange={setRepeat}
            rows={repeatMode === "none" ? dateRows : activeDateRows}
            onRowsChange={setDateRows}
            error={generated.error}
          />
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
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={
            !authenticatedPubkey ||
            pending ||
            !!restored.error ||
            bannerBusy ||
            !!generated.error
          }
          onClick={() => void publish()}
        >
          {frozenDraft ? "Resume publishing" : "Publish event"}
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
