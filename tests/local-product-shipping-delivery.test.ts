import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { withLocalProductCoordinateLocks } from "../packages/core/src/protocol/local-product-coordinate-lock"
import type {
  LocalProductShippingJob,
  LocalProductWriteFrontier,
  LocalProductWriteIntent,
  ProductListingDeliveryJob,
  ProductListingRelayTarget,
} from "../packages/core/src/db"
import {
  deliverPendingProductShippingJobs,
  deliverLocalProductShippingJob,
  deliverProductShippingJob,
  getVerifiedProductShippingAcknowledgements,
  publishExactProductShippingRelay,
  type CommittedProductShippingDelivery,
  type ProductShippingOutboxRepository,
  type ProductShippingRelayPublisher,
} from "../packages/core/src/protocol/local-product-shipping-delivery"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
} from "../packages/core/src/protocol/relay-publish"

const SECRET = generateSecretKey()
const PUBKEY = getPublicKey(SECRET)
const RELAY_A = "wss://relay.conduit.market"
const RELAY_B = "wss://relay.damus.io"

function signed(kind: number, dTag: string, extraTags: string[][] = []) {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_000,
      content: "",
      tags: [["d", dTag], ...extraTags],
    },
    SECRET
  )
}

function committedContext(
  targets: ProductListingRelayTarget[] = [
    { relayUrl: RELAY_A, ownerSelected: false, appRelay: true },
    { relayUrl: RELAY_B, ownerSelected: false, independentRelay: true },
  ]
): CommittedProductShippingDelivery {
  const shippingEvent = signed(30406, "product-1-shipping-standard")
  const listingEvent = signed(30402, "product-1", [
    ["shipping_option", `30406:${PUBKEY}:product-1-shipping-standard`],
  ])
  const shippingJob: LocalProductShippingJob = {
    id: shippingEvent.id,
    merchantPubkey: PUBKEY,
    signedEvent: shippingEvent,
    relayUrls: targets.map((target) => target.relayUrl),
    acknowledgedRelayUrls: [],
    createdAt: 1,
  }
  const listingJob: ProductListingDeliveryJob = {
    id: `product-listing:${listingEvent.id}`,
    merchantPubkey: PUBKEY,
    signedEvents: [listingEvent],
    relayTargets: targets,
    relayDelivery: targets.map((target) => ({
      eventId: listingEvent.id,
      relayUrl: target.relayUrl,
      status: "pending",
      attemptCount: 0,
    })),
    prerequisiteShippingEventIds: [shippingEvent.id],
    readyForDelivery: false,
    state: "pending",
    deliveryAttemptCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const intent: LocalProductWriteIntent = {
    id: "intent-1",
    merchantPubkey: PUBKEY,
    productAddressIds: [`30402:${PUBKEY}:product-1`],
    listingJobId: listingJob.id,
    shippingEventIds: [shippingEvent.id],
    committedAt: 1,
  }
  const currentFrontiers: LocalProductWriteFrontier[] = [
    {
      id: `30402:${PUBKEY}:product-1`,
      merchantPubkey: PUBKEY,
      eventId: listingEvent.id,
      eventCreatedAt: listingEvent.created_at,
      intentId: intent.id,
    },
  ]
  return { shippingJob, listingJob, intent, currentFrontiers }
}

class MemoryOutbox implements ProductShippingOutboxRepository {
  private readonly contexts = new Map<
    string,
    CommittedProductShippingDelivery
  >()

  constructor(...contexts: CommittedProductShippingDelivery[]) {
    for (const context of contexts)
      this.contexts.set(context.shippingJob.id, structuredClone(context))
  }

  async getCommitted(eventId: string) {
    const context = this.contexts.get(eventId)
    return context ? structuredClone(context) : undefined
  }

  async listPendingIds() {
    return [...this.contexts.values()]
      .filter((context) =>
        context.shippingJob.relayUrls.some(
          (relayUrl) =>
            !context.shippingJob.acknowledgedRelayUrls.includes(relayUrl)
        )
      )
      .map((context) => context.shippingJob.id)
  }

  async acknowledge(
    eventId: string,
    relayUrl: string,
    expected: LocalProductShippingJob
  ) {
    const context = this.contexts.get(eventId)
    if (
      !context ||
      JSON.stringify(context.shippingJob.signedEvent) !==
        JSON.stringify(expected.signedEvent)
    ) {
      throw new Error("Signed shipping delivery intent changed")
    }
    if (!context.shippingJob.acknowledgedRelayUrls.includes(relayUrl)) {
      context.shippingJob.acknowledgedRelayUrls.push(relayUrl)
    }
    return structuredClone(context.shippingJob)
  }

  supersede(eventId: string): void {
    const context = this.contexts.get(eventId)
    if (!context) throw new Error("Missing test shipping job")
    context.currentFrontiers[0]!.intentId = "newer-intent"
  }
}

const policyRepository = { get: async () => undefined }
const requestCoordinateLock = async <T>(
  _name: string,
  operation: () => Promise<T>
): Promise<T> => operation()

describe("durable local product shipping delivery", () => {
  it("refuses relay IO without a committed product intent", async () => {
    const context = committedContext()
    context.intent.shippingEventIds = []
    const repository = new MemoryOutbox(context)
    let publishes = 0
    await expect(
      deliverProductShippingJob(
        context.shippingJob.id,
        async () => {
          publishes += 1
          return { status: "acked" }
        },
        {
          repository,
          accountNetworkLocalStateRepository: policyRepository,
          requestCoordinateLock,
        }
      )
    ).rejects.toThrow("committed product intent")
    expect(publishes).toBe(0)
  })

  it("rejects a shipping relay plan different from its companion listing", async () => {
    const context = committedContext()
    context.shippingJob.relayUrls = [RELAY_A]
    const repository = new MemoryOutbox(context)
    let publishes = 0
    await expect(
      deliverProductShippingJob(
        context.shippingJob.id,
        async () => {
          publishes += 1
          return { status: "acked" }
        },
        {
          repository,
          accountNetworkLocalStateRepository: policyRepository,
          requestCoordinateLock,
        }
      )
    ).rejects.toThrow("committed product intent")
    expect(publishes).toBe(0)
  })

  it("does not publish a stale shipping option after a newer local product intent", async () => {
    const context = committedContext()
    context.currentFrontiers[0]!.intentId = "superseding-intent"
    const repository = new MemoryOutbox(context)
    let publishes = 0
    await expect(
      deliverProductShippingJob(
        context.shippingJob.id,
        async () => {
          publishes += 1
          return { status: "acked" }
        },
        {
          repository,
          accountNetworkLocalStateRepository: policyRepository,
          requestCoordinateLock,
        }
      )
    ).rejects.toThrow("committed product intent")
    expect(publishes).toBe(0)
  })

  it("fails closed when a cross-tab product coordinate lock is unavailable", async () => {
    const context = committedContext()
    const repository = new MemoryOutbox(context)
    let publishes = 0
    await expect(
      deliverProductShippingJob(
        context.shippingJob.id,
        async () => {
          publishes += 1
          return { status: "acked" }
        },
        { repository, accountNetworkLocalStateRepository: policyRepository }
      )
    ).rejects.toThrow("Cross-tab product-write lock is unavailable")
    expect(publishes).toBe(0)
  })

  it("holds the product coordinate lock through send and durable ACK", async () => {
    const context = committedContext([
      { relayUrl: RELAY_A, ownerSelected: false, appRelay: true },
    ])
    const repository = new MemoryOutbox(context)
    const tails = new Map<string, Promise<void>>()
    const requestSerialLock = async <T>(
      name: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      const prior = tails.get(name) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      tails.set(
        name,
        prior.then(() => current)
      )
      await prior
      try {
        return await operation()
      } finally {
        release()
      }
    }
    let releasePublish!: () => void
    const publishHeld = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    let reachedPublish!: () => void
    const publishing = new Promise<void>((resolve) => {
      reachedPublish = resolve
    })
    const delivery = deliverProductShippingJob(
      context.shippingJob.id,
      async () => {
        reachedPublish()
        await publishHeld
        return { status: "acked" }
      },
      {
        repository,
        accountNetworkLocalStateRepository: policyRepository,
        requestCoordinateLock: requestSerialLock,
      }
    )
    await publishing
    let superseded = false
    const replacement = withLocalProductCoordinateLocks(
      context.intent.productAddressIds,
      async () => {
        repository.supersede(context.shippingJob.id)
        superseded = true
      },
      { requestLock: requestSerialLock }
    )
    await Promise.resolve()
    expect(superseded).toBe(false)
    try {
      releasePublish()
      const acked = await delivery
      expect(acked.acknowledgedRelayUrls).toEqual([RELAY_A])
    } finally {
      releasePublish()
    }
    await replacement
    expect(superseded).toBe(true)
    await expect(
      getVerifiedProductShippingAcknowledgements(context.shippingJob.id, {
        repository,
      })
    ).rejects.toThrow("committed product intent")
  })

  it("keeps exact signed bytes and retries only unacknowledged targets", async () => {
    const context = committedContext()
    const repository = new MemoryOutbox(context)
    const sent: Array<{ relayUrl: string; eventId: string; sig: string }> = []
    let rejectB = true
    const publisher: ProductShippingRelayPublisher = async ({
      relayUrl,
      signedEvent,
    }) => {
      sent.push({ relayUrl, eventId: signedEvent.id, sig: signedEvent.sig })
      if (relayUrl === RELAY_B && rejectB) return { status: "rejected" }
      return { status: "acked" }
    }
    const options = {
      repository,
      accountNetworkLocalStateRepository: policyRepository,
      requestCoordinateLock,
    }
    const first = await deliverProductShippingJob(
      context.shippingJob.id,
      publisher,
      options
    )
    expect(first.acknowledgedRelayUrls).toEqual([RELAY_A])
    expect(
      await getVerifiedProductShippingAcknowledgements(
        context.shippingJob.id,
        options
      )
    ).toEqual([RELAY_A])

    rejectB = false
    const second = await deliverProductShippingJob(
      context.shippingJob.id,
      publisher,
      options
    )
    expect(second.acknowledgedRelayUrls).toEqual([RELAY_A, RELAY_B])
    expect(sent.map((attempt) => attempt.relayUrl)).toEqual([
      RELAY_A,
      RELAY_B,
      RELAY_B,
    ])
    expect(
      sent.every(
        (attempt) =>
          attempt.eventId === context.shippingJob.id &&
          attempt.sig === context.shippingJob.signedEvent.sig
      )
    ).toBe(true)
  })

  it("uses the exact kind-30406 frame in the production relay adapter", async () => {
    const context = committedContext([
      { relayUrl: RELAY_A, ownerSelected: false, appRelay: true },
    ])
    const repository = new MemoryOutbox(context)
    const sent: Array<{ id: string; kind: number; relayUrl: string }> = []
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ signedEvent, relayUrl }) => {
        sent.push({ id: signedEvent.id, kind: signedEvent.kind, relayUrl })
        return "acked"
      },
    })
    try {
      const ackUrls = await deliverLocalProductShippingJob(
        context.shippingJob.id,
        publishExactProductShippingRelay,
        {
          repository,
          accountNetworkLocalStateRepository: policyRepository,
          requestCoordinateLock,
        }
      )
      expect(ackUrls).toEqual([RELAY_A])
      expect(sent).toEqual([
        { id: context.shippingJob.id, kind: 30406, relayUrl: RELAY_A },
      ])
    } finally {
      __resetRelayPublishTestOverrides()
    }
  })

  it("honors bounded attempts and current relay policy before publishing", async () => {
    const context = committedContext()
    const repository = new MemoryOutbox(context)
    const sent: string[] = []
    const publisher: ProductShippingRelayPublisher = async ({ relayUrl }) => {
      sent.push(relayUrl)
      return { status: "acked" }
    }
    const first = await deliverProductShippingJob(
      context.shippingJob.id,
      publisher,
      {
        repository,
        accountNetworkLocalStateRepository: policyRepository,
        maxRelayAttemptsPerRun: 1,
        requestCoordinateLock,
      }
    )
    expect(first.acknowledgedRelayUrls).toEqual([RELAY_A])
    expect(sent).toEqual([RELAY_A])
    await deliverProductShippingJob(context.shippingJob.id, publisher, {
      repository,
      requestCoordinateLock,
      accountNetworkLocalStateRepository: {
        get: async () => ({
          ...emptyAccountNetworkLocalState(PUBKEY, () => 1),
          exclusions: [
            {
              relayUrl: RELAY_B,
              committedAt: 1,
              relayListFrontier: { eventId: null, createdAt: null },
              inboxDeclarationFrontier: { eventId: null, createdAt: null },
            },
          ],
        }),
      },
    })
    expect(sent).toEqual([RELAY_A])
    expect(
      await getVerifiedProductShippingAcknowledgements(context.shippingJob.id, {
        repository,
      })
    ).toEqual([RELAY_A])
  })

  it("rotates a bounded relay window past a persistently rejecting target", async () => {
    const context = committedContext()
    const repository = new MemoryOutbox(context)
    const sent: string[] = []
    const publisher: ProductShippingRelayPublisher = async ({ relayUrl }) => {
      sent.push(relayUrl)
      return { status: relayUrl === RELAY_A ? "rejected" : "acked" }
    }
    const options = {
      repository,
      accountNetworkLocalStateRepository: policyRepository,
      requestCoordinateLock,
      maxRelayAttemptsPerRun: 1,
    }
    expect(
      (
        await deliverProductShippingJob(
          context.shippingJob.id,
          publisher,
          options
        )
      ).acknowledgedRelayUrls
    ).toEqual([])
    expect(
      (
        await deliverProductShippingJob(
          context.shippingJob.id,
          publisher,
          options
        )
      ).acknowledgedRelayUrls
    ).toEqual([RELAY_B])
    expect(sent).toEqual([RELAY_A, RELAY_B])
  })

  it("continues pending recovery after one malformed job", async () => {
    const invalid = committedContext()
    invalid.shippingJob.signedEvent.sig = "invalid"
    const valid = committedContext([
      { relayUrl: RELAY_A, ownerSelected: false, appRelay: true },
    ])
    valid.shippingJob.id = signed(30406, "product-2-shipping-standard").id
    valid.shippingJob.signedEvent = signed(30406, "product-2-shipping-standard")
    valid.intent.shippingEventIds = [valid.shippingJob.id]
    valid.listingJob.prerequisiteShippingEventIds = [valid.shippingJob.id]
    valid.listingJob.signedEvents[0] = signed(30402, "product-1", [
      ["shipping_option", `30406:${PUBKEY}:product-2-shipping-standard`],
    ])
    valid.listingJob.id = `product-listing:${valid.listingJob.signedEvents[0]!.id}`
    valid.intent.listingJobId = valid.listingJob.id
    valid.currentFrontiers[0]!.eventId = valid.listingJob.signedEvents[0]!.id
    const repository = new MemoryOutbox(invalid, valid)
    const sent: string[] = []
    const publisher: ProductShippingRelayPublisher = async ({
      signedEvent,
    }) => {
      sent.push(signedEvent.id)
      return { status: "acked" }
    }
    const options = {
      repository,
      accountNetworkLocalStateRepository: policyRepository,
      requestCoordinateLock,
      maxJobsPerRun: 1,
    }
    const first = await deliverPendingProductShippingJobs(publisher, options)
    expect(first).toHaveLength(0)
    const completed = await deliverPendingProductShippingJobs(
      publisher,
      options
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]?.id).toBe(valid.shippingJob.id)
    expect(sent).toEqual([valid.shippingJob.id])
  })
})
