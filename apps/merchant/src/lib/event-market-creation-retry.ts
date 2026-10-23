import {
  buildEventMarketCalendarDraft,
  parseEventMarketCalendarEvent,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  publishFutureEventMarketCalendar,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  retryEventMarketCalendarDelivery,
  admitPublicEvent,
  type VerifiedNostrEvent,
  type EventMarketCalendarDraftInput,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { db } from "@conduit/core/db"
import {
  createEmptyOrganizerEventMarketForm,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  toStoredOrganizerEventForm,
  type OrganizerEventMarketFormValues,
} from "./event-market-form"

export interface FutureEventMarketCreation {
  version: 1
  organizerPubkey: string
  dTag: string
  marketCoordinate: string
  calendarCoordinate: string
  form: OrganizerEventMarketFormValues
  calendarEventId?: string
  marketEventId?: string
}

type CreationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function browserStorage(): CreationStorage {
  if (typeof localStorage === "undefined")
    throw new Error("Local storage is required to save Event Market creation.")
  return localStorage
}

function storageKey(organizerPubkey: string): string {
  return `conduit:future-event-market-creation:v1:${organizerPubkey}`
}

function calendarForCreation(
  creation: FutureEventMarketCreation
): EventMarketCalendarDraftInput {
  const prepared = prepareOrganizerEventMarketForm(creation.form, {
    endDateIsExclusive: true,
  }).calendar
  const common = {
    dTag: `${creation.dTag}-calendar`,
    title: prepared.title,
    summary: prepared.summary,
    image: prepared.imageUrl,
    locations: [prepared.location],
    geohash: prepared.geohash,
  }
  return prepared.kind === 31922
    ? {
        ...common,
        kind: 31922,
        start: prepared.start as string,
        end: prepared.end as string | undefined,
      }
    : {
        ...common,
        kind: 31923,
        start: prepared.start as number,
        end: prepared.end as number | undefined,
        startTzid: prepared.timezone,
        endTzid: prepared.timezone,
      }
}

/** Only the creation pointer/form lives here; signed bytes stay in core evidence. */
export function loadFutureEventMarketCreation(
  organizerPubkey: string,
  storage: CreationStorage = browserStorage()
): FutureEventMarketCreation | null {
  const raw = storage.getItem(storageKey(organizerPubkey))
  if (!raw) return null
  try {
    const creation = JSON.parse(raw) as FutureEventMarketCreation
    const emptyForm = createEmptyOrganizerEventMarketForm()
    if (
      creation.version !== 1 ||
      creation.organizerPubkey !== organizerPubkey ||
      !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
      typeof creation.dTag !== "string" ||
      !creation.dTag ||
      creation.marketCoordinate !==
        `30409:${organizerPubkey}:${creation.dTag}` ||
      !creation.form ||
      (creation.form.calendarType !== "timed" &&
        creation.form.calendarType !== "date") ||
      Object.keys(emptyForm).some(
        (key) =>
          typeof creation.form[key as keyof OrganizerEventMarketFormValues] !==
          typeof emptyForm[key as keyof OrganizerEventMarketFormValues]
      ) ||
      [creation.calendarEventId, creation.marketEventId].some(
        (id) => id !== undefined && !/^[0-9a-f]{64}$/.test(id)
      )
    )
      throw new Error("Invalid saved creation.")
    if (
      creation.calendarCoordinate !==
      `${creation.form.calendarType === "date" ? 31922 : 31923}:${organizerPubkey}:${creation.dTag}-calendar`
    )
      throw new Error("Invalid saved calendar coordinate.")
    return creation
  } catch {
    throw new Error(
      "The saved Event Market creation needs review before retry."
    )
  }
}

/** Save a stable coordinate before requesting the first signature. */
export function saveNewFutureEventMarketCreation(
  organizerPubkey: string,
  form: OrganizerEventMarketFormValues,
  storage: CreationStorage = browserStorage(),
  randomId: () => string = () => crypto.randomUUID()
): FutureEventMarketCreation {
  if (!/^[0-9a-f]{64}$/.test(organizerPubkey))
    throw new Error("The authenticated organizer is required.")
  if (loadFutureEventMarketCreation(organizerPubkey, storage))
    throw new Error("Retry the saved Event Market before creating another.")
  const prepared = prepareOrganizerEventMarketForm(form, {
    requireFutureStart: true,
  })
  const dTag = `${slugifyEventMarketTitle(form.title) || "event"}-${randomId().slice(0, 8)}`
  const creation: FutureEventMarketCreation = {
    version: 1,
    organizerPubkey,
    dTag,
    marketCoordinate: `30409:${organizerPubkey}:${dTag}`,
    calendarCoordinate: `${prepared.calendar.kind}:${organizerPubkey}:${dTag}-calendar`,
    form: toStoredOrganizerEventForm(form),
  }
  // Validate the actual wire draft before a saved pointer can freeze the form.
  buildEventMarketCalendarDraft(calendarForCreation(creation))
  storage.setItem(storageKey(organizerPubkey), JSON.stringify(creation))
  return creation
}

interface CreationDependencies {
  loadEvents: (coordinate: string) => Promise<SignedPublicNostrEvent[]>
  retain: typeof retainSignedEventMarketEvidence
  publishCalendar: typeof publishFutureEventMarketCalendar
  publishRoster: typeof publishEventMarketRoster
  retryCalendar: typeof retryEventMarketCalendarDelivery
  retryRoster: typeof retryEventMarketRosterDelivery
}

const defaultDependencies: CreationDependencies = {
  loadEvents: async (coordinate) =>
    (
      await db.eventMarketRosterEvidence
        .where("marketCoordinate")
        .equals(coordinate)
        .toArray()
    ).map((row) => row.signedEvent),
  retain: retainSignedEventMarketEvidence,
  publishCalendar: publishFutureEventMarketCalendar,
  publishRoster: publishEventMarketRoster,
  retryCalendar: retryEventMarketCalendarDelivery,
  retryRoster: retryEventMarketRosterDelivery,
}

const creationLocks = new Map<string, Promise<unknown>>()

/** Signing, retry and unsigned-draft repair share one account-scoped lock. */
export async function withFutureEventMarketCreationLock<T>(
  organizerPubkey: string,
  task: () => Promise<T>
): Promise<T> {
  const name = `conduit:event-market-creation:${organizerPubkey}`
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock)
        throw new Error(
          "Another tab is finishing this Event Market. Wait for it before continuing."
        )
      return task()
    })
  if (typeof window !== "undefined")
    throw new Error(
      "This browser cannot safely coordinate saved creation. Use a browser with Web Locks support."
    )
  // Non-browser callers (including deterministic tests) still serialize work.
  const previous = creationLocks.get(name) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  creationLocks.set(name, next)
  try {
    return await next
  } finally {
    if (creationLocks.get(name) === next) creationLocks.delete(name)
  }
}

