import { afterEach, describe, expect, it } from "bun:test"
import NDK, { NDKEvent, type NDKRelay } from "@nostr-dev-kit/ndk"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetRelayPublishTestOverrides,
  __resetRelayHealth,
  __setRelayPublishTestOverrides,
  EVENT_KINDS,
  getRelayHealth,
  emptyAccountNetworkLocalState,
  publishWithPlannerProgressive,
  type AccountNetworkLocalStateRepository,
  type ExactRelayWriteStatus,
} from "@conduit/core"

const WRAP_SECRET = Uint8Array.from([...new Uint8Array(31), 33])
const FAST_RELAY = "wss://fast-progressive.example"
const SLOW_RELAY = "wss://slow-progressive.example"

function giftWrapEvent(): NDKEvent {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: EVENT_KINDS.GIFT_WRAP,
        created_at: 1_700_000_000,
        tags: [["p", "4".repeat(64)]],
        content: "encrypted",
      },
      WRAP_SECRET
    )
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

afterEach(() => {
  __resetRelayPublishTestOverrides()
  __resetRelayHealth()
})

describe("progressive relay publishing", () => {
  it("resolves accepted on the first ACK while settlement remains pending", async () => {
    const fast = deferred<{ status: ExactRelayWriteStatus }>()
    const slow = deferred<{ status: ExactRelayWriteStatus }>()
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: ({ relayUrl }) =>
        relayUrl === FAST_RELAY ? fast.promise : slow.promise,
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })
    let settled = false
    void milestones.settled.then(() => {
      settled = true
    })

    fast.resolve({ status: "acked" })
    const accepted = await milestones.accepted

    expect(accepted.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(accepted.pendingRelayUrls).toEqual([SLOW_RELAY])
    expect(settled).toBe(false)

    slow.resolve({ status: "timed_out" })
    const final = await milestones.settled

    expect(final.pendingRelayUrls).toEqual([])
    expect(final.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(final.timedOutRelayUrls).toEqual([SLOW_RELAY])
  })

  it("maps a duplicate response to acceptance through the NDK relay path", async () => {
    const ndk = new NDK({ explicitRelayUrls: [] })
    const slow = deferred<boolean>()
    const fastRelay = {
      url: `${FAST_RELAY}/`,
      publish: async () => {
        throw new Error("duplicate: already have this event")
      },
    } as NDKRelay
    const slowRelay = {
      url: `${SLOW_RELAY}/`,
      publish: async () => slow.promise,
    } as NDKRelay
    ndk.pool.relays.set(fastRelay.url, fastRelay)
    ndk.pool.relays.set(slowRelay.url, slowRelay)
    __setRelayPublishTestOverrides({ getNdk: () => ndk })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })
    const accepted = await milestones.accepted

    expect(accepted.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(accepted.pendingRelayUrls).toEqual([SLOW_RELAY])

    slow.resolve(false)
    await expect(milestones.settled).resolves.toMatchObject({
      successfulRelayUrls: [FAST_RELAY],
      timedOutRelayUrls: [SLOW_RELAY],
    })
  })

  it("rejects accepted only after the bounded retry also has zero ACKs", async () => {
    const attempts: Array<{ relayUrl: string; timeoutMs: number }> = []
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: async ({ relayUrl, timeoutMs }) => {
        attempts.push({ relayUrl, timeoutMs })
        return {
          status: relayUrl === FAST_RELAY ? "rejected" : "timed_out",
        }
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })

    await expect(milestones.accepted).rejects.toThrow(
      "Could not publish to the required exclusive relay set"
    )
    const final = await milestones.settled

    expect(final.successfulRelayUrls).toEqual([])
    expect(final.rejectedRelayUrls).toEqual([FAST_RELAY])
    expect(final.timedOutRelayUrls).toEqual([SLOW_RELAY])
    expect(attempts).toEqual([
      { relayUrl: FAST_RELAY, timeoutMs: 10_000 },
      { relayUrl: SLOW_RELAY, timeoutMs: 10_000 },
      { relayUrl: FAST_RELAY, timeoutMs: 15_000 },
      { relayUrl: SLOW_RELAY, timeoutMs: 15_000 },
    ])
  })

  it("accepts a retry ACK without leaking first-round failures", async () => {
    const attempts = new Map<string, number>()
    const slowRetry = deferred<{ status: ExactRelayWriteStatus }>()
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: ({ relayUrl }) => {
        const attempt = (attempts.get(relayUrl) ?? 0) + 1
        attempts.set(relayUrl, attempt)
        if (attempt === 1) {
          return Promise.resolve({
            status: "timed_out",
            failureMessage: "first round timed out",
          })
        }
        return relayUrl === FAST_RELAY
          ? Promise.resolve({ status: "acked" })
          : slowRetry.promise
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })
    const accepted = await milestones.accepted

    expect(accepted.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(accepted.pendingRelayUrls).toEqual([SLOW_RELAY])
    expect(accepted.relayFailureMessages).toEqual({})

    slowRetry.resolve({ status: "timed_out" })
    await expect(milestones.settled).resolves.toMatchObject({
      successfulRelayUrls: [FAST_RELAY],
      timedOutRelayUrls: [SLOW_RELAY],
    })
  })

  it("keeps acceptance pending after one rejection until another relay ACKs", async () => {
    const first = deferred<{ status: ExactRelayWriteStatus }>()
    const second = deferred<{ status: ExactRelayWriteStatus }>()
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: ({ relayUrl }) =>
        relayUrl === FAST_RELAY ? first.promise : second.promise,
    })
    const event = giftWrapEvent()
    const milestones = await publishWithPlannerProgressive(event, {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })
    let accepted = false
    void milestones.accepted.then(() => {
      accepted = true
    })

    first.resolve({ status: "rejected" })
    await Promise.resolve()
    await Promise.resolve()
    expect(accepted).toBe(false)

    second.resolve({ status: "acked" })
    await expect(milestones.accepted).resolves.toMatchObject({
      successfulRelayUrls: [SLOW_RELAY],
      rejectedRelayUrls: [FAST_RELAY],
    })
    await milestones.settled
    expect(event.publishStatus).toBe("success")
  })

  it("does not start relay attempts after session cancellation", async () => {
    let attempts = 0
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: async () => {
        attempts += 1
        return { status: "acked" }
      },
    })

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        authorPubkey: "3".repeat(64),
        recipientPubkeys: ["4".repeat(64)],
        exclusiveRelayUrls: [FAST_RELAY],
        deliveryMode: "critical",
        shouldContinue: () => false,
      })
    ).rejects.toThrow("signer session changed")
    expect(attempts).toBe(0)
  })

  it("cancels after async target policy without recording a relay failure", async () => {
    let current = true
    let attempts = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async () => {
        current = false
        return undefined
      },
    }
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: async () => {
        attempts += 1
        return { status: "acked" }
      },
    })

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        authorPubkey: "3".repeat(64),
        recipientPubkeys: ["4".repeat(64)],
        exclusiveRelayUrls: [FAST_RELAY],
        deliveryMode: "critical",
        accountPubkey: "3".repeat(64),
        accountNetworkLocalStateRepository: repository,
        shouldContinue: () => current,
      })
    ).rejects.toThrow("signer session changed")

    expect(attempts).toBe(0)
    expect(getRelayHealth(FAST_RELAY)).toBeUndefined()
  })

  it("does not retry a relay removed after the first round", async () => {
    let excluded = false
    const attempts: string[] = []
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        const state = emptyAccountNetworkLocalState(pubkey)
        return excluded
          ? {
              ...state,
              exclusions: [
                {
                  relayUrl: FAST_RELAY,
                  committedAt: 1,
                  relayListFrontier: { eventId: null, createdAt: null },
                  inboxDeclarationFrontier: {
                    eventId: null,
                    createdAt: null,
                  },
                },
              ],
            }
          : state
      },
    }
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        excluded = true
        return { status: "timed_out" }
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY],
      deliveryMode: "critical",
      accountPubkey: "3".repeat(64),
      accountNetworkLocalStateRepository: repository,
    })

    await expect(milestones.accepted).rejects.toThrow(
      "required exclusive relay set"
    )
    await milestones.settled
    expect(attempts).toEqual([FAST_RELAY])
  })

  it("propagates cancellation before a zero-ACK retry", async () => {
    let current = true
    let attempts = 0
    __setRelayPublishTestOverrides({
      progressiveRelayPublish: async () => {
        attempts += 1
        current = false
        return { status: "timed_out" }
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      authorPubkey: "3".repeat(64),
      recipientPubkeys: ["4".repeat(64)],
      exclusiveRelayUrls: [FAST_RELAY],
      deliveryMode: "critical",
      shouldContinue: () => current,
    })

    await expect(milestones.accepted).rejects.toThrow("signer session changed")
    await expect(milestones.settled).resolves.toMatchObject({
      successfulRelayUrls: [],
      timedOutRelayUrls: [FAST_RELAY],
    })
    expect(attempts).toBe(1)
  })

  it("refuses non-exclusive and non-critical use", async () => {
    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        deliveryMode: "critical",
      })
    ).rejects.toThrow("requires an exclusive relay plan")
    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        exclusiveRelayUrls: [FAST_RELAY],
      })
    ).rejects.toThrow("requires critical delivery mode")
  })
})
