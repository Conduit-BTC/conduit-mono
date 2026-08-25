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
  createValidatedGuestOrderCompanion,
  createValidatedOrderRouteScope,
  decryptLegacyDirectMessage,
  detectNip44Capabilities,
  EVENT_KINDS,
  fetchInboxRelayUrls,
  getInboxDeclarationEvidence,
  InboxDeclarationPublishSafetyError,
  inspectOwnPrivateMessageRelayReadiness,
  inspectRetainedOwnPrivateMessageRelayReadiness,
  mergeInboxDeclarationEvidenceInMemory,
  mergeInboxDeclarationEvidence,
  parseDirectMessageRumor,
  parsePrivateMessageRelays,
  planInboxReadRelays,
  PrivateMessageRelayReadinessError,
  publishPrivateMessage,
  publishPrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclarationAcrossPlans,
  RelayPublishDiagnosticsError,
  resolveInboxDeclaration,
  selectInboxDeclarationCreatedAt,
  selectPrivateMessageDeliveryRoute,
  sharedInboxDiscoveryRelayUrls,
  unwrapGiftWrap,
  type GiftUnwrapFn,
  type InboxDeclarationDistributionRepository,
  type InboxDeclarationEvidenceRepository,
  type OwnPrivateMessageRelayReadiness,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

const INBOX_OWNER_SECRET = new Uint8Array(32).fill(11)
const INBOX_PEER_SECRET = new Uint8Array(32).fill(12)
const INBOX_OTHER_SECRET = new Uint8Array(32).fill(13)
const INBOX_OWNER = getPublicKey(INBOX_OWNER_SECRET)
const INBOX_PEER = getPublicKey(INBOX_PEER_SECRET)
const SHARED_INBOX_RELAY = sharedInboxDiscoveryRelayUrls()[0]!

function withInboxSource<T>(event: T, relayUrl = SHARED_INBOX_RELAY): T {
  attachEventSourceRelayUrl(event as unknown as NDKEvent, relayUrl)
  return event
}

const readyOwnInbox = async (): Promise<
  Extract<OwnPrivateMessageRelayReadiness, { state: "ready" }>
> => ({
  state: "ready",
  eventId: "a".repeat(64),
  relayUrls: ["wss://sender.inbox.conduit.market"],
  stale: false,
  distributionRepairable: false,
})

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

