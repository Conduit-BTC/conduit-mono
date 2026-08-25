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

function relayResult(
  events: NDKEvent[],
  relays: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
    eventCount: number
  }>
) {
  return { events, relays }
}

function publishResult(input: {
  primaryRelayUrls?: string[]
  broadcastRelayUrls?: string[]
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
}) {
  return {
    plan: {
      intent: "author_event" as const,
      primaryRelayUrls: input.primaryRelayUrls ?? [],
      broadcastRelayUrls: input.broadcastRelayUrls ?? [],
      parkedRelayUrls: [],
      hintRelayUrls: [],
    },
    attemptedRelayUrls: input.attemptedRelayUrls,
    successfulRelayUrls: input.successfulRelayUrls,
    failedRelayUrls: input.failedRelayUrls,
    relayFailureMessages: {},
  }
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
      fetchEvents: async () =>
        relayResult(
          [],
          [
            {
              relayUrl: "wss://relay.example",
              status: "partial",
              eventCount: 0,
            },
          ]
        ),
    })
    expect(result).toEqual({ state: "unavailable", reason: "relay_read" })
  })

  it("accepts a usable read when another planned relay fails", async () => {
    const { pubkey } = await signerFixture()
    const result = await fetchShopperPresets(pubkey, {
      readRelayUrls: ["wss://healthy.example", "wss://offline.example"],
      getRelayLists: async () => new Map(),
      fetchEvents: async () =>
        relayResult(
          [],
          [
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
          ]
        ),
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
        return relayResult(
          [],
          [
            {
              relayUrl: options.relayUrls![0]!,
              status: "success",
              eventCount: 0,
            },
          ]
        )
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
      fetchEvents: async () =>
        relayResult(
          [older, newer],
          [
            {
              relayUrl: "wss://relay.example",
              status: "success",
              eventCount: 2,
            },
          ]
        ),
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
          return relayResult(published ? [published] : [], [
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
          ])
        },
        publishEvent: async (event, options) => {
          published = event
          publishOptions = options
          return publishResult({
            primaryRelayUrls: ["wss://relay.example"],
            attemptedRelayUrls: ["wss://relay.example"],
            successfulRelayUrls: ["wss://relay.example"],
            failedRelayUrls: [],
          })
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

  it("accepts readback from one acknowledged relay when another attempted relay failed", async () => {
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
            }
            return relayResult(published ? [published] : [], [
              {
                relayUrl: "wss://relay-a.example",
                status: "success",
                eventCount: published ? 1 : 0,
              },
            ])
          },
          publishEvent: async (event) => {
            published = event
            return publishResult({
              primaryRelayUrls: ["wss://relay-a.example"],
              attemptedRelayUrls: [
                "wss://relay-a.example",
                "wss://relay-b.example",
              ],
              successfulRelayUrls: ["wss://relay-a.example"],
              failedRelayUrls: ["wss://relay-b.example"],
            })
          },
        },
      })
    ).resolves.toMatchObject({ revision: { createdAt: nowMs / 1_000 } })
  })

  it("accepts one complete acknowledged target when another acknowledged target is unavailable", async () => {
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
              attachEventSourceRelayUrl(published, "wss://relay-b.example")
            }
            return relayResult(published ? [published] : [], [
              {
                relayUrl: "wss://relay-a.example",
                status: "failed",
                eventCount: 0,
              },
              {
                relayUrl: "wss://relay-b.example",
                status: "success",
                eventCount: published ? 1 : 0,
              },
            ])
          },
          publishEvent: async (event) => {
            published = event
            return publishResult({
              primaryRelayUrls: ["wss://relay-a.example"],
              broadcastRelayUrls: ["wss://relay-b.example"],
              attemptedRelayUrls: [
                "wss://relay-a.example",
                "wss://relay-b.example",
              ],
              successfulRelayUrls: [
                "wss://relay-a.example",
                "wss://relay-b.example",
              ],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).resolves.toBeDefined()
  })

  it("does not converge exact readback from a partially completed source", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published: NDKEvent | null = null
    let readbackAttempts = 0
    let waits = 0

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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () => {
            if (published) {
              readbackAttempts += 1
              attachEventSourceRelayUrl(published, "wss://relay.example")
            }
            return relayResult(published ? [published] : [], [
              {
                relayUrl: "wss://relay.example",
                status: published ? "partial" : "success",
                eventCount: published ? 1 : 0,
              },
            ])
          },
          publishEvent: async (event) => {
            published = event
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).rejects.toThrow("did not converge")

    expect(readbackAttempts).toBe(3)
    expect(waits).toBe(2)
  })

  it("fails when publishing has no acknowledged relay targets", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    await expect(
      publishShopperPresets({
        pubkey,
        value: preset,
        password,
        appId: "market",
        dependencies: {
          signer,
          ndk,
          getRelayLists: async () => new Map(),
          fetchEvents: async () =>
            relayResult(
              [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: 0,
                },
              ]
            ),
          publishEvent: async () =>
            publishResult({
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: [],
              failedRelayUrls: ["wss://relay.example"],
            }),
        },
      })
    ).rejects.toThrow("did not converge")
  })

  it("fails closed when readback selects a newer competing winner", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published = false
    let waits = 0
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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () =>
            relayResult(
              published
                ? [
                    eventFixture(pubkey, {
                      id: "b".repeat(64),
                      createdAt: nowMs / 1_000 + 1,
                    }),
                  ]
                : [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: published ? 1 : 0,
                },
              ]
            ),
          publishEvent: async () => {
            published = true
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).rejects.toThrow("did not converge")
    expect(waits).toBe(0)
  })

  it("fails immediately when an equal-timestamp lower-ID competitor wins", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published = false
    let waits = 0

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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () =>
            relayResult(
              published
                ? [
                    eventFixture(pubkey, {
                      id: "0".repeat(64),
                      createdAt: nowMs / 1_000,
                    }),
                  ]
                : [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: published ? 1 : 0,
                },
              ]
            ),
          publishEvent: async (event) => {
            event.id = "b".repeat(64)
            published = true
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).rejects.toThrow("did not converge")

    expect(waits).toBe(0)
  })

  it("retries when an equal-timestamp higher-ID competitor is observed before our event", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published: NDKEvent | null = null
    let readbackAttempts = 0
    let waits = 0

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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () => {
            if (!published) {
              return relayResult(
                [],
                [
                  {
                    relayUrl: "wss://relay.example",
                    status: "success",
                    eventCount: 0,
                  },
                ]
              )
            }

            readbackAttempts += 1
            if (readbackAttempts === 1) {
              return relayResult(
                [
                  eventFixture(pubkey, {
                    id: "b".repeat(64),
                    createdAt: nowMs / 1_000,
                  }),
                ],
                [
                  {
                    relayUrl: "wss://relay.example",
                    status: "success",
                    eventCount: 1,
                  },
                ]
              )
            }

            attachEventSourceRelayUrl(published, "wss://relay.example")
            return relayResult(
              [published],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: 1,
                },
              ]
            )
          },
          publishEvent: async (event) => {
            event.id = "a".repeat(64)
            published = event
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).resolves.toMatchObject({ revision: { eventId: "a".repeat(64) } })

    expect(readbackAttempts).toBe(2)
    expect(waits).toBe(1)
  })

  it("retries a thrown convergence read before accepting exact readback", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published: NDKEvent | null = null
    let readbackAttempts = 0
    let waits = 0

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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () => {
            if (!published) {
              return relayResult(
                [],
                [
                  {
                    relayUrl: "wss://relay.example",
                    status: "success" as const,
                    eventCount: 0,
                  },
                ]
              )
            }
            readbackAttempts += 1
            if (readbackAttempts === 1) throw new Error("Temporary relay error")
            attachEventSourceRelayUrl(published, "wss://relay.example")
            return relayResult(
              [published],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success" as const,
                  eventCount: 1,
                },
              ]
            )
          },
          publishEvent: async (event) => {
            published = event
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).resolves.toBeDefined()

    expect(readbackAttempts).toBe(2)
    expect(waits).toBe(1)
  })

  it("exhausts the bounded convergence retries when every read throws", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published = false
    let readbackAttempts = 0
    let waits = 0

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
          waitForConvergenceRetry: async () => {
            waits += 1
          },
          fetchEvents: async () => {
            if (published) {
              readbackAttempts += 1
              throw new Error("Relay unavailable")
            }
            return relayResult(
              [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success" as const,
                  eventCount: 0,
                },
              ]
            )
          },
          publishEvent: async () => {
            published = true
            return publishResult({
              primaryRelayUrls: ["wss://relay.example"],
              attemptedRelayUrls: ["wss://relay.example"],
              successfulRelayUrls: ["wss://relay.example"],
              failedRelayUrls: [],
            })
          },
        },
      })
    ).rejects.toThrow("did not converge")

    expect(readbackAttempts).toBe(3)
    expect(waits).toBe(2)
  })

  it("retries bounded readback for indexing lag and fails after exhaustion", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published: NDKEvent | null = null
    let readbackAttempts = 0
    let waits = 0
    const dependencies = {
      signer,
      ndk,
      now: () => nowMs,
      getRelayLists: async () => new Map(),
      waitForConvergenceRetry: async () => {
        waits += 1
      },
      fetchEvents: async () => {
        if (!published) {
          return relayResult(
            [],
            [
              {
                relayUrl: "wss://relay.example",
                status: "success" as const,
                eventCount: 0,
              },
            ]
          )
        }
        readbackAttempts += 1
        if (readbackAttempts < 2) {
          return relayResult(
            [],
            [
              {
                relayUrl: "wss://relay.example",
                status: "success" as const,
                eventCount: 0,
              },
            ]
          )
        }
        attachEventSourceRelayUrl(published, "wss://relay.example")
        return relayResult(
          [published],
          [
            {
              relayUrl: "wss://relay.example",
              status: "success" as const,
              eventCount: 1,
            },
          ]
        )
      },
      publishEvent: async (event: NDKEvent) => {
        published = event
        return publishResult({
          primaryRelayUrls: ["wss://relay.example"],
          attemptedRelayUrls: ["wss://relay.example"],
          successfulRelayUrls: ["wss://relay.example"],
          failedRelayUrls: [],
        })
      },
    }

    await expect(
      publishShopperPresets({
        pubkey,
        value: preset,
        password,
        appId: "market",
        dependencies,
      })
    ).resolves.toBeDefined()
    expect(readbackAttempts).toBe(2)
    expect(waits).toBe(1)

    published = null
    readbackAttempts = 0
    waits = 0
    dependencies.fetchEvents = async () =>
      relayResult(
        [],
        [
          {
            relayUrl: "wss://relay.example",
            status: "success" as const,
            eventCount: 0,
          },
        ]
      )
    await expect(
      publishShopperPresets({
        pubkey,
        value: preset,
        password,
        appId: "market",
        dependencies,
      })
    ).rejects.toThrow("did not converge")
    expect(waits).toBe(2)
  })

  it("floors a clear revision above the locally accepted revision", async () => {
    const { signer, pubkey, ndk } = await signerFixture()
    let published: NDKEvent | null = null
    const acceptedCreatedAt = nowMs / 1_000 + 20
    const result = await publishShopperPresets({
      pubkey,
      value: null,
      password,
      appId: "market",
      acceptedRevision: {
        eventId: "a".repeat(64),
        createdAt: acceptedCreatedAt,
      },
      dependencies: {
        signer,
        ndk,
        now: () => nowMs,
        getRelayLists: async () => new Map(),
        fetchEvents: async () => {
          if (published)
            attachEventSourceRelayUrl(published, "wss://relay.example")
          return relayResult(published ? [published] : [], [
            {
              relayUrl: "wss://relay.example",
              status: "success",
              eventCount: published ? 1 : 0,
            },
          ])
        },
        publishEvent: async (event) => {
          published = event
          return publishResult({
            primaryRelayUrls: ["wss://relay.example"],
            attemptedRelayUrls: ["wss://relay.example"],
            successfulRelayUrls: ["wss://relay.example"],
            failedRelayUrls: [],
          })
        },
      },
    })

    expect(result.document.enabled).toBe(false)
    expect(result.document.updatedAt).toBe(acceptedCreatedAt + 1)
  })

  it("rejects an accepted revision timestamp that cannot be incremented", async () => {
    const { signer: realSigner, pubkey, ndk } = await signerFixture()
    let signed = false
    let published = false
    const signer = {
      user: () => realSigner.user(),
      sign: async () => {
        signed = true
        throw new Error("The signer must not be called")
      },
    } as unknown as NDKSigner

    await expect(
      publishShopperPresets({
        pubkey,
        value: preset,
        password,
        appId: "market",
        acceptedRevision: {
          eventId: "a".repeat(64),
          createdAt: Number.MAX_SAFE_INTEGER,
        },
        dependencies: {
          signer,
          ndk,
          getRelayLists: async () => new Map(),
          fetchEvents: async () =>
            relayResult(
              [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: 0,
                },
              ]
            ),
          publishEvent: async () => {
            published = true
            throw new Error("Publishing must not be attempted")
          },
        },
      })
    ).rejects.toThrow("The accepted shopper preset revision is invalid.")

    expect(signed).toBe(false)
    expect(published).toBe(false)
  })

  it("rejects a fetched revision that would derive the final safe timestamp", async () => {
    const { signer: realSigner, pubkey, ndk } = await signerFixture()
    const envelope = await encryptShopperPresetsDocument(
      presetDocument(),
      password
    )
    const previous = eventFixture(pubkey, {
      id: "a".repeat(64),
      createdAt: Number.MAX_SAFE_INTEGER - 1,
      content: serializeShopperPresetsEnvelope(envelope),
    })
    let signed = false
    let published = false
    const signer = {
      user: () => realSigner.user(),
      sign: async () => {
        signed = true
        throw new Error("The signer must not be called")
      },
    } as unknown as NDKSigner

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
          randomBytes: () => {
            throw new Error("Encryption must not be attempted")
          },
          getRelayLists: async () => new Map(),
          fetchEvents: async () =>
            relayResult(
              [previous],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: 1,
                },
              ]
            ),
          publishEvent: async () => {
            published = true
            throw new Error("Publishing must not be attempted")
          },
        },
      })
    ).rejects.toThrow("The shopper preset revision timestamp is invalid.")

    expect(signed).toBe(false)
    expect(published).toBe(false)
  })

  it("rejects a clock value that would derive the final safe timestamp", async () => {
    const { signer: realSigner, pubkey, ndk } = await signerFixture()
    let signed = false
    let published = false
    const signer = {
      user: () => realSigner.user(),
      sign: async () => {
        signed = true
        throw new Error("The signer must not be called")
      },
    } as unknown as NDKSigner

    await expect(
      publishShopperPresets({
        pubkey,
        value: preset,
        password,
        appId: "market",
        dependencies: {
          signer,
          ndk,
          now: () => Number.MAX_SAFE_INTEGER * 1_000,
          randomBytes: () => {
            throw new Error("Encryption must not be attempted")
          },
          getRelayLists: async () => new Map(),
          fetchEvents: async () =>
            relayResult(
              [],
              [
                {
                  relayUrl: "wss://relay.example",
                  status: "success",
                  eventCount: 0,
                },
              ]
            ),
          publishEvent: async () => {
            published = true
            throw new Error("Publishing must not be attempted")
          },
        },
      })
    ).rejects.toThrow("The shopper preset revision timestamp is invalid.")

    expect(signed).toBe(false)
    expect(published).toBe(false)
  })
})
