import type {
  SignedPublicNostrEvent,
  ExclusiveRelayPublishStatus,
} from "@conduit/core"

type FixturePublisher = (
  this: SignedPublicNostrEvent,
  relaySet: { relayUrls: Set<string> },
  timeoutMs: number
) => Promise<unknown>
const publishers = new Map<string, FixturePublisher>()
export const fixturePublisher = {
  publish: async function (
    _relaySet: { relayUrls: Set<string> },
    ..._args: [number]
  ): Promise<unknown> {
    void _args
    return new Set([..._relaySet.relayUrls].map((url) => ({ url })))
  },
}
export function setFixturePublisher(
  event: SignedPublicNostrEvent,
  publish: FixturePublisher
): void {
  publishers.set(event.id, publish)
}
export function plainFixtureEvent(
  _ndk: unknown,
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  return event
}
let queue: Array<{
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  timeoutMs: number
  resolve: (status: ExclusiveRelayPublishStatus) => void
}> = []
export function fixtureWrite(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  timeoutMs: number
}): Promise<ExclusiveRelayPublishStatus> {
  return new Promise((resolve) => {
    queue.push({ ...input, resolve })
    if (queue.length !== 1) return
    queueMicrotask(async () => {
      const pending = queue
      queue = []
      const groups = new Map<string, typeof pending>()
      for (const item of pending) {
        const key = item.signedEvent.id + ":" + item.timeoutMs
        groups.set(key, [...(groups.get(key) ?? []), item])
      }
      for (const group of groups.values()) {
        const { signedEvent, timeoutMs } = group[0]!
        let result: unknown
        try {
          result = await (
            publishers.get(signedEvent.id) ?? fixturePublisher.publish
          ).call(
            signedEvent,
            {
              relayUrls: new Set(
                group.map((item) => new URL(item.relayUrl).href)
              ),
            },
            timeoutMs
          )
        } catch (error) {
          result = error
        }
        const successes =
          result instanceof Set
            ? result
            : ((result as { publishedToRelays?: Set<{ url: string }> })
                ?.publishedToRelays ?? new Set())
        for (const item of group) {
          const accepted = [...successes].some(
            (r) =>
              new URL((r as { url: string }).url).href ===
              new URL(item.relayUrl).href
          )
          const errors = (result as { errors?: Map<{ url: string }, Error> })
            ?.errors
          const reason =
            errors &&
            [...errors].find(
              ([r]) => new URL(r.url).href === new URL(item.relayUrl).href
            )?.[1].message
          item.resolve(
            accepted || reason?.startsWith("duplicate:")
              ? "acked"
              : reason?.match(
                    /^(pow|blocked|rate-limited|invalid|restricted|mute|error):/
                  )
                ? "rejected"
                : "timed_out"
          )
        }
      }
    })
  })
}
export function resetFixturePublishers(): void {
  publishers.clear()
}