function guestOrderCompanionFixture() {
  const authoritativeOrder = new NDKEvent()
  authoritativeOrder.id = "guest-order-rumor"
  authoritativeOrder.kind = EVENT_KINDS.ORDER
  authoritativeOrder.pubkey = "guest"
  authoritativeOrder.created_at = 1000
  authoritativeOrder.tags = [
    ["p", "merchant"],
    ["type", "order"],
    ["order", "guest-order-id"],
  ]
  authoritativeOrder.content = JSON.stringify({
    id: "guest-order-id",
    merchantPubkey: "merchant",
    buyerPubkey: "guest",
    buyerIdentityKind: "guest_ephemeral",
    items: [
      {
        productId: "product-id",
        quantity: 1,
        priceAtPurchase: 1,
        currency: "SATS",
      },
    ],
    subtotal: 1,
    currency: "SATS",
    guestContact: {
      email: "guest@example.com",
      phone: "+1-555-0100",
    },
    createdAt: 1_000_000,
  })

  return {
    authoritativeOrder,
    ...createValidatedGuestOrderCompanion({
      authoritativeOrder,
      senderPubkey: "guest",
      recipientPubkey: "merchant",
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
        recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
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

  it("blocks kind-14 sends for every non-ready sender state before wrapping", async () => {
    const eventId = "a".repeat(64)
    const blockedReadiness: OwnPrivateMessageRelayReadiness[] = [
      {
        state: "distribution_pending",
        eventId,
        relayUrls: ["wss://sender.inbox.example"],
        retainedRelayUrls: [],
        stale: true,
        distributionRepairable: false,
      },
      {
        state: "signed_empty",
        eventId,
        stale: false,
        distributionRepairable: false,
        retainedRelayUrls: [],
      },
      {
        state: "malformed",
        eventId,
        stale: false,
        distributionRepairable: false,
        retainedRelayUrls: [],
      },
      { state: "lookup_unavailable" },
    ]

    for (const senderReadiness of blockedReadiness) {
      let wraps = 0
      let publishes = 0
      let caught: unknown
      try {
        await publishPrivateMessage({
          rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
          senderPubkey: "sender",
          recipientPubkey: "recipient",
          signer,
          rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
          recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
          inspectOwnInboxReadiness: async () => senderReadiness,
          giftWrapFn: (async () => {
            wraps += 1
            return wrap("unexpected")
          }) as never,
          publishFn: (async () => {
            publishes += 1
            return {} as never
          }) as never,
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(PrivateMessageRelayReadinessError)
      expect((caught as PrivateMessageRelayReadinessError).reason).toBe(
        "sender_not_ready"
      )
      expect(wraps).toBe(0)
      expect(publishes).toBe(0)
    }
  })

  it("delivers one scoped guest order companion without inspecting a guest inbox", async () => {
    const { companion, scope } = guestOrderCompanionFixture()
    const wrappedRecipients: string[] = []
    const publishRelays: Array<readonly string[]> = []
    let senderReadinessChecks = 0

    const result = await publishPrivateMessage({
      rumor: companion,
      senderPubkey: "guest",
      recipientPubkey: "merchant",
      signer: {
        user: async () => ({ pubkey: "guest" }),
      } as unknown as NDKSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      recipientInboxRelays: ["wss://merchant.inbox.conduit.market"],
      validatedGuestOrderCompanionScope: scope,
      inspectOwnInboxReadiness: async () => {
        senderReadinessChecks += 1
        return { state: "lookup_unavailable" }
      },
      giftWrapFn: (async (_rumor, recipient) => {
        wrappedRecipients.push(recipient.pubkey)
        return wrap(`wrap-${recipient.pubkey}`)
      }) as never,
      publishFn: (async (_event, options) => {
        const relays = options.exclusiveRelayUrls ?? []
        publishRelays.push(relays)
        return {
          successfulRelayUrls: [relays[0]],
          failedRelayUrls: [],
        } as never
      }) as never,
    })

    expect(senderReadinessChecks).toBe(0)
    expect(wrappedRecipients).toEqual(["merchant"])
    expect(publishRelays).toEqual([["wss://merchant.inbox.conduit.market"]])
    expect(result.wrappedToSelf).toBeNull()
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      "wss://merchant.inbox.conduit.market",
    ])
  })

  it("keeps the guest companion capability one-use and recipient-inbox strict", async () => {
    const first = guestOrderCompanionFixture()
    const input = {
      rumor: first.companion,
      senderPubkey: "guest",
      recipientPubkey: "merchant",
      signer: {
        user: async () => ({ pubkey: "guest" }),
      } as unknown as NDKSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      recipientInboxRelays: ["wss://merchant.inbox.conduit.market"],
      validatedGuestOrderCompanionScope: first.scope,
      inspectOwnInboxReadiness: async () =>
        ({ state: "lookup_unavailable" }) as const,
      giftWrapFn: (async () => wrap("wrap-merchant")) as never,
      publishFn: (async () =>
        ({
          successfulRelayUrls: ["wss://merchant.inbox.conduit.market"],
        }) as never) as never,
    }

    await expect(publishPrivateMessage(input)).resolves.toMatchObject({
      deliveryRoute: "declared_inbox",
    })
    await expect(publishPrivateMessage(input)).rejects.toMatchObject({
      reason: "sender_not_ready",
    })

    const second = guestOrderCompanionFixture()
    await expect(
      publishPrivateMessage({
        ...input,
        rumor: second.companion,
        recipientInboxRelays: [],
        validatedGuestOrderCompanionScope: second.scope,
      })
    ).rejects.toMatchObject({ reason: "recipient_not_ready" })
  })

  it("does not authorize mutated guest companion content or tags", async () => {
    for (const mutate of [
      (companion: NDKEvent) => {
        companion.content = JSON.stringify({
          contact: "guest@example.com",
          payment: "lnbc-sensitive",
        })
      },
      (companion: NDKEvent) => {
        companion.tags.push(["order", "conflicting-order"])
      },
    ]) {
      const fixture = guestOrderCompanionFixture()
      mutate(fixture.companion)
      fixture.companion.id = fixture.companion.getEventHash()

      await expect(
        publishPrivateMessage({
          rumor: fixture.companion,
          senderPubkey: "guest",
          recipientPubkey: "merchant",
          signer: {
            user: async () => ({ pubkey: "guest" }),
          } as unknown as NDKSigner,
          rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
          selfCopy: false,
          recipientInboxRelays: ["wss://merchant.inbox.conduit.market"],
          validatedGuestOrderCompanionScope: fixture.scope,
          inspectOwnInboxReadiness: async () =>
            ({ state: "lookup_unavailable" }) as const,
        })
      ).rejects.toMatchObject({ reason: "sender_not_ready" })
    }
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
        return [`wss://${pubkey}.inbox.conduit.market`]
      },
      inspectOwnInboxReadiness: async (pubkey) => {
        resolved.push(pubkey)
        return readyOwnInbox()
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
        relays: ["wss://recipient.inbox.conduit.market"],
      },
      {
        id: "wrap-sender",
        recipients: ["sender"],
        relays: ["wss://sender.inbox.conduit.market"],
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
      recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      inspectOwnInboxReadiness: readyOwnInbox,
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
        return ["wss://merchant.inbox.conduit.market"]
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
      recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      senderInboxRelays: ["wss://sender.inbox.conduit.market"],
      inspectOwnInboxReadiness: readyOwnInbox,
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
        relayUrls: ["wss://compatibility.conduit.market"],
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
        relays: ["wss://compatibility.conduit.market"],
      },
    ])
    expect(result.deliveryRoute).toBe("compatibility_order")
  })

  it("records a guest order update to the merchant without treating the guest as an inbox", async () => {
    const guestOrderUpdate = orderRumor({
      pubkey: "merchant",
      tags: [
        ["p", "guest"],
        ["type", "status_update"],
        ["order", "guest-order-id"],
        ["status", "paid"],
      ],
      content: JSON.stringify({
        orderId: "guest-order-id",
        merchantPubkey: "merchant",
        buyerPubkey: "guest",
        status: "paid",
      }),
    })

    const result = await publishPrivateMessage({
      rumor: guestOrderUpdate,
      senderPubkey: "merchant",
      recipientPubkey: "merchant",
      signer: {
        user: async () => ({ pubkey: "merchant" }),
      } as unknown as NDKSigner,
      rumorKind: EVENT_KINDS.ORDER,
      selfCopy: false,
      recipientInboxRelays: [],
      validatedOrderScope: createValidatedOrderRouteScope({
        rumor: guestOrderUpdate,
        orderId: "guest-order-id",
        senderPubkey: "merchant",
        recipientPubkey: "merchant",
        rumorRecipientPubkey: "guest",
      }),
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: ["wss://compatibility.conduit.market"],
      },
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async () => ({})) as never,
    })

    expect(result.wrappedToRecipient.id).toBe("wrap-merchant")
    expect(result.deliveryRoute).toBe("compatibility_order")
  })

  it("does not authorize a mismatched order rumor for third-party delivery", () => {
    const mismatchedOrder = orderRumor({
      pubkey: "merchant",
      tags: [
        ["p", "guest"],
        ["type", "status_update"],
        ["order", "guest-order-id"],
        ["status", "paid"],
      ],
      content: JSON.stringify({ status: "paid" }),
    })

    expect(() =>
      createValidatedOrderRouteScope({
        rumor: mismatchedOrder,
        orderId: "guest-order-id",
        senderPubkey: "merchant",
        recipientPubkey: "third-party",
        rumorRecipientPubkey: "guest",
      })
    ).toThrow("Cannot authorize compatibility routing for this rumor.")
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
          "wss://commerce.conduit.market",
          "wss://inbox.conduit.market",
          "wss://interop.conduit.market",
        ],
      },
      resolveCompatibilityRecipientReadRelays: async () => [
        "wss://arbitrary.conduit.market",
        "wss://inbox.conduit.market/",
      ],
      giftWrapFn: (async () => wrap("recipient-wrap")) as never,
      publishFn: (async (_event, options) => {
        const relayUrls = [...(options.exclusiveRelayUrls ?? [])]
        expect(relayUrls).toEqual([
          "wss://inbox.conduit.market",
          "wss://commerce.conduit.market",
          "wss://interop.conduit.market",
        ])
        return {
          plan: {
            intent: "recipient_event",
            primaryRelayUrls: relayUrls,
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: ["wss://inbox.conduit.market"],
          failedRelayUrls: [
            "wss://commerce.conduit.market",
            "wss://interop.conduit.market",
          ],
          relayFailureMessages: {
            "wss://commerce.conduit.market":
              "No acknowledgement before timeout",
            "wss://interop.conduit.market": "rate-limited: retry later",
          },
        }
      }) as never,
    })

    expect(result.deliveryStatus).toBe("partial_success")
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      "wss://inbox.conduit.market",
    ])
    expect(result.deliveryRelaySources).toEqual({
      "wss://inbox.conduit.market": "recipient_nip65",
      "wss://commerce.conduit.market": "compatibility_registry",
      "wss://interop.conduit.market": "compatibility_registry",
    })
    expect(JSON.stringify(result.deliveryRelaySources)).not.toContain(
      "Order update"
    )
  })

  it("fails explicitly when every compatibility relay fails", async () => {
    const diagnostics = {
      plan: {
        intent: "recipient_event" as const,
        primaryRelayUrls: [
          "wss://one.conduit.market",
          "wss://two.conduit.market",
        ],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      },
      attemptedRelayUrls: [
        "wss://one.conduit.market",
        "wss://two.conduit.market",
      ],
      successfulRelayUrls: [],
      failedRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      relayFailureMessages: {
        "wss://one.conduit.market": "No acknowledgement before timeout",
        "wss://two.conduit.market": "No acknowledgement before timeout",
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
          relayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
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
      recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      compatibilityOrderRoute: {
        enabled: true,
        relayUrls: ["wss://compatibility.conduit.market"],
      },
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (_event, options) => {
        publishes.push(options.exclusiveRelayUrls ?? [])
        return {} as never
      }) as never,
    })

    expect(publishes).toEqual([["wss://recipient.inbox.conduit.market"]])
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
          relayUrls: ["wss://compatibility.conduit.market"],
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
          relayUrls: ["wss://compatibility.conduit.market"],
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
        // Signed declaration with no public relay: malformed, never
        // downgraded to not_observed, so the compatibility lane stays closed.
        recipientInboxRelays: [
          "ws://insecure.conduit.market",
          "wss://127.0.0.1:8080",
        ],
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://compatibility.conduit.market"],
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
        relayUrls: ["wss://compatibility.conduit.market"],
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
      ["wss://compatibility.conduit.market"],
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
      relayUrls: ["wss://read.conduit.market"],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      fetchEvents: async () =>
        [
          signedInboxDeclaration(INBOX_PEER_SECRET, [
            "wss://inbox.conduit.market",
            "ws://insecure.conduit.market",
          ]),
        ] as never,
    })
    expect(relays).toEqual(["wss://inbox.conduit.market"])
  })

  it("surfaces fetch failures without caching a fallback result", async () => {
    __resetInboxRelayCache()
    await expect(
      fetchInboxRelayUrls("peer-2", {
        relayUrls: ["wss://read.conduit.market"],
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
                ["wss://later.conduit.market"],
                101
              ),
            ]
      ) as never
    }

    expect(
      await fetchInboxRelayUrls(INBOX_PEER, {
        relayUrls: ["wss://read.conduit.market"],
        fetchEvents,
        evidenceRepository,
      })
    ).toEqual([])
    expect(
      await fetchInboxRelayUrls(INBOX_PEER, {
        relayUrls: ["wss://read.conduit.market"],
        fetchEvents,
        evidenceRepository,
      })
    ).toEqual(["wss://later.conduit.market"])
    expect(fetches).toBe(2)
  })
})

