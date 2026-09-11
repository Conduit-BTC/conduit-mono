import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"

import {
  applyAccountNetworkRelayExclusion,
  applyE2eRelayIsolation,
  config,
  createInMemoryAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
} from "@conduit/core"
import type { ProductDeletionDeliveryJob } from "@conduit/core/db"
import {
  deliverProductDeletionJob,
  deliverPendingProductDeletions,
  getPendingProductDeletionDeliveries,
  persistProductDeletionDelivery,
  planProductDeletionRelays,
  type ProductDeletionDeliveryOptions,
  type ProductDeletionOutboxRepository,
  type ProductDeletionRelayPublisher,
} from "@conduit/core/protocol/product-deletion-delivery"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  deliverQueuedProductDeletion,
  productDeletionJobToPublishResult,
  resumePendingProductDeletionDeliveries,
} from "../apps/merchant/src/lib/product-deletion-delivery"
import { buildProductDeliveryNotice } from "../apps/merchant/src/lib/product-delivery"

const MERCHANT_SECRET = new Uint8Array(32).fill(7)
const NOW = 1_700_000_000_000
const allowAllAccountNetworkLocalStateRepository = {
  get: async () => undefined,
}

function withEligibleAccountRelays<T extends ProductDeletionDeliveryOptions>(
  options: T
) {
  return {
    accountNetworkLocalStateRepository:
      allowAllAccountNetworkLocalStateRepository,
    authenticatedPubkey: signedDeletionEvent().pubkey,
    ...options,
  }
}

function signedDeletionEvent(
  targetEventId = "a".repeat(64)
): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: 5,
      created_at: 1_700_000_000,
      tags: [["e", targetEventId, "wss://source.example"]],
      content: "",
    },
    MERCHANT_SECRET
  )
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

function cloneJob(job: ProductDeletionDeliveryJob): ProductDeletionDeliveryJob {
  return structuredClone(job)
}

class MemoryProductDeletionOutbox implements ProductDeletionOutboxRepository {
  constructor(
    private readonly storage: Map<
      string,
      ProductDeletionDeliveryJob
    > = new Map()
  ) {}

  async add(job: ProductDeletionDeliveryJob): Promise<void> {
    if (this.storage.has(job.id)) throw new Error("duplicate")
    this.storage.set(job.id, cloneJob(job))
  }

  async get(id: string): Promise<ProductDeletionDeliveryJob | undefined> {
    const job = this.storage.get(id)
    return job ? cloneJob(job) : undefined
  }

  async listUndelivered(): Promise<ProductDeletionDeliveryJob[]> {
    return Array.from(this.storage.values())
      .filter((job) => job.state !== "delivered")
      .map(cloneJob)
  }

  async update(
    id: string,
    updater: (current: ProductDeletionDeliveryJob) => ProductDeletionDeliveryJob
  ): Promise<ProductDeletionDeliveryJob> {
    const current = this.storage.get(id)
    if (!current) throw new Error("missing")
    const next = updater(cloneJob(current))
    this.storage.set(id, cloneJob(next))
    return cloneJob(next)
  }
}

function tickingClock(start = NOW): () => number {
  let timestamp = start
  return () => timestamp++
}

describe("product deletion relay plan", () => {
  it("builds a deterministic secure union and preserves every relay role", () => {
    expect(
      planProductDeletionRelays({
        currentWriteRelayUrls: [
          "WSS://RELAY.EXAMPLE/",
          "wss://127.0.0.1:7447",
          "ws://127.0.0.1:7777",
          "ws://owner-selected.example",
          "https://write.example/catalog/?ignored=true",
        ],
        sourceRelayUrls: [
          "wss://127.0.0.1:7447/",
          "ws://127.0.0.1:7777/",
          "wss://192.168.1.50:7447",
          "ws://insecure.example",
          "wss://relay.example",
          "wss://source.example/products/",
          "wss://relay.conduit.market/",
          "not a url",
        ],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      })
    ).toEqual([
      {
        relayUrl: "ws://127.0.0.1:7777",
        roles: ["author_write"],
      },
      {
        relayUrl: "ws://owner-selected.example",
        roles: ["author_write"],
      },
      {
        relayUrl: "wss://127.0.0.1:7447",
        roles: ["author_write", "source"],
      },
      {
        relayUrl: "wss://relay.conduit.market",
        roles: ["source", "conduit"],
      },
      {
        relayUrl: "wss://relay.example",
        roles: ["author_write", "source"],
      },
      {
        relayUrl: "wss://write.example/catalog",
        roles: ["author_write"],
      },
    ])
  })

  it("requires a secure canonical Conduit relay", () => {
    expect(() =>
      planProductDeletionRelays({
        currentWriteRelayUrls: [],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "ws://relay.conduit.market",
      })
    ).toThrow("secure wss://")
  })

  it("rejects a private canonical relay target", () => {
    expect(() =>
      planProductDeletionRelays({
        currentWriteRelayUrls: [],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://127.0.0.1:7447",
      })
    ).toThrow("public secure wss://")
  })

  it("drops public provenance and planner targets during E2E isolation", () => {
    const previousConfig = structuredClone(config)
    const isolatedRelayUrl = "ws://127.0.0.1:7777"

    try {
      Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
      expect(
        planProductDeletionRelays({
          currentWriteRelayUrls: [
            "wss://saved-public.example",
            isolatedRelayUrl,
          ],
          sourceRelayUrls: ["wss://source-public.example"],
          canonicalConduitRelayUrl: isolatedRelayUrl,
        })
      ).toEqual([
        {
          relayUrl: isolatedRelayUrl,
          roles: ["author_write", "conduit"],
        },
      ])
    } finally {
      Object.assign(config, previousConfig)
    }
  })
})

