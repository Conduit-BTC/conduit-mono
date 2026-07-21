import { describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  __resetInboxRelayCache,
  buildDirectMessageRumor,
  classifyPrivateMessageKind,
  decryptLegacyDirectMessage,
  detectNip44Capabilities,
  EVENT_KINDS,
  fetchInboxRelayUrls,
  inspectOwnPrivateMessageRelayReadiness,
  parseDirectMessageRumor,
  parsePrivateMessageRelays,
  PrivateMessageRelayReadinessError,
  publishPrivateMessage,
  publishPrivateMessageRelayDeclaration,
  unwrapGiftWrap,
  type GiftUnwrapFn,
} from "@conduit/core"

const signer = {} as NDKSigner

function wrap(id: string): NDKEvent {
  return { id } as unknown as NDKEvent
}

function rumor(kind: number, overrides: Partial<NDKEvent> = {}): NDKEvent {
  return {
    id: "rumor-id",
    kind,
    pubkey: "sender",
    created_at: 1000,
    tags: [["p", "recipient"]],
    content: "hi",
    ...overrides,
  } as unknown as NDKEvent
}

function orderRumor(overrides: Partial<NDKEvent> = {}): NDKEvent {
  return rumor(EVENT_KINDS.ORDER, {
    tags: [
      ["p", "recipient"],
      ["type", "message"],
      ["order", "order-id"],
    ],
    content: JSON.stringify({ note: "Order update" }),
    ...overrides,
  })
}

describe("classifyPrivateMessageKind", () => {
  it("maps kind 14 to direct and kind 16 to order", () => {
    expect(classifyPrivateMessageKind(EVENT_KINDS.DIRECT_MESSAGE)).toBe(
      "direct"
    )
    expect(classifyPrivateMessageKind(EVENT_KINDS.ORDER)).toBe("order")
  })
  it("returns null for unrelated kinds", () => {
    expect(classifyPrivateMessageKind(1)).toBeNull()
    expect(classifyPrivateMessageKind(undefined)).toBeNull()
  })
})