describe("inspectOwnPrivateMessageRelayReadiness", () => {
  it("retains canonical shared proof across an ordinary resolve and degraded owner check", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const declaration = withInboxSource(
      signedInboxDeclaration(INBOX_OWNER_SECRET, ["wss://inbox.example"])
    )

    await resolveInboxDeclaration(INBOX_OWNER, {
      relayUrls: [SHARED_INBOX_RELAY],
      evidenceRepository,
      fetchEventsWithDiagnostics: async () => ({
        events: [declaration] as never,
        attemptedRelayUrls: [SHARED_INBOX_RELAY],
        successfulRelayUrls: [SHARED_INBOX_RELAY],
        failedRelayUrls: [],
      }),
    })
    __resetInboxRelayCache()

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [SHARED_INBOX_RELAY],
          successfulRelayUrls: [],
          failedRelayUrls: [SHARED_INBOX_RELAY],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      eventId: declaration.id,
      relayUrls: ["wss://inbox.example"],
      stale: true,
      distributionRepairable: false,
    })
  })

  it("does not promote owner-local provenance during an ordinary resolve", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const ownerLocalRelay = "wss://127.0.0.1:7777"
    const declaration = withInboxSource(
      signedInboxDeclaration(INBOX_OWNER_SECRET, ["wss://inbox.example"]),
      ownerLocalRelay
    )

    await resolveInboxDeclaration(INBOX_OWNER, {
      relayUrls: [ownerLocalRelay],
      allowLocalRelayUrlsForPubkey: INBOX_OWNER,
      evidenceRepository,
      fetchEventsWithDiagnostics: async () => ({
        events: [declaration] as never,
        attemptedRelayUrls: [ownerLocalRelay],
        successfulRelayUrls: [ownerLocalRelay],
        failedRelayUrls: [],
      }),
    })
    __resetInboxRelayCache()

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [SHARED_INBOX_RELAY],
          successfulRelayUrls: [],
          failedRelayUrls: [SHARED_INBOX_RELAY],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "distribution_pending",
      eventId: declaration.id,
      relayUrls: ["wss://inbox.example"],
      retainedRelayUrls: [],
      stale: true,
      distributionRepairable: false,
    })
  })

  it("performs the send-time readiness check from durable evidence without relay traffic", async () => {
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
        sourceRelayUrls: [SHARED_INBOX_RELAY],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY],
        observedAt: 1_000,
        completeObservedAt: 1_000,
      },
      evidenceRepository
    )

    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository,
      })
    ).toEqual({
      state: "ready",
      eventId: declaration.id,
      relayUrls: ["wss://inbox.example"],
      stale: false,
      distributionRepairable: false,
    })

    const blocker = signedInboxDeclaration(INBOX_OWNER_SECRET, [], 200)
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: blocker },
      evidenceRepository
    )
    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository,
      })
    ).toMatchObject({ state: "signed_empty", eventId: blocker.id })
  })

  it("fails the durable send-time boundary closed on stronger process-only evidence", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const durable = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://durable-inbox.example"],
      100
    )
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: durable,
        sourceRelayUrls: [SHARED_INBOX_RELAY],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY],
      },
      evidenceRepository
    )
    mergeInboxDeclarationEvidenceInMemory({
      pubkey: INBOX_OWNER,
      signedEvent: signedInboxDeclaration(INBOX_OWNER_SECRET, [], 200),
    })

    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository,
      })
    ).toEqual({ state: "lookup_unavailable" })
  })

  it("revalidates durable rows before using them as send authority", async () => {
    __resetInboxRelayCache()
    const seed = createInMemoryInboxDeclarationEvidenceRepository()
    const declaration = signedInboxDeclaration(INBOX_OWNER_SECRET, [
      "wss://inbox.example",
    ])
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: declaration,
        sourceRelayUrls: [SHARED_INBOX_RELAY],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY],
      },
      seed
    )
    const validRecord = (await getInboxDeclarationEvidence(INBOX_OWNER, seed))!

    const invalidSignature = structuredClone(validRecord)
    invalidSignature.current.signedEvent.sig = "0".repeat(128)
    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          invalidSignature,
        ]),
      })
    ).toEqual({ state: "lookup_unavailable" })

    const mismatchedPending = structuredClone(validRecord)
    mismatchedPending.pendingDistribution = {
      signedEvent: signedInboxDeclaration(
        INBOX_OWNER_SECRET,
        ["wss://other-inbox.example"],
        200
      ),
      publishRelayUrls: [SHARED_INBOX_RELAY],
      stagedAt: 2_000,
    }
    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          mismatchedPending,
        ]),
      })
    ).toEqual({ state: "lookup_unavailable" })

    const emptySeed = createInMemoryInboxDeclarationEvidenceRepository()
    const signedEmpty = signedInboxDeclaration(INBOX_OWNER_SECRET, [], 300)
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: signedEmpty,
        sourceRelayUrls: [SHARED_INBOX_RELAY],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY],
      },
      emptySeed
    )
    const mismatchedState = (await getInboxDeclarationEvidence(
      INBOX_OWNER,
      emptySeed
    ))!
    Object.assign(mismatchedState.current, {
      state: "declared",
      secureRelayUrls: ["wss://forged-inbox.example"],
    })
    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          mismatchedState,
        ]),
      })
    ).toMatchObject({ state: "signed_empty", eventId: signedEmpty.id })
  })

  it("backfills legacy durable shared provenance at the send boundary", async () => {
    __resetInboxRelayCache()
    const seed = createInMemoryInboxDeclarationEvidenceRepository()
    const declaration = signedInboxDeclaration(INBOX_OWNER_SECRET, [
      "wss://inbox.example",
    ])
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: declaration,
        sourceRelayUrls: [SHARED_INBOX_RELAY],
      },
      seed
    )
    const legacy = (await getInboxDeclarationEvidence(INBOX_OWNER, seed))!
    delete legacy.current.sharedSourceRelayUrls

    expect(
      await inspectRetainedOwnPrivateMessageRelayReadiness(INBOX_OWNER, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          legacy,
        ]),
      })
    ).toMatchObject({ state: "ready", eventId: declaration.id })
  })

  it("preserves durable shared proof while refusing new proof after a write failure", async () => {
    const cases = [
      { previouslyConfirmed: true, expectedState: "ready" as const },
      {
        previouslyConfirmed: false,
        expectedState: "distribution_pending" as const,
      },
    ]

    for (const testCase of cases) {
      __resetInboxRelayCache()
      const backing = createInMemoryInboxDeclarationEvidenceRepository()
      const declaration = signedInboxDeclaration(INBOX_OWNER_SECRET, [
        "wss://inbox.example",
      ])
      await mergeInboxDeclarationEvidence(
        {
          pubkey: INBOX_OWNER,
          signedEvent: declaration,
          sourceRelayUrls: [
            testCase.previouslyConfirmed
              ? SHARED_INBOX_RELAY
              : "wss://owner-local.example",
          ],
          sharedSourceRelayUrls: testCase.previouslyConfirmed
            ? [SHARED_INBOX_RELAY]
            : [],
        },
        backing
      )
      const readOnlyRepository: InboxDeclarationEvidenceRepository = {
        get: (pubkey) => backing.get(pubkey),
        merge: async () => {
          throw new Error("durable write unavailable")
        },
        mergeBatch: async () => {
          throw new Error("durable write unavailable")
        },
      }
      const observed = withInboxSource(declaration)
      const readiness = await inspectOwnPrivateMessageRelayReadiness(
        INBOX_OWNER,
        {
          relayUrls: [SHARED_INBOX_RELAY],
          evidenceRepository: readOnlyRepository,
          fetchEventsWithDiagnostics: testCase.previouslyConfirmed
            ? async () => ({
                events: [],
                attemptedRelayUrls: [SHARED_INBOX_RELAY],
                successfulRelayUrls: [],
                failedRelayUrls: [SHARED_INBOX_RELAY],
              })
            : async () => ({
                events: [observed] as never,
                attemptedRelayUrls: [SHARED_INBOX_RELAY],
                successfulRelayUrls: [SHARED_INBOX_RELAY],
                failedRelayUrls: [],
              }),
        }
      )

      expect(readiness.state).toBe(testCase.expectedState)
      expect(
        (await getInboxDeclarationEvidence(INBOX_OWNER, backing))?.current
          .sharedSourceRelayUrls
      ).toEqual(testCase.previouslyConfirmed ? [SHARED_INBOX_RELAY] : [])
    }
  })
  it("reports ready with the declared secure relays", async () => {
    __resetInboxRelayCache()
    const declaration = withInboxSource(
      signedInboxDeclaration(INBOX_OWNER_SECRET, ["wss://inbox.example"])
    )
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () => [declaration] as never,
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      eventId: declaration.id,
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
      "wss://inbox.conduit.market",
    ])
    await mergeInboxDeclarationEvidence(
      {
        pubkey: INBOX_OWNER,
        signedEvent: declaration,
        sourceRelayUrls: [SHARED_INBOX_RELAY],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY],
        observedAt: 1_000,
        completeObservedAt: 1_000,
      },
      evidenceRepository
    )

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [SHARED_INBOX_RELAY],
          successfulRelayUrls: [SHARED_INBOX_RELAY],
          failedRelayUrls: [],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      eventId: declaration.id,
      relayUrls: ["wss://inbox.conduit.market"],
      stale: true,
      distributionRepairable: true,
    })
  })

  it("never reports an unconfirmed retained declaration ready after empty shared reads", async () => {
    for (const coverage of ["partial", "complete"] as const) {
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
        },
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
            successfulRelayUrls:
              coverage === "complete"
                ? ["wss://shared-a.example", "wss://shared-b.example"]
                : ["wss://shared-a.example"],
            failedRelayUrls:
              coverage === "complete" ? [] : ["wss://shared-b.example"],
          }),
        }
      )

      expect(readiness).toEqual({
        state: "distribution_pending",
        eventId: declaration.id,
        relayUrls: ["wss://inbox.example"],
        retainedRelayUrls: [],
        stale: true,
        distributionRepairable: coverage === "complete",
      })
    }
  })

  it("accepts exact shared confirmation even when a sibling relay fails", async () => {
    __resetInboxRelayCache()
    const siblingSharedRelay = sharedInboxDiscoveryRelayUrls()[1]!
    const declaration = withInboxSource(
      signedInboxDeclaration(INBOX_OWNER_SECRET, ["wss://inbox.example"])
    )
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY, siblingSharedRelay],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEventsWithDiagnostics: async () => ({
          events: [declaration] as never,
          attemptedRelayUrls: [SHARED_INBOX_RELAY, siblingSharedRelay],
          successfulRelayUrls: [SHARED_INBOX_RELAY],
          failedRelayUrls: [siblingSharedRelay],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      eventId: declaration.id,
      relayUrls: ["wss://inbox.example"],
      stale: true,
      distributionRepairable: false,
    })
  })

  it("keeps stale signed blockers retry-only and exposes retained recovery relays", async () => {
    __resetInboxRelayCache()
    const evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const declared = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://usable.conduit.market"],
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
        relayUrls: [
          "wss://shared-a.conduit.market",
          "wss://shared-b.conduit.market",
        ],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [
            "wss://shared-a.conduit.market",
            "wss://shared-b.conduit.market",
          ],
          successfulRelayUrls: ["wss://shared-a.conduit.market"],
          failedRelayUrls: ["wss://shared-b.conduit.market"],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      eventId: blocker.id,
      stale: true,
      distributionRepairable: false,
      retainedRelayUrls: ["wss://usable.conduit.market"],
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
        relayUrls: ["wss://shared.conduit.market"],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://shared.conduit.market"],
          successfulRelayUrls: ["wss://shared.conduit.market"],
          failedRelayUrls: [],
        }),
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      eventId: blocker.id,
      stale: true,
      distributionRepairable: false,
      retainedRelayUrls: [],
    })
  })

  it("reports not_observed when no declaration is observed", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.conduit.market"],
      fetchEvents: async () => [] as never,
    })

    expect(readiness).toEqual({ state: "not_observed" })
  })

  it("reports lookup_unavailable for lookup errors instead of not_observed", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.conduit.market"],
      fetchEvents: async () => {
        throw new Error("lookup failed")
      },
    })

    expect(readiness).toEqual({ state: "lookup_unavailable" })
  })

  it("reports lookup_unavailable when every discovery relay is unavailable", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://read.conduit.market"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://read.conduit.market"],
      }),
    })

    expect(readiness).toEqual({ state: "lookup_unavailable" })
  })

  it("reports lookup_partial for an empty partial lookup instead of absence", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness("owner", {
      relayUrls: ["wss://read-a.conduit.market", "wss://read-b.conduit.market"],
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: [
          "wss://read-a.conduit.market",
          "wss://read-b.conduit.market",
        ],
        successfulRelayUrls: ["wss://read-a.conduit.market"],
        failedRelayUrls: ["wss://read-b.conduit.market"],
      }),
    })

    expect(readiness).toEqual({ state: "lookup_partial" })
  })

  it("ignores declarations signed by a different author", async () => {
    __resetInboxRelayCache()
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.conduit.market"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () =>
          [
            signedInboxDeclaration(INBOX_OTHER_SECRET, [
              "wss://attacker.conduit.market",
            ]),
          ] as never,
      }
    )

    expect(readiness).toEqual({ state: "not_observed" })
  })

  it("reports malformed for a signed declaration without usable relays", async () => {
    __resetInboxRelayCache()
    const malformed = signedInboxDeclaration(INBOX_OWNER_SECRET, [
      "://invalid",
      "ftp://inbox.example",
      "ws://insecure.example",
    ])
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.conduit.market"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () => [malformed] as never,
      }
    )

    expect(readiness).toEqual({
      state: "malformed",
      eventId: malformed.id,
      stale: false,
      distributionRepairable: false,
      retainedRelayUrls: [],
    })
  })

  it("reports a cryptographically valid empty declaration distinctly", async () => {
    __resetInboxRelayCache()
    const signedEmpty = signedInboxDeclaration(INBOX_OWNER_SECRET, [])
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: ["wss://read.conduit.market"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () => [signedEmpty] as never,
      }
    )

    expect(readiness).toEqual({
      state: "signed_empty",
      eventId: signedEmpty.id,
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
      frontierCreatedAt: null,
      expectedFrontierEventId: null,
      nowMs: () => 1_234_000,
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      relayConfig: {
        dmInboxDefaultRelayUrls: [
          "wss://inbox-a.conduit.market/",
          "wss://inbox-b.conduit.market",
        ],
      },
      getSignerPubkey: async () => INBOX_OWNER,
      signFn: async (unsignedEvent) => {
        calls.push("sign")
        expect(unsignedEvent.kind).toBe(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)
        expect(unsignedEvent.pubkey).toBe(INBOX_OWNER)
        expect(unsignedEvent.created_at).toBe(1234)
        expect(unsignedEvent.tags).toEqual([
          ["relay", "wss://inbox-a.conduit.market"],
          ["relay", "wss://inbox-b.conduit.market"],
        ])
        expect(unsignedEvent.content).toBe("")
        const signed = signedInboxDeclaration(
          INBOX_OWNER_SECRET,
          ["wss://inbox-a.conduit.market", "wss://inbox-b.conduit.market"],
          1234
        )
        unsignedEvent.id = signed.id
        unsignedEvent.pubkey = signed.pubkey
        unsignedEvent.sig = signed.sig
        return unsignedEvent.sig
      },
      getDiscoveryRelayUrls: () => [
        "wss://read-a.conduit.market",
        "wss://read-b.conduit.market/",
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
      exclusiveRelayUrls: [
        "wss://read-a.conduit.market",
        "wss://read-b.conduit.market",
      ],
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
    ).toEqual([])
    // A memory prime is useful fallback evidence, but it is not cross-client
    // discovery proof; the next lookup must still perform relay read-back.
    expect(fetched).toBe(true)
  })

  it("awaits durable staging before publishing the exact signed bytes", async () => {
    __resetInboxRelayCache()
    const backing = createInMemoryInboxDeclarationEvidenceRepository()
    let releaseStage!: () => void
    let markStageStarted!: () => void
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve
    })
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve
    })
    const repository: InboxDeclarationDistributionRepository = {
      ...backing,
      stageDistribution: async (input) => {
        markStageStarted()
        await stageGate
        return backing.stageDistribution(input)
      },
    }
    let publishCalls = 0
    let publishedRaw: unknown

    const publishing = publishPrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signer,
      relayUrls: ["wss://inbox.example"],
      frontierCreatedAt: null,
      expectedFrontierEventId: null,
      nowMs: () => 1_234_000,
      evidenceRepository: repository,
      getSignerPubkey: async () => INBOX_OWNER,
      signFn: async (event) => {
        const signed = signedInboxDeclaration(
          INBOX_OWNER_SECRET,
          ["wss://inbox.example"],
          1_234
        )
        event.id = signed.id
        event.pubkey = signed.pubkey
        event.sig = signed.sig
        return signed.sig
      },
      getDiscoveryRelayUrls: () => ["wss://shared.example"],
      publishFn: (async (event) => {
        publishCalls += 1
        publishedRaw = structuredClone(event.rawEvent())
        return {} as never
      }) as never,
    })

    await stageStarted
    expect(publishCalls).toBe(0)
    releaseStage()
    await publishing

    const stored = await getInboxDeclarationEvidence(INBOX_OWNER, backing)
    expect(publishCalls).toBe(1)
    expect(stored?.pendingDistribution?.signedEvent).toEqual(publishedRaw)
    expect(stored?.pendingDistribution?.publishRelayUrls).toEqual([
      "wss://shared.example",
    ])
  })

  it("does not publish when durable staging fails", async () => {
    const backing = createInMemoryInboxDeclarationEvidenceRepository()
    const repository: InboxDeclarationDistributionRepository = {
      ...backing,
      stageDistribution: async () => {
        throw new Error("storage unavailable")
      },
    }
    let publishCalls = 0

    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        relayUrls: ["wss://inbox.example"],
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        nowMs: () => 1_234_000,
        evidenceRepository: repository,
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          const signed = signedInboxDeclaration(
            INBOX_OWNER_SECRET,
            ["wss://inbox.example"],
            1_234
          )
          event.id = signed.id
          event.pubkey = signed.pubkey
          event.sig = signed.sig
          return signed.sig
        },
        getDiscoveryRelayUrls: () => [SHARED_INBOX_RELAY],
        publishFn: (async () => {
          publishCalls += 1
          return {} as never
        }) as never,
      })
    ).rejects.toThrow("storage unavailable")
    expect(publishCalls).toBe(0)
  })

  it("keeps exact pending work when declaration delivery gets no ACK", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        relayUrls: ["wss://inbox.example"],
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        nowMs: () => 1_234_000,
        evidenceRepository: repository,
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          const signed = signedInboxDeclaration(
            INBOX_OWNER_SECRET,
            ["wss://inbox.example"],
            1_234
          )
          event.id = signed.id
          event.pubkey = signed.pubkey
          event.sig = signed.sig
          return signed.sig
        },
        getDiscoveryRelayUrls: () => [SHARED_INBOX_RELAY],
        publishFn: (async () => ({
          successfulRelayUrls: [],
          failedRelayUrls: [SHARED_INBOX_RELAY],
        })) as never,
      })
    ).rejects.toThrow("without a relay ACK")

    const pending = await getInboxDeclarationEvidence(INBOX_OWNER, repository)
    expect(pending?.pendingDistribution?.publishRelayUrls).toEqual([
      SHARED_INBOX_RELAY,
    ])
    await expect(
      redistributePrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signedEvent: pending!.pendingDistribution!.signedEvent,
        publishRelayUrls: pending!.pendingDistribution!.publishRelayUrls,
        publishFn: (async () => ({
          successfulRelayUrls: [],
          failedRelayUrls: [SHARED_INBOX_RELAY],
        })) as never,
      })
    ).rejects.toThrow("without a relay ACK")
    expect(
      (await getInboxDeclarationEvidence(INBOX_OWNER, repository))
        ?.pendingDistribution?.signedEvent.id
    ).toBe(pending?.pendingDistribution?.signedEvent.id)
  })

  it("retains ambiguous delivery for restart-safe exact retry until readback", async () => {
    __resetInboxRelayCache()
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    let attemptedRaw: ReturnType<NDKEvent["rawEvent"]> | undefined

    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        relayUrls: ["wss://inbox.example"],
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        nowMs: () => 1_234_000,
        evidenceRepository: repository,
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          const signed = signedInboxDeclaration(
            INBOX_OWNER_SECRET,
            ["wss://inbox.example"],
            1_234
          )
          event.id = signed.id
          event.pubkey = signed.pubkey
          event.sig = signed.sig
          return signed.sig
        },
        getDiscoveryRelayUrls: () => [SHARED_INBOX_RELAY],
        publishFn: (async (event) => {
          attemptedRaw = structuredClone(event.rawEvent())
          throw new Error("ACK lost")
        }) as never,
      })
    ).rejects.toThrow("ACK lost")

    const pending = await getInboxDeclarationEvidence(INBOX_OWNER, repository)
    expect(pending?.pendingDistribution?.signedEvent).toEqual(attemptedRaw)
    expect(pending?.lastUsable).toBeUndefined()

    __resetInboxRelayCache()
    let retriedRaw: unknown
    await redistributePrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signedEvent: pending!.pendingDistribution!.signedEvent,
      publishRelayUrls: pending!.pendingDistribution!.publishRelayUrls,
      publishFn: (async (event, options) => {
        retriedRaw = structuredClone(event.rawEvent())
        expect(options.exclusiveRelayUrls).toEqual([SHARED_INBOX_RELAY])
        return {} as never
      }) as never,
    })
    expect(retriedRaw).toEqual(attemptedRaw)
    expect(
      (await getInboxDeclarationEvidence(INBOX_OWNER, repository))
        ?.pendingDistribution?.signedEvent
    ).toEqual(attemptedRaw)

    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: async () => ({
          events: [withInboxSource(attemptedRaw!)] as never,
          attemptedRelayUrls: [SHARED_INBOX_RELAY],
          successfulRelayUrls: [SHARED_INBOX_RELAY],
          failedRelayUrls: [],
        }),
      }
    )
    expect(readiness.state).toBe("ready")
    expect(
      (await getInboxDeclarationEvidence(INBOX_OWNER, repository))
        ?.pendingDistribution
    ).toBeUndefined()
  })

  it("rejects invalid signed output before the publish boundary", async () => {
    let published = false
    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        relayUrls: ["wss://inbox.conduit.market"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          event.id = "not-a-valid-id"
          event.sig = "not-a-valid-signature"
          return event.sig
        },
        getDiscoveryRelayUrls: () => ["wss://shared.conduit.market"],
        publishFn: (async () => {
          published = true
          return {} as never
        }) as never,
      })
    ).rejects.toThrow("signer returned an invalid event")
    expect(published).toBe(false)
  })

  it("rejects a signer that mutates the bounded declaration timestamp", async () => {
    let published = false
    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        nowMs: () => 1_000_000,
        relayUrls: ["wss://inbox.example"],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        getSignerPubkey: async () => INBOX_OWNER,
        signFn: async (event) => {
          const signed = signedInboxDeclaration(
            INBOX_OWNER_SECRET,
            ["wss://inbox.example"],
            9_999_999
          )
          event.created_at = signed.created_at
          event.id = signed.id
          event.pubkey = signed.pubkey
          event.sig = signed.sig
          return signed.sig
        },
        getDiscoveryRelayUrls: () => [SHARED_INBOX_RELAY],
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
        "wss://inbox-a.conduit.market",
        "wss://inbox-b.conduit.market",
        "wss://inbox-c.conduit.market",
        "wss://inbox-d.conduit.market",
      ],
      1234
    )
    let published: NDKEvent | undefined
    const event = await redistributePrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      getDiscoveryRelayUrls: () => ["wss://shared.conduit.market"],
      publishFn: (async (candidate, options) => {
        published = candidate
        expect(options.exclusiveRelayUrls).toEqual([
          "wss://shared.conduit.market",
        ])
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

  it("preserves staged targets and separately covers a rotated shared plan", async () => {
    const retained = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://inbox.example"],
      1234
    )
    const attempts: Array<{ relays: readonly string[]; raw: unknown }> = []

    await redistributePrivateMessageRelayDeclarationAcrossPlans({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      storedPublishRelayUrls: [
        "wss://shared-a.example",
        "wss://shared-b.example",
      ],
      currentSharedRelayUrls: [
        "wss://shared-b.example",
        "wss://shared-c.example",
      ],
      publishFn: (async (event, options) => {
        const relays = options.exclusiveRelayUrls ?? []
        attempts.push({ relays, raw: structuredClone(event.rawEvent()) })
        return { successfulRelayUrls: [relays[0]], failedRelayUrls: [] }
      }) as never,
    })

    expect(attempts.map((attempt) => attempt.relays)).toEqual([
      ["wss://shared-a.example", "wss://shared-b.example"],
      ["wss://shared-b.example", "wss://shared-c.example"],
    ])
    expect(
      attempts.map((attempt) => JSON.parse(JSON.stringify(attempt.raw)))
    ).toEqual([
      JSON.parse(JSON.stringify(retained)),
      JSON.parse(JSON.stringify(retained)),
    ])
  })

  it("recovers through current shared relays when every stored target is dead", async () => {
    const retained = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://inbox.example"],
      1234
    )
    const attempts: string[][] = []

    await redistributePrivateMessageRelayDeclarationAcrossPlans({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      storedPublishRelayUrls: ["wss://retired-shared.example"],
      currentSharedRelayUrls: [SHARED_INBOX_RELAY],
      publishFn: (async (_event, options) => {
        const relays = [...(options.exclusiveRelayUrls ?? [])]
        attempts.push(relays)
        return {
          successfulRelayUrls: relays.includes(SHARED_INBOX_RELAY)
            ? [SHARED_INBOX_RELAY]
            : [],
          failedRelayUrls: relays.includes(SHARED_INBOX_RELAY) ? [] : relays,
        }
      }) as never,
    })

    expect(attempts).toEqual([
      ["wss://retired-shared.example"],
      [SHARED_INBOX_RELAY],
    ])
  })

  it("does not republish when the stored plan already covers the current shared set", async () => {
    const retained = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://inbox.example"],
      1234
    )
    const attempts: string[][] = []

    await redistributePrivateMessageRelayDeclarationAcrossPlans({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      storedPublishRelayUrls: [
        "wss://owner-write.example",
        "wss://shared-b.example",
        "wss://shared-a.example",
      ],
      currentSharedRelayUrls: [
        "wss://shared-a.example",
        "wss://shared-b.example",
      ],
      publishFn: (async (_event, options) => {
        attempts.push([...(options.exclusiveRelayUrls ?? [])])
        return { successfulRelayUrls: ["wss://shared-a.example"] }
      }) as never,
    })

    expect(attempts).toEqual([
      [
        "wss://owner-write.example",
        "wss://shared-b.example",
        "wss://shared-a.example",
      ],
    ])
  })

  it("falls through an unsafe stored plan to the current shared plan", async () => {
    const retained = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://inbox.example"],
      1234
    )
    const attempts: string[][] = []

    await redistributePrivateMessageRelayDeclarationAcrossPlans({
      pubkey: INBOX_OWNER,
      signedEvent: retained,
      storedPublishRelayUrls: ["ws://retired-local.example"],
      currentSharedRelayUrls: [SHARED_INBOX_RELAY],
      publishFn: (async (_event, options) => {
        const relays = [...(options.exclusiveRelayUrls ?? [])]
        attempts.push(relays)
        return { successfulRelayUrls: relays }
      }) as never,
    })

    expect(attempts).toEqual([[SHARED_INBOX_RELAY]])
  })

  it("carries owner repair through unrelated sender discovery and strict recipient reads", async () => {
    __resetInboxRelayCache()
    const ownerRepository = createInMemoryInboxDeclarationEvidenceRepository()
    let distributed: NDKEvent | undefined
    await publishPrivateMessageRelayDeclaration({
      pubkey: INBOX_OWNER,
      signer,
      relayUrls: ["wss://recipient-inbox.conduit.market"],
      frontierCreatedAt: null,
      expectedFrontierEventId: null,
      nowMs: () => 2_000_000,
      evidenceRepository: ownerRepository,
      getSignerPubkey: async () => INBOX_OWNER,
      signFn: async (event) => {
        const signed = signedInboxDeclaration(
          INBOX_OWNER_SECRET,
          ["wss://recipient-inbox.conduit.market"],
          2_000
        )
        event.id = signed.id
        event.pubkey = signed.pubkey
        event.sig = signed.sig
        return signed.sig
      },
      getDiscoveryRelayUrls: () => ["wss://shared-discovery.conduit.market"],
      publishFn: (async (event) => {
        distributed = event
        return {} as never
      }) as never,
    })

    __resetInboxRelayCache()
    const senderRepository = createInMemoryInboxDeclarationEvidenceRepository()
    const senderView = await resolveInboxDeclaration(INBOX_OWNER, {
      relayUrls: ["wss://shared-discovery.conduit.market"],
      evidenceRepository: senderRepository,
      fetchEventsWithDiagnostics: async () => ({
        events: [distributed!] as never,
        attemptedRelayUrls: ["wss://shared-discovery.conduit.market"],
        successfulRelayUrls: ["wss://shared-discovery.conduit.market"],
        failedRelayUrls: [],
      }),
    })
    const delivery = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: senderView,
      validatedOrder: false,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })
    const recipientRead = planInboxReadRelays({
      declaration: senderView,
      localReadRelayUrls: [],
      compatibilityRelayUrls: [],
    })

    expect(senderView.state).toBe("declared")
    expect(delivery.route).toBe("declared_inbox")
    expect(delivery.relayUrls).toEqual(["wss://recipient-inbox.conduit.market"])
    expect(delivery.relayUrls).not.toContain(
      "wss://compatibility.conduit.market"
    )
    expect(recipientRead.relayUrls).toEqual([
      "wss://recipient-inbox.conduit.market",
    ])
  })

  it("rejects a signer pubkey mismatch before signing or publishing", async () => {
    let signed = false
    let published = false

    await expect(
      publishPrivateMessageRelayDeclaration({
        pubkey: "owner",
        signer,
        frontierCreatedAt: null,
        expectedFrontierEventId: null,
        relayUrls: ["wss://inbox.conduit.market"],
        getSignerPubkey: async () => "different-owner",
        signFn: async () => {
          signed = true
          return "signature"
        },
        getDiscoveryRelayUrls: () => ["wss://read.conduit.market"],
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
    for (const relayUrls of [
      [],
      ["ws://insecure.conduit.market"],
      ["not a url"],
    ]) {
      let signerInspected = false
      let signed = false
      let published = false

      await expect(
        publishPrivateMessageRelayDeclaration({
          pubkey: "owner",
          signer,
          frontierCreatedAt: null,
          expectedFrontierEventId: null,
          relayConfig: { dmInboxDefaultRelayUrls: relayUrls },
          getSignerPubkey: async () => {
            signerInspected = true
            return "owner"
          },
          signFn: async () => {
            signed = true
            return "signature"
          },
          getDiscoveryRelayUrls: () => ["wss://read.conduit.market"],
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

describe("selectInboxDeclarationCreatedAt", () => {
  it("wins the retained frontier within the bounded future window", () => {
    const nowMs = () => 1_000_000
    expect(
      selectInboxDeclarationCreatedAt({ frontierCreatedAt: null, nowMs })
    ).toBe(1_000)
    expect(
      selectInboxDeclarationCreatedAt({ frontierCreatedAt: 999, nowMs })
    ).toBe(1_000)
    expect(
      selectInboxDeclarationCreatedAt({ frontierCreatedAt: 1_000, nowMs })
    ).toBe(1_001)
    expect(
      selectInboxDeclarationCreatedAt({ frontierCreatedAt: 1_299, nowMs })
    ).toBe(1_300)
  })

  it("blocks before signer access when the successor exceeds the skew window", async () => {
    let signerInspections = 0
    let signatures = 0
    let publishes = 0
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const priorUsable = signedInboxDeclaration(
      INBOX_OWNER_SECRET,
      ["wss://prior-inbox.example"],
      900
    )
    const futureBlocker = signedInboxDeclaration(INBOX_OWNER_SECRET, [], 1_300)
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: priorUsable },
      repository
    )
    await mergeInboxDeclarationEvidence(
      { pubkey: INBOX_OWNER, signedEvent: futureBlocker },
      repository
    )

    let caught: unknown
    try {
      await publishPrivateMessageRelayDeclaration({
        pubkey: INBOX_OWNER,
        signer,
        relayUrls: ["wss://inbox.example"],
        frontierCreatedAt: 1_300,
        expectedFrontierEventId: futureBlocker.id,
        nowMs: () => 1_000_000,
        evidenceRepository: repository,
        getSignerPubkey: async () => {
          signerInspections += 1
          return INBOX_OWNER
        },
        signFn: async () => {
          signatures += 1
          return "unexpected"
        },
        getDiscoveryRelayUrls: () => ["wss://shared.example"],
        publishFn: (async () => {
          publishes += 1
          return {} as never
        }) as never,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(InboxDeclarationPublishSafetyError)
    expect(caught).toMatchObject({
      code: "future_frontier_outside_publish_window",
      frontierCreatedAt: 1_300,
      nowSeconds: 1_000,
      nextEligibleAt: 1_001,
    })
    expect(signerInspections).toBe(0)
    expect(signatures).toBe(0)
    expect(publishes).toBe(0)
    const retained = await getInboxDeclarationEvidence(INBOX_OWNER, repository)
    expect(retained?.current.state).toBe("signed_empty")
    expect(retained?.current.signedEvent.id).toBe(futureBlocker.id)
    expect(retained?.lastUsable?.signedEvent.id).toBe(priorUsable.id)
  })

  it("unblocks at the next second and rejects invalid timestamps", () => {
    expect(() =>
      selectInboxDeclarationCreatedAt({
        frontierCreatedAt: 1_300,
        nowMs: () => 1_000_000,
      })
    ).toThrow(InboxDeclarationPublishSafetyError)
    expect(
      selectInboxDeclarationCreatedAt({
        frontierCreatedAt: 1_300,
        nowMs: () => 1_001_000,
      })
    ).toBe(1_301)
    expect(() =>
      selectInboxDeclarationCreatedAt({
        frontierCreatedAt: Number.NaN,
        nowMs: () => 1_000_000,
      })
    ).toThrow("frontier")
    expect(() =>
      selectInboxDeclarationCreatedAt({
        frontierCreatedAt: null,
        nowMs: () => Number.POSITIVE_INFINITY,
      })
    ).toThrow("wall clock")
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
