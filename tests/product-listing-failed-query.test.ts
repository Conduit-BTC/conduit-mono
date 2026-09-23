import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  getPendingProductListingDeliveries,
  getProductListingDeliveryJobId,
  getRejectedProductListingDeliveries,
  type ProductListingDeliveryJob,
  type ProductListingOutboxRepository,
} from "@conduit/core"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const OTHER_MERCHANT = getPublicKey(generateSecretKey())
const RELAYS = ["wss://first.example", "wss://second.example"]

function listingJob(
  dTag: string,
  overrides: Partial<ProductListingDeliveryJob> = {}
): ProductListingDeliveryJob {
  const signedEvent = finalizeEvent(
    {
      kind: 30402,
      created_at: 1_800_000_000,
      tags: [["d", dTag]],
      content: "",
    },
    MERCHANT_SECRET
  )
  return {
    id: getProductListingDeliveryJobId([signedEvent]),
    merchantPubkey: MERCHANT,
    signedEvents: [signedEvent],
    relayTargets: RELAYS.map((relayUrl) => ({
      relayUrl,
      ownerSelected: false,
      appRelay: true,
    })),
    relayDelivery: RELAYS.map((relayUrl) => ({
      eventId: signedEvent.id,
      relayUrl,
      status: "rejected" as const,
      attemptCount: 1,
      rejectedAt: 1_800_000_000_001,
    })),
    readyForDelivery: true,
    state: "failed",
    deliveryAttemptCount: 1,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001,
    ...overrides,
  }
}

class MemoryProductListingOutbox implements ProductListingOutboxRepository {
  private readonly jobs = new Map<string, ProductListingDeliveryJob>()

  constructor(jobs: ProductListingDeliveryJob[]) {
    for (const job of jobs) this.jobs.set(job.id, structuredClone(job))
  }

  async add(job: ProductListingDeliveryJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job))
  }

  async get(id: string): Promise<ProductListingDeliveryJob | undefined> {
    const job = this.jobs.get(id)
    return job ? structuredClone(job) : undefined
  }

  async listUndelivered(): Promise<ProductListingDeliveryJob[]> {
    return Array.from(this.jobs.values())
      .filter((job) => job.state === "pending" || job.state === "partial")
      .map((job) => structuredClone(job))
  }

  async listFailed(
    merchantPubkey: string
  ): Promise<ProductListingDeliveryJob[]> {
    // Deliberately return every stored row to verify the public read boundary
    // enforces its merchant scope even if a repository fails to do so.
    if (!merchantPubkey) return []
    return Array.from(this.jobs.values()).map((job) => structuredClone(job))
  }

  async update(
    id: string,
    updater: (current: ProductListingDeliveryJob) => ProductListingDeliveryJob
  ): Promise<ProductListingDeliveryJob> {
    const current = this.jobs.get(id)
    if (!current) throw new Error("missing")
    const next = updater(structuredClone(current))
    this.jobs.set(id, structuredClone(next))
    return structuredClone(next)
  }
}

describe("terminal product listing delivery inspection", () => {
  it("returns only the merchant's zero-ACK fully rejected jobs after reload", async () => {
    const older = listingJob("older")
    const newer = listingJob("newer", { createdAt: older.createdAt + 1 })
    const otherMerchant = listingJob("other", {
      merchantPubkey: OTHER_MERCHANT,
    })
    const repository = new MemoryProductListingOutbox([
      newer,
      otherMerchant,
      older,
    ])

    const found = await getRejectedProductListingDeliveries(MERCHANT, {
      repository,
    })
    expect(found.map((job) => job.id)).toEqual([older.id, newer.id])
    expect(await getPendingProductListingDeliveries({ repository })).toEqual([])
    found[0]!.relayDelivery[0]!.status = "acked"
    expect((await repository.get(older.id))?.relayDelivery[0]?.status).toBe(
      "rejected"
    )
  })

  it("excludes mixed ACK, timeout, missing, duplicate, unattempted, and corrupt evidence", async () => {
    const valid = listingJob("valid")
    const mixedAck = listingJob("mixed-ack")
    mixedAck.relayDelivery[0]!.status = "acked"
    const mixedTimeout = listingJob("mixed-timeout")
    mixedTimeout.relayDelivery[0]!.status = "timed_out"
    const missingPair = listingJob("missing-pair")
    missingPair.relayDelivery.pop()
    const duplicatePair = listingJob("duplicate-pair")
    duplicatePair.relayDelivery[1] = structuredClone(
      duplicatePair.relayDelivery[0]!
    )
    const unattempted = listingJob("unattempted")
    unattempted.relayDelivery[0]!.attemptCount = 0
    const unarmed = listingJob("unarmed", { readyForDelivery: false })
    const unrun = listingJob("unrun", { deliveryAttemptCount: 0 })
    const notFailed = listingJob("not-failed", { state: "partial" })
    const corrupt = listingJob("corrupt")
    corrupt.signedEvents[0]!.content = "tampered after signing"
    const repository = new MemoryProductListingOutbox([
      valid,
      mixedAck,
      mixedTimeout,
      missingPair,
      duplicatePair,
      unattempted,
      unarmed,
      unrun,
      notFailed,
      corrupt,
    ])

    const found = await getRejectedProductListingDeliveries(MERCHANT, {
      repository,
    })
    expect(found.map((job) => job.id)).toEqual([valid.id])
  })

  it("fails closed when the repository cannot inspect failed jobs", async () => {
    const repository: ProductListingOutboxRepository = {
      add: async () => {},
      get: async () => undefined,
      listUndelivered: async () => [],
      update: async () => {
        throw new Error("unused")
      },
    }
    await expect(
      getRejectedProductListingDeliveries(MERCHANT, { repository })
    ).rejects.toThrow("cannot inspect failed jobs")
    await expect(
      getRejectedProductListingDeliveries("not-a-pubkey", { repository })
    ).rejects.toThrow("valid merchant pubkey")
  })
})
