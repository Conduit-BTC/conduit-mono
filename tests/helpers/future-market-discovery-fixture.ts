import { expect } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { matchFilter, type Filter } from "nostr-tools"
import {
  buildEventMarketRosterDraft,
  discoverFutureEventMarkets,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
export async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(check()).toBe(true)
}
const relay = "wss://relay.example"
export function fixture(count = 2) {
  const records = Array.from({ length: count }, (_, index) => {
    const secret = generateSecretKey(),
      author = getPublicKey(secret)
    const coordinate = `30409:${author}:fair-${index}`,
      calendarCoordinate = `31923:${author}:date-${index}`
    const roster = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          organizerPubkey: author,
          dTag: `fair-${index}`,
          calendarCoordinate,
          state: "open",
          merchants: [],
        }),
        created_at: 100,
      },
      secret
    )
    const calendar = finalizeEvent(
      {
        kind: 31923,
        tags: [
          ["d", `date-${index}`],
          ["title", `Fair ${index}`],
          ["start", "4070952000"],
          ["D", String(Math.floor(4070952000 / 86400))],
        ],
        content: "",
        created_at: 100,
      },
      secret
    )
    return { secret, author, coordinate, roster, calendar }
  })
  const live: SignedPublicNostrEvent[] = records.flatMap((record) => [
    record.roster,
    record.calendar,
  ])
  const retained = new Map<string, SignedPublicNostrEvent[]>()
  const dependencies: NonNullable<
    Parameters<typeof discoverFutureEventMarkets>[1]
  > = {
    plan: async () => ({
      relayUrls: [relay],
      candidateRelayUrls: [relay],
      ownerSelectedRelayUrls: [],
      appRelayUrls: [relay],
      personalRelayUrls: [],
      independentRelayUrls: [],
      relayListState: "missing",
      relayHintTruncated: false,
    }),
    fetch: async (filter) => ({
      events: live.filter((event) => matchFilter(filter as Filter, event)),
      relays: [{ relayUrl: relay, status: "success" }],
    }),
    load: async (coordinate) => retained.get(coordinate) ?? [],
    retain: async (coordinate, events) =>
      retained.set(coordinate, [
        ...new Map(
          [...(retained.get(coordinate) ?? []), ...events].map((event) => [
            event.id,
            event,
          ])
        ).values(),
      ]),
  }
  return { records, live, retained, dependencies }
}
