import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  applyE2eRelayIsolation,
  config,
  createInMemoryInboxDeclarationEvidenceRepository,
  EVENT_KINDS,
  getInboxRelayCandidates,
  inboxDeclarationPublishRelayUrls,
  inboxDiscoveryRelayUrls,
  inspectOwnPrivateMessageRelayReadiness,
  planCompatibilityOrderRelays,
  publishPrivateMessageRelayDeclaration,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  sharedInboxDiscoveryRelayUrls,
} from "@conduit/core"

import {
  normalizeRelayEvent,
  relayServerOptionsFromEnv,
  RelayEventStore,
  startRelayServer,
  type RelayServerOptions,
} from "../scripts/dev/relay_bun"

function signedEvent(input: {
  createdAt: number
  kind?: number
  tags?: string[][]
  content?: string
  secretKey?: Uint8Array
}) {
  return finalizeEvent(
    {
      kind: input.kind ?? 1,
      created_at: input.createdAt,
      tags: input.tags ?? [],
      content: input.content ?? "test event",
    },
    input.secretKey ?? generateSecretKey()
  )
}

function startTestRelay(options: RelayServerOptions = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * 16_384)
    try {
      const relay = startRelayServer({
        ...options,
        hostname: "127.0.0.1",
        port,
        persistence: options.persistence ?? false,
      })
      return {
        relay,
        relayUrl: `ws://127.0.0.1:${relay.server.port}`,
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error
      }
    }
  }
  throw new Error("Unable to bind an ephemeral test relay port")
}

async function waitForFrame(
  frames: unknown[][],
  predicate: (frame: unknown[]) => boolean
): Promise<unknown[]> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const match = frames.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for a relay frame")
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for relay state")
}

async function openRelaySocket(relayUrl: string): Promise<{
  socket: WebSocket
  frames: unknown[][]
}> {
  const socket = new WebSocket(relayUrl)
  const frames: unknown[][] = []
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data))
    if (Array.isArray(frame)) frames.push(frame)
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("Relay WebSocket failed"))
  })
  return { socket, frames }
}

