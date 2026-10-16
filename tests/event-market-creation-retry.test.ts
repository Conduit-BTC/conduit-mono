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
  reviseFutureEventMarketCreation,
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
  const key = `conduit:future-event-market-creation:v1:${organizer}`

  it("restores and repairs an invalid unsigned v1 form using the same identity", async () => {
    const test = setup()
    const legacy = {
      ...test.creation,
      form: {
        ...test.creation.form,
        summary: "x".repeat(1_001),
        timezone: "invalid",
      },
    }
    test.storage.setItem(key, JSON.stringify(legacy))
    const restored = loadFutureEventMarketCreation(organizer, test.storage)!
    const revised = await reviseFutureEventMarketCreation(
      {
        creation: restored,
        form: {
          ...test.form,
          title: "Corrected fair",
          summary: "First paragraph\nSecond paragraph",
          timezone: "America/New_York",
          imageUrl: "https://example.com/new.jpg",
        },
        shouldContinue: () => true,
        storage: test.storage,
      },
      test.dependencies
    )
    expect(revised?.marketCoordinate).toBe(restored.marketCoordinate)
    expect(revised?.calendarCoordinate).toBe(restored.calendarCoordinate)
    await test.run()
    expect(test.signed.map((event) => event.kind)).toEqual([31923, 30409])
    expect(test.signed[0]?.content).toBe("First paragraph\nSecond paragraph")
    expect(test.signed[0]?.tags).toContainEqual(["title", "Corrected fair"])
  })

  it("discards only an unsigned plan and permits a deliberate new creation", async () => {
    const test = setup()
    await reviseFutureEventMarketCreation(
      {
        creation: test.creation,
        shouldContinue: () => true,
        storage: test.storage,
      },
      test.dependencies
    )
    expect(loadFutureEventMarketCreation(organizer, test.storage)).toBeNull()
    const next = saveNewFutureEventMarketCreation(
      organizer,
      test.form,
      test.storage,
      () => "87654321-new"
    )
    expect(next.marketCoordinate === test.creation.marketCoordinate).toBe(false)
    expect(test.signed.length).toBe(0)
  })

  it("preflights non-description calendar constraints before saving any pointer", async () => {
    const test = setup()
    await reviseFutureEventMarketCreation(
      {
        creation: test.creation,
        shouldContinue: () => true,
        storage: test.storage,
      },
      test.dependencies
    )
    let message = ""
    try {
      saveNewFutureEventMarketCreation(
        organizer,
        { ...test.form, title: "x".repeat(201) },
        test.storage
      )
    } catch (cause) {
      message = (cause as Error).message
    }
    expect(message).toContain("Calendar title")
    expect(loadFutureEventMarketCreation(organizer, test.storage)).toBeNull()
  })

  it("refuses draft repair when signature retention succeeded but pointer saving failed", async () => {
    const test = setup()
    const setItem = test.storage.setItem
    test.storage.setItem = () => {
      throw new Error("Storage interrupted")
    }
    await expect(test.run()).rejects.toThrow("Storage interrupted")
    test.storage.setItem = setItem
    const before = test.storage.getItem(key)
    for (const form of [undefined, test.form]) {
      await expect(
        reviseFutureEventMarketCreation(
          {
            creation: test.creation,
            form,
            shouldContinue: () => true,
            storage: test.storage,
          },
          test.dependencies
        )
      ).rejects.toThrow("Signed records")
      expect(test.storage.getItem(key) === before).toBe(true)
    }
    await test.run()
    expect(test.signed.length).toBe(2)
  })

  it("keeps pinned missing signatures and unavailable storage outside unsigned recovery", async () => {
    const test = setup()
    const before = test.storage.getItem(key)
    await expect(
      reviseFutureEventMarketCreation(
        {
          creation: test.creation,
          shouldContinue: () => true,
          storage: test.storage,
        },
        {
          loadEvents: async () => {
            throw new Error("Evidence unavailable")
          },
        }
      )
    ).rejects.toThrow("Evidence unavailable")
    expect(test.storage.getItem(key) === before).toBe(true)
    const pinned = { ...test.creation, calendarEventId: "a".repeat(64) }
    test.storage.setItem(key, JSON.stringify(pinned))
    await expect(
      reviseFutureEventMarketCreation(
        { creation: pinned, shouldContinue: () => true, storage: test.storage },
        test.dependencies
      )
    ).rejects.toThrow("Signed records")
    expect(
      loadFutureEventMarketCreation(organizer, test.storage)?.calendarEventId
    ).toBe(pinned.calendarEventId)
  })

  it("fences stale tabs and account changes during unsigned repair", async () => {
    const test = setup()
    const revised = await reviseFutureEventMarketCreation(
      {
        creation: test.creation,
        form: { ...test.form, title: "Newer details" },
        shouldContinue: () => true,
        storage: test.storage,
      },
      test.dependencies
    )
    await expect(
      reviseFutureEventMarketCreation(
        {
          creation: test.creation,
          shouldContinue: () => true,
          storage: test.storage,
        },
        test.dependencies
      )
    ).rejects.toThrow("another tab")
    let current = true
    await expect(
      reviseFutureEventMarketCreation(
        {
          creation: revised!,
          shouldContinue: () => current,
          storage: test.storage,
        },
        {
          loadEvents: async () => {
            current = false
            return []
          },
        }
      )
    ).rejects.toThrow("session changed")
    expect(
      loadFutureEventMarketCreation(organizer, test.storage)?.form.title
    ).toBe("Newer details")
  })

  it("serializes signing against discard and rechecks retained evidence after waiting", async () => {
    const test = setup()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const publishCalendar = test.dependencies.publishCalendar
    test.dependencies.publishCalendar = async (input) => {
      entered()
      await hold
      return publishCalendar(input)
    }
    test.acknowledgments.set(31923, false)
    const publication = test.run().catch(() => undefined)
    await started
    const discard = reviseFutureEventMarketCreation(
      {
        creation: test.creation,
        shouldContinue: () => true,
        storage: test.storage,
      },
      test.dependencies
    )
    release()
    await publication
    await expect(discard).rejects.toThrow("another tab")
    expect(test.signed.length).toBe(1)
    expect(
      loadFutureEventMarketCreation(organizer, test.storage)
        ?.calendarEventId === test.signed[0]?.id
    ).toBe(true)
  })

  it("serializes simultaneous retries without creating another signed calendar", async () => {
    const test = setup()
    test.acknowledgments.set(31923, false)
    await Promise.allSettled([test.run(), test.run()])
    expect(test.signed.length).toBe(1)
    expect(test.attempts.length).toBe(2)
    expect(test.attempts[0]?.id === test.attempts[1]?.id).toBe(true)
  })

  it("retries signed bytes despite invalid legacy form text without re-signing", async () => {
    const test = setup()
    test.acknowledgments.set(31923, false)
    await expect(test.run()).rejects.toThrow("saved for retry")
    const saved = loadFutureEventMarketCreation(organizer, test.storage)!
    test.storage.setItem(
      key,
      JSON.stringify({
        ...saved,
        form: {
          ...saved.form,
          summary: "x".repeat(1_001),
          timezone: "invalid",
        },
      })
    )
    test.acknowledgments.set(31923, true)
    await test.run()
    expect(test.signed.length).toBe(2)
    expect(test.attempts[0]?.id === test.attempts[1]?.id).toBe(true)
  })

  it.each(["x".repeat(1_001), "Public\u0000fair"])(
    "rejects invalid calendar text before saving a creation",
    (summary) => {
      let message = ""
      try {
        setup({ summary })
      } catch (cause) {
        message = (cause as Error).message
      }
      expect(message).toContain("Description")
    }
  )

  it("publishes a short multiline description without trapping an unsigned draft", async () => {
    const test = setup({ summary: "Public fair\nBring friends" })
    await test.run()
    expect(test.signed[0]?.content).toBe("Public fair\nBring friends")
    expect(loadFutureEventMarketCreation(organizer, test.storage)).toBeNull()
  })

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