describe("durable product deletion delivery", () => {
  it("admits an owner-selected ws target without admitting remote ws provenance", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const ownerRelayUrl = "ws://owner-selected.example"
    const remoteRelayUrl = "ws://remote-source.example"
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [ownerRelayUrl],
        sourceRelayUrls: [remoteRelayUrl],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    expect(job.relayPlan).toEqual([
      { relayUrl: ownerRelayUrl, roles: ["author_write"] },
      { relayUrl: "wss://relay.conduit.market", roles: ["conduit"] },
    ])

    const publisherInputs: Parameters<ProductDeletionRelayPublisher>[0][] = []
    const result = await deliverProductDeletionJob(
      job.id,
      async (input) => {
        publisherInputs.push(input)
        return { status: "acked" }
      },
      withEligibleAccountRelays({ repository, now: tickingClock() })
    )

    expect(
      publisherInputs.map(({ relayUrl, ownerSelectedRelayUrls }) => ({
        relayUrl,
        ownerSelectedRelayUrls,
      }))
    ).toEqual([
      { relayUrl: ownerRelayUrl, ownerSelectedRelayUrls: [ownerRelayUrl] },
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelectedRelayUrls: [],
      },
    ])
    expect(publisherInputs.map(({ relayUrl }) => relayUrl)).not.toContain(
      remoteRelayUrl
    )
    expect(result.state).toBe("delivered")
  })

  it("rejects an invalid deletion event before creating an outbox job", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const invalidEvent = { ...signedDeletionEvent(), content: "tampered" }

    await expect(
      persistProductDeletionDelivery(
        {
          signedEvent: invalidEvent,
          currentWriteRelayUrls: ["wss://write.example"],
          sourceRelayUrls: [],
          canonicalConduitRelayUrl: "wss://relay.conduit.market",
        },
        { repository }
      )
    ).rejects.toThrow("valid signed kind-5 event")
    expect(await repository.listUndelivered()).toEqual([])
  })

  it("rejects a valid kind-5 signature with no safe product target", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const signed = finalizeEvent(
      {
        kind: 5,
        created_at: 1_700_000_000,
        tags: [["p", "b".repeat(64)]],
        content: "",
      },
      MERCHANT_SECRET
    )

    await expect(
      persistProductDeletionDelivery(
        {
          signedEvent: signed,
          currentWriteRelayUrls: [],
          sourceRelayUrls: [],
          canonicalConduitRelayUrl: "wss://relay.conduit.market",
        },
        { repository }
      )
    ).rejects.toThrow("safe product target")
    expect(await repository.listUndelivered()).toEqual([])
  })

  it("retires legacy private and remote-ws source-only targets before retry I/O", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const created = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      withEligibleAccountRelays({ repository, now: () => NOW })
    )
    const unapprovedSourceRelays = [
      "wss://127.0.0.1:7447",
      "ws://remote-source.example",
    ]
    await repository.update(created.id, (current) => ({
      ...current,
      relayPlan: [
        ...current.relayPlan,
        ...unapprovedSourceRelays.map((relayUrl) => ({
          relayUrl,
          roles: ["source" as const],
        })),
      ],
      relayDelivery: [
        ...current.relayDelivery,
        ...unapprovedSourceRelays.map((relayUrl) => ({
          relayUrl,
          status: "pending" as const,
          attemptCount: 0,
        })),
      ],
    }))

    const attemptedRelayUrls: string[] = []
    const result = await deliverProductDeletionJob(
      created.id,
      async ({ relayUrl }) => {
        attemptedRelayUrls.push(relayUrl)
        return { status: "acked" }
      },
      withEligibleAccountRelays({ repository, now: () => NOW })
    )

    expect(attemptedRelayUrls).toEqual(["wss://relay.conduit.market"])
    expect(result.relayPlan.map(({ relayUrl }) => relayUrl)).toEqual([
      "wss://relay.conduit.market",
    ])
    expect(result.relayDelivery.map(({ relayUrl }) => relayUrl)).toEqual([
      "wss://relay.conduit.market",
    ])
    expect(result.state).toBe("delivered")

    await deliverProductDeletionJob(
      created.id,
      async ({ relayUrl }) => {
        attemptedRelayUrls.push(relayUrl)
        return { status: "acked" }
      },
      withEligibleAccountRelays({ repository, now: () => NOW })
    )
    expect(attemptedRelayUrls).toEqual(["wss://relay.conduit.market"])
    expect(await getPendingProductDeletionDeliveries({ repository })).toEqual(
      []
    )
  })

  it("retires persisted public targets before an E2E retry can publish", async () => {
    const previousConfig = structuredClone(config)
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const beforeReload = new MemoryProductDeletionOutbox(durableStorage)

    try {
      Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
      const created = await persistProductDeletionDelivery(
        {
          signedEvent: signedDeletionEvent(),
          currentWriteRelayUrls: [isolatedRelayUrl],
          sourceRelayUrls: [],
          canonicalConduitRelayUrl: isolatedRelayUrl,
        },
        { repository: beforeReload, now: () => NOW }
      )
      const publicRelayUrl = "wss://source-before-isolation.example"
      await beforeReload.update(created.id, (current) => ({
        ...current,
        relayPlan: [
          ...current.relayPlan,
          { relayUrl: publicRelayUrl, roles: ["source"] },
        ],
        relayDelivery: [
          ...current.relayDelivery,
          { relayUrl: publicRelayUrl, status: "pending", attemptCount: 0 },
        ],
      }))

      const afterReload = new MemoryProductDeletionOutbox(durableStorage)
      const attemptedRelayUrls: string[] = []
      const result = await deliverProductDeletionJob(
        created.id,
        async ({ relayUrl }) => {
          attemptedRelayUrls.push(relayUrl)
          return { status: "acked" }
        },
        withEligibleAccountRelays({
          repository: afterReload,
          now: () => NOW,
        })
      )

      expect(attemptedRelayUrls).toEqual([isolatedRelayUrl])
      expect(result.relayPlan.map(({ relayUrl }) => relayUrl)).toEqual([
        isolatedRelayUrl,
      ])
      expect(result.state).toBe("delivered")
    } finally {
      Object.assign(config, previousConfig)
    }
  })

  it("persists the exact signed event and plan before publisher I/O", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const now = tickingClock()
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://write.conduit.market"],
        sourceRelayUrls: ["wss://source.conduit.market"],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now }
    )

    let publisherObservedPersistedJob = false
    const publisher: ProductDeletionRelayPublisher = async ({
      relayUrl,
      signedEvent,
    }) => {
      const persisted = await repository.get(event.id)
      publisherObservedPersistedJob =
        persisted?.id === event.id &&
        JSON.stringify(persisted.signedEvent) === JSON.stringify(event) &&
        persisted.relayPlan.length === 3
      expect(signedEvent).toEqual(event)

      if (relayUrl === "wss://write.conduit.market") return { status: "acked" }
      if (relayUrl === "wss://source.conduit.market") {
        return { status: "rejected" }
      }
      return { status: "timed_out" }
    }

    const result = await deliverProductDeletionJob(
      job.id,
      publisher,
      withEligibleAccountRelays({
        repository,
        now,
        retryDelayMs: 1_000,
      })
    )

    expect(publisherObservedPersistedJob).toBe(true)
    expect(result.state).toBe("partial")
    expect(result.deliveryAttemptCount).toBe(1)
    expect(result.retryCount).toBe(0)
    expect(
      Object.fromEntries(
        result.relayDelivery.map(({ relayUrl, status }) => [relayUrl, status])
      )
    ).toEqual({
      "wss://relay.conduit.market": "timed_out",
      "wss://source.conduit.market": "rejected",
      "wss://write.conduit.market": "acked",
    })
    expect(
      result.relayDelivery.every(
        (delivery) =>
          delivery.attemptCount === 1 && delivery.lastAttemptAt !== undefined
      )
    ).toBe(true)
    expect(
      result.relayDelivery.find(
        ({ relayUrl }) => relayUrl === "wss://source.conduit.market"
      )?.rejectedAt
    ).toBeNumber()
    expect(
      result.relayDelivery.find(
        ({ relayUrl }) => relayUrl === "wss://relay.conduit.market"
      )?.timedOutAt
    ).toBeNumber()

    const diagnostics = productDeletionJobToPublishResult(result)
    const serializedDiagnostics = JSON.stringify(diagnostics)
    expect(serializedDiagnostics).not.toContain(event.id)
    expect(serializedDiagnostics).not.toContain(event.pubkey)
    expect(serializedDiagnostics).not.toContain(event.sig)
    expect(serializedDiagnostics).not.toContain("a".repeat(64))
    expect(Object.keys(diagnostics)).toEqual([
      "plan",
      "attemptedRelayUrls",
      "successfulRelayUrls",
      "failedRelayUrls",
      "relayFailureMessages",
    ])
  })

  it("lets whole-relay removal cut off an owner-selected ws target immediately", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const excludedRelayUrl = "ws://owner-selected.example"
    const accountNetworkLocalStateRepository =
      createInMemoryAccountNetworkLocalStateRepository([
        applyAccountNetworkRelayExclusion(
          emptyAccountNetworkLocalState(event.pubkey, () => NOW),
          {
            relayUrl: excludedRelayUrl,
            relayListFrontier: { eventId: null, createdAt: null },
            inboxDeclarationFrontier: { eventId: null, createdAt: null },
            committedAt: NOW,
          }
        ),
      ])
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [excludedRelayUrl],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    const publisherInputs: Parameters<ProductDeletionRelayPublisher>[0][] = []

    const result = await deliverProductDeletionJob(
      job.id,
      async (input) => {
        publisherInputs.push(input)
        return { status: "acked" }
      },
      {
        repository,
        accountNetworkLocalStateRepository,
        now: tickingClock(),
      }
    )

    expect(
      publisherInputs.map(({ relayUrl, accountPubkey }) => ({
        relayUrl,
        accountPubkey,
      }))
    ).toEqual([
      {
        relayUrl: "wss://relay.conduit.market",
        accountPubkey: event.pubkey,
      },
    ])
    expect(publisherInputs[0]?.accountNetworkLocalStateRepository).toBe(
      accountNetworkLocalStateRepository
    )
    expect(result.relayPlan).toEqual(job.relayPlan)
    expect(
      result.relayDelivery.find(({ relayUrl }) => relayUrl === excludedRelayUrl)
    ).toEqual({
      relayUrl: excludedRelayUrl,
      status: "pending",
      attemptCount: 0,
    })
    expect(result.state).toBe("partial")
  })

  it("fails closed without changing pending delivery evidence when account policy is unavailable", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const accountLookups: string[] = []
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    const published: string[] = []

    const result = await deliverProductDeletionJob(
      job.id,
      async ({ relayUrl }) => {
        published.push(relayUrl)
        return { status: "acked" }
      },
      {
        repository,
        accountNetworkLocalStateRepository: {
          get: async (accountPubkey) => {
            accountLookups.push(accountPubkey)
            throw new Error("local policy unavailable")
          },
        },
        now: () => NOW,
      }
    )

    expect(accountLookups).toEqual([event.pubkey])
    expect(published).toEqual([])
    expect(result.relayPlan).toEqual(job.relayPlan)
    expect(result.relayDelivery).toEqual(job.relayDelivery)
    expect(result.deliveryAttemptCount).toBe(0)
    expect(result.state).toBe("pending")
  })

  it("re-reads account eligibility before each pending relay attempt", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const removedAfterFirstAttempt = "wss://write.conduit.market"
    const accountNetworkLocalStateRepository =
      createInMemoryAccountNetworkLocalStateRepository([
        emptyAccountNetworkLocalState(event.pubkey, () => NOW),
      ])
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [removedAfterFirstAttempt],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    const attemptedRelayUrls: string[] = []

    const result = await deliverProductDeletionJob(
      job.id,
      async ({ relayUrl }) => {
        attemptedRelayUrls.push(relayUrl)
        await accountNetworkLocalStateRepository.update(
          event.pubkey,
          (current) =>
            applyAccountNetworkRelayExclusion(current, {
              relayUrl: removedAfterFirstAttempt,
              relayListFrontier: { eventId: null, createdAt: null },
              inboxDeclarationFrontier: { eventId: null, createdAt: null },
              committedAt: NOW + 1,
            })
        )
        return { status: "acked" }
      },
      {
        repository,
        accountNetworkLocalStateRepository,
        now: tickingClock(),
      }
    )

    expect(attemptedRelayUrls).toEqual(["wss://relay.conduit.market"])
    expect(
      result.relayDelivery.find(
        ({ relayUrl }) => relayUrl === removedAfterFirstAttempt
      )
    ).toEqual({
      relayUrl: removedAfterFirstAttempt,
      status: "pending",
      attemptCount: 0,
    })
  })

  it("revalidates a persisted exact event before deriving its account principal", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    await repository.update(job.id, (current) => ({
      ...current,
      signedEvent: { ...current.signedEvent, content: "tampered" },
    }))
    const accountLookups: string[] = []
    const published: string[] = []

    await expect(
      deliverProductDeletionJob(
        job.id,
        async ({ relayUrl }) => {
          published.push(relayUrl)
          return { status: "acked" }
        },
        {
          repository,
          accountNetworkLocalStateRepository: {
            get: async (accountPubkey) => {
              accountLookups.push(accountPubkey)
              return undefined
            },
          },
          now: () => NOW,
        }
      )
    ).rejects.toThrow("valid signed kind-5 event")
    expect(accountLookups).toEqual([])
    expect(published).toEqual([])
  })

  it("survives reload and retries the same event on only unacked relays", async () => {
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const beforeReload = new MemoryProductDeletionOutbox(durableStorage)
    const event = signedDeletionEvent()
    const firstNow = tickingClock()
    const created = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://write.conduit.market"],
        sourceRelayUrls: ["wss://source.conduit.market"],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository: beforeReload, now: firstNow }
    )

    await deliverProductDeletionJob(
      created.id,
      async ({ relayUrl }) =>
        relayUrl === "wss://write.conduit.market"
          ? { status: "acked" }
          : relayUrl === "wss://source.conduit.market"
            ? { status: "rejected" }
            : { status: "timed_out" },
      withEligibleAccountRelays({
        repository: beforeReload,
        now: firstNow,
        retryDelayMs: 1,
      })
    )

    // A new repository instance represents route teardown/browser restart.
    const afterReload = new MemoryProductDeletionOutbox(durableStorage)
    const pending = await getPendingProductDeletionDeliveries({
      repository: afterReload,
      now: () => NOW + 10_000,
      dueOnly: true,
    })
    expect(pending.map(({ id }) => id)).toEqual([event.id])

    const retriedRelayUrls: string[] = []
    const retriedEvents: SignedPublicNostrEvent[] = []
    const result = await deliverProductDeletionJob(
      event.id,
      async ({ relayUrl, signedEvent }) => {
        retriedRelayUrls.push(relayUrl)
        retriedEvents.push(signedEvent)
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository: afterReload,
        now: tickingClock(NOW + 20_000),
        retryDelayMs: 1,
      })
    )

    expect(retriedRelayUrls).toEqual([
      "wss://relay.conduit.market",
      "wss://source.conduit.market",
    ])
    expect(retriedEvents).toEqual([event, event])
    expect(result.signedEvent).toEqual(event)
    expect(result.state).toBe("delivered")
    expect(result.deliveryAttemptCount).toBe(2)
    expect(result.retryCount).toBe(1)
    expect(result.nextRetryAt).toBeUndefined()
    expect(
      Object.fromEntries(
        result.relayDelivery.map(({ relayUrl, attemptCount }) => [
          relayUrl,
          attemptCount,
        ])
      )
    ).toEqual({
      "wss://relay.conduit.market": 2,
      "wss://source.conduit.market": 2,
      "wss://write.conduit.market": 1,
    })
  })

  it("resumes wss while logged out but reserves persisted owner ws for matching auth", async () => {
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const beforeReload = new MemoryProductDeletionOutbox(durableStorage)
    const event = signedDeletionEvent()
    const ownerRelayUrl = "ws://owner-selected.example"
    const remoteRelayUrl = "ws://remote-source.example"
    const canonicalRelayUrl = "wss://relay.conduit.market"
    const created = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [ownerRelayUrl],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: canonicalRelayUrl,
      },
      { repository: beforeReload, now: () => NOW }
    )
    await beforeReload.update(created.id, (current) => ({
      ...current,
      relayPlan: [
        ...current.relayPlan,
        { relayUrl: remoteRelayUrl, roles: ["source" as const] },
      ],
      relayDelivery: [
        ...current.relayDelivery,
        {
          relayUrl: remoteRelayUrl,
          status: "pending" as const,
          attemptCount: 0,
        },
      ],
    }))

    const afterReload = new MemoryProductDeletionOutbox(durableStorage)
    const loggedOutInputs: Parameters<ProductDeletionRelayPublisher>[0][] = []
    const loggedOutResult = await deliverProductDeletionJob(
      created.id,
      async (input) => {
        loggedOutInputs.push(input)
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository: afterReload,
        now: tickingClock(NOW + 20_000),
        retryDelayMs: 1,
        authenticatedPubkey: null,
      })
    )
    expect(loggedOutInputs.map(({ relayUrl }) => relayUrl)).toEqual([
      canonicalRelayUrl,
    ])
    expect(loggedOutResult.state).toBe("partial")

    const switchedAccountInputs: string[] = []
    await deliverProductDeletionJob(
      created.id,
      async ({ relayUrl }) => {
        switchedAccountInputs.push(relayUrl)
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository: afterReload,
        now: tickingClock(NOW + 30_000),
        retryDelayMs: 1,
        authenticatedPubkey: "a".repeat(64),
      })
    )
    expect(switchedAccountInputs).toEqual([])

    const ownerInputs: Parameters<ProductDeletionRelayPublisher>[0][] = []
    const result = await deliverProductDeletionJob(
      created.id,
      async (input) => {
        ownerInputs.push(input)
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository: afterReload,
        now: tickingClock(NOW + 40_000),
        retryDelayMs: 1,
        authenticatedPubkey: event.pubkey,
      })
    )

    expect(
      ownerInputs.map(
        ({
          relayUrl,
          authenticatedPubkey,
          ownerSelectedRelayUrls,
          signedEvent,
        }) => ({
          relayUrl,
          authenticatedPubkey,
          ownerSelectedRelayUrls,
          signedEvent,
        })
      )
    ).toEqual([
      {
        relayUrl: ownerRelayUrl,
        authenticatedPubkey: event.pubkey,
        ownerSelectedRelayUrls: [ownerRelayUrl],
        signedEvent: event,
      },
    ])
    expect(result.relayPlan.map(({ relayUrl }) => relayUrl)).toEqual([
      ownerRelayUrl,
      canonicalRelayUrl,
    ])
    expect(result.relayDelivery.map(({ relayUrl }) => relayUrl)).not.toContain(
      remoteRelayUrl
    )
    expect(result.state).toBe("delivered")
  })

  it("drops stale worker auth between relay admissions while continuing wss", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const firstOwnerRelayUrl = "ws://a.owner-selected.example"
    const secondOwnerRelayUrl = "ws://b.owner-selected.example"
    const canonicalRelayUrl = "wss://relay.conduit.market"
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [firstOwnerRelayUrl, secondOwnerRelayUrl],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: canonicalRelayUrl,
      },
      { repository, now: () => NOW }
    )
    let authIsCurrent = true
    const attemptedRelayUrls: string[] = []

    const result = await deliverProductDeletionJob(
      job.id,
      async ({ relayUrl }) => {
        attemptedRelayUrls.push(relayUrl)
        if (relayUrl === firstOwnerRelayUrl) authIsCurrent = false
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository,
        now: tickingClock(),
        authenticatedPubkey: event.pubkey,
        isAuthenticatedPubkeyCurrent: () => authIsCurrent,
      })
    )

    expect(attemptedRelayUrls).toEqual([firstOwnerRelayUrl, canonicalRelayUrl])
    expect(result.relayDelivery).toContainEqual({
      relayUrl: secondOwnerRelayUrl,
      status: "pending",
      attemptCount: 0,
    })
    expect(result.state).toBe("partial")
  })

  it("retains a Conduit ACK and never retries it when other relays fail", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    let timestamp = NOW
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://write.conduit.market"],
        sourceRelayUrls: ["wss://source.conduit.market"],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => timestamp }
    )

    await deliverProductDeletionJob(
      event.id,
      async ({ relayUrl }) =>
        relayUrl === "wss://relay.conduit.market"
          ? { status: "acked" }
          : { status: "timed_out" },
      withEligibleAccountRelays({
        repository,
        now: () => timestamp,
        retryDelayMs: 1,
      })
    )

    timestamp += 10
    const retried: string[] = []
    const result = await deliverProductDeletionJob(
      event.id,
      async ({ relayUrl }) => {
        retried.push(relayUrl)
        return { status: "acked" }
      },
      withEligibleAccountRelays({
        repository,
        now: () => timestamp,
        retryDelayMs: 1,
      })
    )

    expect(retried).toEqual([
      "wss://source.conduit.market",
      "wss://write.conduit.market",
    ])
    expect(retried).not.toContain("wss://relay.conduit.market")
    expect(result.state).toBe("delivered")
    expect(
      result.relayDelivery.find(
        ({ relayUrl }) => relayUrl === "wss://relay.conduit.market"
      )?.attemptCount
    ).toBe(1)
  })

  it("lets an explicit retry recover an unexpired orphan lease without stale outcome regression", async () => {
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const firstTab = new MemoryProductDeletionOutbox(durableStorage)
    const secondTab = new MemoryProductDeletionOutbox(durableStorage)
    const event = signedDeletionEvent()
    let timestamp = NOW
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository: firstTab, now: () => timestamp }
    )

    let releaseFirstAttempt!: () => void
    const firstAttemptStarted = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve
    })
    let observeFirstAttempt!: () => void
    const observedFirstAttempt = new Promise<void>((resolve) => {
      observeFirstAttempt = resolve
    })
    const staleDelivery = deliverProductDeletionJob(
      event.id,
      async () => {
        observeFirstAttempt()
        await firstAttemptStarted
        return { status: "timed_out" }
      },
      withEligibleAccountRelays({
        repository: firstTab,
        now: () => timestamp,
        deliveryLeaseOwner: "first-tab",
        deliveryLeaseMs: 10_000,
      })
    )
    await observedFirstAttempt

    timestamp += 1
    const winningDelivery = await deliverProductDeletionJob(
      event.id,
      async () => ({ status: "acked" }),
      withEligibleAccountRelays({
        repository: secondTab,
        now: () => timestamp,
        deliveryLeaseOwner: "second-tab",
        deliveryLeaseMs: 10_000,
        forceDeliveryLeaseRecovery: true,
      })
    )
    expect(winningDelivery.state).toBe("delivered")

    releaseFirstAttempt()
    await staleDelivery
    const durable = await secondTab.get(event.id)
    expect(durable?.state).toBe("delivered")
    expect(durable?.relayDelivery[0]?.status).toBe("acked")
    expect(durable?.relayDelivery[0]?.attemptCount).toBe(2)
  })

  it("keeps unattempted pending relays outstanding in the Merchant projection", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const job = await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://write.example"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    const interrupted: ProductDeletionDeliveryJob = {
      ...job,
      state: "partial",
      deliveryAttemptCount: 1,
      relayDelivery: job.relayDelivery.map((delivery, index) =>
        index === 0
          ? {
              ...delivery,
              status: "acked",
              attemptCount: 1,
              lastAttemptAt: NOW,
              acknowledgedAt: NOW,
            }
          : delivery
      ),
    }

    const projection = productDeletionJobToPublishResult(interrupted)
    const pendingRelay = interrupted.relayDelivery.find(
      (delivery) => delivery.status === "pending"
    )
    expect(pendingRelay?.attemptCount).toBe(0)
    expect(projection.failedRelayUrls).toEqual([pendingRelay?.relayUrl])
    expect(projection.relayFailureMessages[pendingRelay!.relayUrl]).toBe(
      "Delivery attempt pending"
    )
    const notice = buildProductDeliveryNotice("delete", projection)
    expect(notice.state).toBe("partial")
    expect(notice.detail).toContain("ACKed 1 of 2 relays.")
  })

  it("gates an explicit retry on restoring its local tombstone", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    let allowRestore = false
    const published: string[] = []
    const options = {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW,
      restoreLocalEvidence: async () => {
        if (!allowRestore) throw new Error("transient tombstone write failure")
      },
      publisher: async ({
        signedEvent,
      }: Parameters<ProductDeletionRelayPublisher>[0]) => {
        published.push(signedEvent.id)
        return { status: "acked" as const }
      },
    }

    await expect(
      deliverQueuedProductDeletion(event.id, options)
    ).rejects.toThrow("transient tombstone write failure")
    expect((await repository.get(event.id))?.state).toBe("pending")
    expect(published).toEqual([])

    allowRestore = true
    const result = await deliverQueuedProductDeletion(event.id, options)

    expect((await repository.get(event.id))?.state).toBe("delivered")
    expect(result.failedRelayUrls).toEqual([])
    expect(published).toEqual([event.id])
  })

  it("binds explicit retry auth to the live session without stopping public wss", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const ownerRelayUrl = "ws://owner-selected.example"
    const publicRelayUrl = "wss://relay.conduit.market"
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: [ownerRelayUrl],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: publicRelayUrl,
      },
      { repository, now: () => NOW }
    )
    let sessionCurrent = true
    const attemptedRelayUrls: string[] = []

    const result = await deliverQueuedProductDeletion(event.id, {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      authenticatedPubkey: event.pubkey,
      shouldContinue: () => sessionCurrent,
      now: tickingClock(),
      restoreLocalEvidence: async () => {},
      publisher: async ({
        relayUrl,
        authenticatedPubkey,
        isAuthenticatedPubkeyCurrent,
      }) => {
        attemptedRelayUrls.push(relayUrl)
        if (relayUrl === ownerRelayUrl) {
          expect(authenticatedPubkey).toBe(event.pubkey)
          expect(isAuthenticatedPubkeyCurrent?.(event.pubkey)).toBe(true)
          sessionCurrent = false
        } else {
          expect(authenticatedPubkey).toBeNull()
        }
        return { status: "acked" }
      },
    })

    expect(attemptedRelayUrls).toEqual([ownerRelayUrl, publicRelayUrl])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("returns an already-delivered job when a background worker wins the retry race", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: [],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now: () => NOW }
    )
    await deliverProductDeletionJob(
      event.id,
      async () => ({ status: "acked" }),
      withEligibleAccountRelays({ repository, now: () => NOW })
    )

    const restored: string[] = []
    const republished: string[] = []
    const result = await deliverQueuedProductDeletion(
      event.id,
      withEligibleAccountRelays({
        repository,
        now: () => NOW,
        restoreLocalEvidence: async (job) => {
          restored.push(job.id)
        },
        publisher: async ({ signedEvent }) => {
          republished.push(signedEvent.id)
          return { status: "acked" }
        },
      })
    )

    expect(result.successfulRelayUrls).toEqual(["wss://relay.conduit.market"])
    expect(result.failedRelayUrls).toEqual([])
    expect(restored).toEqual([event.id])
    expect(republished).toEqual([])
  })

  it("gates network delivery on local evidence without starving later jobs", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const blockedEvent = signedDeletionEvent("a".repeat(64))
    const laterEvent = signedDeletionEvent("b".repeat(64))
    for (const event of [blockedEvent, laterEvent]) {
      await persistProductDeletionDelivery(
        {
          signedEvent: event,
          currentWriteRelayUrls: ["wss://relay.conduit.market"],
          sourceRelayUrls: [],
          canonicalConduitRelayUrl: "wss://relay.conduit.market",
        },
        { repository, now: () => NOW }
      )
    }

    let blockRestore = true
    const restored: string[] = []
    const published: string[] = []
    const options = {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW,
      deliveryLeaseOwner: "worker",
      restoreLocalEvidence: async (job: ProductDeletionDeliveryJob) => {
        if (job.id === blockedEvent.id && blockRestore) {
          throw new Error("transient tombstone write failure")
        }
        restored.push(job.id)
      },
      publisher: async ({
        signedEvent,
      }: Parameters<ProductDeletionRelayPublisher>[0]) => {
        published.push(signedEvent.id)
        return { status: "acked" as const }
      },
    }

    await resumePendingProductDeletionDeliveries(options)

    expect((await repository.get(blockedEvent.id))?.state).toBe("pending")
    expect((await repository.get(laterEvent.id))?.state).toBe("delivered")
    expect(restored).toEqual([laterEvent.id])
    expect(published).toEqual([laterEvent.id])

    blockRestore = false
    await resumePendingProductDeletionDeliveries(options)

    expect((await repository.get(blockedEvent.id))?.state).toBe("delivered")
    expect(restored).toEqual([laterEvent.id, blockedEvent.id])
    expect(published).toEqual([laterEvent.id, blockedEvent.id])
  })

  it("continues later durable jobs when an older job cannot be loaded", async () => {
    const storage = new Map<string, ProductDeletionDeliveryJob>()
    const baseRepository = new MemoryProductDeletionOutbox(storage)
    const first = signedDeletionEvent("a".repeat(64))
    const second = signedDeletionEvent("b".repeat(64))
    for (const event of [first, second]) {
      await persistProductDeletionDelivery(
        {
          signedEvent: event,
          currentWriteRelayUrls: ["wss://relay.conduit.market"],
          sourceRelayUrls: [],
          canonicalConduitRelayUrl: "wss://relay.conduit.market",
        },
        { repository: baseRepository, now: () => NOW }
      )
    }

    const repository: ProductDeletionOutboxRepository = {
      add: (job) => baseRepository.add(job),
      get: async (id) => {
        if (id === first.id) throw new Error("unreadable durable row")
        return await baseRepository.get(id)
      },
      listUndelivered: () => baseRepository.listUndelivered(),
      update: (id, updater) => baseRepository.update(id, updater),
    }
    const completed = await deliverPendingProductDeletions(
      async () => ({ status: "acked" }),
      withEligibleAccountRelays({ repository, now: () => NOW })
    )

    expect(completed.map(({ id }) => id)).toEqual([second.id])
    expect((await baseRepository.get(second.id))?.state).toBe("delivered")
    expect((await baseRepository.get(first.id))?.state).toBe("pending")
  })

  it("marks a fully acknowledged first attempt delivered", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const event = signedDeletionEvent()
    const now = tickingClock()
    await persistProductDeletionDelivery(
      {
        signedEvent: event,
        currentWriteRelayUrls: ["wss://relay.conduit.market"],
        sourceRelayUrls: ["wss://relay.conduit.market"],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { repository, now }
    )

    const result = await deliverProductDeletionJob(
      event.id,
      async () => ({ status: "acked" }),
      withEligibleAccountRelays({ repository, now })
    )

    expect(result.relayPlan).toEqual([
      {
        relayUrl: "wss://relay.conduit.market",
        roles: ["author_write", "source", "conduit"],
      },
    ])
    expect(result.relayDelivery).toEqual([
      {
        relayUrl: "wss://relay.conduit.market",
        status: "acked",
        attemptCount: 1,
        lastAttemptAt: expect.any(Number),
        acknowledgedAt: expect.any(Number),
      },
    ])
    expect(result.state).toBe("delivered")
  })
})
