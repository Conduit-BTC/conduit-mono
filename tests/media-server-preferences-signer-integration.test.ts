import { beforeEach, describe, expect, it } from "bun:test"
import type { NostrEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import {
  __resetMediaServerPreferencesForTests,
  BLOSSOM_SERVER_LIST_KIND,
  publishMediaServerPreferences,
  readMediaServerPreferences,
  toReviewedMediaServerEvidence,
  type MediaServerPreferencesStorage,
} from "../packages/core/src/protocol/media-server-preferences"
import { createNdkNostrEventSigner } from "../packages/core/src/protocol/ndk-nostr-event-signer"
import { Nip07SessionSigner } from "../packages/core/src/protocol/nip07-signer"
import {
  NdkBunkerSignerAdapter,
  type RemoteBunkerSigner,
} from "../packages/core/src/protocol/remote-signer"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"

const PRIVATE_KEY = generateSecretKey()
const PUBKEY = getPublicKey(PRIVATE_KEY)
const RELAY_URL = "wss://relay.conduit.market"

class MemoryStorage implements MediaServerPreferencesStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

async function publishWithExternalSigner(
  externalSigner: NostrEventSigner,
  storage: MemoryStorage
): Promise<SignedPublicNostrEvent> {
  let published: SignedPublicNostrEvent | null = null
  const fetchEvents = async (
    filter: { ids?: string[] },
    options: { relayUrls: string[] }
  ) => ({
    events: filter.ids?.length && published ? [published] : [],
    eventSourceRelayUrls:
      filter.ids?.length && published ? { [published.id]: [RELAY_URL] } : {},
    relays: options.relayUrls.map((relayUrl) => ({
      relayUrl,
      status: "success" as const,
      eventCount: filter.ids?.length && published ? 1 : 0,
      rejectedEventCount: 0,
    })),
    eventsVerified: true,
  })
  const resolution = await readMediaServerPreferences(PUBKEY, {
    storage,
    readRelayUrls: [RELAY_URL],
    fetchEvents,
  })
  const result = await publishMediaServerPreferences({
    owner: PUBKEY,
    serverUrls: ["https://media.conduit.market"],
    signer: externalSigner,
    reviewed: toReviewedMediaServerEvidence(resolution),
    dependencies: {
      storage,
      readRelayUrls: [RELAY_URL],
      publishRelayUrls: [RELAY_URL],
      fetchEvents,
      publishToRelay: async (input) => {
        published = input.signedEvent
        return "acked"
      },
    },
  })
  expect(result.outcome).toBe("confirmed")
  expect(published).not.toBeNull()
  return published!
}

beforeEach(() => {
  __resetMediaServerPreferencesForTests()
})

describe("kind 10063 external-signer integration", () => {
  it("publishes through the production NIP-07 session fence", async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        nostr: {
          getPublicKey: async () => PUBKEY,
          signEvent: async (event: NostrEvent) =>
            finalizeEvent(
              {
                kind: event.kind,
                pubkey: event.pubkey,
                created_at: event.created_at,
                tags: event.tags,
                content: event.content,
              },
              PRIVATE_KEY
            ),
        },
      },
    })
    try {
      const nip07 = new Nip07SessionSigner()
      await nip07.blockUntilReady()
      const session = new SessionSigner(nip07, {
        expectedPubkey: PUBKEY,
        hasAuthority: () => true,
      })
      const signed = await publishWithExternalSigner(
        createNdkNostrEventSigner(session, PUBKEY, "nip07"),
        new MemoryStorage()
      )
      expect(verifyEvent(signed)).toBe(true)
      expect(signed.kind).toBe(BLOSSOM_SERVER_LIST_KIND)
      expect(signed.tags).toEqual([["server", "https://media.conduit.market"]])
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: originalWindow,
      })
    }
  })

  it("publishes through the production NIP-46 session fence", async () => {
    const bunkerSigner = {
      signEvent: async (event: NostrEvent) =>
        finalizeEvent(
          {
            kind: event.kind,
            pubkey: event.pubkey,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
          },
          PRIVATE_KEY
        ),
      close: async () => undefined,
    } as unknown as RemoteBunkerSigner
    const nip46 = new NdkBunkerSignerAdapter(bunkerSigner, PUBKEY)
    const session = new SessionSigner(nip46, {
      expectedPubkey: PUBKEY,
      hasAuthority: () => true,
    })
    const signed = await publishWithExternalSigner(
      createNdkNostrEventSigner(session, PUBKEY, "nip46"),
      new MemoryStorage()
    )
    expect(verifyEvent(signed)).toBe(true)
    expect(signed.kind).toBe(BLOSSOM_SERVER_LIST_KIND)
    expect(signed.tags).toEqual([["server", "https://media.conduit.market"]])
  })
})
