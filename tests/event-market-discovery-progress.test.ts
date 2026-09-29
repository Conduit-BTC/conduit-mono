import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  discoverFutureEventMarkets,
  type FutureEventMarketDiscoveryResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  deferred,
  until,
  fixture,
} from "./helpers/future-market-discovery-fixture"

describe("progressive current Event Market discovery", () => {
  it("paints a completed signed event while another organizer is held", async () => {
    const state = fixture(),
      held = deferred<void>(),
      progress: FutureEventMarketDiscoveryResult[] = []
    const plan = state.dependencies.plan
    state.dependencies.plan = async (input) => {
      if (input.organizerPubkey === state.records[1]!.author) await held.promise
      return plan(input)
    }
    let settled = false
    const result = discoverFutureEventMarkets(
      {
        organizerPubkeys: state.records.map((record) => record.author),
        onProgress: (value) => progress.push(value),
      },
      state.dependencies
    ).then((value) => {
      settled = true
      return value
    })
    await until(() =>
      progress.some((value) =>
        value.markets.some(
          (read) =>
            read.coordinate === state.records[0]!.coordinate && read.calendar
        )
      )
    )
    expect(settled).toBe(false)
    expect(progress.every((value) => value.coverage === "partial")).toBe(true)
    held.resolve()
    expect((await result).markets).toHaveLength(2)
    expect((await result).coverage).toBe("complete")
  })
  it("bounds organizer plans to four and starts queued authors after a slot frees", async () => {
    const state = fixture(7),
      held = deferred<void>()
    const plan = state.dependencies.plan
    let active = 0,
      max = 0,
      started = 0
    state.dependencies.plan = async (input) => {
      active++
      max = Math.max(max, active)
      started++
      await held.promise
      active--
      return plan(input)
    }
    const result = discoverFutureEventMarkets(
      { organizerPubkeys: state.records.map((record) => record.author) },
      state.dependencies
    )
    await until(() => started === 4)
    expect(max).toBe(4)
    held.resolve()
    expect((await result).markets).toHaveLength(7)
    expect(max).toBe(4)
  })
  it("shows retained signed dates before relay planning without turning them into fresh evidence", async () => {
    const state = fixture(1),
      held = deferred<void>(),
      progress: FutureEventMarketDiscoveryResult[] = []
    const record = state.records[0]!
    state.retained.set(record.coordinate, [record.roster, record.calendar])
    state.dependencies.loadDiscovered = async () => [record.roster]
    const plan = state.dependencies.plan
    state.dependencies.plan = async (input) => {
      await held.promise
      return plan(input)
    }
    const result = discoverFutureEventMarkets(
      {
        organizerPubkeys: [record.author],
        onProgress: (value) => progress.push(value),
      },
      state.dependencies
    )
    await until(() => progress.some((value) => value.markets[0]?.calendar))
    expect(progress[0]?.markets[0]?.coverage).not.toBe("complete")
    expect(progress[0]?.markets[0]?.calendarCoverage).not.toBe("complete")
    held.resolve()
    expect((await result).coverage).toBe("complete")
  })
  it("cannot resurrect a live deletion when an older cache inventory finishes late", async () => {
    const state = fixture(1),
      held = deferred<SignedPublicNostrEvent[]>(),
      progress: FutureEventMarketDiscoveryResult[] = []
    const record = state.records[0]!
    state.retained.set(record.coordinate, [record.roster, record.calendar])
    const deletion = finalizeEvent(
      {
        kind: 5,
        tags: [["a", record.coordinate]],
        content: "",
        created_at: 101,
      },
      record.secret
    )
    state.live.push(deletion)
    state.dependencies.loadDiscovered = () => held.promise
    const result = discoverFutureEventMarkets(
      {
        organizerPubkeys: [record.author],
        onProgress: (value) => progress.push(value),
      },
      state.dependencies
    )
    await until(() =>
      progress.some((value) => value.markets[0]?.resolution.state === "deleted")
    )
    held.resolve([record.roster])
    const final = await result
    expect(final.markets[0]?.resolution.state).toBe("deleted")
    expect(
      progress.every(
        (value) => value.markets[0]?.resolution.state !== "current"
      )
    ).toBe(true)
  })
  it("revalidates a warm-cache read when broad discovery observes a newer signed roster", async () => {
    const state = fixture(1),
      record = state.records[0]!
    const broadHeld = deferred<void>(),
      exactHeld = deferred<void>()
    state.retained.set(record.coordinate, [record.roster, record.calendar])
    state.dependencies.loadDiscovered = async () => [record.roster]
    const fetch = state.dependencies.fetch
    let exactStarted = false,
      holdExact = true
    state.dependencies.fetch = async (filter, options) => {
      if (filter.kinds?.includes(30409 as never) && !filter["#d"])
        await broadHeld.promise
      if (filter.kinds?.includes(30409 as never) && filter["#d"] && holdExact) {
        holdExact = false
        const older = await fetch(filter, options)
        exactStarted = true
        await exactHeld.promise
        return older
      }
      return fetch(filter, options)
    }
    const result = discoverFutureEventMarkets(
      { organizerPubkeys: [record.author] },
      state.dependencies
    )
    await until(() => exactStarted)
    const closed = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          organizerPubkey: record.author,
          dTag: "fair-0",
          calendarCoordinate: `31923:${record.author}:date-0`,
          state: "closed",
          merchants: [],
          previousEventId: record.roster.id,
        }),
        created_at: 101,
      },
      record.secret
    )
    state.live.push(closed)
    broadHeld.resolve()
    await until(
      () =>
        state.retained
          .get(record.coordinate)
          ?.some((event) => event.id === closed.id) ?? false
    )
    exactHeld.resolve()
    const final = await result
    expect(final.markets[0]?.resolution).toMatchObject({
      state: "current",
      market: { eventId: closed.id, state: "closed" },
    })
  })
  it("keeps healthy signed rows with a failed optional organizer and reports unavailable all-source failure", async () => {
    const state = fixture(),
      fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      if (filter.authors?.includes(state.records[1]!.author))
        throw new Error("offline")
      return fetch(filter, options)
    }
    const result = await discoverFutureEventMarkets(
      { organizerPubkeys: state.records.map((record) => record.author) },
      state.dependencies
    )
    expect(result.markets).toHaveLength(1)
    expect(result.coverage).toBe("partial")
    state.dependencies.fetch = async () => {
      throw new Error("offline")
    }
    expect(
      (
        await discoverFutureEventMarkets(
          { organizerPubkeys: [state.records[1]!.author] },
          state.dependencies
        )
      ).coverage
    ).toBe("unavailable")
  })
  it("reports bounded author coverage after deduplication without reading a 65th author", async () => {
    const state = fixture(65),
      plan = state.dependencies.plan,
      planned = new Set<string>()
    state.dependencies.plan = async (input) => {
      planned.add(input.organizerPubkey)
      return plan(input)
    }
    const result = await discoverFutureEventMarkets(
      { organizerPubkeys: state.records.map((record) => record.author) },
      state.dependencies
    )
    expect(planned.size).toBe(64)
    expect(planned.has(state.records[64]!.author)).toBe(false)
    expect(result.markets).toHaveLength(64)
    expect(result.coverage).toBe("partial")
    const single = fixture(1)
    expect(
      (
        await discoverFutureEventMarkets(
          { organizerPubkeys: Array(65).fill(single.records[0]!.author) },
          single.dependencies
        )
      ).coverage
    ).toBe("complete")
  })
  it("reports saturated cached coordinate coverage and never starts a 129th exact read", async () => {
    const state = fixture(1),
      record = state.records[0]!
    const cached = Array.from({ length: 129 }, (_, index) =>
      finalizeEvent(
        {
          ...buildEventMarketRosterDraft({
            organizerPubkey: record.author,
            dTag: `cached-${index}`,
            calendarCoordinate: `31923:${record.author}:date-0`,
            state: "open",
            merchants: [],
          }),
          created_at: 100,
        },
        record.secret
      )
    )
    state.dependencies.loadDiscovered = async () => cached
    state.live.splice(0, state.live.length, record.calendar, ...cached)
    for (const event of cached)
      state.retained.set(
        `30409:${record.author}:${event.tags.find((tag) => tag[0] === "d")![1]}`,
        [event, record.calendar]
      )
    const fetch = state.dependencies.fetch,
      exact = new Set<string>()
    state.dependencies.fetch = async (filter, options) => {
      if (filter.kinds?.includes(30409 as never) && !filter["#d"])
        return {
          events: [],
          relays: [{ relayUrl: "wss://relay.example", status: "success" }],
        }
      if (filter.kinds?.includes(30409 as never) && filter["#d"])
        exact.add(filter["#d"]![0]!)
      return fetch(filter, options)
    }
    const result = await discoverFutureEventMarkets(
      { organizerPubkeys: [record.author] },
      state.dependencies
    )
    expect(exact.size).toBe(128)
    expect(result.markets).toHaveLength(128)
    expect(result.coverage).toBe("partial")
  })
  it("stops queued work and progress after caller cancellation", async () => {
    const state = fixture(7),
      held = deferred<void>(),
      plan = state.dependencies.plan
    let active = true,
      plans = 0,
      progress = 0
    state.dependencies.plan = async (input) => {
      plans++
      await held.promise
      return plan(input)
    }
    const result = discoverFutureEventMarkets(
      {
        organizerPubkeys: state.records.map((record) => record.author),
        shouldContinue: () => active,
        onProgress: () => {
          progress++
        },
      },
      state.dependencies
    )
    await until(() => plans === 4)
    active = false
    held.resolve()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(plans).toBe(4)
    expect(progress).toBe(0)
  })
})
