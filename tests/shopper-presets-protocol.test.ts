import { describe, expect, it } from "bun:test"
import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  SHOPPER_PRESETS_D_TAG,
  SHOPPER_PRESETS_FORMAT,
  SHOPPER_PRESETS_KDF,
  buildShopperPresetsDocument,
  config,
  decryptShopperPresetsDocument,
  encryptShopperPresetsDocument,
  fetchShopperPresets,
  getShopperDiscoveryDestination,
  getShopperPresetsValue,
  parseShopperPresetsEnvelope,
  publishShopperPresets,
  selectLatestShopperPresetsEvent,
  serializeShopperPresetsEnvelope,
  type PublishWithPlannerResult,
  type ShopperPresetsDocument,
  type ShopperPresetsValue,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

const nowMs = 1_770_000_000_000
const password = "correct horse battery staple 7"

const preset: ShopperPresetsValue = {
  shipping: {
    recipientName: "Ada Lovelace",
    addressLine1: "12 St James Square",
    addressLine2: "Flat 3",
    city: "London",
    stateOrRegion: "Greater London",
    postalCode: "SW1Y 4LB",
    country: "GB",
    email: "ada@example.test",
    phone: "+44 20 0000 0000",
  },
  preferredRail: "nwc",
  display: { currency: "GBP", bitcoinUnit: "sats" },
}

function presetDocument(): ShopperPresetsDocument {
  return buildShopperPresetsDocument({
    value: preset,
    updatedAt: nowMs / 1_000,
  })
}

async function signerFixture() {
  const signer = NDKPrivateKeySigner.generate()
  const user = await signer.user()
  const ndk = new NDK({ explicitRelayUrls: [] })
  ndk.signer = signer
  return { signer, pubkey: user.pubkey, ndk }
}

function eventFixture(
  pubkey: string,
  input: { id: string; createdAt: number; content?: string }
): NDKEvent {
  const event = new NDKEvent()
  event.id = input.id
  event.pubkey = pubkey
  event.kind = EVENT_KINDS.APPLICATION_DATA
  event.created_at = input.createdAt
  event.tags = [["d", SHOPPER_PRESETS_D_TAG]]
  event.content = input.content ?? "invalid"
  return event
}

