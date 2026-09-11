import { describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetInboxRelayCache,
  applyAccountNetworkRelayExclusion,
  buildDirectMessageRumor,
  classifyPrivateMessageKind,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryAccountNetworkLocalStateRepository,
  createValidatedGuestOrderCompanion,
  createValidatedOrderRouteScope,
  decryptLegacyDirectMessage,
  detectNip44Capabilities,
  EVENT_KINDS,
  fetchInboxRelayUrls,
  getInboxDeclarationEvidence,
  inspectOwnPrivateMessageRelayReadiness,
  inspectRetainedOwnPrivateMessageRelayReadiness,
  isOrderCompanionNotificationRumor,
  mergeInboxDeclarationEvidenceInMemory,
  mergeInboxDeclarationEvidence,
  parseDirectMessageRumor,
  parsePrivateMessageRelays,
  planInboxReadRelays,
  PrivateMessageRelayReadinessError,
  publishPrivateMessage,
  RelayPublishDiagnosticsError,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  sharedInboxDiscoveryRelayUrls,
  unwrapGiftWrap,
  type GiftUnwrapFn,
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

function guestOrderCompanionFixture(
  merchantOrigin = "https://sell.conduit.market"
) {
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
      merchantOrigin,
    }),
  }
}

describe("isOrderCompanionNotificationRumor", () => {
  const canonicalContent =
    "A new order was sent to you through Conduit Market.\n" +
    "Review it at: https://sell.conduit.market/orders?order=order-id"
  const canonicalTags = [
    ["p", "merchant"],
    ["subject", "conduit-order-notification"],
    ["order", "order-id"],
    ["conduit", "order-companion", "1", "authoritative-order-id"],
    ["client", "Conduit Market"],
  ]

  it("recognizes only the complete v1 app marker", () => {
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags: canonicalTags,
          content: canonicalContent,
        })
      )
    ).toBe(true)
  })

  it("fails open for arbitrary content and extra tags", () => {
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags: canonicalTags,
          content: "Reply on Signal, not here.",
        })
      )
    ).toBe(false)
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags: [...canonicalTags, ["extra", "tag"]],
          content: canonicalContent,
        })
      )
    ).toBe(false)
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags: canonicalTags,
          content:
            "A new order was sent to you through Conduit Market.\n" +
            "Review it at: https://attacker.example/orders?order=order-id",
        })
      )
    ).toBe(false)
  })

  it.each([
    ["subject only", canonicalTags.slice(0, 3)],
    [
      "unknown marker version",
      canonicalTags.map((tag) =>
        tag[0] === "conduit" ? ["conduit", "order-companion", "2"] : tag
      ),
    ],
    ["missing recipient", canonicalTags.filter((tag) => tag[0] !== "p")],
    ["missing order", canonicalTags.filter((tag) => tag[0] !== "order")],
    ["missing client", canonicalTags.filter((tag) => tag[0] !== "client")],
    [
      "duplicate marker",
      [
        ...canonicalTags,
        ["conduit", "order-companion", "1", "authoritative-order-id"],
      ],
    ],
    ["duplicate subject", [...canonicalTags, canonicalTags[1]!]],
    ["duplicate order", [...canonicalTags, canonicalTags[2]!]],
    ["duplicate recipient", [...canonicalTags, canonicalTags[0]!]],
  ])("fails open for %s", (_label, tags) => {
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          tags,
          content: canonicalContent,
        })
      )
    ).toBe(false)
  })

  it("does not classify an order rumor as an inbox notification", () => {
    expect(
      isOrderCompanionNotificationRumor(
        rumor(EVENT_KINDS.ORDER, {
          tags: canonicalTags,
          content: canonicalContent,
        })
      )
    ).toBe(false)
  })
})

