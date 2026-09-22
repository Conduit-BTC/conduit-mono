import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  __resetRelayHealth,
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  emptyAccountNetworkLocalState,
  EVENT_KINDS,
  publishWithPlannerProgressive,
  type AccountNetworkLocalStateRepository,
  type ExactRelayWriteStatus,
} from "@conduit/core"

const FAST_RELAY = "wss://fast-progressive.example"
const SLOW_RELAY = "wss://slow-progressive.example"
const ERROR_RELAY = "wss://error-progressive.example"

function giftWrapEvent(): NDKEvent {
  const recipientPubkey = getPublicKey(generateSecretKey())
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: EVENT_KINDS.GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [["p", recipientPubkey]],
        content: "encrypted",
      },
      generateSecretKey()
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
  it("resolves the first relay ACK while exact-target settlement continues", async () => {
    const fast = deferred<ExactRelayWriteStatus>()
    const slow = deferred<ExactRelayWriteStatus>()
    const event = giftWrapEvent()
    const signedBytes = JSON.stringify(event.rawEvent())
    const attempted: string[] = []
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl, signedEvent }) => {
        attempted.push(relayUrl)
        expect(JSON.stringify(signedEvent)).toBe(signedBytes)
        return await (relayUrl === FAST_RELAY ? fast.promise : slow.promise)
      },
    })

    const milestones = await publishWithPlannerProgressive(event, {
      intent: "recipient_event",
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      independentRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
    })
    let settlementComplete = false
    void milestones.settled.then(() => {
      settlementComplete = true
    })

    fast.resolve("acked")
    const accepted = await milestones.accepted

    expect(accepted.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(accepted.pendingRelayUrls).toEqual([SLOW_RELAY])
    expect(settlementComplete).toBe(false)
    expect(JSON.stringify(event.rawEvent())).toBe(signedBytes)

    slow.resolve("timed_out")
    const settled = await milestones.settled

    expect(settled.pendingRelayUrls).toEqual([])
    expect(settled.successfulRelayUrls).toEqual([FAST_RELAY])
    expect(settled.timedOutRelayUrls).toEqual([SLOW_RELAY])
    expect(settled.relayAttempts).toEqual(
      expect.arrayContaining([
        { relayUrl: FAST_RELAY, attempt: 1, status: "acked" },
        { relayUrl: SLOW_RELAY, attempt: 1, status: "timed_out" },
      ])
    )
    expect(attempted.sort()).toEqual([FAST_RELAY, SLOW_RELAY].sort())
    expect(JSON.stringify(event.rawEvent())).toBe(signedBytes)
  })

  it("rejects foreground acceptance after zero ACKs and preserves every bounded outcome", async () => {
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        if (relayUrl === FAST_RELAY) return "rejected"
        if (relayUrl === SLOW_RELAY) return "timed_out"
        throw new Error("simulated transport failure")
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY, ERROR_RELAY],
      independentRelayUrls: [FAST_RELAY, SLOW_RELAY, ERROR_RELAY],
      deliveryMode: "critical",
    })

    await expect(milestones.accepted).rejects.toThrow(
      "Could not publish to the required exclusive relay set"
    )
    const settled = await milestones.settled

    expect(settled.successfulRelayUrls).toEqual([])
    expect(settled.rejectedRelayUrls).toEqual([FAST_RELAY])
    expect(settled.timedOutRelayUrls).toEqual([SLOW_RELAY])
    expect(settled.erroredRelayUrls).toEqual([ERROR_RELAY])
    expect(settled.relayAttempts).toHaveLength(6)
    for (const relayUrl of [FAST_RELAY, SLOW_RELAY, ERROR_RELAY]) {
      expect(
        settled.relayAttempts.filter((attempt) => attempt.relayUrl === relayUrl)
      ).toHaveLength(2)
    }
  })

  it("never widens the exact plan and rechecks durable relay exclusions", async () => {
    const accountPubkey = getPublicKey(generateSecretKey())
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => ({
        ...emptyAccountNetworkLocalState(pubkey),
        exclusions: [
          {
            relayUrl: SLOW_RELAY,
            committedAt: 1,
            relayListFrontier: { eventId: null, createdAt: null },
            inboxDeclarationFrontier: { eventId: null, createdAt: null },
          },
        ],
      }),
    }
    const attempted: string[] = []
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        attempted.push(relayUrl)
        return "acked"
      },
    })

    const milestones = await publishWithPlannerProgressive(giftWrapEvent(), {
      intent: "recipient_event",
      accountPubkey,
      exclusiveRelayUrls: [FAST_RELAY, SLOW_RELAY],
      independentRelayUrls: [FAST_RELAY, SLOW_RELAY],
      deliveryMode: "critical",
      accountNetworkLocalStateRepository: repository,
    })

    await expect(milestones.accepted).resolves.toMatchObject({
      successfulRelayUrls: [FAST_RELAY],
    })
    await expect(milestones.settled).resolves.toMatchObject({
      attemptedRelayUrls: [FAST_RELAY],
      failedRelayUrls: [],
    })
    expect(attempted).toEqual([FAST_RELAY])
  })

  it("fails closed when the signer session changes before network I/O", async () => {
    let attempts = 0
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async () => {
        attempts += 1
        return "acked"
      },
    })

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        exclusiveRelayUrls: [FAST_RELAY],
        independentRelayUrls: [FAST_RELAY],
        deliveryMode: "critical",
        shouldContinue: () => false,
      })
    ).rejects.toThrow("signer session changed")
    expect(attempts).toBe(0)
  })

  it("refuses non-gift-wrap, non-recipient, non-exclusive, and non-critical use", async () => {
    const event = giftWrapEvent()
    event.kind = EVENT_KINDS.TEXT_NOTE
    await expect(
      publishWithPlannerProgressive(event, {
        intent: "recipient_event",
        exclusiveRelayUrls: [FAST_RELAY],
        deliveryMode: "critical",
      })
    ).rejects.toThrow("recipient gift-wrap delivery")

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "author_event",
        exclusiveRelayUrls: [FAST_RELAY],
        deliveryMode: "critical",
      })
    ).rejects.toThrow("recipient gift-wrap delivery")

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        deliveryMode: "critical",
      })
    ).rejects.toThrow("exclusive relay plan")

    await expect(
      publishWithPlannerProgressive(giftWrapEvent(), {
        intent: "recipient_event",
        exclusiveRelayUrls: [FAST_RELAY],
      })
    ).rejects.toThrow("critical delivery mode")
  })
})