describe("unwrapGiftWrap", () => {
  it("classifies a kind-14 rumor as a direct message", async () => {
    const giftUnwrap: GiftUnwrapFn = async () =>
      rumor(EVENT_KINDS.DIRECT_MESSAGE)
    const outcome = await unwrapGiftWrap(wrap("w1"), signer, { giftUnwrap })
    expect(outcome.status).toBe("ok")
    if (outcome.status === "ok") expect(outcome.category).toBe("direct")
  })

  it("classifies a kind-16 rumor as an order message", async () => {
    const giftUnwrap: GiftUnwrapFn = async () => orderRumor()
    const outcome = await unwrapGiftWrap(wrap("w2"), signer, { giftUnwrap })
    expect(outcome.status).toBe("ok")
    if (outcome.status === "ok") expect(outcome.category).toBe("order")
  })

  it("ignores a NIP-18-shaped kind-16 generic repost", async () => {
    const giftUnwrap: GiftUnwrapFn = async () =>
      rumor(EVENT_KINDS.ORDER, {
        tags: [
          ["k", "30402"],
          ["a", "30402:merchant:product-id"],
        ],
        content: JSON.stringify({ kind: 30402 }),
      })

    const outcome = await unwrapGiftWrap(wrap("w-nip18"), signer, {
      giftUnwrap,
    })

    expect(outcome).toEqual({
      status: "ignored",
      wrapId: "w-nip18",
      kind: EVENT_KINDS.ORDER,
    })
  })

  it("reports a partial Conduit kind-16 envelope as content-free malformed", async () => {
    const giftUnwrap: GiftUnwrapFn = async () =>
      rumor(EVENT_KINDS.ORDER, {
        tags: [
          ["p", "recipient"],
          ["type", "message"],
        ],
        content: "private order text",
      })

    const outcome = await unwrapGiftWrap(wrap("w-partial-order"), signer, {
      giftUnwrap,
    })

    expect(outcome).toEqual({
      status: "decrypt_failed",
      wrapId: "w-partial-order",
      reason: "malformed",
    })
    expect(JSON.stringify(outcome)).not.toContain("private order text")
  })

  it("rejects a fully tagged kind-16 rumor with non-JSON content", async () => {
    const giftUnwrap: GiftUnwrapFn = async () =>
      orderRumor({ content: "arbitrary plaintext" })
    const outcome = await unwrapGiftWrap(wrap("w-json"), signer, { giftUnwrap })

    expect(outcome).toEqual({
      status: "decrypt_failed",
      wrapId: "w-json",
      reason: "malformed",
    })
  })

  it("rejects a fully tagged message rumor without a typed note", async () => {
    const giftUnwrap: GiftUnwrapFn = async () =>
      orderRumor({ content: JSON.stringify({}) })
    const outcome = await unwrapGiftWrap(wrap("w-shape"), signer, {
      giftUnwrap,
    })

    expect(outcome).toEqual({
      status: "decrypt_failed",
      wrapId: "w-shape",
      reason: "malformed",
    })
  })

  it("surfaces a decrypt failure (not silence) when unwrap returns null", async () => {
    const giftUnwrap: GiftUnwrapFn = async () => null
    const outcome = await unwrapGiftWrap(wrap("w3"), signer, { giftUnwrap })
    expect(outcome.status).toBe("decrypt_failed")
    if (outcome.status === "decrypt_failed") {
      expect(outcome.wrapId).toBe("w3")
      expect(outcome.reason).toBe("nip44_failed")
    }
  })

  it("surfaces a decrypt failure when unwrap throws", async () => {
    const giftUnwrap: GiftUnwrapFn = async () => {
      throw new Error("bad mac")
    }
    const outcome = await unwrapGiftWrap(wrap("w4"), signer, { giftUnwrap })
    expect(outcome.status).toBe("decrypt_failed")
    if (outcome.status === "decrypt_failed")
      expect(outcome.reason).toBe("nip44_failed")
  })

  it("reports a timeout reason when unwrap stalls", async () => {
    const giftUnwrap: GiftUnwrapFn = () => new Promise(() => {})
    const outcome = await unwrapGiftWrap(wrap("w5"), signer, {
      giftUnwrap,
      timeoutMs: 10,
    })
    expect(outcome.status).toBe("decrypt_failed")
    if (outcome.status === "decrypt_failed")
      expect(outcome.reason).toBe("timeout")
  })

  it("ignores unrelated inner kinds", async () => {
    const giftUnwrap: GiftUnwrapFn = async () => rumor(1)
    const outcome = await unwrapGiftWrap(wrap("w6"), signer, { giftUnwrap })
    expect(outcome.status).toBe("ignored")
  })

  it("does not leak plaintext in a decrypt-failure record", async () => {
    const giftUnwrap: GiftUnwrapFn = async () => {
      throw new Error("secret plaintext should not appear")
    }
    const outcome = await unwrapGiftWrap(wrap("w7"), signer, { giftUnwrap })
    expect(Object.keys(outcome).sort()).toEqual(["reason", "status", "wrapId"])
  })
})

describe("buildDirectMessageRumor / parseDirectMessageRumor", () => {
  it("builds a kind-14 rumor tagged to the recipient", () => {
    const built = buildDirectMessageRumor({
      senderPubkey: "buyer",
      recipientPubkey: "merchant",
      content: "do you ship to NZ?",
      appId: "market",
      createdAt: 2000,
    })
    expect(built.kind).toBe(EVENT_KINDS.DIRECT_MESSAGE)
    expect(built.pubkey).toBe("buyer")
    expect(built.tags.find((t) => t[0] === "p")?.[1]).toBe("merchant")
    expect(built.content).toBe("do you ship to NZ?")
  })

  it("parses an unwrapped kind-14 rumor with ms timestamps", () => {
    const parsed = parseDirectMessageRumor(
      rumor(EVENT_KINDS.DIRECT_MESSAGE, {
        id: "m1",
        pubkey: "merchant",
        created_at: 2000,
        content: "yes we do",
      })
    )
    expect(parsed).toEqual({
      id: "m1",
      senderPubkey: "merchant",
      recipientPubkey: "recipient",
      content: "yes we do",
      createdAt: 2_000_000,
      transport: "nip17",
    })
  })
})

