import { useEffect, useMemo, useRef, useState } from "react"
import {
  buildEventMarketCalendarDraft,
  EVENT_MARKET_CALENDAR_SUMMARY_MAX_LENGTH,
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DialogTrigger,
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
  isFutureEventMarketCreationSigned,
  publishFutureEventMarketCreation,
  reviseFutureEventMarketCreation,
  saveNewFutureEventMarketCreation,
  withFutureEventMarketCreationLock,
} from "../lib/event-market-creation-retry"

import { EventBannerField } from "./EventAuthoringFields"
import { EventDetailsFields } from "./EventDetailsFields"
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
  /** Pinned before network I/O, including when evidence storage is later lost. */
  signedEventIds?: string[]
}

function isUnsignedSeriesDraft(
  draft: FrozenSeriesDraft,
  retainedCount: number
): boolean {
  if (retainedCount || draft.signedEventIds?.length) return false
  if (draft.signedEventIds) return true
  // Old writers rejected these common fields before requesting any signature.
  // Other legacy plans without local history remain frozen for recovery.
  const summary = draft.form.summary.trim()
  return (
    summary.length > EVENT_MARKET_CALENDAR_SUMMARY_MAX_LENGTH ||
    /\p{Cc}/u.test(summary)
  )
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
    typeof draft.form.timezone !== "string" ||
    typeof draft.form.summary !== "string" ||
    (draft.signedEventIds !== undefined &&
      (!Array.isArray(draft.signedEventIds) ||
        draft.signedEventIds.some(
          (id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)
        ) ||
        draft.signedEventIds.length > draft.dateRows.length + 2))
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
  const [creationSigned, setCreationSigned] = useState<boolean | null>(
    restored.creation ? null : false
  )
  const [creationEvidenceRevision, setCreationEvidenceRevision] = useState(0)
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
  const [seriesSigned, setSeriesSigned] = useState<boolean | null>(null)
  const [recordProgress, setRecordProgress] = useState<Record<string, string>>(
    {}
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(restored.error)
  const [step, setStep] = useState("")
  const [bannerBusy, setBannerBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  useEffect(() => {
    let active = true
    if (!creation) {
      setCreationSigned(false)
      return
    }
    setCreationSigned(null)
    void isFutureEventMarketCreationSigned(creation)
      .then((signed) => {
        if (active) setCreationSigned(signed)
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Saved signatures could not be checked."
          )
      })
    return () => {
      active = false
    }
  }, [creation, creationEvidenceRevision])

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
            if (active) {
              setSavedSignatureCount(signed.length)
              setSeriesSigned(!isUnsignedSeriesDraft(saved, events.length))
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

  async function discardUnsigned(keepDetails = false): Promise<void> {
    if (publishing.current || pending || bannerBusy) return
    setDiscardOpen(false)
    setPending(true)
    setError("")
    try {
      if (creation) {
        await reviseFutureEventMarketCreation({ creation, shouldContinue })
        setCreation(null)
      } else if (frozenDraft) {
        await withFutureEventMarketCreationLock(organizerPubkey, async () => {
          const assertCurrent = () => {
            if (!shouldContinue()) throw new Error("Organizer session changed.")
            if (
              JSON.stringify(readFrozenSeriesDraft(organizerPubkey)) !==
              JSON.stringify(frozenDraft)
            )
              throw new Error(
                "The saved series changed in another tab. Reload before continuing."
              )
          }
          assertCurrent()
          const events = await loadRetainedSignedEventMarketEvidence(
            `30409:${organizerPubkey}:${frozenDraft.marketDTag}`
          )
          if (!isUnsignedSeriesDraft(frozenDraft, events.length))
            throw new Error(
              "Signed records may already be public. Resume publishing the saved series."
            )
          assertCurrent()
          clearFrozenSeriesDraft(organizerPubkey)
        })
        setFrozenDraft(null)
        setSavedSignatureCount(0)
      }
      if (!keepDetails) {
        setForm(createEmptyOrganizerEventMarketForm())
        setRepeatMode("none")
        setDateRows([])
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The saved draft could not be changed."
      )
    } finally {
      setPending(false)
    }
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
        if (creation)
          throw new Error(
            "Finish or discard the saved single event before creating a series."
          )
        const expectedDraft = frozenDraft
        await withFutureEventMarketCreationLock(organizerPubkey, async () => {
          if (loadFutureEventMarketCreation(organizerPubkey))
            throw new Error(
              "Finish or discard the saved single event before creating a series."
            )
          let draft = readFrozenSeriesDraft(organizerPubkey)
          if (JSON.stringify(draft) !== JSON.stringify(expectedDraft))
            throw new Error(
              "The saved series changed in another tab. Reload before continuing."
            )
          if (!draft) {
            const dates = prepareOrganizerEventMarketDates(
              form,
              activeDateRows,
              {
                requireFutureStart: true,
              }
            )
            for (const date of dates)
              buildEventMarketCalendarDraft(
                preparedCalendarDraft(date.calendar, "preflight")
              )
            const marketDTag = `${slugifyEventMarketTitle(form.title)}-${crypto.randomUUID().slice(0, 8)}`
            draft = {
              version: 1,
              signedEventIds: [],
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
          if (
            draft.signedEventIds?.some(
              (id) => !savedSignedEvents.some((event) => event.id === id)
            )
          )
            throw new Error(
              "An exact saved series signature is missing. Keep the saved plan for recovery."
            )
          if (!savedSignedEvents.length && !isUnsignedSeriesDraft(draft, 0))
            throw new Error(
              "The saved series has no retained signature history. Keep its plan and restore the original browser storage before retrying."
            )
          draft = {
            ...draft,
            signedEventIds: savedSignedEvents.map((event) => event.id),
          }
          localStorage.setItem(
            seriesDraftKey(organizerPubkey),
            JSON.stringify(draft)
          )
          setFrozenDraft(draft)
          setSavedSignatureCount(savedSignedEvents.length)
          setSeriesSigned(savedSignedEvents.length > 0)
          const retainSeriesSignature = async (
            event: SignedPublicNostrEvent
          ) => {
            await retainSignedEventMarketEvidence(marketCoordinate, event)
            draft = {
              ...draft!,
              signedEventIds: [
                ...new Set([...(draft!.signedEventIds ?? []), event.id]),
              ],
            }
            localStorage.setItem(
              seriesDraftKey(organizerPubkey),
              JSON.stringify(draft)
            )
            setFrozenDraft(draft)
            setSavedSignatureCount(draft.signedEventIds!.length)
            setSeriesSigned(true)
          }
          const newOccurrences = preparedDates.map((date, index) =>
            preparedCalendarDraft(date.calendar, draft!.occurrenceDTags[index]!)
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
            onSignedLocal: retainSeriesSignature,
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
                  onSignedLocal: retainSeriesSignature,
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
              const delivery =
                summarizeEventMarketPublishDelivery(rosterDelivery)
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
        })
        return
      }
      let saved = await withFutureEventMarketCreationLock(
        organizerPubkey,
        async () => {
          if (readFrozenSeriesDraft(organizerPubkey))
            throw new Error(
              "Finish or discard the saved series before creating another event."
            )
          const current = loadFutureEventMarketCreation(organizerPubkey)
          if (JSON.stringify(current) !== JSON.stringify(creation))
            throw new Error(
              "The saved creation changed in another tab. Reload before continuing."
            )
          return (
            current ?? saveNewFutureEventMarketCreation(organizerPubkey, form)
          )
        }
      )
      if (creation && creationSigned === false) {
        saved = (await reviseFutureEventMarketCreation({
          creation,
          form,
          shouldContinue,
        }))!
      }
      setCreation(saved)
      const result = await publishFutureEventMarketCreation({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        expectedCreation: saved,
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
      // Signature retention can succeed even when its plan pointer write fails.
      // Recheck that evidence even when the saved creation object did not change.
      setCreationEvidenceRevision((revision) => revision + 1)
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
            {creationSigned === false
              ? "Your saved draft is editable. Correct the details and publish, or discard it to start a new event."
              : creationSigned === null
                ? "Checking saved signatures before enabling draft changes…"
                : "Signed records may already be public. Retry the saved event first, then edit its details on the event page. The same signatures will be reused."}
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
          disabled={
            Boolean(frozenDraft) ||
            (!!creation && creationSigned !== false) ||
            pending
          }
          className="space-y-5"
        >
          <EventDetailsFields
            idPrefix="future"
            title={form.title}
            summary={form.summary}
            location={form.eventLocation}
            onTitleChange={(value) => update("title", value)}
            onSummaryChange={(value) => update("summary", value)}
            onLocationChange={(value) => update("eventLocation", value)}
            banner={
              <EventBannerField
                id="future-image"
                value={form.imageUrl}
                title={form.title}
                scopeId={bannerScope}
                disabled={
                  pending ||
                  (!!creation && creationSigned !== false) ||
                  !!frozenDraft
                }
                onChange={(url) => update("imageUrl", url)}
                onBusyChange={setBannerBusy}
              />
            }
          />
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
            (!!creation && creationSigned === null) ||
            bannerBusy ||
            !!generated.error
          }
          onClick={() => void publish()}
        >
          {frozenDraft
            ? "Resume publishing"
            : creationSigned
              ? "Retry saved event"
              : "Publish event"}
        </Button>
        {(creation && creationSigned === false) ||
        (frozenDraft && seriesSigned === false) ? (
          <div className="flex flex-wrap gap-2">
            {frozenDraft ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || bannerBusy}
                onClick={() => void discardUnsigned(true)}
              >
                Edit saved draft
              </Button>
            ) : null}
            <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || bannerBusy}
                >
                  Discard draft and start new event
                </Button>
              </DialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Discard this unsigned draft?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The saved details will be removed from this browser. We
                    check for signed records again before discarding.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDiscardOpen(false)}
                  >
                    Keep draft
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void discardUnsigned()}
                  >
                    Discard draft
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
        {!authenticatedPubkey ? (
          <p className="text-sm text-[var(--text-muted)]">
            Connect the organizer signer to publish.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
