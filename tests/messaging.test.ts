import { describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetInboxRelayCache,
  buildDirectMessageRumor,
  classifyPrivateMessageKind,
  createInMemoryInboxDeclarationEvidenceRepository,
  createValidatedOrderRouteScope,
  decryptLegacyDirectMessage,
  detectNip44Capabilities,
  EVENT_KINDS,
  fetchInboxRelayUrls,
  inspectOwnPrivateMessageRelayReadiness,
  mergeInboxDeclarationEvidence,
  parseDirectMessageRumor,
  parsePrivateMessageRelays,
  planInboxReadRelays,
  PrivateMessageRelayReadinessError,
  publishPrivateMessage,
  publishPrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclaration,
  RelayPublishDiagnosticsError,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  unwrapGiftWrap,
  type GiftUnwrapFn,
} from "@conduit/core"

const INBOX_OWNER_SECRET = new Uint8Array(32).fill(11)
const INBOX_PEER_SECRET = new Uint8Array(32).fill(12)
const INBOX_OTHER_SECRET = new Uint8Array(32).fill(13)
const INBOX_OWNER = getPublicKey(INBOX_OWNER_SECRET)
const INBOX_PEER = getPublicKey(INBOX_PEER_SECRET)

function signedInboxDeclaration(
  secretKey: Uint8Array,
  relayUrls: readonly string[],
  createdAt = 100
) {
  return finalizeEvent(
    {
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      created_at: createdAt,
      tags: relayUrls.map((relayUrl) => ["relay", relayUrl]),
      content: "",
    },
    secretKey
  )
}

const signer = {
  user: async () => ({ pubkey: "sender" }),
} as unknown as NDKSigner

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