describe("decryptLegacyDirectMessage", () => {
  function legacyEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
    return rumor(EVENT_KINDS.DM_LEGACY, {
      id: "legacy-id",
      pubkey: "sender",
      tags: [["p", "recipient"]],
      content: "ciphertext?iv=secret",
      ...overrides,
    })
  }

  it("decrypts incoming and outgoing kind-4 messages with the counterparty", async () => {
    const calls: Array<{ pubkey: string; ciphertext: string }> = []
    const decrypt = async (pubkey: string, ciphertext: string) => {
      calls.push({ pubkey, ciphertext })
      return `plain:${ciphertext}`
    }

    const incoming = await decryptLegacyDirectMessage(
      legacyEvent(),
      "recipient",
      decrypt
    )
    const outgoing = await decryptLegacyDirectMessage(
      legacyEvent({ pubkey: "recipient", tags: [["p", "sender"]] }),
      "recipient",
      decrypt
    )

    expect(incoming.status).toBe("ok")
    expect(outgoing.status).toBe("ok")
    if (incoming.status === "ok" && outgoing.status === "ok") {
      expect(incoming.message.transport).toBe("nip04")
      expect(outgoing.message.transport).toBe("nip04")
      expect(incoming.message.content).toBe("plain:ciphertext?iv=secret")
      expect(outgoing.message.senderPubkey).toBe("recipient")
    }
    expect(calls).toEqual([
      { pubkey: "sender", ciphertext: "ciphertext?iv=secret" },
      { pubkey: "sender", ciphertext: "ciphertext?iv=secret" },
    ])
  })

  it("ignores malformed and unrelated legacy events without decrypting", async () => {
    let decryptCalls = 0
    const decrypt = async () => {
      decryptCalls += 1
      return "plaintext"
    }

    expect(
      await decryptLegacyDirectMessage(
        legacyEvent({ tags: [] }),
        "recipient",
        decrypt
      )
    ).toEqual({ status: "ignored", eventId: "legacy-id" })
    expect(
      await decryptLegacyDirectMessage(
        legacyEvent({ pubkey: "other", tags: [["p", "another"]] }),
        "recipient",
        decrypt
      )
    ).toEqual({ status: "ignored", eventId: "legacy-id" })
    expect(decryptCalls).toBe(0)
  })

  it("reports rejection and timeout with content-free failure records", async () => {
    const rejected = await decryptLegacyDirectMessage(
      legacyEvent({ id: "legacy-rejected" }),
      "recipient",
      async () => {
        throw new Error("plaintext and ciphertext must stay private")
      }
    )
    const timedOut = await decryptLegacyDirectMessage(
      legacyEvent({ id: "legacy-timeout" }),
      "recipient",
      () => new Promise(() => {}),
      { timeoutMs: 5 }
    )

    expect(rejected).toEqual({
      status: "decrypt_failed",
      failure: {
        eventId: "legacy-rejected",
        reason: "decrypt_failed",
        retryable: true,
      },
    })
    expect(timedOut).toEqual({
      status: "decrypt_failed",
      failure: {
        eventId: "legacy-timeout",
        reason: "timeout",
        retryable: true,
      },
    })
    expect(Object.keys(rejected).sort()).toEqual(["failure", "status"])
    expect(Object.keys(timedOut).sort()).toEqual(["failure", "status"])
  })
})

