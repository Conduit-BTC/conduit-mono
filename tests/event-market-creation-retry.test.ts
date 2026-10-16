import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  retryEventMarketRosterDelivery,
  retryEventMarketCalendarDelivery,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  loadFutureEventMarketCreation,
  publishFutureEventMarketCreation,
  saveNewFutureEventMarketCreation,
} from "../apps/merchant/src/lib/event-market-creation-retry"
import {
  createEmptyOrganizerEventMarketForm,
  fromStoredOrganizerEventForm,
  type OrganizerEventMarketFormValues,
} from "../apps/merchant/src/lib/event-market-form"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const otherOrganizer = getPublicKey(generateSecretKey())
const relay = "wss://relay.example"

function result(acknowledged: boolean): PublishWithPlannerResult {
  return {
    plan: {} as never,
    attemptedRelayUrls: [relay],
    successfulRelayUrls: acknowledged ? [relay] : [],
    failedRelayUrls: acknowledged ? [] : [relay],
    relayFailureMessages: acknowledged ? {} : { [relay]: "relay timeout" },
  }
}

function setup(overrides: Partial<OrganizerEventMarketFormValues> = {}) {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
  const form = {
    ...createEmptyOrganizerEventMarketForm(),
    title: "Future fair",
    summary: "A future public fair",
    imageUrl: "https://example.com/fair.jpg",
    eventLocation: "Public square",
    start: "2099-01-01T12:00",
    end: "2099-01-01T13:00",
    timezone: "UTC",
    ...overrides,
  }
  const creation = saveNewFutureEventMarketCreation(
    organizer,
    form,
    storage,
    () => "12345678-fixed"
  )
  const saved = new Map<string, SignedPublicNostrEvent>()
  const signed: SignedPublicNostrEvent[] = []
  const attempts: SignedPublicNostrEvent[] = []
  const acknowledgments = new Map<number, boolean>([
    [31922, true],
    [31923, true],
    [30409, true],
  ])
  let throwForKind: number | null = null
  const publish = async (event: SignedPublicNostrEvent) => {
    expect(structuredClone(saved.get(event.id))).toEqual(structuredClone(event))
    attempts.push(structuredClone(event))
    if (event.kind === throwForKind) throw new Error("Connection interrupted")
    return result(acknowledgments.get(event.kind) ?? false)
  }
  const read = async () => {
    const market = [...saved.values()].find((event) => event.kind === 30409)
    const admitted = market ? await admitPublicEvent(market) : undefined
    if (admitted && admitted.status !== "verified")
      throw new Error(`Fixture admission failed: ${admitted.status}`)
    return {
      coordinate: creation.marketCoordinate,
      resolution: market
        ? {
            state: "current" as const,
            market: parseEventMarketRosterEvent(admitted!.event)!,
          }
        : { state: "missing" as const },
      coverage: "complete" as const,
      retained: true,
      observedRelayUrls: [],
    }
  }
  const dependencies = {
    loadEvents: async () =>
      [...saved.values()].map((event) => structuredClone(event)),
    retain: async (_coordinate: string, event: SignedPublicNostrEvent) => {
      saved.set(event.id, structuredClone(event))
    },
    publishCalendar: async (
      input: Parameters<
        typeof import("@conduit/core").publishFutureEventMarketCalendar
      >[0]
    ) => {
      const event = finalizeEvent(
        { ...buildEventMarketCalendarDraft(input.calendar), created_at: 100 },
        secret
      )
      signed.push(structuredClone(event))
      await input.onSignedLocal(event)
      const delivery = await publish(event)
      if (!delivery.successfulRelayUrls.length)
        throw new Error(
          "The signed calendar was saved for retry but no relay acknowledged it."
        )
      return { signedEvent: event, delivery }
    },
    publishRoster: (input: Parameters<typeof publishEventMarketRoster>[0]) =>
      publishEventMarketRoster(input, {
        read,
        sign: async ({ draft, createdAt }) => {
          const event = finalizeEvent(
            { ...draft, created_at: createdAt },
            secret
          )
          signed.push(structuredClone(event))
          return event
        },
        publish,
      }),
    retryCalendar: (
      input: Parameters<typeof retryEventMarketCalendarDelivery>[0]
    ) => retryEventMarketCalendarDelivery(input, { publish }),
    retryRoster: (
      input: Parameters<typeof retryEventMarketRosterDelivery>[0]
    ) => retryEventMarketRosterDelivery(input, { read, publish }),
  }
  const run = () =>
    publishFutureEventMarketCreation(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        shouldContinue: () => true,
        storage,
      },
      dependencies
    )
  return {
    storage,
    form,
    creation,
    saved,
    signed,
    attempts,
    acknowledgments,
    dependencies,
    run,
    interrupt: (kind: number | null) => {
      throwForKind = kind
    },
  }
}