describe("local Bun relay", () => {
  it("accepts valid signatures and rejects altered events", () => {
    const event = signedEvent({ createdAt: 10 })

    expect(normalizeRelayEvent(event)?.id).toBe(event.id)
    expect(
      normalizeRelayEvent({ ...event, content: "altered after signing" })
    ).toBeNull()
  })

  it("retains only the newest addressable event", () => {
    const store = new RelayEventStore()
    const secretKey = generateSecretKey()
    const older = signedEvent({
      kind: 30_402,
      createdAt: 10,
      tags: [["d", "listing"]],
      content: "older",
      secretKey,
    })
    const newer = signedEvent({
      kind: 30_402,
      createdAt: 11,
      tags: [["d", "listing"]],
      content: "newer",
      secretKey,
    })

    expect(store.store(older)).toEqual({ accepted: true, status: "stored" })
    expect(store.store(newer)).toEqual({ accepted: true, status: "stored" })
    expect(store.store(older)).toEqual({
      accepted: false,
      status: "superseded",
    })
    expect(store.query([{ kinds: [30_402], "#d": ["listing"] }])).toEqual([
      newer,
    ])
  })

  it("supports deterministic delayed and partial reads", () => {
    let now = 100
    const store = new RelayEventStore(() => now)
    const first = signedEvent({ createdAt: 10 })
    const second = signedEvent({ createdAt: 11 })

    store.store(first, 50)
    store.store(second, 50)
    expect(store.query([{}])).toEqual([])

    now = 150
    expect(store.query([{}])).toEqual([second, first])
    expect(store.query([{}], 1)).toEqual([second])
  })

  it("acknowledges ephemeral events without retaining them", () => {
    const store = new RelayEventStore()
    const event = signedEvent({ kind: 20_001, createdAt: 10 })

    expect(store.store(event)).toEqual({
      accepted: true,
      status: "ephemeral",
    })
    expect(store.size).toBe(0)
  })

  it("serves signed publish, ACK, readback, and EOSE over WebSocket", async () => {
    const { relay, relayUrl } = startTestRelay()
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      const event = signedEvent({ createdAt: 10 })
      socket.send(JSON.stringify(["EVENT", event]))
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === event.id
        )
      ).toEqual(["OK", event.id, true, "saved"])

      socket.send(
        JSON.stringify([
          "REQ",
          "readback",
          { ids: [event.id], kinds: [event.kind] },
        ])
      )
      const readbackFrame = await waitForFrame(
        frames,
        (frame) => frame[0] === "EVENT" && frame[1] === "readback"
      )
      expect(readbackFrame.slice(0, 2)).toEqual(["EVENT", "readback"])
      expect((readbackFrame[2] as { id?: string } | undefined)?.id).toBe(
        event.id
      )
      expect(normalizeRelayEvent(readbackFrame[2])?.id).toBe(event.id)
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "EOSE" && frame[1] === "readback"
        )
      ).toEqual(["EOSE", "readback"])

      socket.send(
        JSON.stringify(["EVENT", { ...event, content: "invalid mutation" }])
      )
      expect(
        await waitForFrame(
          frames,
          (frame) =>
            frame[0] === "OK" && frame[1] === event.id && frame[2] === false
        )
      ).toEqual([
        "OK",
        event.id,
        false,
        "invalid: event id or signature verification failed",
      ])
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("accepts only signed events within the NIP-01 kind domain", async () => {
    const { relay, relayUrl } = startTestRelay()
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      const boundaryEvents = [
        { event: signedEvent({ kind: 0, createdAt: 10 }), accepted: true },
        {
          event: signedEvent({ kind: 65_535, createdAt: 11 }),
          accepted: true,
        },
        { event: signedEvent({ kind: -1, createdAt: 12 }), accepted: false },
        {
          event: signedEvent({ kind: 65_536, createdAt: 13 }),
          accepted: false,
        },
      ]

      for (const { event, accepted } of boundaryEvents) {
        socket.send(JSON.stringify(["EVENT", event]))
        const ack = await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === event.id
        )
        expect(ack[2]).toBe(accepted)
      }

      expect(relay.store.size).toBe(2)
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("rejects signed events with empty tag arrays", async () => {
    const { relay, relayUrl } = startTestRelay()
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      const event = signedEvent({ createdAt: 10, tags: [[]] })
      socket.send(JSON.stringify(["EVENT", event]))
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === event.id
        )
      ).toEqual([
        "OK",
        event.id,
        false,
        "invalid: event id or signature verification failed",
      ])
      expect(relay.store.size).toBe(0)
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("keeps NIP-42 auth events off subscriptions", async () => {
    const { relay, relayUrl } = startTestRelay()
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      socket.send(
        JSON.stringify(["REQ", "ephemeral-events", { kinds: [20_001, 22_242] }])
      )
      await waitForFrame(
        frames,
        (frame) => frame[0] === "EOSE" && frame[1] === "ephemeral-events"
      )

      const authEvent = signedEvent({ kind: 22_242, createdAt: 10 })
      socket.send(JSON.stringify(["EVENT", authEvent]))
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === authEvent.id
        )
      ).toEqual(["OK", authEvent.id, true, "saved"])
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(
        frames.some(
          (frame) =>
            frame[0] === "EVENT" &&
            frame[1] === "ephemeral-events" &&
            (frame[2] as { id?: string } | undefined)?.id === authEvent.id
        )
      ).toBe(false)

      const ordinaryEphemeralEvent = signedEvent({
        kind: 20_001,
        createdAt: 11,
      })
      socket.send(JSON.stringify(["EVENT", ordinaryEphemeralEvent]))
      expect(
        (
          await waitForFrame(
            frames,
            (frame) =>
              frame[0] === "EVENT" &&
              frame[1] === "ephemeral-events" &&
              (frame[2] as { id?: string } | undefined)?.id ===
                ordinaryEphemeralEvent.id
          )
        )[2]
      ).toEqual(Object.fromEntries(Object.entries(ordinaryEphemeralEvent)))
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("rejects malformed filters without widening reads", async () => {
    const { relay, relayUrl } = startTestRelay()
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      const event = signedEvent({
        kind: 30_402,
        createdAt: 10,
        tags: [["d", "listing"]],
      })
      socket.send(JSON.stringify(["EVENT", event]))
      await waitForFrame(
        frames,
        (frame) => frame[0] === "OK" && frame[1] === event.id
      )

      const malformedRequests = [
        { id: "empty-id-list", filters: [{ ids: [] }] },
        { id: "bad-author", filters: [{ authors: ["not-a-pubkey"] }] },
        { id: "empty-kind-list", filters: [{ kinds: [] }] },
        {
          id: "empty-tag-list",
          filters: [{ kinds: [30_402], "#d": [] }],
        },
        {
          id: "bad-identifier-tag",
          filters: [{ "#p": ["A".repeat(64)] }],
        },
        {
          id: "invalid-sibling-filter",
          filters: [{ kinds: [30_402] }, { authors: "not-an-array" }],
        },
        { id: "unknown-key", filters: [{ kindz: [30_402] }] },
      ]

      for (const request of malformedRequests) {
        socket.send(JSON.stringify(["REQ", request.id, ...request.filters]))
        expect(
          await waitForFrame(
            frames,
            (frame) => frame[0] === "CLOSED" && frame[1] === request.id
          )
        ).toEqual(["CLOSED", request.id, "invalid: malformed filter"])
        expect(
          frames.some(
            (frame) => frame[0] === "EVENT" && frame[1] === request.id
          )
        ).toBe(false)
      }
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("requires valid NIP-42 authentication for protected inbox reads", async () => {
    const nowSeconds = 1_800_000_000
    const { relay, relayUrl } = startTestRelay({
      now: () => nowSeconds * 1_000,
    })
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      const recipientSecretKey = generateSecretKey()
      const recipientPubkey = signedEvent({
        createdAt: 10,
        secretKey: recipientSecretKey,
      }).pubkey
      const giftWrap = signedEvent({
        kind: 1_059,
        createdAt: 10,
        tags: [["p", recipientPubkey]],
      })
      socket.send(JSON.stringify(["EVENT", giftWrap]))
      await waitForFrame(
        frames,
        (frame) => frame[0] === "OK" && frame[1] === giftWrap.id
      )

      socket.send(
        JSON.stringify([
          "REQ",
          "protected",
          { kinds: [1_059], "#p": [recipientPubkey] },
        ])
      )
      const challengeFrame = await waitForFrame(
        frames,
        (frame) => frame[0] === "AUTH" && typeof frame[1] === "string"
      )
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "CLOSED" && frame[1] === "protected"
        )
      ).toEqual([
        "CLOSED",
        "protected",
        "auth-required: authenticate for protected reads",
      ])

      const authEvent = finalizeEvent(
        {
          kind: 22_242,
          created_at: nowSeconds,
          tags: [
            ["relay", relayUrl],
            ["challenge", challengeFrame[1] as string],
          ],
          content: "",
        },
        recipientSecretKey
      )
      socket.send(JSON.stringify(["AUTH", authEvent]))
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === authEvent.id
        )
      ).toEqual(["OK", authEvent.id, true, "authenticated"])

      socket.send(
        JSON.stringify([
          "REQ",
          "authenticated",
          { kinds: [1_059], "#p": [recipientPubkey] },
        ])
      )
      const eventFrame = await waitForFrame(
        frames,
        (frame) => frame[0] === "EVENT" && frame[1] === "authenticated"
      )
      expect((eventFrame[2] as { id?: string }).id).toBe(giftWrap.id)
      expect(
        await waitForFrame(
          frames,
          (frame) => frame[0] === "EOSE" && frame[1] === "authenticated"
        )
      ).toEqual(["EOSE", "authenticated"])
      expect(relay.counters.authAccepted).toBe(1)
      expect(relay.counters.protectedRequests).toBe(1)

      const otherRecipientPubkey = signedEvent({ createdAt: 10 }).pubkey
      const restrictedRequests = [
        { id: "unbounded", filters: [{}] },
        { id: "missing-recipient", filters: [{ kinds: [1_059] }] },
        {
          id: "mixed-kinds",
          filters: [{ kinds: [1, 1_059], "#p": [recipientPubkey] }],
        },
        {
          id: "mixed-filters",
          filters: [
            { kinds: [1] },
            { kinds: [1_059], "#p": [recipientPubkey] },
          ],
        },
        {
          id: "mixed-recipients",
          filters: [
            {
              kinds: [1_059],
              "#p": [recipientPubkey, otherRecipientPubkey],
            },
          ],
        },
        {
          id: "cross-recipient",
          filters: [{ kinds: [1_059], "#p": [otherRecipientPubkey] }],
        },
      ]

      for (const request of restrictedRequests) {
        socket.send(JSON.stringify(["REQ", request.id, ...request.filters]))
        const closed = await waitForFrame(
          frames,
          (frame) => frame[0] === "CLOSED" && frame[1] === request.id
        )
        expect(closed[2]).toStartWith("restricted:")
        expect(
          frames.some(
            (frame) => frame[0] === "EVENT" && frame[1] === request.id
          )
        ).toBe(false)
      }
    } finally {
      socket.close()
      relay.server.stop()
    }
  })

  it("rejects stale and future NIP-42 authentication events", async () => {
    const nowSeconds = 1_800_000_000
    const { relay, relayUrl } = startTestRelay({
      now: () => nowSeconds * 1_000,
    })
    const recipientSecretKey = generateSecretKey()
    const recipientPubkey = signedEvent({
      createdAt: 10,
      secretKey: recipientSecretKey,
    }).pubkey

    async function authenticateAt(createdAt: number): Promise<unknown[]> {
      const { socket, frames } = await openRelaySocket(relayUrl)

      try {
        socket.send(
          JSON.stringify([
            "REQ",
            "protected",
            { kinds: [1_059], "#p": [recipientPubkey] },
          ])
        )
        const challengeFrame = await waitForFrame(
          frames,
          (frame) => frame[0] === "AUTH" && typeof frame[1] === "string"
        )
        const authEvent = finalizeEvent(
          {
            kind: 22_242,
            created_at: createdAt,
            tags: [
              ["relay", relayUrl],
              ["challenge", challengeFrame[1] as string],
            ],
            content: "",
          },
          recipientSecretKey
        )
        socket.send(JSON.stringify(["AUTH", authEvent]))
        return await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === authEvent.id
        )
      } finally {
        socket.close()
      }
    }

    try {
      expect(await authenticateAt(nowSeconds - 601)).toEqual([
        "OK",
        expect.any(String),
        false,
        "invalid: NIP-42 authentication failed",
      ])
      expect(await authenticateAt(nowSeconds + 601)).toEqual([
        "OK",
        expect.any(String),
        false,
        "invalid: NIP-42 authentication failed",
      ])
      expect(relay.counters.authRejected).toBe(2)
      expect(relay.counters.authAccepted).toBe(0)
    } finally {
      relay.server.stop()
    }
  })

  it("routes isolated declarations and private orders through the fixture", async () => {
    const { relay, relayUrl } = startTestRelay()
    const originalConfig = { ...config }
    const { socket, frames } = await openRelaySocket(relayUrl)

    try {
      Object.assign(config, applyE2eRelayIsolation(config, [relayUrl]))

      expect(sharedInboxDiscoveryRelayUrls()).toEqual([relayUrl])
      expect(inboxDiscoveryRelayUrls()).toEqual([relayUrl])
      expect(inboxDeclarationPublishRelayUrls()).toEqual([relayUrl])
      expect(getInboxRelayCandidates([], [relayUrl])).toEqual([
        expect.objectContaining({
          url: relayUrl,
          declared: true,
          selectable: true,
        }),
      ])

      const recipientSecretKey = generateSecretKey()
      const recipientSigner = new NDKPrivateKeySigner(recipientSecretKey)
      const recipientPubkey = (await recipientSigner.user()).pubkey
      const declaration = await publishPrivateMessageRelayDeclaration({
        pubkey: recipientPubkey,
        signer: recipientSigner,
        relayUrls: [relayUrl],
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        nowMs: () => 11_000,
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        getDiscoveryRelayUrls: () => [relayUrl],
      })

      __resetInboxDeclarationCache()
      const readbackRepository =
        createInMemoryInboxDeclarationEvidenceRepository()
      const declarationReadback = await resolveInboxDeclaration(
        recipientPubkey,
        {
          relayUrls: [relayUrl],
          evidenceRepository: readbackRepository,
        }
      )
      expect(declarationReadback.state).toBe("declared")
      expect(declarationReadback.eventId).toBe(declaration.id)
      expect(declarationReadback.relayUrls).toEqual([relayUrl])
      const ownReadiness = await inspectOwnPrivateMessageRelayReadiness(
        recipientPubkey,
        {
          relayUrls: [relayUrl],
          evidenceRepository: readbackRepository,
        }
      )
      expect(ownReadiness.state).toBe("ready")
      expect(
        ownReadiness.state === "ready" ? ownReadiness.eventId : undefined
      ).toBe(declaration.id)

      const declaredRoute = selectPrivateMessageDeliveryRoute({
        rumorKind: EVENT_KINDS.ORDER,
        declaration: declarationReadback,
        validatedOrder: true,
      })
      expect(declaredRoute.relayUrls).toEqual([relayUrl])

      const compatibilityPlan = planCompatibilityOrderRelays({
        approvedRelayUrls: [relayUrl],
      })
      expect(compatibilityPlan.relayUrls).toEqual([relayUrl])
      const compatibilityRoute = selectPrivateMessageDeliveryRoute({
        rumorKind: EVENT_KINDS.ORDER,
        declaration: {
          pubkey: recipientPubkey,
          state: "not_observed",
          relayUrls: [],
          stale: false,
          fetchedAt: 0,
        },
        validatedOrder: true,
        compatibilityEnabled: true,
        compatibilityRelayUrls: [relayUrl],
      })
      expect(compatibilityRoute.relayUrls).toEqual([relayUrl])

      for (const [index, route] of [
        declaredRoute,
        compatibilityRoute,
      ].entries()) {
        const giftWrap = signedEvent({
          kind: EVENT_KINDS.GIFT_WRAP,
          createdAt: 20 + index,
          tags: [["p", recipientPubkey]],
        })
        expect(route.relayUrls).toContain(relayUrl)
        socket.send(JSON.stringify(["EVENT", giftWrap]))
        expect(
          await waitForFrame(
            frames,
            (frame) => frame[0] === "OK" && frame[1] === giftWrap.id
          )
        ).toEqual(["OK", giftWrap.id, true, "saved"])
      }
    } finally {
      Object.assign(config, originalConfig)
      socket.close()
      relay.server.stop()
    }
  })

  it("exercises configured fault modes over WebSocket", async () => {
    async function startFaultRelay(
      faultMode: string,
      environment: Record<string, string> = {},
      overrides: { now?: () => number } = {}
    ) {
      const options = relayServerOptionsFromEnv({
        RELAY_EPHEMERAL: "true",
        RELAY_FAULT_MODE: faultMode,
        RELAY_HOST: "127.0.0.1",
        ...environment,
      })
      const { relay, relayUrl } = startTestRelay({ ...options, ...overrides })
      const connection = await openRelaySocket(relayUrl)
      return { ...connection, relay }
    }

    {
      const { relay, socket, frames } = await startFaultRelay("reject-writes")
      try {
        const event = signedEvent({ createdAt: 10 })
        socket.send(JSON.stringify(["EVENT", event]))
        expect(
          await waitForFrame(
            frames,
            (frame) => frame[0] === "OK" && frame[1] === event.id
          )
        ).toEqual(["OK", event.id, false, "blocked: injected write rejection"])
        expect(relay.store.size).toBe(0)
      } finally {
        socket.close()
        relay.server.stop()
      }
    }

    {
      const { relay, socket, frames } = await startFaultRelay("drop-acks")
      try {
        const event = signedEvent({ createdAt: 10 })
        socket.send(JSON.stringify(["EVENT", event]))
        await waitForCondition(() => relay.store.size === 1)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(
          frames.some((frame) => frame[0] === "OK" && frame[1] === event.id)
        ).toBe(false)
      } finally {
        socket.close()
        relay.server.stop()
      }
    }

    {
      let now = 1_000
      const { relay, socket, frames } = await startFaultRelay(
        "delay-reads",
        { RELAY_READ_DELAY_MS: "50" },
        { now: () => now }
      )
      try {
        const event = signedEvent({ createdAt: 10 })
        socket.send(JSON.stringify(["EVENT", event]))
        await waitForFrame(
          frames,
          (frame) => frame[0] === "OK" && frame[1] === event.id
        )
        socket.send(
          JSON.stringify(["REQ", "before-delay", { kinds: [event.kind] }])
        )
        await waitForFrame(
          frames,
          (frame) => frame[0] === "EOSE" && frame[1] === "before-delay"
        )
        expect(
          frames.some(
            (frame) => frame[0] === "EVENT" && frame[1] === "before-delay"
          )
        ).toBe(false)

        now += 50
        socket.send(
          JSON.stringify(["REQ", "after-delay", { kinds: [event.kind] }])
        )
        expect(
          (
            await waitForFrame(
              frames,
              (frame) => frame[0] === "EVENT" && frame[1] === "after-delay"
            )
          )[2]
        ).toEqual(Object.fromEntries(Object.entries(event)))
        expect(
          await waitForFrame(
            frames,
            (frame) => frame[0] === "EOSE" && frame[1] === "after-delay"
          )
        ).toEqual(["EOSE", "after-delay"])
      } finally {
        socket.close()
        relay.server.stop()
      }
    }

    {
      const { relay, socket, frames } = await startFaultRelay("partial-reads", {
        RELAY_PARTIAL_READ_LIMIT: "1",
      })
      try {
        const events = [
          signedEvent({ createdAt: 10 }),
          signedEvent({ createdAt: 11 }),
        ]
        for (const event of events) {
          socket.send(JSON.stringify(["EVENT", event]))
          await waitForFrame(
            frames,
            (frame) => frame[0] === "OK" && frame[1] === event.id
          )
        }
        socket.send(
          JSON.stringify(["REQ", "partial", { kinds: [events[0].kind] }])
        )
        await waitForFrame(
          frames,
          (frame) => frame[0] === "EOSE" && frame[1] === "partial"
        )
        expect(
          frames.filter(
            (frame) => frame[0] === "EVENT" && frame[1] === "partial"
          )
        ).toHaveLength(1)
      } finally {
        socket.close()
        relay.server.stop()
      }
    }

    expect(() =>
      relayServerOptionsFromEnv({ RELAY_FAULT_MODE: "unsupported" })
    ).toThrow("Unsupported RELAY_FAULT_MODE")
  })
})