describe("publishPrivateMessage", () => {
  it("rejects a rumor kind mismatch before wrapping or publishing", async () => {
    const mismatchedOrderRumor = orderRumor({
      content: JSON.stringify({ message: "Order declined" }),
    })

    await expect(
      publishPrivateMessage({
        rumor: mismatchedOrderRumor,
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: [],
        senderInboxRelays: [],
      })
    ).rejects.toThrow(
      "Private message rumor kind does not match requested kind"
    )
  })

  it("rejects kind 4 before wrapping or publishing", async () => {
    let wrapped = false
    let published = false

    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DM_LEGACY),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.example"],
        giftWrapFn: (async () => {
          wrapped = true
          return wrap("unexpected-wrap")
        }) as never,
        publishFn: (async () => {
          published = true
          return {} as never
        }) as never,
      })
    ).rejects.toThrow(
      "Private message rumor kind does not match requested kind"
    )
    expect(wrapped).toBe(false)
    expect(published).toBe(false)
  })

  it("does not accept kind 4 as a publish rumorKind", () => {
    type PublishRumorKind = Parameters<
      typeof publishPrivateMessage
    >[0]["rumorKind"]
    type Kind4IsPublishable =
      typeof EVENT_KINDS.DM_LEGACY extends PublishRumorKind ? true : false
    const kind4IsPublishable: Kind4IsPublishable = false

    expect(kind4IsPublishable).toBe(false)
  })

  it("throws typed recipient_not_ready before wrapping or publishing", async () => {
    let wrapped = false
    let published = false
    let thrown: unknown

    try {
      await publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: [],
        giftWrapFn: (async () => {
          wrapped = true
          return wrap("unexpected-wrap")
        }) as never,
        publishFn: (async () => {
          published = true
          return {} as never
        }) as never,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(PrivateMessageRelayReadinessError)
    expect((thrown as PrivateMessageRelayReadinessError).reason).toBe(
      "recipient_not_ready"
    )
    expect(wrapped).toBe(false)
    expect(published).toBe(false)
  })

  it("routes recipient and self-copy publishes through their kind-10050 relays", async () => {
    const resolved: string[] = []
    const wrappedRecipients: string[] = []
    const wrappedRumorsHaveNdk: boolean[] = []
    const publishes: Array<{
      id: string
      recipients: string[]
      relays: readonly string[]
    }> = []

    const result = await publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      resolveInboxRelays: async (pubkey) => {
        resolved.push(pubkey)
        return [`wss://${pubkey}.inbox.example`]
      },
      giftWrapFn: (async (rumorEvent, recipient) => {
        wrappedRumorsHaveNdk.push(Boolean(rumorEvent.ndk))
        wrappedRecipients.push(recipient.pubkey)
        return wrap(`wrap-${recipient.pubkey}`)
      }) as never,
      publishFn: (async (event, options) => {
        publishes.push({
          id: event.id,
          recipients: options.recipientPubkeys ?? [],
          relays: options.exclusiveRelayUrls ?? [],
        })
        return {} as never
      }) as never,
    })

    expect(resolved).toEqual(["recipient", "sender"])
    expect(wrappedRecipients).toEqual(["recipient", "sender"])
    expect(wrappedRumorsHaveNdk).toEqual([true, true])
    expect(publishes).toEqual([
      {
        id: "wrap-recipient",
        recipients: ["recipient"],
        relays: ["wss://recipient.inbox.example"],
      },
      {
        id: "wrap-sender",
        recipients: ["sender"],
        relays: ["wss://sender.inbox.example"],
      },
    ])
    expect(result.selfCopyError).toBeNull()
  })

  it("attaches an NDK instance before the real gift-wrap encryption path", async () => {
    const senderSigner = NDKPrivateKeySigner.generate()
    const recipientSigner = NDKPrivateKeySigner.generate()
    const sender = await senderSigner.user()
    const recipient = await recipientSigner.user()
    const directRumor = buildDirectMessageRumor({
      senderPubkey: sender.pubkey,
      recipientPubkey: recipient.pubkey,
      content: "hello",
      appId: "market",
    })
    expect(directRumor.ndk).toBeUndefined()

    const result = await publishPrivateMessage({
      rumor: directRumor,
      senderPubkey: sender.pubkey,
      recipientPubkey: recipient.pubkey,
      signer: senderSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      recipientInboxRelays: ["wss://recipient.inbox.example"],
      publishFn: (async () => ({})) as never,
    })

    expect(directRumor.ndk).toBeDefined()
    expect(result.wrappedToRecipient.ndk).toBeDefined()
  })

  it("skips sender resolution and wrapping when self-copy is disabled", async () => {
    const resolved: string[] = []
    const wrappedRecipients: string[] = []

    const result = await publishPrivateMessage({
      rumor: orderRumor(),
      senderPubkey: "guest",
      recipientPubkey: "merchant",
      signer,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: false,
      resolveInboxRelays: async (pubkey) => {
        resolved.push(pubkey)
        return ["wss://merchant.inbox.example"]
      },
      giftWrapFn: (async (_rumor, recipient) => {
        wrappedRecipients.push(recipient.pubkey)
        return wrap(`wrap-${recipient.pubkey}`)
      }) as never,
      publishFn: (async () => ({})) as never,
    })

    expect(resolved).toEqual(["merchant"])
    expect(wrappedRecipients).toEqual(["merchant"])
    expect(result.wrappedToSelf).toBeNull()
  })

  it("keeps recipient delivery successful when self-copy publish fails", async () => {
    const published: string[] = []
    const result = await publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      recipientInboxRelays: ["wss://recipient.inbox.example"],
      senderInboxRelays: ["wss://sender.inbox.example"],
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (event) => {
        published.push(event.id)
        if (event.id === "wrap-sender") throw new Error("self relay rejected")
        return {} as never
      }) as never,
    })

    expect(published).toEqual(["wrap-recipient", "wrap-sender"])
    expect(result.selfCopyError).toBe("self relay rejected")
  })
})