export async function isFutureEventMarketCreationSigned(
  creation: FutureEventMarketCreation,
  dependencies: Pick<CreationDependencies, "loadEvents"> = defaultDependencies
): Promise<boolean> {
  // A missing pointer does not prove unsigned: retention precedes pointer save.
  return Boolean(
    creation.calendarEventId ||
    creation.marketEventId ||
    (await dependencies.loadEvents(creation.marketCoordinate)).length
  )
}

/** Only unsigned plans may change or be discarded; retained bytes are untouched. */
export async function reviseFutureEventMarketCreation(
  input: {
    creation: FutureEventMarketCreation
    /** Omit to discard the unsigned plan. */
    form?: OrganizerEventMarketFormValues
    shouldContinue: () => boolean
    storage?: CreationStorage
  },
  dependencies: Pick<CreationDependencies, "loadEvents"> = defaultDependencies
): Promise<FutureEventMarketCreation | null> {
  return withFutureEventMarketCreationLock(
    input.creation.organizerPubkey,
    async () => {
      const storage = input.storage ?? browserStorage()
      const current = loadFutureEventMarketCreation(
        input.creation.organizerPubkey,
        storage
      )
      const assertCurrent = () => {
        if (!input.shouldContinue())
          throw new Error("Organizer session changed.")
        if (
          JSON.stringify(
            loadFutureEventMarketCreation(
              input.creation.organizerPubkey,
              storage
            )
          ) !== JSON.stringify(input.creation)
        )
          throw new Error(
            "The saved creation changed in another tab. Reload before continuing."
          )
      }
      assertCurrent()
      if (
        !current ||
        (await isFutureEventMarketCreationSigned(current, dependencies))
      )
        throw new Error(
          "Signed records may already be public. Finish publishing the saved event before editing or starting another."
        )
      assertCurrent()
      if (!input.form) {
        storage.removeItem(storageKey(current.organizerPubkey))
        return null
      }
      const prepared = prepareOrganizerEventMarketForm(input.form, {
        requireFutureStart: true,
      })
      const revised = {
        ...current,
        form: toStoredOrganizerEventForm(input.form),
        calendarCoordinate: `${prepared.calendar.kind}:${current.organizerPubkey}:${current.dTag}-calendar`,
      }
      buildEventMarketCalendarDraft(calendarForCreation(revised))
      storage.setItem(
        storageKey(current.organizerPubkey),
        JSON.stringify(revised)
      )
      return revised
    }
  )
}

