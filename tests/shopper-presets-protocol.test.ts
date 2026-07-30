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

const nowMs = 1_770_000_000_000
const password = "correct horse battery staple"

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
        fetchEvents: async () => ({
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
        }),
        publishEvent: async (event) => {
          published = event
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
    expect(signerContent).toBe(serializeShopperPresetsEnvelope(result.envelope))
    for (const plaintext of ["Ada", "SW1Y", "London", "example.test"]) {
      expect(signerContent).not.toContain(plaintext)
    }
    expect(
      await decryptShopperPresetsDocument(result.envelope, password)
    ).toEqual(result.document)
  })
})
