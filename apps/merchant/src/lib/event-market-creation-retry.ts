import {
  parseEventMarketCalendarEvent,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  publishFutureEventMarketCalendar,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  retryOrganizerEventMarketRecord,
  type EventMarketCalendarDraftInput,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { db } from "@conduit/core/db"
import {
  createEmptyOrganizerEventMarketForm,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
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
  const prepared = prepareOrganizerEventMarketForm(creation.form).calendar
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
    const calendar = calendarForCreation(creation)
    if (
      creation.calendarCoordinate !==
      `${calendar.kind}:${organizerPubkey}:${calendar.dTag}`
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
    form: { ...form },
  }
  storage.setItem(storageKey(organizerPubkey), JSON.stringify(creation))
  return creation
}

interface CreationDependencies {
  loadEvents: (coordinate: string) => Promise<SignedPublicNostrEvent[]>
  retain: typeof retainSignedEventMarketEvidence
  publishCalendar: typeof publishFutureEventMarketCalendar
  publishRoster: typeof publishEventMarketRoster
  retryCalendar: typeof retryOrganizerEventMarketRecord
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
  retryCalendar: retryOrganizerEventMarketRecord,
  retryRoster: retryEventMarketRosterDelivery,
}

/** Resume missing signatures and retry saved signatures without minting revisions. */
export async function publishFutureEventMarketCreation(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    shouldContinue: () => boolean
    onSaved?: (creation: FutureEventMarketCreation) => void
    onStep?: (step: string) => void
    storage?: CreationStorage
  },
  dependencies: CreationDependencies = defaultDependencies
): Promise<{ marketCoordinate: string; successfulRelayUrls: string[] }> {
  const storage = input.storage ?? browserStorage()
  let creation = loadFutureEventMarketCreation(input.organizerPubkey, storage)
  if (!creation || input.authenticatedPubkey !== creation.organizerPubkey)
    throw new Error(
      "The authenticated organizer and saved creation are required."
    )
  const activeCreation = creation
  function assertCurrent(): void {
    if (!input.shouldContinue()) throw new Error("Organizer session changed.")
  }
  assertCurrent()
  const events = await dependencies.loadEvents(creation.marketCoordinate)
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
    if (result.delivery.acknowledgedRelayUrls.length === 0)
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