describe("detectNip44Capabilities", () => {
  it("defaults to v2 and keeps v3 gated off even when present", () => {
    const caps = detectNip44Capabilities({ nip44: {}, nip44v3: {} })
    expect(caps.hasNip44).toBe(true)
    expect(caps.hasNip44V3).toBe(true)
    expect(caps.defaultVersion).toBe("v2")
    expect(caps.supportedVersions).toEqual(["v2"])
  })

  it("reports no support when the signer lacks nip44", () => {
    const caps = detectNip44Capabilities({})
    expect(caps.hasNip44).toBe(false)
    expect(caps.supportedVersions).toEqual([])
  })
})

describe("fetchInboxRelayUrls", () => {
  it("resolves and filters a peer's kind-10050 inbox relays", async () => {
    __resetInboxRelayCache()
    const relays = await fetchInboxRelayUrls("peer", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () =>
        [
          {
            id: "10050",
            kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
            pubkey: "peer",
            created_at: 100,
            content: "",
            tags: [
              ["relay", "wss://inbox.example"],
              ["relay", "ws://insecure.example"],
            ],
          },
        ] as never,
    })
    expect(relays).toEqual(["wss://inbox.example"])
  })

  it("surfaces fetch failures without caching a fallback result", async () => {
    __resetInboxRelayCache()
    await expect(
      fetchInboxRelayUrls("peer-2", {
        relayUrls: ["wss://read.example"],
        fetchEvents: async () => {
          throw new Error("relay unavailable")
        },
      })
    ).rejects.toThrow("relay unavailable")
  })

  it("does not cache an absent declaration", async () => {
    __resetInboxRelayCache()
    let fetches = 0
    const fetchEvents = async () => {
      fetches += 1
      return (
        fetches === 1
          ? []
          : [
              {
                id: "10050-later",
                kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
                pubkey: "peer-3",
                created_at: 101,
                content: "",
                tags: [["relay", "wss://later.example"]],
              },
            ]
      ) as never
    }

    expect(
      await fetchInboxRelayUrls("peer-3", {
        relayUrls: ["wss://read.example"],
        fetchEvents,
      })
    ).toEqual([])
    expect(
      await fetchInboxRelayUrls("peer-3", {
        relayUrls: ["wss://read.example"],
        fetchEvents,
      })
    ).toEqual(["wss://later.example"])
    expect(fetches).toBe(2)
  })
})

