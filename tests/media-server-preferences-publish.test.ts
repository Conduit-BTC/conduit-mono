import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import {
  __resetMediaServerPreferencesForTests,
  BLOSSOM_SERVER_LIST_KIND,
  getMediaServerPreferencesStorageKey,
  loadMediaServerPreferenceRecord,
  publishMediaServerPreferences,
  readMediaServerPreferences,
  retryMediaServerPreferencesPublish,
  saveMediaServerDraft,
  toReviewedMediaServerEvidence,
  type MediaServerPreferencesStorage,
  type PublishMediaServerPreferencesDependencies,
} from "../packages/core/src/protocol/media-server-preferences"
import {
  NostrSignerError,
  type NostrEventSigner,
} from "../packages/core/src/protocol/nostr-event-signer"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"

const OWNER_KEY = generateSecretKey()
const OTHER_KEY = generateSecretKey()
const OWNER = getPublicKey(OWNER_KEY)
const OTHER_OWNER = getPublicKey(OTHER_KEY)
const NOW = 1_700_000_000_000

class MemoryStorage implements MediaServerPreferencesStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function signer(
  options: {
    pubkey?: string
    secretKey?: Uint8Array
    onSign?: (event: SignedPublicNostrEvent) => void
    failure?: NostrSignerError
  } = {}
): NostrEventSigner {
  return {
    authMethod: "nip07",
    getPublicKey: async () => options.pubkey ?? OWNER,
    signEvent: async (unsigned) => {
      if (options.failure) throw options.failure
      const signed = finalizeEvent(unsigned, options.secretKey ?? OWNER_KEY)
      options.onSign?.(signed)
      return signed
    },
  }
}

function readResult(input: {
  events?: SignedPublicNostrEvent[]
  relayUrls: readonly string[]
  sources?: Record<string, string[]>
  failedRelayUrls?: readonly string[]
}) {
  const events = input.events ?? []
  const failed = new Set(input.failedRelayUrls ?? [])
  return {
    events,
    eventSourceRelayUrls: input.sources ?? {},
    relays: input.relayUrls.map((relayUrl) => ({
      relayUrl,
      status: failed.has(relayUrl) ? ("failed" as const) : ("success" as const),
      eventCount: events.length,
      rejectedEventCount: 0,
    })),
    eventsVerified: true,
  }
}

async function reviewedEmpty(
  storage: MemoryStorage,
  relayUrls = ["wss://one.conduit.market", "wss://two.conduit.market"]
) {
  return await readMediaServerPreferences(OWNER, {
    storage,
    now: () => NOW,
    readRelayUrls: relayUrls,
    fetchEvents: async () => readResult({ relayUrls }),
  })
}

beforeEach(() => {
  __resetMediaServerPreferencesForTests()
})