describe("order companion deployment links", () => {
  it("builds the fixed guest copy on the selected Merchant origin", () => {
    const { companion } = guestOrderCompanionFixture(
      "https://fix-293.conduit-merchant-33n.pages.dev"
    )
    expect(companion.content).toContain(
      "https://fix-293.conduit-merchant-33n.pages.dev/orders?order=guest-order-id"
    )
    expect(companion.tags).toContainEqual(["client", "Conduit Market"])
  })
})

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
        recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
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

  it("intersects declared recipient inboxes with the explicit sender account policy", async () => {
    const excludedRelayUrl = "wss://removed-inbox.conduit.market"
    const eligibleRelayUrl = "wss://eligible-inbox.conduit.market"
    const repository = createInMemoryAccountNetworkLocalStateRepository(
      [],
      () => 100
    )
    await repository.update(INBOX_OWNER, (state) =>
      applyAccountNetworkRelayExclusion(state, {
        relayUrl: excludedRelayUrl,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 100,
      })
    )
    let publishOptions: Parameters<
      NonNullable<Parameters<typeof publishPrivateMessage>[0]["publishFn"]>
    >[1]

    const result = await publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, {
        pubkey: INBOX_OWNER,
        tags: [["p", INBOX_PEER]],
      }),
      senderPubkey: INBOX_OWNER,
      recipientPubkey: INBOX_PEER,
      accountPubkey: INBOX_OWNER,
      accountNetworkLocalStateRepository: repository,
      signer: {
        user: async () => ({ pubkey: INBOX_OWNER }),
      } as unknown as NDKSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      recipientInboxRelays: [excludedRelayUrl, eligibleRelayUrl],
      inspectOwnInboxReadiness: async () => ({
        state: "ready",
        eventId: "a".repeat(64),
        relayUrls: [eligibleRelayUrl],
        stale: false,
        distributionRepairable: false,
      }),
      giftWrapFn: (async () => wrap("eligible-recipient-wrap")) as never,
      publishFn: (async (_event, options) => {
        publishOptions = options
        return {
          successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
          failedRelayUrls: [],
        } as never
      }) as never,
    })

    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(publishOptions!.exclusiveRelayUrls).toEqual([eligibleRelayUrl])
    expect(publishOptions!.accountPubkey).toBe(INBOX_OWNER)
    expect(publishOptions!.accountNetworkLocalStateRepository).toBe(repository)
  })

  it("blocks when every declared recipient inbox is excluded without compatibility substitution", async () => {
    const excludedRelayUrl = "wss://removed-inbox.conduit.market"
    const compatibilityRelayUrl = "wss://compatibility.conduit.market"
    const repository = createInMemoryAccountNetworkLocalStateRepository(
      [],
      () => 100
    )
    await repository.update(INBOX_OWNER, (state) =>
      applyAccountNetworkRelayExclusion(state, {
        relayUrl: excludedRelayUrl,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 100,
      })
    )
    const order = orderRumor({
      pubkey: INBOX_OWNER,
      tags: [
        ["p", INBOX_PEER],
        ["type", "message"],
        ["order", "order-id"],
      ],
    })
    const validatedOrderScope = createValidatedOrderRouteScope({
      rumor: order,
      orderId: "order-id",
      senderPubkey: INBOX_OWNER,
      recipientPubkey: INBOX_PEER,
    })
    let wraps = 0
    let publishes = 0
    let compatibilityLookups = 0

    await expect(
      publishPrivateMessage({
        rumor: order,
        senderPubkey: INBOX_OWNER,
        recipientPubkey: INBOX_PEER,
        accountPubkey: INBOX_OWNER,
        accountNetworkLocalStateRepository: repository,
        signer: {
          user: async () => ({ pubkey: INBOX_OWNER }),
        } as unknown as NDKSigner,
        rumorKind: EVENT_KINDS.ORDER,
        selfCopy: false,
        recipientInboxRelays: [excludedRelayUrl],
        validatedOrderScope,
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: [compatibilityRelayUrl],
        },
        resolveCompatibilityRecipientReadRelays: async () => {
          compatibilityLookups += 1
          return [compatibilityRelayUrl]
        },
        giftWrapFn: (async () => {
          wraps += 1
          return wrap("unexpected")
        }) as never,
        publishFn: (async () => {
          publishes += 1
          return {} as never
        }) as never,
      })
    ).rejects.toMatchObject({ reason: "recipient_relays_excluded" })
    expect(compatibilityLookups).toBe(0)
    expect(wraps).toBe(0)
    expect(publishes).toBe(0)
  })

  it("requires an explicit account scope to match the sender", async () => {
    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          pubkey: INBOX_OWNER,
          tags: [["p", INBOX_PEER]],
        }),
        senderPubkey: INBOX_OWNER,
        recipientPubkey: INBOX_PEER,
        accountPubkey: INBOX_PEER,
        signer: {
          user: async () => ({ pubkey: INBOX_OWNER }),
        } as unknown as NDKSigner,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      })
    ).rejects.toThrow("account does not match sender")
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
    let visibilityChecks = 0

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
      signerInteraction: "application_owned",
      waitForSignerVisibility: async () => {
        visibilityChecks += 1
      },
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
    expect(visibilityChecks).toBe(0)
    expect(wrappedRecipients).toEqual(["merchant"])
    expect(publishRelays).toEqual([["wss://merchant.inbox.conduit.market"]])
    expect(result.wrappedToSelf).toBeNull()
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      "wss://merchant.inbox.conduit.market",
    ])
  })

  it("does not repeat recipient wrapping after an ambiguous bridge error", async () => {
    let wrapCalls = 0

    await expect(
      publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
        inspectOwnInboxReadiness: async () => ({
          state: "ready",
          eventId: "a".repeat(64),
          relayUrls: ["wss://sender.inbox.conduit.market"],
          stale: false,
        }),
        giftWrapFn: (async () => {
          wrapCalls += 1
          throw new Error(
            "The message port closed before a response was received."
          )
        }) as never,
      })
    ).rejects.toThrow("message port closed")

    expect(wrapCalls).toBe(1)
  })

  it("waits for visibility before dispatching a sequential sender self-copy", async () => {
    let visible = true
    let releaseVisibility = () => {}
    const visibilityRestored = new Promise<void>((resolve) => {
      releaseVisibility = resolve
    })
    const wrappedRecipients: string[] = []
    let visibilityChecks = 0
    const interactiveSigner = {
      user: async () => ({ pubkey: "sender" }),
      encrypt: async (recipient: { pubkey: string }) => {
        wrappedRecipients.push(recipient.pubkey)
        if (recipient.pubkey === "recipient") visible = false
        return "ciphertext"
      },
    } as unknown as NDKSigner

    const publishing = publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer: interactiveSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      signerInteraction: "external",
      recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      inspectOwnInboxReadiness: async () => ({
        state: "ready",
        eventId: "a".repeat(64),
        relayUrls: ["wss://sender.inbox.conduit.market"],
        stale: false,
      }),
      waitForSignerVisibility: async () => {
        visibilityChecks += 1
        if (!visible) await visibilityRestored
      },
      giftWrapFn: (async (_rumor, recipient, workflowSigner) => {
        await workflowSigner.encrypt(recipient, "seal", "nip44")
        return wrap(`wrap-${recipient.pubkey}`)
      }) as never,
      publishFn: (async (_event, options) => ({
        successfulRelayUrls: [options.exclusiveRelayUrls?.[0]],
        failedRelayUrls: [],
      })) as never,
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(wrappedRecipients).toEqual(["recipient"])

    visible = true
    releaseVisibility()
    const result = await publishing

    expect(wrappedRecipients).toEqual(["recipient", "sender"])
    expect(visibilityChecks).toBe(2)
    expect(result.wrappedToSelf?.id).toBe("wrap-sender")
  })

  it("waits between one gift wrap's external encryption and seal signature", async () => {
    let visible = true
    let restoreVisibility = () => {}
    const visibleAgain = new Promise<void>((resolve) => {
      restoreVisibility = resolve
    })
    let encryptCalls = 0
    let signCalls = 0
    let visibilityChecks = 0
    const interactiveSigner = {
      user: async () => ({ pubkey: "sender" }),
      encrypt: async () => {
        encryptCalls += 1
        visible = false
        return "ciphertext"
      },
      sign: async () => {
        signCalls += 1
        return "signature"
      },
    } as unknown as NDKSigner

    const publishing = publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer: interactiveSigner,
      signerInteraction: "external",
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
      inspectOwnInboxReadiness: async () => ({
        state: "ready",
        eventId: "a".repeat(64),
        relayUrls: ["wss://sender.inbox.conduit.market"],
        stale: false,
      }),
      waitForSignerVisibility: async () => {
        visibilityChecks += 1
        if (!visible) await visibleAgain
      },
      giftWrapFn: (async (_message, recipient, workflowSigner) => {
        await workflowSigner.encrypt(recipient, "seal", "nip44")
        await workflowSigner.sign({} as never)
        return wrap("wrap-recipient")
      }) as never,
      publishFn: (async (_event, options) => ({
        successfulRelayUrls: [options.exclusiveRelayUrls?.[0]],
        failedRelayUrls: [],
      })) as never,
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(encryptCalls).toBe(1)
    expect(signCalls).toBe(0)

    visible = true
    restoreVisibility()
    await publishing

    expect(encryptCalls).toBe(1)
    expect(signCalls).toBe(1)
    expect(visibilityChecks).toBe(2)
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
    expect(result.selfDeliveryStatus).toBe("full_success")
    expect(result.selfDelivery).toEqual({})
  })

  it("authorizes owner ws only for the sender self-copy leg", async () => {
    const senderPubkey = "a".repeat(64)
    const recipientPubkey = "b".repeat(64)
    const ownerWs = "ws://owner-inbox.example"
    const remoteWs = "ws://recipient-inbox.example"
    const accountNetworkLocalStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const publishes: Array<{
      recipient: string
      relays: readonly string[]
      ownerSelectedRelayUrls: readonly string[]
      accountPubkey: string | null | undefined
      authenticatedPubkey: string | null | undefined
    }> = []

    await publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, {
        pubkey: senderPubkey,
        tags: [["p", recipientPubkey]],
      }),
      senderPubkey,
      accountPubkey: senderPubkey,
      authenticatedPubkey: senderPubkey,
      accountNetworkLocalStateRepository,
      recipientPubkey,
      signer: {
        user: async () => ({ pubkey: senderPubkey }),
      } as unknown as NDKSigner,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      recipientInboxRelays: [remoteWs, "wss://recipient.inbox.conduit.market"],
      inspectOwnInboxReadiness: async () => ({
        state: "ready",
        eventId: "c".repeat(64),
        relayUrls: [ownerWs],
        stale: false,
        distributionRepairable: false,
      }),
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (_event, options) => {
        publishes.push({
          recipient: options.recipientPubkeys?.[0] ?? "",
          relays: options.exclusiveRelayUrls ?? [],
          ownerSelectedRelayUrls: options.ownerSelectedRelayUrls ?? [],
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
        })
        return {
          successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
          failedRelayUrls: [],
        } as never
      }) as never,
    })

    expect(publishes).toEqual([
      {
        recipient: recipientPubkey,
        relays: ["wss://recipient.inbox.conduit.market"],
        ownerSelectedRelayUrls: [],
        accountPubkey: senderPubkey,
        authenticatedPubkey: senderPubkey,
      },
      {
        recipient: senderPubkey,
        relays: [ownerWs],
        ownerSelectedRelayUrls: [ownerWs],
        accountPubkey: senderPubkey,
        authenticatedPubkey: senderPubkey,
      },
    ])
  })

  it("does not infer owner ws authority from the sender, rumor, or account", async () => {
    const senderPubkey = "a".repeat(64)
    const recipientPubkey = "b".repeat(64)
    const ownerWs = "ws://owner-inbox.example"
    const ownerWss = "wss://owner.inbox.conduit.market"
    const recipientWss = "wss://recipient.inbox.conduit.market"
    const accountNetworkLocalStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()

    for (const authenticatedPubkey of [undefined, recipientPubkey]) {
      const publishes: Array<{
        recipient: string
        relays: readonly string[]
        ownerSelectedRelayUrls: readonly string[]
        accountPubkey: string | null | undefined
        authenticatedPubkey: string | null | undefined
      }> = []

      await publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE, {
          pubkey: senderPubkey,
          tags: [["p", recipientPubkey]],
        }),
        senderPubkey,
        accountPubkey: senderPubkey,
        authenticatedPubkey,
        accountNetworkLocalStateRepository,
        recipientPubkey,
        signer: {
          user: async () => ({ pubkey: senderPubkey }),
        } as unknown as NDKSigner,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: [recipientWss],
        inspectOwnInboxReadiness: async () => ({
          state: "ready",
          eventId: "c".repeat(64),
          relayUrls: [ownerWs, ownerWss],
          stale: false,
          distributionRepairable: false,
        }),
        giftWrapFn: (async (_rumor, recipient) =>
          wrap(`wrap-${recipient.pubkey}`)) as never,
        publishFn: (async (_event, options) => {
          publishes.push({
            recipient: options.recipientPubkeys?.[0] ?? "",
            relays: options.exclusiveRelayUrls ?? [],
            ownerSelectedRelayUrls: options.ownerSelectedRelayUrls ?? [],
            accountPubkey: options.accountPubkey,
            authenticatedPubkey: options.authenticatedPubkey,
          })
          return {
            successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
            failedRelayUrls: [],
          } as never
        }) as never,
      })

      expect(publishes).toEqual([
        {
          recipient: recipientPubkey,
          relays: [recipientWss],
          ownerSelectedRelayUrls: [],
          accountPubkey: senderPubkey,
          authenticatedPubkey: null,
        },
        {
          recipient: senderPubkey,
          relays: [ownerWss],
          ownerSelectedRelayUrls: [],
          accountPubkey: senderPubkey,
          authenticatedPubkey: null,
        },
      ])
    }
  })

  it("reports exact zero, partial, and full self-copy delivery diagnostics", async () => {
    const cases = [
      {
        successfulRelayUrls: [] as string[],
        failedRelayUrls: ["wss://sender.inbox.conduit.market"],
        status: "zero_success",
        error: "Sender self-copy received no relay ACK.",
      },
      {
        successfulRelayUrls: ["wss://sender-a.inbox.conduit.market"],
        failedRelayUrls: ["wss://sender-b.inbox.conduit.market"],
        status: "partial_success",
        error: "Sender self-copy reached only part of its inbox relay set.",
      },
      {
        successfulRelayUrls: ["wss://sender.inbox.conduit.market"],
        failedRelayUrls: [] as string[],
        status: "full_success",
        error: null,
      },
    ] as const

    for (const testCase of cases) {
      const result = await publishPrivateMessage({
        rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
        senderPubkey: "sender",
        recipientPubkey: "recipient",
        signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        recipientInboxRelays: ["wss://recipient.inbox.conduit.market"],
        senderInboxRelays: [
          "wss://sender-a.inbox.conduit.market",
          "wss://sender-b.inbox.conduit.market",
        ],
        inspectOwnInboxReadiness: readyOwnInbox,
        giftWrapFn: (async (_rumor, recipient) =>
          wrap(`wrap-${recipient.pubkey}`)) as never,
        publishFn: (async (event) => {
          if (event.id === "wrap-recipient") {
            return {
              successfulRelayUrls: ["wss://recipient.inbox.conduit.market"],
              failedRelayUrls: [],
            } as never
          }
          return {
            successfulRelayUrls: testCase.successfulRelayUrls,
            failedRelayUrls: testCase.failedRelayUrls,
          } as never
        }) as never,
      })

      expect(result.selfDelivery?.successfulRelayUrls).toEqual(
        testCase.successfulRelayUrls
      )
      expect(result.selfDeliveryStatus).toBe(testCase.status)
      expect(result.selfCopyError).toBe(testCase.error)
    }
  })

  it("preserves recipient and self ACKs when the relay planner throws partial diagnostics", async () => {
    const result = await publishPrivateMessage({
      rumor: rumor(EVENT_KINDS.DIRECT_MESSAGE),
      senderPubkey: "sender",
      recipientPubkey: "recipient",
      signer,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      recipientInboxRelays: [
        "wss://recipient-a.inbox.conduit.market",
        "wss://recipient-b.inbox.conduit.market",
      ],
      senderInboxRelays: [
        "wss://sender-a.inbox.conduit.market",
        "wss://sender-b.inbox.conduit.market",
      ],
      inspectOwnInboxReadiness: async () => ({
        state: "ready" as const,
        eventId: "a".repeat(64),
        relayUrls: [
          "wss://sender-a.inbox.conduit.market",
          "wss://sender-b.inbox.conduit.market",
        ],
        stale: false,
        distributionRepairable: false,
      }),
      giftWrapFn: (async (_rumor, recipient) =>
        wrap(`wrap-${recipient.pubkey}`)) as never,
      publishFn: (async (_event, options) => {
        const attemptedRelayUrls = [...(options.exclusiveRelayUrls ?? [])]
        const diagnostics = {
          plan: {
            intent: "recipient_event" as const,
            primaryRelayUrls: attemptedRelayUrls,
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls,
          successfulRelayUrls: attemptedRelayUrls.slice(0, 1),
          failedRelayUrls: attemptedRelayUrls.slice(1),
          relayFailureMessages: Object.fromEntries(
            attemptedRelayUrls
              .slice(1)
              .map((relayUrl) => [
                relayUrl,
                "No acknowledgement before timeout",
              ])
          ),
        }
        throw new RelayPublishDiagnosticsError(
          "Some relays did not acknowledge the wrap.",
          diagnostics,
          new Error("partial relay delivery")
        )
      }) as never,
    })

    expect(result.deliveryStatus).toBe("partial_success")
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      "wss://recipient-a.inbox.conduit.market",
    ])
    expect(result.selfDeliveryStatus).toBe("partial_success")
    expect(result.selfDelivery?.successfulRelayUrls).toEqual([
      "wss://sender-a.inbox.conduit.market",
    ])
    expect(result.selfCopyError).toBe(
      "Sender self-copy reached only part of its inbox relay set."
    )
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
    expect(result.selfDelivery).toBeNull()
    expect(result.selfDeliveryStatus).toBeNull()
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
    const controller = new AbortController()
    const shouldContinue = () => true
    const relays = await fetchInboxRelayUrls(INBOX_PEER, {
      relayUrls: ["wss://read.conduit.market"],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      signal: controller.signal,
      shouldContinue,
      fetchEvents: async (_filter, options) => {
        expect(options?.signal).toBe(controller.signal)
        expect(options?.shouldContinue).toBe(shouldContinue)
        return [
          signedInboxDeclaration(INBOX_PEER_SECRET, [
            "wss://inbox.conduit.market",
            "ws://insecure.conduit.market",
          ]),
        ] as never
      },
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
      requestingAccountPubkey: INBOX_OWNER,
      authenticatedPubkey: INBOX_OWNER,
      ownerSelectedRelayUrls: [ownerLocalRelay],
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
        recordCutoverRecoveryReadback: async () => {
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
    const sharedRelayUrls = sharedInboxDiscoveryRelayUrls().slice(0, 2)
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
          relayUrls: sharedRelayUrls,
          evidenceRepository,
          fetchEventsWithDiagnostics: async () => ({
            events: [],
            attemptedRelayUrls: sharedRelayUrls,
            successfulRelayUrls:
              coverage === "complete" ? sharedRelayUrls : [sharedRelayUrls[0]!],
            failedRelayUrls:
              coverage === "complete" ? [] : [sharedRelayUrls[1]!],
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

  it("keeps an authenticated owner's ws inbox declaration usable", async () => {
    __resetInboxRelayCache()
    const malformed = signedInboxDeclaration(INBOX_OWNER_SECRET, [
      "://invalid",
      "ftp://inbox.example",
      "ws://insecure.example",
    ])
    const readiness = await inspectOwnPrivateMessageRelayReadiness(
      INBOX_OWNER,
      {
        relayUrls: [SHARED_INBOX_RELAY],
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
        fetchEvents: async () => [withInboxSource(malformed)] as never,
      }
    )

    expect(readiness).toEqual({
      state: "ready",
      eventId: malformed.id,
      relayUrls: ["ws://insecure.example"],
      stale: false,
      distributionRepairable: false,
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