describe("inspectOwnPrivateMessageRelayReadiness", () => {
  it("reports ready with the declared secure relays", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () =>
        [
          {
            kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
            pubkey: "owner",
            created_at: 100,
            tags: [["relay", "wss://inbox.example"]],
          },
        ] as never,
    })

    expect(readiness).toEqual({
      state: "ready",
      relayUrls: ["wss://inbox.example"],
    })
  })

  it("reports not_declared when no usable declaration exists", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () => [] as never,
    })

    expect(readiness).toEqual({ state: "not_declared" })
  })

  it("rejects lookup errors instead of reporting not_declared", async () => {
    __resetInboxRelayCache()
    await expect(
      inspectOwnPrivateMessageRelayReadiness("owner", {
        relayUrls: ["wss://read.example"],
        fetchEvents: async () => {
          throw new Error("lookup failed")
        },
      })
    ).rejects.toThrow("lookup failed")
  })

  it("rejects when every production discovery relay is unavailable", async () => {
    __resetInboxRelayCache()
    await expect(
      inspectOwnPrivateMessageRelayReadiness("owner", {
        relayUrls: ["wss://read.example"],
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://read.example"],
          successfulRelayUrls: [],
          failedRelayUrls: ["wss://read.example"],
        }),
      })
    ).rejects.toThrow("Private-message relay lookup unavailable")
  })

  it("rejects an empty partial lookup instead of confirming absence", async () => {
    __resetInboxRelayCache()
    await expect(
      inspectOwnPrivateMessageRelayReadiness("owner", {
        relayUrls: ["wss://read-a.example", "wss://read-b.example"],
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://read-a.example", "wss://read-b.example"],
          successfulRelayUrls: ["wss://read-a.example"],
          failedRelayUrls: ["wss://read-b.example"],
        }),
      })
    ).rejects.toThrow("Private-message relay lookup incomplete")
  })

  it("ignores declarations signed by a different author", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () =>
        [
          {
            kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
            pubkey: "attacker",
            created_at: 100,
            tags: [["relay", "wss://attacker.example"]],
          },
        ] as never,
    })

    expect(readiness).toEqual({ state: "not_declared" })
  })

  it("ignores malformed declaration relay tags", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () =>
        [
          {
            kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
            pubkey: "owner",
            created_at: 100,
            tags: [
              ["relay", "://invalid"],
              ["relay", "ftp://inbox.example"],
              ["relay", "ws://insecure.example"],
            ],
          },
        ] as never,
    })

    expect(readiness).toEqual({ state: "not_declared" })
  })
})