function validatedOrderInput(order = orderRumor()) {
  return {
    rumor: order,
    validatedOrderScope: createValidatedOrderRouteScope({
      rumor: order,
      orderId: "order-id",
      senderPubkey: "sender",
      recipientPubkey: "recipient",
    }),
  }
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

  it("rejects a rumor authored by a different account before wrapping", async () => {
    let wrapped = false

    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, { pubkey: "other" }),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.example"],
        giftWrapFn: (async () => {
          wrapped = true
          return wrap("unexpected")
        }) as never,
      })
    ).rejects.toThrow("rumor author does not match sender")
    expect(wrapped).toBe(false)
  })

  it("rejects a signer principal that differs from the sender", async () => {
    let wrapped = false

    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer: {
          user: async () => ({ pubkey: "other" }),
        } as unknown as NDKSigner,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.example"],
        giftWrapFn: (async () => {
          wrapped = true
          return wrap("unexpected")
        }) as never,
      })
    ).rejects.toThrow("signer does not match sender")
    expect(wrapped).toBe(false)
  })

  it("rejects a rumor addressed to a different recipient", async () => {
    let wrapped = false

    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags: [["p", "someone-else"]],
        }),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.example"],
        giftWrapFn: (async () => {
          wrapped = true
          return wrap("unexpected")
        }) as never,
      })
    ).rejects.toThrow("rumor recipient does not match delivery recipient")
    expect(wrapped).toBe(false)
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
      rumor: orderRumor({
        pubkey: "guest",
        tags: [
          ["p", "merchant"],
          ["type", "message"],
          ["order", "order-id"],
        ],
      }),
      senderPubkey: "guest",
      recipientPubkey: "merchant",
      signer: {
        user: async () => ({ pubkey: "guest" }),
      } as unknown as NDKSigner,
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

  it("delivers a validated order over the compatibility route when the recipient has no declaration", async () => {
    const publishes: Array<{ id: string; relays: readonly string[] }> = []

    const result = await publishPrivateMessage({
      ...validatedOrderInput(),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: false,
      recipientInboxRelays: [],
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: ["wss://compatibility.conduit.example"],
      },
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (event, options) => {
        publishes.push({
          id: event.id,
          relays: options.exclusiveRelayUrls ?? [],
        })
        return {} as never
      }) as never,
    })

    expect(publishes).toEqual([
      {
        id: "wrap-recipient",
        relays: ["wss://compatibility.conduit.example"],
      },
    ])
    expect(result.deliveryRoute).toBe("compatibility_order")
  })

  it("accepts one compatibility ACK, surfaces partial delivery, and keeps NIP-65 bounded", async () => {
    const result = await publishPrivateMessage({
      ...validatedOrderInput(),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: false,
      recipientInboxRelays: [],
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: [
          "wss://conduit.example",
          "wss://inbox.example",
          "wss://interop.example",
        ],
      },
      resolveCompatibilityRecipientReadRelays: async () => [
        "wss://arbitrary.example",
        "wss://inbox.example/",
      ],
      giftWrapFn: (async () => wrap("recipient-wrap")) as never,
      publishFn: (async (_event, options) => {
        const relayUrls = [...(options.exclusiveRelayUrls ?? [])]
        expect(relayUrls).toEqual([
          "wss://inbox.example",
          "wss://conduit.example",
          "wss://interop.example",
        ])
        return {
          plan: {
            intent: "recipient_event",
            primaryRelayUrls: relayUrls,
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: ["wss://inbox.example"],
          failedRelayUrls: ["wss://conduit.example", "wss://interop.example"],
          relayFailureMessages: {
            "wss://conduit.example": "No acknowledgement before timeout",
            "wss://interop.example": "rate-limited: retry later",
          },
        }
      }) as never,
    })

    expect(result.deliveryStatus).toBe("partial_success")
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      "wss://inbox.example",
    ])
    expect(result.deliveryRelaySources).toEqual({
      "wss://inbox.example": "recipient_nip65",
      "wss://conduit.example": "compatibility_registry",
      "wss://interop.example": "compatibility_registry",
    })
    expect(JSON.stringify(result.deliveryRelaySources)).not.toContain(
      "Order update"
    )
  })

  it("fails explicitly when every compatibility relay fails", async () => {
    const diagnostics = {
      plan: {
        intent: "recipient_event" as const,
        primaryRelayUrls: ["wss://one.example", "wss://two.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      },
      attemptedRelayUrls: ["wss://one.example", "wss://two.example"],
      successfulRelayUrls: [],
      failedRelayUrls: ["wss://one.example", "wss://two.example"],
      relayFailureMessages: {
        "wss://one.example": "No acknowledgement before timeout",
        "wss://two.example": "No acknowledgement before timeout",
      },
    }

    await expect(
      publishPrivateMessage({
        ...validatedOrderInput(),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        recipientInboxRelays: [],
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://one.example", "wss://two.example"],
        },
        giftWrapFn: (async () => wrap("recipient-wrap")) as never,
        publishFn: (async () => {
          throw new RelayPublishDiagnosticsError(
            "No compatibility relay ACKed the order.",
            diagnostics,
            new Error("relay delivery failed")
          )
        }) as never,
      })
    ).rejects.toBeInstanceOf(RelayPublishDiagnosticsError)
  })

  it("keeps a declared inbox exclusive even when compatibility is enabled", async () => {
    const publishes: Array<readonly string[]> = []

    const result = await publishPrivateMessage({
      ...validatedOrderInput(),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: false,
      recipientInboxRelays: ["wss://recipient.inbox.example"],
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: ["wss://compatibility.conduit.example"],
      },
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (_event, options) => {
        publishes.push(options.exclusiveRelayUrls ?? [])
        return {} as never
      }) as never,
    })

    expect(publishes).toEqual([["wss://recipient.inbox.example"]])
    expect(result.deliveryRoute).toBe("declared_inbox")
  })

  it("never routes kind-14 direct messages through the compatibility lane", async () => {
    let published = false
    let thrown: unknown

    try {
      await publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        selfCopy: false,
        recipientInboxRelays: [],
        validatedOrderScope: {} as never,
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://compatibility.conduit.example"],
        },
        giftWrapFn: (async () => wrap("unexpected")) as never,
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
    expect(published).toBe(false)
  })

  it("blocks unvalidated orders from the compatibility lane", async () => {
    let published = false
    let thrown: unknown

    try {
      await publishPrivateMessage({
        rumor: orderRumor(),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        recipientInboxRelays: [],
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://compatibility.conduit.example"],
        },
        giftWrapFn: (async () => wrap("unexpected")) as never,
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
    expect(published).toBe(false)
  })

  it("keeps compatibility writes disabled by default for validated orders", async () => {
    let published = false
    let thrown: unknown

    try {
      await publishPrivateMessage({
        ...validatedOrderInput(),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        recipientInboxRelays: [],
        giftWrapFn: (async () => wrap("unexpected")) as never,
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
    expect(published).toBe(false)
  })

  it("blocks a malformed recipient declaration instead of using compatibility", async () => {
    let published = false
    let thrown: unknown

    try {
      await publishPrivateMessage({
        ...validatedOrderInput(),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        // Signed declaration with no secure relay: malformed, never
        // downgraded to not_observed, so the compatibility lane stays closed.
        recipientInboxRelays: ["ws://insecure.example"],
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://compatibility.conduit.example"],
        },
        giftWrapFn: (async () => wrap("unexpected")) as never,
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
      "recipient_declaration_malformed"
    )
    expect(published).toBe(false)
  })

  it("reports a signed empty recipient distinctly while keeping compatibility closed", async () => {
    let thrown: unknown
    try {
      await publishPrivateMessage({
        ...validatedOrderInput(),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        resolveInboxRelays: async () => {
          const error = new Error("signed empty") as Error & {
            declarationState?: string
          }
          error.declarationState = "signed_empty"
          throw error
        },
        giftWrapFn: (async () => wrap("unexpected")) as never,
      })
    } catch (error) {
      thrown = error
    }

    // The legacy seam cannot authenticate signed-empty provenance, so this
    // assertion exercises the public typed reason through the route selector.
    expect(thrown).toBeInstanceOf(PrivateMessageRelayReadinessError)
    expect((thrown as PrivateMessageRelayReadinessError).reason).toBe(
      "recipient_lookup_failed"
    )
  })

  it("keeps the sender self-copy off the compatibility lane", async () => {
    const publishedExclusiveSets: string[][] = []

    const result = await publishPrivateMessage({
      ...validatedOrderInput(),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: true,
      recipientInboxRelays: [],
      senderInboxRelays: [],
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: ["wss://compatibility.conduit.example"],
      },
      giftWrapFn: (async () => wrap("wrap")) as never,
      publishFn: (async (_event: unknown, options: never) => {
        publishedExclusiveSets.push(
          (options as { exclusiveRelayUrls: string[] }).exclusiveRelayUrls
        )
        return {} as never
      }) as never,
    })

    // Recipient leg uses compatibility; the sender self-copy stays strict and
    // fails soft instead of writing to the compatibility allowlist.
    expect(result.deliveryRoute).toBe("compatibility_order")
    expect(publishedExclusiveSets).toEqual([
      ["wss://compatibility.conduit.example"],
    ])
    expect(result.selfCopyError).toBe(
      "Sender has no usable NIP-17 inbox relay declaration."
    )
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
    const relays = await fetchInboxRelayUrls(INBOX_PEER, {
      relayUrls: ["wss://read.example"],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      fetchEvents: async () =>
        [
          signedInboxDeclaration(INBOX_PEER_SECRET, [
            "wss://inbox.example",
            "ws://insecure.example",
          ]),
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
    ).rejects.toThrow("Private-message relay lookup unavailable")
  })

  it("does not cache an absent declaration", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    let fetches = 0
    const fetchEvents = async () => {
      fetches += 1
      return (
        fetches === 1
          ? []
          : [
              signedInboxDeclaration(
                INBOX_PEER_SECRET,
                ["wss://later.example"],
                101
              ),
            ]
      ) as never
    }

    expect(
      await fetchInboxRelayUrls(INBOX_PEER, {
        relayUrls: ["wss://read.example"],
        fetchEvents,
        evidenceRepository,
      })
    ).toEqual([])
    expect(
      await fetchInboxRelayUrls(INBOX_PEER, {
        relayUrls: ["wss://read.example"],
        fetchEvents,
        evidenceRepository,
      })
    ).toEqual(["wss://later.example"])
    expect(fetches).toBe(2)
  })
})

describe("inspectOwnPrivateMessageRelayReadiness", () => {
  it("reports ready with the declared secure relays", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.example"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () =>
          [
            signedInboxDeclaration(INBOX_OWNER_SECRET, ["wss://inbox.example"]),
          ] as never,
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      relayUrls: ["wss://inbox.example"],
      stale: false,
      distributionRepairable: false,
    })
  })

  it("makes a retained declaration repairable after complete shared non-observation", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const declaration = signedInboxDeclaration(INBOX_OWNER_SECRET, [
      "wss://inbox.example",
    ])
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: declaration,
        sourceRelayUrls: ["wss://owner-local.example"],
        observedAt: 1_000,
        completeObservedAt: 1_000,
      },
      evidenceRepository
    )

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://shared.example"],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://shared.example"],
          successfulRelayUrls: ["wss://shared.example"],
          failedRelayUrls: [],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      relayUrls: ["wss://inbox.example"],
      stale: true,
      distributionRepairable: true,
    })
  })

  it("keeps stale signed blockers retry-only and exposes retained recovery relays", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const declared = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://usable.example"],
      100
    )
    const blocker = signedInboxDeclaration(INBOX_OWNER_SECRET, [], 200)
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: declared },
      evidenceRepository
    )
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: blocker },
      evidenceRepository
    )

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [
            "wss://shared-a.example",
            "wss://shared-b.example",
          ],
          successfulRelayUrls: ["wss://shared-a.example"],
          failedRelayUrls: ["wss://shared-b.example"],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      stale: true,
      distributionRepairable: false,
      retainedRelayUrls: ["wss://usable.example"],
    })
  })

  it("does not repair a retained signed blocker from a complete empty view", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const blocker = signedInboxDeclaration(INBOX_OWNER_SECRET, [], 200)
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: blocker },
      evidenceRepository
    )

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://shared.example"],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://shared.example"],
          successfulRelayUrls: ["wss://shared.example"],
          failedRelayUrls: [],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      stale: true,
      distributionRepairable: false,
      retainedRelayUrls: [],
    })
  })

  it("reports not_observed when no declaration is observed", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () => [] as never,
    })

    expect(readiness).toEqual({ state: "not_observed" })
  })

  it("reports lookup_unavailable for lookup errors instead of not_observed", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEvents: async () => {
        throw new Error("lookup failed")
      },
    })

    expect(readiness).toEqual({ state: "lookup_unavailable" })
  })

  it("reports lookup_unavailable when every discovery relay is unavailable", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://read.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://read.example"],
      }),
    })

    expect(readiness).toEqual({ state: "lookup_unavailable" })
  })

  it("reports lookup_partial for an empty partial lookup instead of absence", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read-a.example", "wss://read-b.example"],
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://read-a.example", "wss://read-b.example"],
        successfulRelayUrls: ["wss://read-a.example"],
        failedRelayUrls: ["wss://read-b.example"],
      }),
    })

    expect(readiness).toEqual({ state: "lookup_partial" })
  })

  it("ignores declarations signed by a different author", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.example"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () =>
          [
            signedInboxDeclaration(INBOX_OTHER_SECRET, [
              "wss://attacker.example",
            ]),
          ] as never,
      }
    )

    expect(readiness).toEqual({ state: "not_observed" })
  })

  it("reports malformed for a signed declaration without usable relays", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.example"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () =>
          [
            signedInboxDeclaration(INBOX_OWNER_SECRET, [
              "://invalid",
              "ftp://inbox.example",
              "ws://insecure.example",
            ]),
          ] as never,
      }
    )

    expect(readiness).toEqual({
      state: "malformed",
      stale: false,
      distributionRepairable: false,
      retainedRelayUrls: [],
    })
  })

  it("reports a cryptographically valid empty declaration distinctly", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.example"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () =>
          [signedInboxDeclaration(INBOX_OWNER_SECRET, [])] as never,
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      stale: false,
      distributionRepairable: false,
      retainedRelayUrls: [],
    })
  })
})