describe("durable future Event Market creation", () => {
  it.each(["2099-01-03", ""])(
    "preserves a legacy v1 all-day end %s and retries the exact signed calendar",
    async (end) => {
      const test = setup({
        calendarType: "date",
        start: "2099-01-01",
        end: "2099-01-01",
      })
      expect(test.creation.form.end).toBe("2099-01-02")
      const legacy = { ...test.creation, form: { ...test.creation.form, end } }
      test.storage.setItem(
        `conduit:future-event-market-creation:v1:${organizer}`,
        JSON.stringify(legacy)
      )
      const restored = loadFutureEventMarketCreation(organizer, test.storage)!
      expect(fromStoredOrganizerEventForm(restored.form).end).toBe(
        end ? "2099-01-02" : "2099-01-01"
      )
      test.acknowledgments.set(31922, false)
      await expect(test.run()).rejects.toThrow("saved for retry")
      const signedCalendar = test.signed.find((event) => event.kind === 31922)!
      expect(signedCalendar.tags.find((tag) => tag[0] === "end")?.[1]).toBe(
        end || undefined
      )
      test.acknowledgments.set(31922, true)
      await test.run()
      const attempts = test.attempts.filter((event) => event.kind === 31922)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect(test.signed.filter((event) => event.kind === 31922)).toHaveLength(
        1
      )
    }
  )

  it.each([31923, 30409])(
    "keeps the coordinate and exact signed IDs after kind %i zero ACK and reload",
    async (kind) => {
      const test = setup()
      test.acknowledgments.set(kind, false)
      await expect(test.run()).rejects.toThrow("saved for retry")
      const restored = loadFutureEventMarketCreation(organizer, test.storage)!
      expect(restored.marketCoordinate).toBe(test.creation.marketCoordinate)
      expect(restored.calendarEventId).toBe(test.signed[0]!.id)
      if (kind === 30409)
        expect(restored.marketEventId).toBe(test.signed[1]!.id)
      expect(() =>
        saveNewFutureEventMarketCreation(organizer, test.form, test.storage)
      ).toThrow("Retry the saved Event Market")
      test.acknowledgments.set(kind, true)
      const completed = await test.run()
      expect(completed.marketCoordinate).toBe(test.creation.marketCoordinate)
      expect(test.signed.map((event) => event.kind)).toEqual([31923, 30409])
      for (const event of test.signed) {
        expect(
          test.attempts.filter((attempt) => attempt.id === event.id).length
        ).toBe(event.kind === 31923 || kind === 30409 ? 2 : 1)
        expect(
          test.attempts.filter((attempt) => attempt.kind === event.kind)
        ).toEqual(
          test.attempts
            .filter((attempt) => attempt.kind === event.kind)
            .map(() => event)
        )
      }
      expect(loadFutureEventMarketCreation(organizer, test.storage)).toBeNull()
    }
  )

  it("retains a zero-ACK roster retry and never asks either signer again", async () => {
    const test = setup()
    test.acknowledgments.set(30409, false)
    await expect(test.run()).rejects.toThrow("saved for retry")
    const ids = test.signed.map((event) => event.id)
    await expect(test.run()).rejects.toThrow(
      "still needs a relay acknowledgment"
    )
    expect(test.signed.map((event) => event.id)).toEqual(ids)
    expect(
      loadFutureEventMarketCreation(organizer, test.storage)?.marketEventId
    ).toBe(ids[1])
  })

  it("does not sign a roster while the exact calendar retry has zero ACK", async () => {
    const test = setup()
    test.acknowledgments.set(31923, false)
    await expect(test.run()).rejects.toThrow("saved for retry")
    await expect(test.run()).rejects.toThrow(
      "still needs a relay acknowledgment"
    )
    expect(test.signed.map((event) => event.kind)).toEqual([31923])
    expect(test.attempts[1]).toEqual(test.signed[0])
    expect(
      loadFutureEventMarketCreation(organizer, test.storage)
    ).not.toBeNull()
  })

  it.each([31923, 30409])(
    "retries the same bytes after kind %i delivery throws",
    async (kind) => {
      const test = setup()
      test.interrupt(kind)
      await expect(test.run()).rejects.toThrow("Connection interrupted")
      const prior = [...test.signed]
      test.interrupt(null)
      await test.run()
      expect(test.signed).toHaveLength(2)
      for (const event of prior) {
        expect(
          test.attempts.filter((attempt) => attempt.kind === event.kind)
        ).toEqual([event, event])
      }
    }
  )

  it("recovers retained signed bytes if saving their pointer was interrupted", async () => {
    const test = setup()
    const setItem = test.storage.setItem
    test.storage.setItem = () => {
      throw new Error("Storage interrupted")
    }
    await expect(test.run()).rejects.toThrow("Storage interrupted")
    expect(test.saved.size).toBe(1)
    expect(test.attempts).toHaveLength(0)
    test.storage.setItem = setItem
    await test.run()
    expect(test.signed.map((event) => event.kind)).toEqual([31923, 30409])
    expect(test.attempts[0]).toEqual(test.signed[0])
  })

  it("blocks duplicate signing if the pinned signed evidence is missing", async () => {
    const test = setup()
    test.acknowledgments.set(30409, false)
    await expect(test.run()).rejects.toThrow("saved for retry")
    test.saved.clear()
    await expect(test.run()).rejects.toThrow(
      "exact saved Event Market signature"
    )
    expect(test.signed).toHaveLength(2)
  })

  it("scopes recovery to the organizer and stops a changed signer before delivery", async () => {
    const test = setup()
    expect(
      loadFutureEventMarketCreation(otherOrganizer, test.storage)
    ).toBeNull()
    await expect(
      publishFutureEventMarketCreation(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: otherOrganizer,
          shouldContinue: () => true,
          storage: test.storage,
        },
        test.dependencies
      )
    ).rejects.toThrow("authenticated organizer")
    await expect(
      publishFutureEventMarketCreation(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          shouldContinue: () => false,
          storage: test.storage,
        },
        test.dependencies
      )
    ).rejects.toThrow("session changed")
    expect(test.signed).toHaveLength(0)
    expect(test.attempts).toHaveLength(0)
  })
})