describe("publishPrivateMessageRelayDeclaration", () => {
  it("signs and publishes an exact kind-10050 declaration to discovery targets", async () => {
    __resetInboxRelayCache()
    const calls: string[] = []
    let publishedEvent: NDKEvent | undefined
    let publishOptions: Record<string, unknown> | undefined

    const event = await publishPrivateMessageRelayDeclaration({
      pubkey: "owner",
      signer,
      createdAt: 1234,
      relayConfig: {
        dmInboxDefaultRelayUrls: [
          "wss://inbox-a.example/",
          "wss://inbox-b.example",
        ],
      },
      getSignerPubkey: async () => "owner",
      signFn: async (unsignedEvent) => {
        calls.push("sign")
        expect(unsignedEvent.kind).toBe(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)
        expect(unsignedEvent.pubkey).toBe("owner")
        expect(unsignedEvent.created_at).toBe(1234)
        expect(unsignedEvent.tags).toEqual([
          ["relay", "wss://inbox-a.example"],
          ["relay", "wss://inbox-b.example"],
        ])
        expect(unsignedEvent.content).toBe("")
        unsignedEvent.id = "signed-10050"
        unsignedEvent.sig = "signature"
        return unsignedEvent.sig
      },
      getDiscoveryRelayUrls: () => [
        "wss://read-a.example",
        "wss://read-b.example/",
      ],
      publishFn: (async (signedEvent, options) => {
        calls.push("publish")
        publishedEvent = signedEvent
        publishOptions = options
        return {} as never
      }) as never,
    })

    expect(calls).toEqual(["sign", "publish"])
    expect(event).toBe(publishedEvent)
    expect(event.ndk).toBeDefined()
    expect(event.id).toBe("signed-10050")
    expect(publishOptions).toEqual({
      intent: "author_event",
      authorPubkey: "owner",
      authenticatedPubkey: "owner",
      exclusiveRelayUrls: ["wss://read-a.example", "wss://read-b.example"],
      deliveryMode: "critical",
    })

    let fetched = false
    expect(
      await fetchInboxRelayUrls("owner", {
        fetchEvents: async () => {
          fetched = true
          return [] as never
        },
      })
    ).toEqual(["wss://inbox-a.example", "wss://inbox-b.example"])
    expect(fetched).toBe(false)
  })

  it("rejects a signer pubkey mismatch before signing or publishing", async () => {
    let signed = false
    let published = false

    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: "owner",
        signer,
        relayUrls: ["wss://inbox.example"],
        getSignerPubkey: async () => "different-owner",
        signFn: async () => {
          signed = true
          return "signature"
        },
        getDiscoveryRelayUrls: () => ["wss://read.example"],
        publishFn: (async () => {
          published = true
          return {} as never
        }) as never,
      })
    ).rejects.toThrow(
      "Private-message relay declaration signer does not match pubkey"
    )
    expect(signed).toBe(false)
    expect(published).toBe(false)
  })

  it("does not inspect the signer, sign, or publish invalid relay config", async () => {
    for (const relayUrls of [[], ["ws://insecure.example"], ["not a url"]]) {
      let signerInspected = false
      let signed = false
      let published = false

      await expect(
        publishPrivateMessageRelayDeclaration({
          pubkey: "owner",
          signer,
          relayConfig: { dmInboxDefaultRelayUrls: relayUrls },
          getSignerPubkey: async () => {
            signerInspected = true
            return "owner"
          },
          signFn: async () => {
            signed = true
            return "signature"
          },
          getDiscoveryRelayUrls: () => ["wss://read.example"],
          publishFn: (async () => {
            published = true
            return {} as never
          }) as never,
        })
      ).rejects.toThrow()
      expect(signerInspected).toBe(false)
      expect(signed).toBe(false)
      expect(published).toBe(false)
    }
  })
})

describe("parsePrivateMessageRelays", () => {
  it("parses relay tags from a kind-10050 event", () => {
    const parsed = parsePrivateMessageRelays({
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      pubkey: "merchant",
      tags: [
        ["relay", "wss://a.example"],
        ["relay", "wss://b.example"],
        ["relay", "wss://a.example"],
        ["other", "ignored"],
      ],
    })
    expect(parsed).toEqual({
      pubkey: "merchant",
      relayUrls: ["wss://a.example", "wss://b.example"],
    })
  })

  it("returns null for a non-10050 event", () => {
    expect(
      parsePrivateMessageRelays({ kind: EVENT_KINDS.RELAY_LIST, tags: [] })
    ).toBeNull()
  })
})