/** Resume missing signatures and retry saved signatures without minting revisions. */
async function publishFutureEventMarketCreationUnlocked(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    shouldContinue: () => boolean
    onSaved?: (creation: FutureEventMarketCreation) => void
    onStep?: (step: string) => void
    storage?: CreationStorage
    expectedCreation?: FutureEventMarketCreation
  },
  dependencies: CreationDependencies = defaultDependencies
): Promise<{ marketCoordinate: string; successfulRelayUrls: string[] }> {
  const storage = input.storage ?? browserStorage()
  let creation = loadFutureEventMarketCreation(input.organizerPubkey, storage)
  if (
    input.expectedCreation &&
    JSON.stringify(creation) !== JSON.stringify(input.expectedCreation)
  )
    throw new Error(
      "The saved creation changed in another tab. Reload before continuing."
    )
  if (!creation || input.authenticatedPubkey !== creation.organizerPubkey)
    throw new Error(
      "The authenticated organizer and saved creation are required."
    )
  const activeCreation = creation
  function assertCurrent(): void {
    if (!input.shouldContinue()) throw new Error("Organizer session changed.")
  }
  assertCurrent()
  const loadedEvents = await dependencies.loadEvents(creation.marketCoordinate)
  const events: VerifiedNostrEvent[] = []
  for (let offset = 0; offset < loadedEvents.length; offset += 64) {
    assertCurrent()
    const admissions = await Promise.all(
      loadedEvents
        .slice(offset, offset + 64)
        .map((event) => admitPublicEvent(event))
    )
    assertCurrent()
    for (const admission of admissions) {
      if (admission.status === "verified") events.push(admission.event)
      else if (admission.status === "unavailable")
        throw new Error(
          "Saved Event Market signature verification is unavailable."
        )
      else if (admission.status === "cancelled")
        throw new Error("Organizer session changed.")
    }
  }
  function savedEvent(record: "calendar" | "market") {
    const id =
      record === "calendar"
        ? activeCreation.calendarEventId
        : activeCreation.marketEventId
    const coordinate =
      record === "calendar"
        ? activeCreation.calendarCoordinate
        : activeCreation.marketCoordinate
    const candidates = events.filter((event) => {
      const parsed =
        record === "calendar"
          ? parseEventMarketCalendarEvent(event)
          : parseEventMarketRosterEvent(event)
      return parsed?.coordinate === coordinate && (!id || event.id === id)
    })
    if ((id && candidates.length !== 1) || candidates.length > 1)
      throw new Error("The exact saved Event Market signature needs review.")
    return candidates[0]
  }
  async function saveSigned(
    record: "calendar" | "market",
    event: SignedPublicNostrEvent
  ): Promise<void> {
    assertCurrent()
    await dependencies.retain(activeCreation.marketCoordinate, event)
    creation = {
      ...creation!,
      ...(record === "calendar"
        ? { calendarEventId: event.id }
        : { marketEventId: event.id }),
    }
    storage.setItem(storageKey(input.organizerPubkey), JSON.stringify(creation))
    input.onSaved?.(creation)
  }

  const calendar = savedEvent("calendar")
  assertCurrent()
  input.onStep?.("Publishing saved calendar…")
  if (calendar) {
    await saveSigned("calendar", calendar)
    const result = await dependencies.retryCalendar({
      organizerPubkey: input.organizerPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      signedEvent: calendar,
      shouldContinue: input.shouldContinue,
    })
    if (result.successfulRelayUrls.length === 0)
      throw new Error("The saved calendar still needs a relay acknowledgment.")
  } else {
    const result = await dependencies.publishCalendar({
      organizerPubkey: input.organizerPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      calendar: calendarForCreation(activeCreation),
      shouldContinue: input.shouldContinue,
      onSignedLocal: (event) => saveSigned("calendar", event),
    })
    if (result.delivery.successfulRelayUrls.length === 0)
      throw new Error("The saved calendar still needs a relay acknowledgment.")
  }

  const roster = savedEvent("market")
  assertCurrent()
  input.onStep?.("Publishing saved Event Market…")
  if (roster) await saveSigned("market", roster)
  const delivery = roster
    ? await dependencies.retryRoster({
        authenticatedPubkey: input.authenticatedPubkey,
        signedEvent: roster,
        shouldContinue: input.shouldContinue,
      })
    : (
        await dependencies.publishRoster({
          organizerPubkey: input.organizerPubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          dTag: activeCreation.dTag,
          calendarCoordinate: activeCreation.calendarCoordinate,
          state: "open",
          merchants: [],
          shouldContinue: input.shouldContinue,
          onSignedLocal: (event) => saveSigned("market", event),
        })
      ).delivery
  if (delivery.successfulRelayUrls.length === 0)
    throw new Error(
      "The saved Event Market still needs a relay acknowledgment."
    )
  assertCurrent()
  storage.removeItem(storageKey(input.organizerPubkey))
  return {
    marketCoordinate: activeCreation.marketCoordinate,
    successfulRelayUrls: delivery.successfulRelayUrls,
  }
}

export function publishFutureEventMarketCreation(
  input: Parameters<typeof publishFutureEventMarketCreationUnlocked>[0],
  dependencies: CreationDependencies = defaultDependencies
): ReturnType<typeof publishFutureEventMarketCreationUnlocked> {
  return withFutureEventMarketCreationLock(input.organizerPubkey, () =>
    publishFutureEventMarketCreationUnlocked(input, dependencies)
  )
}