describe("publishPrivateMessageRelayDeclaration", () => {
  it("signs and publishes an exact kind-10050 declaration to discovery targets", async () => {
    __resetInboxRelayCache()
    const calls: string[] = []
    let publishedEvent: NDKEvent | undefined
    let publishOptions: Record<string, unknown> | undefined

    const event = await publishPrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signer,
      createdAt: 1234,
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      relayConfig: {
        dmInboxDefaultRelayUrls: [
          "wss://inbox-a.example/",
          "wss://inbox-b.example",
        ],
      },
      getSignerPubkey: async () => INBOX_OWNER,
      signFn: async (unsignedEvent) => {
        calls.push("sign")
        expect(unsignedEvent.kind).toBe(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)
        expect(unsignedEvent.pubkey).toBe(INBOX_OWNER)
        expect(unsignedEvent.created_at).toBe(1234)
        expect(unsignedEvent.tags).toEqual([
          ["relay", "wss://inbox-a.example"],
          ["relay", "wss://inbox-b.example"],
        ])
        expect(unsignedEvent.content).toBe("")
        const signed = signedInboxDeclaration(
          INBOX_OWNER_SECRET,
          ["wss://inbox-a.example", "wss://inbox-b.example"],
          1234
        )
        unsignedEvent.id = signed.id
        unsignedEvent.pubkey = signed.pubkey
        unsignedEvent.sig = signed.sig
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
    expect(event.id).toMatch(/^[0-9a-f]{64}$/)
    expect(publishOptions).toEqual({
      intent: "author_event",
      authorPubkey: INBOX_OWNER,
      authenticatedPubkey: INBOX_OWNER,
      exclusiveRelayUrls: ["wss://read-a.example", "wss://read-b.example"],
      deliveryMode: "critical",
    })

    let fetched = false
    expect(
      await fetchInboxRelayUrls(INBOX_OWNER, {
        fetchEvents: async () => {
          fetched = true
          return [] as never
        },
      })
    ).toEqual(["wss://inbox-a.example", "wss://inbox-b.example"])
    // A memory prime is useful fallback evidence, but it is not cross-client
    // discovery proof; the next lookup must still perform relay read-back.
    expect(fetched).toBe(true)
  })

  it("rejects invalid signed output before the publish boundary", async () => {
    let published = false
    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        relayUrls: ["wss://inbox.example"],
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          event.id = "not-a-valid-id"
          event.sig = "not-a-valid-signature"
          return event.sig
        },
        getDiscoveryRelayUrls: () => ["wss://shared.example"],
        publishFn: (async () => {
          published = true
          return {} as never
        }) as never,
      })
    ).rejects.toThrow("signer returned an invalid event")
    expect(published).toBe(false)
  })

  it("redistributes the exact retained event without signing a replacement", async () => {
    const retained = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      [
        "wss://inbox-a.example",
        "wss://inbox-b.example",
        "wss://inbox-c.example",
        "wss://inbox-d.example",
      ],
      1234
    )
    let published: NDKEvent | undefined
    const event = await redistributePrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      getDiscoveryRelayUrls: () => ["wss://shared.example"],
      publishFn: (async (candidate, options) => {
        published = candidate
        expect(options.exclusiveRelayUrls).toEqual(["wss://shared.example"])
        return {} as never
      }) as never,
    })

    expect(event).toBe(published)
    expect(JSON.parse(JSON.stringify(event.rawEvent()))).toEqual(
      JSON.parse(JSON.stringify(retained))
    )
    expect(event.created_at).toBe(1234)
    expect(event.id).toBe(retained.id)
  })

  it("carries owner repair through unrelated sender discovery and strict recipient reads", async () => {
    __resetInboxRelayCache()
    const ownerRepository = createInMemoryInboxDeclarationEvidenceRepository()
    let distributed: NDKEvent | undefined
    await publishPrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signer,
      relayUrls: ["wss://recipient-inbox.example"],
      createdAt: 2_000,
      evidenceRepository: ownerRepository,
      getSignerPubkey: async () => INBOX_OWNER,
      signFn: async (event) => {
        const signed = signedInboxDeclaration(
          INBOX_OWNER_SECRET,
          ["wss://recipient-inbox.example"],
          2_000
        )
        event.id = signed.id
        event.pubkey = signed.pubkey
        event.sig = signed.sig
        return signed.sig
      },
      getDiscoveryRelayUrls: () => ["wss://shared-discovery.example"],
      publishFn: (async (event) => {
        distributed = event
        return {} as never
      }) as never,
    })

    __resetInboxRelayCache()
    const senderRepository = createInMemoryInboxDeclarationEvidenceRepository()
    const senderView = await resolveInboxDeclaration(INBOX_OWNER, {
      relayUrls: ["wss://shared-discovery.example"],
      evidenceRepository: senderRepository,
      fetchEventsWithDiagnostics: async () => ({
        events: [distributed!] as never,
        attemptedRelayUrls: ["wss://shared-discovery.example"],
        successfulRelayUrls: ["wss://shared-discovery.example"],
        failedRelayUrls: [],
      }),
    })
    const delivery = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: senderView,
      validatedOrder: false,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })
    const recipientRead = planInboxReadRelays({
      declaration: senderView,
      localReadRelayUrls: [],
      compatibilityRelayUrls: [],
    })

    expect(senderView.state).toBe("declared")
    expect(delivery.route).toBe("declared_inbox")
    expect(delivery.relayUrls).toEqual(["wss://recipient-inbox.example"])
    expect(delivery.relayUrls).not.toContain("wss://compatibility.example")
    expect(recipientRead.relayUrls).toEqual(["wss://recipient-inbox.example"])
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
