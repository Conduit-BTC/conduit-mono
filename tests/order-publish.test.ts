import { getEventHash } from "nostr-tools"
import {
  activateAccountSigner,
  getAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import {
  setTestAccountSigner as setSigner,
  removeTestAccountSigner as removeSigner,
} from "./helpers/plain-signer"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  applyAccountNetworkRelayExclusion,
  createInMemoryAccountNetworkLocalStateRepository,
  disconnectNdk,
  EVENT_KINDS,
  getNdk,
  publishPrivateMessage,
  unwrapGiftWrap,
  type OrderLifecycle,
  type PrivateMessageRumor,
  type OrderRelayDeliveryRepository,
  type StagedOrderLifecycleInput,
} from "@conduit/core"

import { createGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  buildOrderCompanionNotificationRumor,
  buildPaymentProofRumor,
  getDeliveryNotice,
  prepareBuyerRumor,
  publishBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"

let activeSignerLease: ReturnType<typeof setSigner> | null = null

describe("buyer order rumor preparation", () => {
  it("preserves the deployed named order grammar and JSON terms before delivery", () => {
    const rumor = orderRumor()
    const content = rumor.content
    const tags = structuredClone(rumor.tags)
    prepareBuyerRumor(rumor, "b".repeat(64))
    expect(rumor.tags).toEqual(tags)
    expect(rumor.tags.find((tag) => tag[0] === "type")?.[1]).toBe("order")
    expect(rumor.content).toBe(content)
    expect(JSON.parse(rumor.content).items).toHaveLength(1)
    expect(rumor.id).toBe(
      getEventHash({ ...rumor, kind: 16, created_at: rumor.created_at! })
    )
  })

  it("recreates the same payment-proof rumor id for receipt retries", () => {
    const params = {
      merchantPubkey: "merchant-pubkey",
      orderId: "guest-order",
      amountSats: 12,
      currency: "SATS",
      content: '{"zapReceiptId":"receipt-id"}',
      createdAt: 1_700_000_000,
    }
    const first = buildPaymentProofRumor(params)
    const retry = buildPaymentProofRumor(params)

    prepareBuyerRumor(
      first,
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    )
    prepareBuyerRumor(
      retry,
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    )

    expect(first.created_at).toBe(params.createdAt)
    expect(retry.id).toBe(first.id)
  })

  it("recreates the same companion rumor id from the authoritative order", () => {
    const authoritativeOrder = orderRumor({
      tags: [
        ["p", "merchant-pubkey"],
        ["type", "order"],
        ["order", "order /?#% ünicode"],
        [
          "client",
          "Conduit Market",
          "31990:market-pubkey:conduit-market",
          "wss://relay.conduit.market",
        ],
      ],
    })
    prepareBuyerRumor(
      authoritativeOrder,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    const first = buildOrderCompanionNotificationRumor(
      authoritativeOrder,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "merchant-pubkey"
    )
    const retry = buildOrderCompanionNotificationRumor(
      authoritativeOrder,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "merchant-pubkey"
    )

    expect(first.created_at).toBe(authoritativeOrder.created_at)
    expect(retry.id).toBe(first.id)
  })

  it("uses the selected Merchant deployment for signed-in companions", () => {
    const rumor = orderRumor()
    prepareBuyerRumor(
      rumor,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    const companion = buildOrderCompanionNotificationRumor(
      rumor,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "merchant-pubkey",
      "https://fix-293.conduit-merchant-33n.pages.dev"
    )

    expect(companion.content).toContain(
      "https://fix-293.conduit-merchant-33n.pages.dev/orders?order=guest-order"
    )
  })

  it("rejects a prefilled rumor id that does not match its content", () => {
    const rumor = orderRumor({
      id: "prefilled-id",
      getEventHash: () => "derived-id",
    })

    expect(() =>
      prepareBuyerRumor(
        rumor,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      )
    ).toThrow("does not match its content")
  })
})

function orderRumor(overrides: Record<string, unknown> = {}) {
  const rumor = {
    id: "",
    kind: EVENT_KINDS.ORDER,
    pubkey: "",
    created_at: 100,
    content: JSON.stringify({
      id: "guest-order",
      merchantPubkey: "merchant-pubkey",
      buyerPubkey:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      items: [
        {
          productId: "product-id",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      shippingCostSats: 0,
      shippingCostStatus: "not_required",
      createdAt: 100_000,
    }),
    tags: [
      ["p", "merchant-pubkey"],
      ["type", "order"],
      ["order", "guest-order"],
      [
        "client",
        "Conduit Market",
        "31990:market-pubkey:conduit-market",
        "wss://relay.conduit.market",
      ],
    ],
    ...overrides,
  }
  return rumor as never
}

function guestOrderRumor(overrides: Record<string, unknown> = {}) {
  return orderRumor({
    pubkey: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    content: JSON.stringify({
      id: "guest-order",
      merchantPubkey: "merchant-pubkey",
      buyerPubkey:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      buyerIdentityKind: "guest_ephemeral",
      items: [
        {
          productId: "guest-product-id",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      guestContact: {
        email: "guest-private@example.com",
        phone: "+1-555-0100",
      },
      createdAt: 100_000,
    }),
    ...overrides,
  })
}

describe("buyer order publishing", () => {
  beforeEach(() => {
    installBuyerSigner()
  })
  afterEach(() => {
    if (activeSignerLease) {
      removeSigner(activeSignerLease)
      activeSignerLease = null
    }
    disconnectNdk()
  })

  it("stages and fences the exact merchant wrap before relay I/O", async () => {
    const buyerSecret = generateSecretKey()
    const buyerPubkey = getPublicKey(buyerSecret)
    const merchantSecret = generateSecretKey()
    const merchantPubkey = getPublicKey(merchantSecret)
    const relayUrl = "wss://merchant-orders.conduit.market"
    const orderId = "staged-order"
    const createdAt = Date.now()
    const declaration = finalizeEvent(
      {
        created_at: 100,
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        tags: [["relay", relayUrl]],
        content: "",
      },
      merchantSecret
    )
    const recipientWrap = new NDKEvent()
    recipientWrap.kind = EVENT_KINDS.GIFT_WRAP
    recipientWrap.created_at = 100
    recipientWrap.tags = [["p", merchantPubkey]]
    recipientWrap.content = "encrypted staged order"
    await recipientWrap.sign(NDKPrivateKeySigner.generate())

    const rumor = new NDKEvent()
    rumor.kind = EVENT_KINDS.ORDER
    rumor.created_at = Math.floor(createdAt / 1_000)
    rumor.tags = [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", orderId],
      ["amount", "1"],
      ["currency", "SATS"],
    ]
    rumor.content = JSON.stringify({
      id: orderId,
      merchantPubkey,
      buyerPubkey,
      buyerIdentityKind: "signed_in",
      items: [
        {
          productId: "product-id",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      shippingCostSats: 0,
      shippingCostStatus: "not_required",
      createdAt,
    })
    const lifecycle: StagedOrderLifecycleInput = {
      orderId,
      createdAt,
      buyerPubkey,
      buyerIdentityKind: "signed_in",
      merchantPubkey,
      checkoutMode: "pay_later",
      items: [
        {
          productId: "product-id",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      itemSubtotalSats: 1,
      shippingCostSats: 0,
      totalSats: 1,
      totalMsats: 1_000,
      currency: "SATS",
      addressValidity: "not_required",
      shippingZoneEligibility: "not_required",
    }
    let stored: OrderLifecycle | undefined
    const repository: OrderRelayDeliveryRepository = {
      get: async () => structuredClone(stored),
      list: async () => (stored ? [structuredClone(stored)] : []),
      update: async (_storedOrderId, updater) => {
        if (!stored) return undefined
        stored = updater(structuredClone(stored))
        return structuredClone(stored)
      },
      stage: async (record, assertCompatible) => {
        if (stored) {
          assertCompatible(structuredClone(stored))
          return { lifecycle: structuredClone(stored), inserted: false }
        }
        stored = structuredClone(record)
        return { lifecycle: structuredClone(stored), inserted: true }
      },
    }
    const locators: Array<{ orderId: string; expiresAt: number }> = []
    let relayWrites = 0
    const signer = installBuyerSigner(buyerPubkey)

    const result = await publishBuyerOrderMessage(
      rumor,
      merchantPubkey,
      { kind: "signed_in", pubkey: buyerPubkey, signer: signer as never },
      {
        orderLifecycle: lifecycle,
        orderRelayDeliveryRepository: repository,
        rememberCheckoutOrderAttemptFn: (locatedOrderId, expiresAt) => {
          locators.push({ orderId: locatedOrderId, expiresAt })
        },
        cacheBuyerOrderRumorFn: async () => null,
        publishPrivateMessageFn: (async (input) => {
          if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
            return {
              wrappedToRecipient: { id: "companion-wrap" },
              wrappedToSelf: null,
              selfCopyError: null,
              deliveryRoute: "declared_inbox",
            }
          }

          const prepared = {
            rumorId: input.rumor.id,
            wrappedToRecipient: structuredClone(recipientWrap.rawEvent()),
            deliveryRoute: "declared_inbox" as const,
            routingAuthority: {
              eventId: declaration.id,
              eventCreatedAt: declaration.created_at,
              pubkey: declaration.pubkey,
              kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
              relayUrls: [relayUrl],
            },
            relayPlan: [{ relayUrl, source: "declared" as const }],
          }
          await input.onRecipientPrepared?.(prepared)
          expect(stored?.orderRelayDelivery?.relayDelivery[0]).toMatchObject({
            status: "pending",
            attemptCount: 0,
          })
          await input.onRecipientPublishStarting?.(prepared)
          expect(stored?.orderRelayDelivery?.relayDelivery[0]).toMatchObject({
            status: "pending",
            attemptCount: 1,
            attemptGeneration: 1,
          })
          relayWrites += 1
          const recipientDelivery = {
            attemptedRelayUrls: [relayUrl],
            successfulRelayUrls: [relayUrl],
            failedRelayUrls: [],
            rejectedRelayUrls: [],
          }
          await input.onRecipientPublishAccepted?.(recipientDelivery as never)
          await input.onRecipientPublishSettled?.(recipientDelivery as never)
          return {
            wrappedToRecipient: structuredClone(recipientWrap.rawEvent()),
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox",
            recipientDelivery,
          }
        }) as never,
      }
    )

    expect(relayWrites).toBe(1)
    expect(locators).toContainEqual(
      expect.objectContaining({ orderId, expiresAt: expect.any(Number) })
    )
    expect(stored?.orderDeliveryStatus).toBe("sent")
    expect(stored?.checkoutRecoveryPending).toBe(true)
    expect(stored?.orderRelayDelivery?.signedRecipientWrap).toEqual(
      structuredClone(recipientWrap.rawEvent())
    )
    expect(stored?.orderRelayDelivery?.relayDelivery[0]?.status).toBe("acked")
    expect(result.orderRelayDelivery?.signedRecipientWrap.id).toBe(
      recipientWrap.id
    )
  })

  for (const [identityKind, terminalStatus] of (
    ["signed_in", "guest_ephemeral"] as const
  ).flatMap((identityKind) =>
    (
      [
        "timed_out",
        "auth_required",
        "cancelled",
        "policy_blocked",
        "error",
      ] as const
    ).map((status) => [identityKind, status] as const)
  )) {
    it(`adopts durable first-ACK delivery and lazy recovery for ${identityKind}: ${terminalStatus}`, async () => {
      const buyerPubkey =
        identityKind === "signed_in"
          ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          : "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      const signer =
        identityKind === "signed_in"
          ? installBuyerSigner(buyerPubkey)
          : { id: `${identityKind}-signer` }
      const stagedRumor = orderRumor({
        pubkey: buyerPubkey,
        content: JSON.stringify({
          id: "guest-order",
          merchantPubkey: "merchant-pubkey",
          buyerPubkey,
          buyerIdentityKind: identityKind,
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
          ...(identityKind === "guest_ephemeral"
            ? {
                guestContact: {
                  email: "guest@example.com",
                  phone: "+1-555-0100",
                },
              }
            : {}),
          shippingCostSats: 0,
          shippingCostStatus: "not_required",
          createdAt: 100_000,
        }),
        tags: [
          ["p", "merchant-pubkey"],
          ["type", "order"],
          ["order", "guest-order"],
          ["amount", "1"],
          ["currency", "SATS"],
        ],
      })
      const lifecycle = {
        orderId: "guest-order",
        createdAt: 100_000,
        buyerPubkey,
        buyerIdentityKind: identityKind,
        merchantPubkey: "merchant-pubkey",
        checkoutMode: "pay_later" as const,
        items: [
          {
            productId: "product-id",
            format: "physical" as const,
            quantity: 1,
            priceAtPurchase: 1,
            currency: "SATS",
          },
        ],
        itemSubtotalSats: 1,
        shippingCostSats: 0,
        totalSats: 1,
        totalMsats: 1_000,
        currency: "SATS" as const,
        addressValidity: "not_required" as const,
        shippingZoneEligibility: "not_required" as const,
      }
      const relayA = "wss://a.orders.conduit.market"
      const relayB = "wss://b.orders.conduit.market"
      const accepted = {
        plan: {
          intent: "recipient_event" as const,
          primaryRelayUrls: [relayA, relayB],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        },
        attemptedRelayUrls: [relayA, relayB],
        successfulRelayUrls: [relayA],
        failedRelayUrls: [],
        relayFailureMessages: {},
        pendingRelayUrls: [relayB],
        rejectedRelayUrls: [],
        timedOutRelayUrls: [],
      }
      const settled = {
        ...accepted,
        attemptedRelayUrls:
          terminalStatus === "policy_blocked" ? [relayA] : [relayA, relayB],
        relayAttempts: [
          { relayUrl: relayB, attempt: 1, status: terminalStatus },
        ],
        failedRelayUrls: [relayB],
        relayFailureMessages: {
          [relayB]: "No acknowledgement before timeout",
        },
        pendingRelayUrls: [],
        timedOutRelayUrls: [relayB],
      }
      const persistedCalls: Array<{
        releaseLease?: boolean
        outcomes: Array<{ relayUrl: string; status: string }>
      }> = []
      let releaseSettlement!: () => void
      const settlementGate = new Promise<void>((resolve) => {
        releaseSettlement = resolve
      })
      let selfRecoveryStarts = 0
      let cacheAttempts = 0
      let companionPublishes = 0
      const committedLifecycle = {
        ...lifecycle,
        phase: "ordered",
        orderDeliveryStatus: "sent",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        checkoutRecoveryPending: true,
        updatedAt: 100,
        orderRelayDelivery: {
          rumorId: getEventHash({
            ...stagedRumor,
            pubkey: buyerPubkey,
            created_at: stagedRumor.created_at!,
          }),
          signedRecipientWrap: { id: "recipient-wrap" },
          route: "declared_inbox",
          relayDelivery: [
            { relayUrl: relayA, source: "declared", status: "acked" },
            { relayUrl: relayB, source: "declared", status: "pending" },
          ],
        },
      }

      const result = await publishBuyerOrderMessage(
        stagedRumor,
        "merchant-pubkey",
        identityKind === "guest_ephemeral"
          ? {
              kind: "guest_ephemeral",
              pubkey: buyerPubkey,
              signer: signer as never,
              orderId: "guest-order",
              merchantPubkey: "merchant-pubkey",
            }
          : {
              kind: "signed_in",
              pubkey: buyerPubkey,
              signer: signer as never,
            },
        {
          orderLifecycle: lifecycle,
          shouldContinue: () => true,
          publishPrivateMessageFn: async (input) => {
            if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
              companionPublishes += 1
              return {
                wrappedToRecipient: { id: "companion-wrap" } as never,
                wrappedToSelf: null,
                selfCopyError: null,
                deliveryRoute: "declared_inbox" as const,
              } as never
            }
            expect(input.recipientDeliveryBoundary).toBe("accepted")
            const prepared = {
              rumorId: getEventHash({
                ...stagedRumor,
                pubkey: buyerPubkey,
                created_at: stagedRumor.created_at!,
              }),
              wrappedToRecipient: {
                id: "recipient-wrap",
                rawEvent: () => ({ id: "recipient-wrap" }),
              } as never,
              deliveryRoute: "declared_inbox" as const,
              relayPlan: [
                { relayUrl: relayA, source: "declared" as const },
                { relayUrl: relayB, source: "declared" as const },
              ],
            }
            await input.onRecipientPrepared?.(prepared)
            await input.onRecipientPublishStarting?.(prepared)
            await input.onRecipientPublishAccepted?.(accepted)
            void settlementGate.then(() =>
              input.onRecipientPublishSettled?.(settled)
            )
            return {
              wrappedToRecipient: prepared.wrappedToRecipient,
              wrappedToSelf: null,
              selfCopyError: null,
              deliveryRoute: "declared_inbox" as const,
              orderRelayDelivery: committedLifecycle.orderRelayDelivery,
              startPostAcceptanceWork: async () => {
                selfRecoveryStarts += 1
                return {
                  wrappedToSelf: null,
                  selfDelivery: null,
                  selfDeliveryStatus: null,
                  selfCopyError: null,
                }
              },
            } as never
          },
          stageOrderRelayDeliveryFn: (async () => ({
            lifecycle: {
              ...committedLifecycle,
              orderDeliveryStatus: "pending",
            },
            inserted: true,
          })) as never,
          beginOrderRelayDeliveryAttemptFn: (async () => ({
            lifecycle: committedLifecycle,
            generationsByRelay: { [relayA]: 1, [relayB]: 1 },
            wrapId: "recipient-wrap",
          })) as never,
          recordOrderRelayDeliveryOutcomesFn: (async (input) => {
            persistedCalls.push({
              releaseLease: input.releaseLease,
              outcomes: input.outcomes.map((outcome) => ({
                relayUrl: outcome.relayUrl,
                status: outcome.status,
              })),
            })
            return committedLifecycle as never
          }) as never,
          cacheBuyerOrderRumorFn: async () => {
            cacheAttempts += 1
            return null
          },
          patchOrderLifecycleFn: (async () => committedLifecycle) as never,
        }
      )

      expect(persistedCalls).toEqual([
        {
          releaseLease: false,
          outcomes: [{ relayUrl: relayA, status: "acked" }],
        },
      ])
      expect(selfRecoveryStarts).toBe(0)
      expect(cacheAttempts).toBe(0)
      expect(companionPublishes).toBe(0)

      const firstPostWork = result.startPostAcceptanceWork!()
      const secondPostWork = result.startPostAcceptanceWork!()
      expect(secondPostWork).toBe(firstPostWork)
      expect((await firstPostWork).companionNotification).toBe("sent")
      expect(selfRecoveryStarts).toBe(1)
      expect(cacheAttempts).toBe(identityKind === "signed_in" ? 1 : 0)
      expect(companionPublishes).toBe(1)

      releaseSettlement()
      await Promise.resolve()
      await Promise.resolve()
      expect(persistedCalls.at(-1)).toEqual({
        releaseLease: true,
        outcomes: [
          { relayUrl: relayA, status: "acked" },
          { relayUrl: relayB, status: terminalStatus },
        ],
      })
    })
  }

  it("publishes a recipient-only kind-14 companion after signed-in order delivery", async () => {
    const signer = getAccountSigner()!
    const calls: Array<Record<string, unknown>> = []
    let cached = false
    let authoritativeOrderSucceeded = false
    let releaseAuthoritativeOrder = () => {}
    const authoritativeOrderAck = new Promise<void>((resolve) => {
      releaseAuthoritativeOrder = resolve
    })
    const authoritativeOrder = orderRumor()
    const authoritativeContent = authoritativeOrder.content
    const authoritativeTags = structuredClone(authoritativeOrder.tags)

    const publishing = publishBuyerOrderMessage(
      authoritativeOrder,
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        accountPubkey:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        authenticatedPubkey:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        relayAuthMethod: "nip07",
        publishPrivateMessageFn: async (input) => {
          calls.push(input as unknown as Record<string, unknown>)
          if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
            expect(authoritativeOrderSucceeded).toBe(true)
          } else {
            await authoritativeOrderAck
            authoritativeOrderSucceeded = true
          }
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf:
              input.rumorKind === EVENT_KINDS.ORDER
                ? ({ id: "self-wrap" } as never)
                : null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cached = true
          return null
        },
      }
    )

    await Promise.resolve()
    expect(calls.map((call) => call.rumorKind)).toEqual([EVENT_KINDS.ORDER])
    releaseAuthoritativeOrder()
    const result = await publishing

    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])

    const orderCall = calls[0]
    expect(orderCall?.senderPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(orderCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(orderCall?.signer).toBe(signer)
    expect(orderCall?.selfCopy).toBe(true)
    expect(orderCall?.accountPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(orderCall?.authenticatedPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(orderCall?.signerInteraction).toBe("external")
    expect(orderCall?.relayAuthMethod).toBe("nip07")
    expect(orderCall?.validatedOrderScope).toMatchObject({
      rumorId: (orderCall!.rumor as { id: string }).id,
      orderId: "guest-order",
      senderPubkey:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      recipientPubkey: "merchant-pubkey",
    })

    const companionCall = calls[1]
    expect(companionCall?.senderPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(companionCall?.accountPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(companionCall?.authenticatedPubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(companionCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(companionCall?.signer).toBe(signer)
    expect(companionCall?.selfCopy).toBe(false)
    expect(companionCall?.signerInteraction).toBe("background_external")
    expect(companionCall?.relayAuthMethod).toBeUndefined()
    expect(companionCall?.validatedOrderScope).toBeUndefined()
    expect(companionCall?.validatedGuestOrderCompanionScope).toBeUndefined()

    const companion = companionCall?.rumor as {
      kind: number
      pubkey: string
      created_at: number
      content: string
      tags: string[][]
    }
    expect(companion.kind).toBe(EVENT_KINDS.DIRECT_MESSAGE)
    expect(companion.pubkey).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    expect(companion.created_at).toBe(100)
    expect(companion.tags).toEqual([
      ["p", "merchant-pubkey"],
      ["subject", "conduit-order-notification"],
      ["order", "guest-order"],
      [
        "conduit",
        "order-companion",
        "1",
        (orderCall!.rumor as { id: string }).id,
      ],
      [
        "client",
        "Conduit Market",
        "31990:market-pubkey:conduit-market",
        "wss://relay.conduit.market",
      ],
    ])
    expect(companion.content).toBe(
      "A new order was sent to you through Conduit Market.\n" +
        "Review it at: https://sell.conduit.market/orders?order=guest-order"
    )
    expect(companion.content).not.toContain("[")
    expect(companion.content).not.toContain("](")
    expect(authoritativeOrder.kind).toBe(EVENT_KINDS.ORDER)
    expect(authoritativeOrder.content).toBe(authoritativeContent)
    expect(authoritativeOrder.tags).toEqual(authoritativeTags)
    expect(cached).toBe(true)
    expect(result).toMatchObject({
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute: "declared_inbox",
    })
    expect(await result.companionNotification).toBe("sent")
  })

  it("stops signed-in private delivery when the active signer changes before transport", async () => {
    let enteredFinalPolicy!: () => void
    const finalPolicyStarted = new Promise<void>((resolve) => {
      enteredFinalPolicy = resolve
    })
    let finishFinalPolicy!: () => void
    const finalPolicyFinished = new Promise<void>((resolve) => {
      finishFinalPolicy = resolve
    })
    let transportAttempts = 0

    const publishing = publishBuyerOrderMessage(
      orderRumor(),
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        shouldContinue: () => true,
        publishPrivateMessageFn: async (input) => {
          enteredFinalPolicy()
          await finalPolicyFinished
          if (input.shouldContinue?.() === false) {
            throw new Error("Buyer account changed before delivery")
          }
          transportAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    await finalPolicyStarted
    installBuyerSigner("c".repeat(64))
    finishFinalPolicy()

    await expect(publishing).rejects.toThrow(
      "Buyer account changed before delivery"
    )
    expect(transportAttempts).toBe(0)
  })

  it("keeps accepted order delivery and reports unavailable local history after signer change", async () => {
    const buyerPubkey = "a".repeat(64)
    const merchantPubkey = "b".repeat(64)
    const merchantRelayUrl = "wss://merchant.inbox.conduit.market"
    const buyerRelayUrl = "wss://buyer.inbox.conduit.market"
    const signer = installBuyerSigner(buyerPubkey)
    let sessionCurrent = true
    const published: string[] = []
    let companionPublishAttempts = 0
    let recipientWrapId = ""
    let selfWrapId = ""
    const wrapSigner = NDKPrivateKeySigner.generate()
    const order = orderRumor({
      pubkey: buyerPubkey,
      tags: [
        ["p", merchantPubkey],
        ["type", "order"],
        ["order", "single-order"],
      ],
    })

    const result = await publishBuyerOrderMessage(
      order,
      merchantPubkey,
      {
        kind: "signed_in",
        pubkey: buyerPubkey,
        signer: signer as never,
      },
      {
        shouldContinue: () => sessionCurrent,
        publishPrivateMessageFn: async (input) => {
          if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
            companionPublishAttempts += 1
            throw new Error("advisory companion skipped after session change")
          }
          return await publishPrivateMessage({
            ...input,
            recipientInboxRelays: [merchantRelayUrl],
            senderInboxRelays: [buyerRelayUrl],
            inspectOwnInboxReadiness: async () => ({
              state: "ready",
              eventId: "c".repeat(64),
              relayUrls: [buyerRelayUrl],
              stale: false,
              distributionRepairable: false,
            }),
            giftWrapFn: (async (rumor, recipient) => {
              const wrapped = new NDKEvent()
              wrapped.kind = EVENT_KINDS.GIFT_WRAP
              wrapped.created_at = 100
              wrapped.tags = [["p", recipient.pubkey]]
              wrapped.content = "encrypted test fixture"
              await wrapped.sign(wrapSigner)
              if (
                rumor.kind === EVENT_KINDS.ORDER &&
                recipient.pubkey === merchantPubkey
              ) {
                recipientWrapId = wrapped.id
              } else if (
                rumor.kind === EVENT_KINDS.ORDER &&
                recipient.pubkey === buyerPubkey
              ) {
                selfWrapId = wrapped.id
              }
              return wrapped
            }) as never,
            publishFn: (async (event) => {
              published.push(event.id)
              if (event.id !== recipientWrapId) {
                throw new Error("stale self-copy transport must not start")
              }
              sessionCurrent = false
              return {
                successfulRelayUrls: [merchantRelayUrl],
                failedRelayUrls: [],
              }
            }) as never,
          })
        },
      }
    )

    expect(result.orderRelayDelivery).toBeUndefined()
    expect(result.buyerSelfCopyError).toBe(
      "Sender self-copy was skipped because the signer session changed after recipient delivery."
    )
    expect(result.localCacheError).toBe("Local order history unavailable")
    expect(await result.companionNotification).toBe("skipped_session_changed")
    expect(companionPublishAttempts).toBe(0)
    expect(published[0]).toBe(recipientWrapId)
    expect(published).not.toContain(selfWrapId)
  })

  it("filters a whole-removed relay from both signed-in order sends", async () => {
    const buyerPubkey = "a".repeat(64)
    const merchantPubkey = "b".repeat(64)
    const excludedRelayUrl = "wss://removed-order.conduit.market"
    const eligibleRelayUrl = "wss://eligible-order.conduit.market"
    const repository = createInMemoryAccountNetworkLocalStateRepository(
      [],
      () => 100
    )
    await repository.update(buyerPubkey, (state) =>
      applyAccountNetworkRelayExclusion(state, {
        relayUrl: excludedRelayUrl,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 100,
      })
    )
    const openedRelayUrls: string[] = []
    const signer = installBuyerSigner(buyerPubkey)
    const rumor = orderRumor({
      tags: [
        ["p", merchantPubkey],
        ["type", "order"],
        ["order", "guest-order"],
      ],
    })

    const result = await publishBuyerOrderMessage(
      rumor,
      merchantPubkey,
      { kind: "signed_in", pubkey: buyerPubkey, signer: signer as never },
      {
        accountPubkey: buyerPubkey,
        cacheBuyerOrderRumorFn: async () => null,
        publishPrivateMessageFn: async (input) =>
          await publishPrivateMessage({
            ...input,
            accountNetworkLocalStateRepository: repository,
            recipientInboxRelays: [excludedRelayUrl, eligibleRelayUrl],
            // Keep the non-critical self-copy off live inbox discovery.
            senderInboxRelays: [eligibleRelayUrl],
            inspectOwnInboxReadiness: async () => ({
              state: "ready",
              eventId: "c".repeat(64),
              relayUrls: [eligibleRelayUrl],
              stale: false,
              distributionRepairable: false,
            }),
            giftWrapFn: (async (_rumor, recipient) =>
              new NDKEvent(undefined, {
                id: `wrap-${recipient.pubkey}`,
              })) as never,
            publishFn: (async (_event, options) => {
              openedRelayUrls.push(...(options.exclusiveRelayUrls ?? []))
              return {
                successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
                failedRelayUrls: [],
              }
            }) as never,
          }),
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(openedRelayUrls.length).toBeGreaterThan(0)
    expect(openedRelayUrls).not.toContain(excludedRelayUrl)
    expect(openedRelayUrls).toContain(eligibleRelayUrl)
  })

  it("URL-encodes the order id and excludes sensitive order payload fields", async () => {
    const orderId = "order /?&=✓"
    const calls: Array<{ rumor: { content?: string; tags?: string[][] } }> = []
    const sensitiveRumor = orderRumor({
      content: JSON.stringify({
        id: orderId,
        merchantPubkey: "merchant-pubkey",
        buyerPubkey:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        items: [
          {
            productId: "sensitive-product-id",
            title: "Sensitive Product",
            quantity: 1,
            priceAtPurchase: 21_000,
            currency: "SATS",
          },
        ],
        subtotal: 21_000,
        currency: "SATS",
        shippingAddress: {
          name: "Private Buyer",
          street: "123 Private Street",
          city: "Private City",
          postalCode: "12345",
          country: "US",
        },
        note: "private@example.com lnbc-sensitive",
        createdAt: 100_000,
      }),
      tags: [
        ["p", "merchant-pubkey"],
        ["type", "order"],
        ["order", orderId],
        ["amount", "21000"],
        ["item", "sensitive-product-id", "1"],
        [
          "client",
          "Conduit Market",
          "31990:market-pubkey:conduit-market",
          "wss://relay.conduit.market",
        ],
      ],
    })

    await publishBuyerOrderMessage(
      sensitiveRumor,
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        publishPrivateMessageFn: async (input) => {
          calls.push(input as never)
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    const companion = calls[1]?.rumor
    expect(companion?.content).toBe(
      "A new order was sent to you through Conduit Market.\n" +
        "Review it at: https://sell.conduit.market/orders?order=order+%2F%3F%26%3D%E2%9C%93"
    )
    expect(companion?.tags?.map((tag) => tag[0])).toEqual([
      "p",
      "subject",
      "order",
      "conduit",
      "client",
    ])
    for (const sensitiveValue of [
      "Sensitive Product",
      "21000",
      "123 Private Street",
      "private@example.com",
      "lnbc-sensitive",
      "sensitive-product-id",
    ]) {
      expect(companion?.content).not.toContain(sensitiveValue)
      expect(JSON.stringify(companion?.tags)).not.toContain(sensitiveValue)
    }
  })

  it("publishes a one-way guest companion without contact data, self-copy, or durable cache", async () => {
    const guestSigner = { id: "guest-signer" }
    const calls: Array<Record<string, unknown>> = []
    let cacheAttempts = 0

    const result = await publishBuyerOrderMessage(
      guestOrderRumor(),
      "merchant-pubkey",
      {
        kind: "guest_ephemeral",
        pubkey:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: "merchant-pubkey",
      },
      {
        shouldContinue: () => true,
        publishPrivateMessageFn: async (input) => {
          calls.push(input as unknown as Record<string, unknown>)
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cacheAttempts += 1
          return null
        },
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(calls.map((call) => call.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    const orderCall = calls[0]
    expect(orderCall?.senderPubkey).toBe(
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    )
    expect(orderCall?.signer).toBe(guestSigner)
    expect(orderCall?.selfCopy).toBe(false)
    expect(orderCall?.accountPubkey).toBeNull()
    expect(orderCall?.shouldContinue).toBeInstanceOf(Function)
    expect((orderCall?.shouldContinue as () => boolean)()).toBe(true)
    expect(orderCall?.signerInteraction).toBe("application_owned")
    expect(orderCall?.validatedOrderScope).toMatchObject({
      rumorId: (orderCall!.rumor as { id: string }).id,
      orderId: "guest-order",
      senderPubkey:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      recipientPubkey: "merchant-pubkey",
    })

    const companionCall = calls[1]
    expect(companionCall?.senderPubkey).toBe(
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    )
    expect(companionCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(companionCall?.signer).toBe(guestSigner)
    expect(companionCall?.selfCopy).toBe(false)
    expect(companionCall?.accountPubkey).toBeNull()
    expect(companionCall?.shouldContinue).toBeInstanceOf(Function)
    expect((companionCall?.shouldContinue as () => boolean)()).toBe(true)
    expect(companionCall?.signerInteraction).toBe("application_owned")
    expect(companionCall?.validatedOrderScope).toBeUndefined()
    expect(companionCall?.validatedGuestOrderCompanionScope).toMatchObject({
      rumorId: (companionCall?.rumor as { id: string }).id,
      orderRumorId: (orderCall!.rumor as { id: string }).id,
      orderId: "guest-order",
      subject: "conduit-order-notification",
      senderPubkey:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      recipientPubkey: "merchant-pubkey",
    })
    const companion = companionCall?.rumor as { content: string }
    expect(companion.content).toBe(
      "A new guest order was sent to you through Conduit Market.\n" +
        "This buyer does not receive Nostr replies. Review the order and follow up using the email or phone provided there.\n" +
        "Review it at: https://sell.conduit.market/orders?order=guest-order"
    )
    expect(companion.content).not.toContain("guest-private@example.com")
    expect(companion.content).not.toContain("+1-555-0100")
    expect(cacheAttempts).toBe(0)
    expect(await result.companionNotification).toBe("sent")
  })

  it("uses the real transport boundary without requiring a guest inbox", async () => {
    const wrappedRecipients: string[] = []
    const publishedKinds: number[] = []
    let guestInboxChecks = 0
    const merchantInboxRelay = "wss://merchant.inbox.conduit.market"
    const guestSigner = {
      getPublicKey: async () =>
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }

    const merchant = "d".repeat(64)
    const guestRumor = guestOrderRumor() as PrivateMessageRumor
    guestRumor.tags = guestRumor.tags.map((tag) =>
      tag[0] === "p" ? ["p", merchant] : tag
    )
    guestRumor.content = JSON.stringify({
      ...JSON.parse(guestRumor.content),
      merchantPubkey: merchant,
    })
    guestRumor.id = getEventHash(guestRumor)
    const result = await publishBuyerOrderMessage(
      guestRumor,
      merchant,
      {
        kind: "guest_ephemeral",
        pubkey:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: merchant,
      },
      {
        publishPrivateMessageFn: async (input) =>
          await publishPrivateMessage({
            ...input,
            recipientInboxRelays: [merchantInboxRelay],
            inspectOwnInboxReadiness: async () => {
              guestInboxChecks += 1
              return { state: "lookup_unavailable" }
            },
            giftWrapFn: (async (rumor, recipient) => {
              publishedKinds.push(rumor.kind)
              wrappedRecipients.push(recipient.pubkey)
              return new NDKEvent(undefined, {
                id: `wrap-${rumor.kind}-${recipient.pubkey}`,
              }) as never
            }) as never,
            publishFn: (async (_event, options) => ({
              successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
              failedRelayUrls: [],
            })) as never,
          }),
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(publishedKinds).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    expect(wrappedRecipients).toEqual([merchant, merchant])
    expect(guestInboxChecks).toBe(0)
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.buyerSelfCopyError).toBeNull()
    expect(result.localCacheError).toBeNull()
  })

  it("gift-wraps a guest order and PII-free companion only to the merchant", async () => {
    const merchantSigner = plainTestSigner(NDKPrivateKeySigner.generate())
    const merchant = await merchantSigner.user()
    const guestIdentity = createGuestOrderSigningIdentity(
      "guest-order",
      merchant.pubkey
    )
    const authoritativeOrder = new NDKEvent()
    authoritativeOrder.kind = EVENT_KINDS.ORDER
    authoritativeOrder.created_at = 100
    authoritativeOrder.tags = [
      ["p", merchant.pubkey],
      ["type", "order"],
      ["order", "guest-order"],
    ]
    authoritativeOrder.content = JSON.stringify({
      id: "guest-order",
      merchantPubkey: merchant.pubkey,
      buyerPubkey: guestIdentity.pubkey,
      buyerIdentityKind: "guest_ephemeral",
      items: [
        {
          productId: "private-product-id",
          quantity: 1,
          priceAtPurchase: 21_000,
          currency: "SATS",
        },
      ],
      subtotal: 21_000,
      currency: "SATS",
      guestContact: {
        email: "guest-private@example.com",
        phone: "+1-555-0100",
      },
      createdAt: 100_000,
    })

    const wraps: Array<{
      rumorKind: number
      event: NDKEvent
      recipients: string[]
    }> = []
    let guestInboxChecks = 0
    const merchantInboxRelay = "wss://merchant.inbox.conduit.market"
    const result = await publishBuyerOrderMessage(
      authoritativeOrder,
      merchant.pubkey,
      guestIdentity,
      {
        publishPrivateMessageFn: async (input) =>
          await publishPrivateMessage({
            ...input,
            recipientInboxRelays: [merchantInboxRelay],
            inspectOwnInboxReadiness: async () => {
              guestInboxChecks += 1
              return { state: "lookup_unavailable" }
            },
            publishFn: (async (event, options) => {
              wraps.push({
                rumorKind: input.rumorKind,
                event: new NDKEvent(undefined, event),
                recipients: [...(options.recipientPubkeys ?? [])],
              })
              return {
                successfulRelayUrls: [merchantInboxRelay],
                failedRelayUrls: [],
              }
            }) as never,
          }),
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(guestInboxChecks).toBe(0)
    expect(wraps.map((wrap) => wrap.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    expect(wraps.map((wrap) => wrap.recipients)).toEqual([
      [merchant.pubkey],
      [merchant.pubkey],
    ])

    const orderOutcome = await unwrapGiftWrap(wraps[0]!.event, merchantSigner)
    const companionOutcome = await unwrapGiftWrap(
      wraps[1]!.event,
      merchantSigner
    )
    expect(orderOutcome.status).toBe("ok")
    expect(companionOutcome.status).toBe("ok")
    if (orderOutcome.status !== "ok" || companionOutcome.status !== "ok") {
      throw new Error("Expected both guest order wraps to decrypt.")
    }
    expect(orderOutcome.rumor.kind).toBe(EVENT_KINDS.ORDER)
    expect(orderOutcome.rumor.content).toContain("guest-private@example.com")
    expect(companionOutcome.rumor.kind).toBe(EVENT_KINDS.DIRECT_MESSAGE)
    expect(companionOutcome.rumor.tags).toContainEqual([
      "subject",
      "conduit-order-notification",
    ])
    expect(companionOutcome.rumor.tags).toContainEqual([
      "conduit",
      "order-companion",
      "1",
      orderOutcome.rumor.id,
    ])
    for (const sensitiveValue of [
      "guest-private@example.com",
      "+1-555-0100",
      "private-product-id",
      "21000",
    ]) {
      expect(companionOutcome.rumor.content).not.toContain(sensitiveValue)
      expect(JSON.stringify(companionOutcome.rumor.tags)).not.toContain(
        sensitiveValue
      )
    }
  })

  it("does not route a guest companion through compatibility order relays", async () => {
    const guestSigner = { id: "guest-signer" }
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      guestOrderRumor(),
      "merchant-pubkey",
      {
        kind: "guest_ephemeral",
        pubkey:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: "merchant-pubkey",
      },
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "compatibility_order" as const,
          }
        },
      }
    )

    expect(publishAttempts).toBe(1)
    expect(await result.companionNotification).toBe(
      "skipped_non_declared_route"
    )
  })

  it("skips the companion when the authoritative order used compatibility routing", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor(),
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "compatibility_order" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(result.deliveryRoute).toBe("compatibility_order")
    expect(await result.companionNotification).toBe(
      "skipped_non_declared_route"
    )
  })

  it("does not publish a companion for payment proofs", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor({
        tags: [
          ["p", "merchant-pubkey"],
          ["type", "payment_proof"],
          ["order", "guest-order"],
        ],
      }),
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(await result.companionNotification).toBe("skipped_non_order")
  })

  it("does not publish a companion for order-thread replies", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor({
        content: JSON.stringify({
          note: "Order reply",
          orderId: "guest-order",
          merchantPubkey: "merchant-pubkey",
          buyerPubkey:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          createdAt: 100_000,
        }),
        tags: [
          ["p", "merchant-pubkey"],
          ["type", "message"],
          ["order", "guest-order"],
        ],
      }),
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(await result.companionNotification).toBe("skipped_non_order")
  })

  it("does not attempt the companion after authoritative order failure", async () => {
    let publishAttempts = 0
    let cacheAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor(),
        "merchant-pubkey",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("Recipient delivery completed without a relay ACK.")
          },
          cacheBuyerOrderRumorFn: async () => {
            cacheAttempts += 1
            return null
          },
        }
      )
    ).rejects.toThrow("Recipient delivery completed without a relay ACK.")
    expect(publishAttempts).toBe(1)
    expect(cacheAttempts).toBe(0)
  })

  it("does not delay an accepted order while the advisory companion is stalled", async () => {
    let releaseCompanion: (() => void) | undefined
    const companionGate = new Promise<void>((resolve) => {
      releaseCompanion = resolve
    })
    let publishAttempts = 0

    const result = await publishBuyerOrderMessage(
      orderRumor(),
      "merchant-pubkey",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        publishPrivateMessageFn: async (input) => {
          publishAttempts += 1
          if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
            await companionGate
          }
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(2)
    let companionSettled = false
    void result.companionNotification.then(() => {
      companionSettled = true
    })
    await Promise.resolve()
    expect(companionSettled).toBe(false)

    releaseCompanion?.()
    expect(await result.companionNotification).toBe("sent")
  })

  for (const failure of [
    "Signer rejected companion operation",
    "No usable recipient NIP-17 inbox declaration was found on the relays checked.",
    "Recipient delivery completed without a relay ACK.",
  ]) {
    it(`keeps successful order delivery after advisory failure: ${failure}`, async () => {
      const orderRelayDelivery = { wrappedEventId: "recipient-wrap" }
      let publishAttempts = 0
      const result = await publishBuyerOrderMessage(
        orderRumor(),
        "merchant-pubkey",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        {
          publishPrivateMessageFn: async (input) => {
            publishAttempts += 1
            if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
              throw new Error(failure)
            }
            return {
              wrappedToRecipient: { id: "recipient-wrap" } as never,
              wrappedToSelf: null,
              selfCopyError: null,
              deliveryRoute: "declared_inbox" as const,
              orderRelayDelivery: orderRelayDelivery as never,
            }
          },
          cacheBuyerOrderRumorFn: async () => null,
        }
      )

      expect(publishAttempts).toBe(2)
      expect(result).toMatchObject({
        buyerSelfCopyError: null,
        localCacheError: null,
        deliveryRoute: "declared_inbox",
        orderRelayDelivery,
      })
      expect(await result.companionNotification).toBe("failed")
      expect(getDeliveryNotice(result, "Order")).toBeNull()
    })
  }

  it("rejects guest messages outside the bound order", async () => {
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor({
          tags: [
            ["p", "merchant-pubkey"],
            ["type", "payment_proof"],
            ["order", "other-order"],
          ],
        }),
        "merchant-pubkey",
        {
          kind: "guest_ephemeral",
          pubkey:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          signer: {} as never,
          orderId: "expected-order",
          merchantPubkey: "merchant-pubkey",
        },
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Guest order message is outside its signer scope.")
    expect(publishAttempts).toBe(0)
  })

  it("fails before publishing when no buyer signer is available", async () => {
    retireAccountSigner(activeSignerLease!)
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor(),
        "merchant-pubkey",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Buyer order signer is not connected.")
    expect(publishAttempts).toBe(0)
  })

  it("preserves connected buyer signing across an NDK transport reset", async () => {
    const buyerPubkey = "b".repeat(64)
    const signer = {
      pubkey: buyerPubkey,
      user: async () => ({ pubkey: buyerPubkey }),
    }
    let publishAttempts = 0

    activeSignerLease = setSigner(signer as never)
    const originalNdk = getNdk()
    disconnectNdk()
    const replacementNdk = getNdk()

    expect(replacementNdk).not.toBe(originalNdk)
    expect(replacementNdk.signer).toBeUndefined()
    expect(getAccountSigner()).toBe(activeSignerLease)

    await publishBuyerOrderMessage(
      orderRumor(),
      "merchant-pubkey",
      {
        kind: "signed_in",
        pubkey: buyerPubkey,
        signer: activeSignerLease!,
      },
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
  })
})

function installBuyerSigner(
  pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
) {
  const signer = new SessionSigner(
    {
      pubkey,
      getPublicKey: async () => pubkey,
      signEvent: async () => {
        throw new Error("fixture must not sign")
      },
      encryptNip44: async () => {
        throw new Error("fixture must not encrypt")
      },
      decryptNip44: async () => {
        throw new Error("fixture must not decrypt")
      },
      decryptLegacy: async () => {
        throw new Error("fixture must not decrypt")
      },
    },
    {
      expectedPubkey: pubkey,
      revision: "synthetic-revision",
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: false,
      }),
      hasAuthority: () => true,
    }
  )
  activateAccountSigner(signer)
  activeSignerLease = signer
  return signer
}