describe("explicit kind 10063 publication", () => {
  it("signs the displayed ordered list, bounds relay targets, and confirms exact read-back", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    let signed: SignedPublicNostrEvent | null = null
    const attempted: string[] = []
    const phases: string[] = []
    const targets = Array.from(
      { length: 8 },
      (_, index) => `wss://relay-${index}.conduit.market`
    )
    const dependencies: PublishMediaServerPreferencesDependencies = {
      storage,
      now: () => NOW,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      publishRelayUrls: targets,
      onPhase: (phase) => phases.push(phase),
      publishToRelay: async (input) => {
        signed = input.signedEvent
        attempted.push(input.relayUrl)
        return "acked"
      },
      fetchEvents: async (filter, options) => {
        if (filter.ids?.length && signed) {
          return readResult({
            events: [signed],
            relayUrls: options.relayUrls,
            sources: { [signed.id]: [...options.relayUrls] },
          })
        }
        return readResult({ relayUrls: options.relayUrls })
      },
    }

    const result = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: [
        "https://second.conduit.market",
        "https://first.conduit.market",
      ],
      signer: signer(),
      reviewed: toReviewedMediaServerEvidence(resolution),
      dependencies,
    })

    expect(result.outcome).toBe("confirmed")
    expect(result.targetRelayCount).toBe(6)
    expect(attempted).toEqual(targets.slice(0, 6))
    expect(signed).not.toBeNull()
    expect(verifyEvent(signed!)).toBe(true)
    expect(signed).toMatchObject({
      kind: BLOSSOM_SERVER_LIST_KIND,
      pubkey: OWNER,
      created_at: NOW / 1_000,
      content: "",
      tags: [
        ["server", "https://second.conduit.market"],
        ["server", "https://first.conduit.market"],
      ],
    })
    expect(phases).toEqual([
      "checking",
      "awaiting_signature",
      "publishing",
      "confirming",
    ])
    expect(
      loadMediaServerPreferenceRecord(OWNER, storage).pending
    ).toBeUndefined()
  })

  it("reports partial acceptance, retains the exact event, and retries without signing again", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    const targets = ["wss://one.conduit.market", "wss://two.conduit.market"]
    let signed: SignedPublicNostrEvent | null = null
    let signCalls = 0
    let secondRelayAccepts = false
    const attempts: string[] = []
    const dependencies: PublishMediaServerPreferencesDependencies = {
      storage,
      now: () => NOW,
      readRelayUrls: targets,
      publishRelayUrls: targets,
      publishToRelay: async (input) => {
        signed = input.signedEvent
        attempts.push(input.relayUrl)
        if (input.relayUrl === targets[1] && !secondRelayAccepts) {
          return "rejected"
        }
        return "acked"
      },
      fetchEvents: async (filter, options) => {
        if (filter.ids?.length && signed) {
          const visibleSources = secondRelayAccepts
            ? [...options.relayUrls]
            : [targets[0]!]
          return readResult({
            events: [signed],
            relayUrls: options.relayUrls,
            sources: { [signed.id]: visibleSources },
          })
        }
        return readResult({ relayUrls: options.relayUrls })
      },
    }
    const externalSigner = signer({
      onSign: () => {
        signCalls += 1
      },
    })

    const first = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: ["https://media.conduit.market"],
      signer: externalSigner,
      reviewed: toReviewedMediaServerEvidence(resolution),
      dependencies,
    })
    expect(first).toMatchObject({
      outcome: "partial",
      acceptedRelayCount: 1,
      rejectedRelayCount: 1,
      partialAcceptance: true,
      retryAvailable: true,
    })
    const retained = loadMediaServerPreferenceRecord(OWNER, storage).pending
    expect(retained?.signedEvent.id).toBe(signed?.id)
    expect(retained?.publishRelayUrls).toEqual(targets)

    secondRelayAccepts = true
    const retried = await retryMediaServerPreferencesPublish({
      owner: OWNER,
      dependencies,
    })
    expect(retried).toMatchObject({
      outcome: "confirmed",
      acceptedRelayCount: 2,
      rejectedRelayCount: 0,
      retryAvailable: false,
    })
    expect(signCalls).toBe(1)
    expect(attempts).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
      "wss://two.conduit.market",
    ])
    expect(
      loadMediaServerPreferenceRecord(OWNER, storage).pending
    ).toBeUndefined()
  })

  it("distinguishes full rejection from accepted-but-pending confirmation", async () => {
    const rejectedStorage = new MemoryStorage()
    const rejectedResolution = await reviewedEmpty(rejectedStorage, [
      "wss://reject.conduit.market",
    ])
    const rejected = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: ["https://media.conduit.market"],
      signer: signer(),
      reviewed: toReviewedMediaServerEvidence(rejectedResolution),
      dependencies: {
        storage: rejectedStorage,
        now: () => NOW,
        readRelayUrls: ["wss://reject.conduit.market"],
        publishRelayUrls: ["wss://reject.conduit.market"],
        publishToRelay: async () => "rejected",
        fetchEvents: async (_filter, options) =>
          readResult({ relayUrls: options.relayUrls }),
      },
    })
    expect(rejected).toMatchObject({
      outcome: "rejected",
      acceptedRelayCount: 0,
      rejectedRelayCount: 1,
      confirmed: false,
      retryAvailable: true,
    })

    __resetMediaServerPreferencesForTests()
    const pendingStorage = new MemoryStorage()
    const pendingResolution = await reviewedEmpty(pendingStorage, [
      "wss://pending.conduit.market",
    ])
    const pending = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: ["https://media.conduit.market"],
      signer: signer(),
      reviewed: toReviewedMediaServerEvidence(pendingResolution),
      dependencies: {
        storage: pendingStorage,
        now: () => NOW,
        readRelayUrls: ["wss://pending.conduit.market"],
        publishRelayUrls: ["wss://pending.conduit.market"],
        publishToRelay: async () => "acked",
        fetchEvents: async (_filter, options) =>
          readResult({ relayUrls: options.relayUrls }),
      },
    })
    expect(pending).toMatchObject({
      outcome: "confirmation_pending",
      acceptedRelayCount: 1,
      confirmed: false,
      retryAvailable: true,
    })
  })

  it("blocks signer mismatch and unavailable replacement evidence before signing", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    let signCalls = 0
    await expect(
      publishMediaServerPreferences({
        owner: OWNER,
        serverUrls: ["https://media.conduit.market"],
        signer: signer({
          pubkey: OTHER_OWNER,
          secretKey: OTHER_KEY,
          onSign: () => {
            signCalls += 1
          },
        }),
        reviewed: toReviewedMediaServerEvidence(resolution),
        dependencies: {
          storage,
          now: () => NOW,
          readRelayUrls: [
            "wss://one.conduit.market",
            "wss://two.conduit.market",
          ],
          publishRelayUrls: ["wss://one.conduit.market"],
          fetchEvents: async (_filter, options) =>
            readResult({ relayUrls: options.relayUrls }),
        },
      })
    ).rejects.toMatchObject({ code: "signer_mismatch" })
    expect(signCalls).toBe(0)

    __resetMediaServerPreferencesForTests()
    const degradedStorage = new MemoryStorage()
    const degraded = await readMediaServerPreferences(OWNER, {
      storage: degradedStorage,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents: async () =>
        readResult({
          relayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
          failedRelayUrls: [
            "wss://one.conduit.market",
            "wss://two.conduit.market",
          ],
        }),
    })
    await expect(
      publishMediaServerPreferences({
        owner: OWNER,
        serverUrls: ["https://media.conduit.market"],
        signer: signer({
          onSign: () => {
            signCalls += 1
          },
        }),
        reviewed: toReviewedMediaServerEvidence(degraded),
        dependencies: {
          storage: degradedStorage,
          readRelayUrls: [
            "wss://one.conduit.market",
            "wss://two.conduit.market",
          ],
          publishRelayUrls: ["wss://one.conduit.market"],
          fetchEvents: async () =>
            readResult({
              relayUrls: [
                "wss://one.conduit.market",
                "wss://two.conduit.market",
              ],
              failedRelayUrls: [
                "wss://one.conduit.market",
                "wss://two.conduit.market",
              ],
            }),
        },
      })
    ).rejects.toMatchObject({ code: "evidence_unavailable" })
    expect(signCalls).toBe(0)
  })

  it("surfaces signer cancellation without staging or relay I/O", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    let publishCalls = 0
    await expect(
      publishMediaServerPreferences({
        owner: OWNER,
        serverUrls: ["https://media.conduit.market"],
        signer: signer({
          failure: new NostrSignerError("authorization_denied"),
        }),
        reviewed: toReviewedMediaServerEvidence(resolution),
        dependencies: {
          storage,
          now: () => NOW,
          readRelayUrls: [
            "wss://one.conduit.market",
            "wss://two.conduit.market",
          ],
          publishRelayUrls: ["wss://one.conduit.market"],
          fetchEvents: async (_filter, options) =>
            readResult({ relayUrls: options.relayUrls }),
          publishToRelay: async () => {
            publishCalls += 1
            return "acked"
          },
        },
      })
    ).rejects.toMatchObject({ code: "authorization_denied" })
    expect(publishCalls).toBe(0)
    expect(
      loadMediaServerPreferenceRecord(OWNER, storage).pending
    ).toBeUndefined()
  })

  it("rechecks the durable frontier after signing before any relay I/O", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    const competing = finalizeEvent(
      {
        kind: BLOSSOM_SERVER_LIST_KIND,
        created_at: NOW / 1_000 + 1,
        tags: [["server", "https://newer.conduit.market"]],
        content: "",
      },
      OWNER_KEY
    )
    let publishCalls = 0
    await expect(
      publishMediaServerPreferences({
        owner: OWNER,
        serverUrls: ["https://media.conduit.market"],
        signer: signer({
          onSign: () => {
            storage.setItem(
              getMediaServerPreferencesStorageKey(OWNER),
              JSON.stringify({
                version: 1,
                owner: OWNER,
                frontier: {
                  eventId: competing.id,
                  createdAt: competing.created_at,
                  state: "valid",
                },
              })
            )
          },
        }),
        reviewed: toReviewedMediaServerEvidence(resolution),
        dependencies: {
          storage,
          now: () => NOW,
          readRelayUrls: ["wss://one.conduit.market"],
          publishRelayUrls: ["wss://one.conduit.market"],
          fetchEvents: async (_filter, options) =>
            readResult({ relayUrls: options.relayUrls }),
          publishToRelay: async () => {
            publishCalls += 1
            return "acked"
          },
        },
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })
    expect(publishCalls).toBe(0)
  })

  it("preserves a newer partial checkpoint and draft across a delayed read", async () => {
    const storage = new MemoryStorage()
    const resolution = await reviewedEmpty(storage)
    const targets = ["wss://one.conduit.market", "wss://two.conduit.market"]
    let resolveDelayed!: (value: ReturnType<typeof readResult>) => void
    const delayedResult = new Promise<ReturnType<typeof readResult>>(
      (resolve) => {
        resolveDelayed = resolve
      }
    )
    const delayedRead = readMediaServerPreferences(OWNER, {
      storage,
      now: () => NOW + 10,
      readRelayUrls: targets,
      fetchEvents: async () => await delayedResult,
    })
    let signed: SignedPublicNostrEvent | null = null
    const published = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: ["https://partial.conduit.market"],
      signer: signer(),
      reviewed: toReviewedMediaServerEvidence(resolution),
      dependencies: {
        storage,
        now: () => NOW + 1,
        readRelayUrls: targets,
        publishRelayUrls: targets,
        publishToRelay: async (input) => {
          signed = input.signedEvent
          return input.relayUrl === targets[0] ? "acked" : "rejected"
        },
        fetchEvents: async (filter, options) =>
          filter.ids?.length && signed
            ? readResult({
                events: [signed],
                relayUrls: options.relayUrls,
                sources: { [signed.id]: [targets[0]!] },
              })
            : readResult({ relayUrls: options.relayUrls }),
      },
    })
    expect(published.outcome).toBe("partial")
    saveMediaServerDraft(
      OWNER,
      {
        serverUrls: ["https://draft.conduit.market"],
        baseServerUrls: [],
        baseEventId: null,
        updatedAt: NOW + 20,
      },
      storage
    )

    resolveDelayed(readResult({ relayUrls: targets }))
    await delayedRead

    const retained = loadMediaServerPreferenceRecord(OWNER, storage)
    expect(retained.pending).toMatchObject({
      signedEvent: { id: signed?.id },
      acknowledgedRelayUrls: [targets[0]],
    })
    expect(retained.frontier?.eventId).toBe(signed?.id)
    expect(retained.published?.signedEvent.id).toBe(signed?.id)
    expect(retained.draft?.serverUrls).toEqual(["https://draft.conduit.market"])
  })

  it("retires a superseded pending update before retry relay I/O", async () => {
    const storage = new MemoryStorage()
    const target = "wss://one.conduit.market"
    const resolution = await reviewedEmpty(storage, [target])
    const initial = await publishMediaServerPreferences({
      owner: OWNER,
      serverUrls: ["https://older.conduit.market"],
      signer: signer(),
      reviewed: toReviewedMediaServerEvidence(resolution),
      dependencies: {
        storage,
        now: () => NOW,
        readRelayUrls: [target],
        publishRelayUrls: [target],
        publishToRelay: async () => "timed_out",
        fetchEvents: async (_filter, options) =>
          readResult({ relayUrls: options.relayUrls }),
      },
    })
    expect(initial).toMatchObject({ outcome: "failed", retryAvailable: true })
    const oldPending = loadMediaServerPreferenceRecord(OWNER, storage).pending!
    const newer = finalizeEvent(
      {
        kind: BLOSSOM_SERVER_LIST_KIND,
        created_at: oldPending.signedEvent.created_at + 1,
        tags: [["server", "https://newer.conduit.market"]],
        content: "",
      },
      OWNER_KEY
    )
    let publishCalls = 0

    await expect(
      retryMediaServerPreferencesPublish({
        owner: OWNER,
        dependencies: {
          storage,
          now: () => NOW + 1_000,
          readRelayUrls: [target],
          publishRelayUrls: [target],
          publishToRelay: async () => {
            publishCalls += 1
            return "acked"
          },
          fetchEvents: async (_filter, options) =>
            readResult({
              events: [newer],
              relayUrls: options.relayUrls,
              sources: { [newer.id]: [target] },
            }),
        },
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })

    const record = loadMediaServerPreferenceRecord(OWNER, storage)
    expect(publishCalls).toBe(0)
    expect(record.pending).toBeUndefined()
    expect(record.frontier?.eventId).toBe(newer.id)
    expect(record.published?.signedEvent.id).toBe(newer.id)
  })
})