describe("NIP-78 shopper presets", () => {
  it("round-trips the complete address with the fixed interoperable envelope", async () => {
    let fill = 1
    const envelope = await encryptShopperPresetsDocument(
      presetDocument(),
      password,
      (length) => new Uint8Array(length).fill(fill++)
    )

    expect(envelope).toMatchObject({
      format: SHOPPER_PRESETS_FORMAT,
      version: 1,
      encryption: {
        kdf: "argon2id",
        parameters: {
          memoryKiB: SHOPPER_PRESETS_KDF.memoryKiB,
          iterations: SHOPPER_PRESETS_KDF.iterations,
          parallelism: SHOPPER_PRESETS_KDF.parallelism,
          keyLength: 32,
        },
        cipher: "xchacha20-poly1305",
      },
    })
    const serialized = serializeShopperPresetsEnvelope(envelope)
    expect(serialized).not.toContain("Ada")
    expect(serialized).toBe(JSON.stringify(envelope))
    expect(parseShopperPresetsEnvelope(serialized)).toEqual(envelope)
    expect(await decryptShopperPresetsDocument(envelope, password)).toEqual(
      presetDocument()
    )
  })

  it("rejects the wrong password and authenticated-ciphertext tampering", async () => {
    const envelope = await encryptShopperPresetsDocument(
      presetDocument(),
      password
    )
    await expect(
      decryptShopperPresetsDocument(envelope, "incorrect password")
    ).rejects.toThrow()
    const first = envelope.ciphertext.startsWith("A") ? "B" : "A"
    await expect(
      decryptShopperPresetsDocument(
        { ...envelope, ciphertext: `${first}${envelope.ciphertext.slice(1)}` },
        password
      )
    ).rejects.toThrow()
  })

  it("requires 16 password characters and one number", async () => {
    await expect(
      encryptShopperPresetsDocument(presetDocument(), "short pass 7")
    ).rejects.toThrow("16 or more characters")
    await expect(
      encryptShopperPresetsDocument(
        presetDocument(),
        "sixteen characters exactly"
      )
    ).rejects.toThrow("at least one number")
  })

  it("derives only the narrow discovery destination", () => {
    const value = getShopperPresetsValue(presetDocument())
    expect(getShopperDiscoveryDestination(value)).toEqual({
      country: "GB",
      postalCode: "SW1Y 4LB",
    })
    expect(Object.keys(getShopperDiscoveryDestination(value)!)).toEqual([
      "country",
      "postalCode",
    ])
  })

  it("uses the latest matching pubkey, kind, and d-tag event", async () => {
    const { pubkey } = await signerFixture()
    const older = eventFixture(pubkey, { id: "f".repeat(64), createdAt: 10 })
    const tiedHigher = eventFixture(pubkey, {
      id: "b".repeat(64),
      createdAt: 11,
    })
    const tiedLower = eventFixture(pubkey, {
      id: "a".repeat(64),
      createdAt: 11,
    })
    expect(
      selectLatestShopperPresetsEvent([older, tiedHigher, tiedLower], pubkey)
        ?.id
    ).toBe(tiedLower.id)
  })

  it("does not turn an incomplete empty read into not-found", async () => {
    const { pubkey } = await signerFixture()
    const result = await fetchShopperPresets(pubkey, {
      readRelayUrls: ["wss://relay.example"],
      getRelayLists: async () => new Map(),
      fetchEvents: async () => ({
        events: [],
        relays: [
          {
            relayUrl: "wss://relay.example",
            status: "partial",
            eventCount: 0,
          },
        ],
      }),
    })
    expect(result).toEqual({ state: "unavailable", reason: "relay_read" })
  })

  it("accepts a usable read when another planned relay fails", async () => {
    const { pubkey } = await signerFixture()
    const result = await fetchShopperPresets(pubkey, {
      readRelayUrls: ["wss://healthy.example", "wss://offline.example"],
      getRelayLists: async () => new Map(),
      fetchEvents: async () => ({
        events: [],
        relays: [
          {
            relayUrl: "wss://healthy.example",
            status: "success",
            eventCount: 0,
          },
          {
            relayUrl: "wss://offline.example",
            status: "failed",
            eventCount: 0,
          },
        ],
      }),
    })
    expect(result).toEqual({ state: "not_found" })
  })

  it("discovers relay hints and uses bounded preset read timeouts", async () => {
    const { pubkey } = await signerFixture()
    let relayListOptions:
      | {
          cacheOnly?: boolean
          relayUrls?: readonly string[]
          allowInsecureRelayUrlsForPubkey?: string | null
        }
      | undefined
    let fetchOptions:
      | {
          relayUrls?: readonly string[]
          connectTimeoutMs?: number
          fetchTimeoutMs?: number
        }
      | undefined

    const result = await fetchShopperPresets(pubkey, {
      getRelayLists: async (_pubkeys, options) => {
        relayListOptions = options
        return new Map()
      },
      fetchEvents: async (_filter, options) => {
        fetchOptions = options
        return {
          events: [],
          relays: [
            {
              relayUrl: options.relayUrls![0]!,
              status: "success",
              eventCount: 0,
            },
          ],
        }
      },
    })

    expect(result).toEqual({ state: "not_found" })
    expect(relayListOptions).toMatchObject({
      cacheOnly: false,
      allowInsecureRelayUrlsForPubkey: pubkey,
    })
    expect(relayListOptions!.relayUrls).toEqual([
      ...config.appWriteRelayUrls,
      ...config.corePublicFallbackRelayUrls,
    ])
    expect(fetchOptions).toMatchObject({
      connectTimeoutMs: 2_000,
      fetchTimeoutMs: 3_000,
    })
    expect(fetchOptions!.relayUrls![0]).toBe(config.appWriteRelayUrls[0])
    expect(fetchOptions!.relayUrls!.length).toBeLessThanOrEqual(6)
  })

  it("fails closed when the newest replacement has an invalid envelope", async () => {
    const { pubkey } = await signerFixture()
    const validEnvelope = await encryptShopperPresetsDocument(
      presetDocument(),
      password
    )
    const older = eventFixture(pubkey, {
      id: "b".repeat(64),
      createdAt: 10,
      content: serializeShopperPresetsEnvelope(validEnvelope),
    })
    const newer = eventFixture(pubkey, {
      id: "a".repeat(64),
      createdAt: 11,
      content: JSON.stringify({
        format: SHOPPER_PRESETS_FORMAT,
        version: 2,
      }),
    })

    const result = await fetchShopperPresets(pubkey, {
      readRelayUrls: ["wss://relay.example"],
      getRelayLists: async () => new Map(),
      fetchEvents: async () => ({
        events: [older, newer],
        relays: [
          {
            relayUrl: "wss://relay.example",
            status: "success",
            eventCount: 2,
          },
        ],
      }),
    })

    expect(result).toEqual({
      state: "unavailable",
      reason: "invalid_envelope",
      revision: { eventId: "a".repeat(64), createdAt: 11 },
    })
  })

  it("gives the signer ciphertext only", async () => {
    const { signer: realSigner, pubkey, ndk } = await signerFixture()
    let signerContent = ""
    let encryptionCalled = false
    const signer = {
      user: () => realSigner.user(),
      sign: async (event: NDKEvent) => {
        signerContent = event.content
        return realSigner.sign(event)
      },
      encrypt: async () => {
        encryptionCalled = true
        throw new Error("Signer encryption must not be called")
      },
      decrypt: async () => {
        encryptionCalled = true
        throw new Error("Signer decryption must not be called")
      },
    } as unknown as NDKSigner
    ndk.signer = signer
    let published: NDKEvent | null = null
    let publishOptions:
      { refreshRelayLists?: boolean; deliveryMode?: string } | undefined

    const result = await publishShopperPresets({
      pubkey,
      value: preset,
      password,
      appId: "market",
      dependencies: {
        signer,
        ndk,
        readRelayUrls: ["wss://relay.example", "wss://offline.example"],
        now: () => nowMs,
        getRelayLists: async () => new Map(),
        fetchEvents: async () => {
          if (published) {
            attachEventSourceRelayUrl(published, "wss://relay.example")
          }
          return {
            events: published ? [published] : [],
            relays: [
              {
                relayUrl: "wss://relay.example",
                status: "success",
                eventCount: published ? 1 : 0,
              },
              {
                relayUrl: "wss://offline.example",
                status: "failed",
                eventCount: 0,
              },
            ],
          }
        },
        publishEvent: async (event, options) => {
          published = event
          publishOptions = options
          return {
            plan: {
              intent: "author_event",
              primaryRelayUrls: ["wss://relay.example"],
              broadcastRelayUrls: [],
              parkedRelayUrls: [],
              hintRelayUrls: [],
            },
            attemptedRelayUrls: ["wss://relay.example"],
            successfulRelayUrls: ["wss://relay.example"],
            failedRelayUrls: [],
            relayFailureMessages: {},
          } as PublishWithPlannerResult
        },
      },
    })

    expect(encryptionCalled).toBe(false)
    expect(publishOptions).toMatchObject({
      refreshRelayLists: false,
      deliveryMode: "standard",
    })
    expect(signerContent).toBe(serializeShopperPresetsEnvelope(result.envelope))
    for (const plaintext of ["Ada", "SW1Y", "London", "example.test"]) {
      expect(signerContent).not.toContain(plaintext)
    }
    expect(
      await decryptShopperPresetsDocument(result.envelope, password)
    ).toEqual(result.document)
  })

  it("requires complete convergence on every attempted write relay", async () => {
    for (const relayB of [
      { status: "failed" as const, storesEvent: true },
      { status: "success" as const, storesEvent: false },
    ]) {
      const { signer, pubkey, ndk } = await signerFixture()
      let published: NDKEvent | null = null

      await expect(
        publishShopperPresets({
          pubkey,
          value: preset,
          password,
          appId: "market",
          dependencies: {
            signer,
            ndk,
            now: () => nowMs,
            getRelayLists: async () => new Map(),
            fetchEvents: async () => {
              if (published) {
                attachEventSourceRelayUrl(published, "wss://relay-a.example")
                if (relayB.storesEvent) {
                  attachEventSourceRelayUrl(published, "wss://relay-b.example")
                }
              }
              return {
                events: published ? [published] : [],
                relays: [
                  {
                    relayUrl: "wss://relay-a.example",
                    status: "success",
                    eventCount: published ? 1 : 0,
                  },
                  {
                    relayUrl: "wss://relay-b.example",
                    status: relayB.status,
                    eventCount: published && relayB.storesEvent ? 1 : 0,
                  },
                ],
              }
            },
            publishEvent: async (event) => {
              published = event
              return {
                plan: {
                  intent: "author_event",
                  primaryRelayUrls: [
                    "wss://relay-a.example",
                    "wss://relay-b.example",
                  ],
                  broadcastRelayUrls: [],
                  parkedRelayUrls: [],
                  hintRelayUrls: [],
                },
                attemptedRelayUrls: [
                  "wss://relay-a.example",
                  "wss://relay-b.example",
                ],
                successfulRelayUrls: ["wss://relay-a.example"],
                failedRelayUrls: ["wss://relay-b.example"],
                relayFailureMessages: {},
              } as PublishWithPlannerResult
            },
          },
        })
      ).rejects.toThrow(
        "The published shopper preset did not converge on relay storage."
      )
    }
  })
})
