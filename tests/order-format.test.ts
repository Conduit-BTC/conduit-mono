import { afterEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import Dexie from "dexie"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { wrapEvent, unwrapEvent } from "nostr-tools/nip59"
import { ConduitDB, type OrderLifecycle } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import { encodeOpenMarketsBuyerMessage } from "../packages/core/src/protocol/commerce-wire"
import { createPrivateMessageRumor } from "../packages/core/src/protocol/messaging"
import {
  getOrderWireFormat,
  pinOrderWireFormat,
  projectOwnedNumericOrderMessages,
  correlateLegacyNumericOrderHistory,
} from "../packages/core/src/protocol/order-format"
import { extractOrderSummary } from "../packages/core/src/protocol/order-summary"
import { parseOrderMessageRumorEvent } from "../packages/core/src/protocol/orders"
import {
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import {
  stageOrderRelayDelivery,
  type OrderRelayDeliveryRepository,
} from "../packages/core/src/protocol/order-relay-delivery"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"
import { admitFixture } from "./helpers/public-event"
import { publishBuyerOrderMessage } from "../apps/market/src/lib/order-publish"
import { publishPrivateMessage } from "../packages/core/src/protocol/private-message-delivery"
import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  pruneExpiredGuestOrderData,
} from "../packages/core/src/protocol/order-lifecycle"
import {
  createValidatedOrderRouteScope,
  consumeValidatedOrderRouteScope,
} from "../packages/core/src/protocol/private-message-primitives"
import {
  plainTestSigner,
  setTestAccountSigner,
  removeTestAccountSigner,
} from "./helpers/plain-signer"

// Peer contract vectors: nostrichOS/nostrich-marketplace@668198e3388ba35e0fcc3a2a4a9e9503402de69e
// src/orders/orders.ts buildOrder/buildReceipt/parseOrderRumor and docs/orders.md.
// Synthetic local tests, not an observation from a running external client.
const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
const signerLeases: ReturnType<typeof setTestAccountSigner>[] = []
afterEach(async () => {
  for (const lease of signerLeases.splice(0)) removeTestAccountSigner(lease)
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})
function fixture() {
  const buyerKey = generateSecretKey()
  const merchantKey = generateSecretKey()
  const buyerPubkey = getPublicKey(buyerKey)
  const merchantPubkey = getPublicKey(merchantKey)
  const orderId = crypto.randomUUID()
  const database = new ConduitDB(`order-format-${orderId}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const createdAt = Date.now()
  const lifecycle: OrderLifecycle = {
    orderId,
    buyerPubkey,
    merchantPubkey,
    orderWireFormat: "open_markets",
    buyerIdentityKind: "signed_in",
    checkoutMode: "pay_later",
    createdAt,
    updatedAt: createdAt,
    phase: "pending",
    items: [
      {
        productId: `30402:${merchantPubkey}:book`,
        format: "physical",
        quantity: 1,
        priceAtPurchase: 200,
        currency: "SATS",
      },
    ],
    itemSubtotalSats: 200,
    shippingCostSats: 0,
    totalSats: 200,
    totalMsats: 200_000,
    currency: "SATS",
    contactNote: "Synthetic peer order",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "pending",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
  }
  const canonical = createPrivateMessageRumor({
    kind: 16,
    pubkey: buyerPubkey,
    created_at: Math.floor(createdAt / 1000),
    tags: [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", orderId],
      ["amount", "200"],
      ["currency", "SATS"],
    ],
    content: JSON.stringify({
      id: orderId,
      buyerPubkey,
      merchantPubkey,
      buyerIdentityKind: "signed_in",
      items: lifecycle.items,
      subtotal: 200,
      currency: "SATS",
      createdAt,
      note: "Synthetic peer order",
    }),
  })
  const scope = { buyerPubkey, merchantPubkey, orderId }
  return {
    buyerKey,
    merchantKey,
    buyerPubkey,
    merchantPubkey,
    orderId,
    database,
    lifecycle,
    canonical,
    scope,
  }
}

describe("explicit order-format selection and the numeric peer contract", () => {
  it.each([0, 200])(
    "refuses unsupported numeric pickup encoding before encryption (total=%s)",
    (total) => {
      const f = fixture()
      for (const buyerIdentityKind of ["signed_in", "guest_ephemeral"]) {
        const payload = JSON.parse(f.canonical.content)
        payload.buyerIdentityKind = buyerIdentityKind
        payload.subtotal = total
        payload.items[0].priceAtPurchase = total
        payload.items[0].fulfillment = { type: "event_market_pickup" }
        expect(() =>
          encodeOpenMarketsBuyerMessage(
            { ...f.canonical, content: JSON.stringify(payload) },
            f.scope
          )
        ).toThrow("Event pickup requires Conduit order compatibility")
      }
    }
  )

  it("accepts a singleton recipient with an optional bounded relay hint, including validated extensions", () => {
    const f = fixture()
    const numeric = encodeOpenMarketsBuyerMessage(f.canonical, f.scope)
    for (const extension of [false, true]) {
      for (const hint of [undefined, "", "wss://peer.example/inbox"]) {
        const rumor = createPrivateMessageRumor({
          ...numeric,
          id: "",
          tags: numeric.tags
            .filter(
              (tag) => tag[0] !== "p" && (extension || tag[0] !== "conduit")
            )
            .concat([
              hint === undefined
                ? ["p", f.merchantPubkey]
                : ["p", f.merchantPubkey, hint],
            ]),
        })
        expect(parseOrderMessageRumorEvent(rumor).type).toBe("order")
      }
    }
    for (const tag of [
      ["p", f.merchantPubkey, "https://peer.example"],
      ["p", f.merchantPubkey, "wss://peer.example", "extra"],
    ]) {
      expect(() =>
        parseOrderMessageRumorEvent(
          createPrivateMessageRumor({
            ...numeric,
            id: "",
            tags: numeric.tags.filter((tag) => tag[0] !== "p").concat([tag]),
          })
        )
      ).toThrow()
    }
    expect(() =>
      parseOrderMessageRumorEvent(
        createPrivateMessageRumor({
          ...numeric,
          id: "",
          tags: [...numeric.tags, ["p", f.merchantPubkey]],
        })
      )
    ).toThrow()
  })

  it("binds historical named invoice and fulfillment history only to its exact extension-backed party pair", () => {
    const f = fixture()
    const numeric = parseOrderMessageRumorEvent(
      createPrivateMessageRumor({
        ...encodeOpenMarketsBuyerMessage(f.canonical, f.scope),
        id: "",
      })
    )
    const named = (buyer = f.buyerPubkey) =>
      parseOrderMessageRumorEvent(
        createPrivateMessageRumor({
          kind: 16,
          pubkey: f.merchantPubkey,
          created_at: f.canonical.created_at,
          tags: [
            ["p", buyer],
            ["order", f.orderId],
            ["type", "status_update"],
          ],
          content: JSON.stringify({ status: "paid" }),
        })
      )
    const paid = named()
    const other = named(getPublicKey(generateSecretKey()))
    const messages = correlateLegacyNumericOrderHistory([numeric, paid, other])
    expect(messages[1]?.orderId).toBe(numeric.orderId)
    expect(messages[1]?.wireFormat).toBeUndefined()
    expect(messages[2]).toEqual(other)
    const original = parseOrderMessageRumorEvent(f.canonical)
    expect(
      correlateLegacyNumericOrderHistory([numeric, paid, original])[1]
    ).toEqual(paid)
  })

  it("persists an accepted numeric conversation through the default cache when the self-copy is refused", async () => {
    const f = fixture()
    await f.database.orderLifecycles.put(f.lifecycle)
    const signer = new NDKPrivateKeySigner(
      Buffer.from(f.buyerKey).toString("hex")
    )
    const lease = setTestAccountSigner(signer)
    signerLeases.push(lease)
    installProtectedReadSigner(lease, f.buyerPubkey, () => true)
    const authorization = getProtectedReadAuthorization(f.buyerPubkey)!
    const owner = new CommerceInbox(
      authorization,
      lease,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(owner)
    let sends = 0
    const result = await publishBuyerOrderMessage(
      {
        ...f.canonical,
        id: "",
        tags: [
          ["p", f.merchantPubkey],
          ["type", "message"],
          ["order", f.orderId],
        ],
        content: JSON.stringify({ note: "Synthetic accepted conversation" }),
      },
      f.merchantPubkey,
      { pubkey: f.buyerPubkey, signer: lease },
      {
        orderContext: f.lifecycle,
        getCommerceInboxFn: () => owner,
        publishPrivateMessageFn: async (input) => {
          sends++
          expect(input.rumor.kind).toBe(14)
          await input.onRecipientAccepted?.({
            successfulRelayUrls: ["wss://fixture.example"],
          } as never)
          return {
            deliveryRoute: "declared_inbox",
            selfDeliveryStatus: "failed",
            selfCopyError: "Synthetic self-copy refusal",
          } as never
        },
      }
    )
    expect(sends).toBe(1)
    expect(result.localCacheError).toBeNull()
    expect(result.buyerSelfCopyError).not.toBeNull()
    owner.stop()
    const reloaded = new CommerceInbox(
      authorization,
      lease,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(reloaded)
    await reloaded.initialize()
    expect(
      reloaded
        .getSnapshot()
        .orderMessages.filter(
          (m) => m.type === "message" && m.orderId === f.orderId
        )
    ).toHaveLength(1)
    expect(reloaded.getSnapshot().directMessages).toHaveLength(1)
    expect(
      JSON.stringify(await f.database.commerceInboxRecords.toArray())
    ).not.toContain("Synthetic accepted conversation")
  })

  it("expires staged and pre-staging guest format metadata with the existing guest window", async () => {
    const f = fixture()
    const now = Date.now()
    await pinOrderWireFormat(f.lifecycle, { database: f.database })
    await f.database.orderLifecycles.put(f.lifecycle)
    const guest = {
      ...f.lifecycle,
      orderId: crypto.randomUUID(),
      buyerIdentityKind: "guest_ephemeral" as const,
      contactNote: undefined,
      createdAt: now,
      guestSessionExpiresAt: now + 100,
    }
    await pinOrderWireFormat(guest, { database: f.database })
    await f.database.orderLifecycles.put(guest)
    await pinOrderWireFormat(
      { ...guest, orderId: crypto.randomUUID() },
      { database: f.database }
    )
    expect(
      await pruneExpiredGuestOrderData(
        now + 200,
        GUEST_ORDER_LOCAL_RETENTION_MS,
        f.database
      )
    ).toBe(1)
    expect(await f.database.orderWireFormats.count()).toBe(1)
    expect(await f.database.orderLifecycles.count()).toBe(1)
    expect(
      (await f.database.orderWireFormats.get(f.orderId))?.orderWireFormat
    ).toBe("open_markets")
  })
  it("defaults only to the named contract and pins one party-scoped choice before staging", async () => {
    const f = fixture()
    expect(getOrderWireFormat({})).toBe("conduit")
    expect(
      getOrderWireFormat({
        orderWireFormat: undefined,
        ...{ client: "nostrich", kind: 10050 },
      })
    ).toBe("conduit")
    expect(() =>
      getOrderWireFormat({ orderWireFormat: "unknown" as never })
    ).toThrow()
    await pinOrderWireFormat(f.lifecycle, { database: f.database })
    await f.database.close()
    await f.database.open()
    expect(
      await pinOrderWireFormat(f.lifecycle, { database: f.database })
    ).toBe("open_markets")
    await expect(
      pinOrderWireFormat(
        { ...f.lifecycle, orderWireFormat: "conduit" },
        { database: f.database }
      )
    ).rejects.toThrow()
    await expect(
      pinOrderWireFormat(
        { ...f.lifecycle, merchantPubkey: getPublicKey(generateSecretKey()) },
        { database: f.database }
      )
    ).rejects.toThrow()
    expect(await f.database.orderWireFormats.count()).toBe(1)
  })

  it("commits the format before the publisher can stage encrypted delivery and fences account changes", async () => {
    const f = fixture()
    let publishCalls = 0
    const signer = setTestAccountSigner(
      plainTestSigner(
        new NDKPrivateKeySigner(Buffer.from(f.buyerKey).toString("hex"))
      )
    )
    signerLeases.push(signer)
    const publish: NonNullable<
      NonNullable<
        Parameters<typeof publishBuyerOrderMessage>[3]
      >["publishPrivateMessageFn"]
    > = async (input) => {
      publishCalls++
      expect(
        (await f.database.orderWireFormats.get(f.orderId))?.orderWireFormat
      ).toBe("open_markets")
      expect(
        input.rumor.tags.some((tag) => tag[0] === "type" && tag[1] === "1")
      ).toBe(true)
      throw new Error("stop before transport")
    }
    await expect(
      publishBuyerOrderMessage(
        structuredClone(f.canonical),
        f.merchantPubkey,
        { kind: "signed_in", pubkey: f.buyerPubkey, signer: signer as never },
        {
          orderLifecycle: f.lifecycle,
          shouldContinue: () => true,
          pinOrderWireFormatFn: (order, options) =>
            pinOrderWireFormat(order, { ...options, database: f.database }),
          publishPrivateMessageFn: publish,
        }
      )
    ).rejects.toThrow("stop before transport")
    await expect(
      publishBuyerOrderMessage(
        structuredClone(f.canonical),
        f.merchantPubkey,
        { kind: "signed_in", pubkey: f.buyerPubkey, signer: signer as never },
        {
          orderContext: { ...f.lifecycle, buyerPubkey: f.merchantPubkey },
          shouldContinue: () => true,
          publishPrivateMessageFn: publish,
        }
      )
    ).rejects.toThrow("another buyer or merchant")
    let current = true
    await expect(
      pinOrderWireFormat(
        { ...f.lifecycle, orderId: crypto.randomUUID() },
        {
          database: f.database,
          shouldContinue: () => {
            const value = current
            current = false
            return value
          },
        }
      )
    ).rejects.toThrow("session ended")
    expect(publishCalls).toBe(1)
    expect(await f.database.orderWireFormats.count()).toBe(1)
  })

  it("upgrades an installed v26 pending named invoice without changing its authority or history", async () => {
    const f = fixture()
    const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange }
    const name = `installed-v26-${crypto.randomUUID()}`
    const legacy = new Dexie(name, dependencies)
    legacy.version(26).stores({
      orderLifecycles: "orderId, buyerPubkey, merchantPubkey, phase, createdAt",
    })
    const { orderWireFormat: _format, ...named } = f.lifecycle
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField("Installed invoice"),
      ],
    })
    const pending = {
      ...named,
      invoice,
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
    }
    await legacy.table("orderLifecycles").put(pending)
    legacy.close()
    const upgraded = new ConduitDB(name, dependencies)
    databases.push(upgraded)
    const restored = await upgraded.orderLifecycles.get(f.orderId)
    expect(restored).toEqual(pending)
    expect(getOrderWireFormat(restored!)).toBe("conduit")
    expect(await upgraded.orderWireFormats.count()).toBe(0)
    await expect(
      pinOrderWireFormat(
        { ...restored!, orderWireFormat: "open_markets" },
        { database: upgraded }
      )
    ).rejects.toThrow("staged order cannot change")
  })

  it("retains one real encrypted numeric order across reload and rejects a changed representation or rewrap", async () => {
    const f = fixture()
    const repository: OrderRelayDeliveryRepository = {
      get: (id) => f.database.orderLifecycles.get(id),
      list: () => f.database.orderLifecycles.toArray(),
      update: async (id, updater) => {
        const existing = await f.database.orderLifecycles.get(id)
        if (!existing) return undefined
        const next = updater(existing)
        await f.database.orderLifecycles.put(next)
        return next
      },
      stage: async (record, assertCompatible) => {
        const existing = await f.database.orderLifecycles.get(record.orderId)
        if (existing) {
          assertCompatible(existing)
          return { lifecycle: existing, inserted: false }
        }
        await f.database.orderLifecycles.put(record)
        return { lifecycle: record, inserted: true }
      },
    }
    await pinOrderWireFormat(f.lifecycle, { database: f.database })
    const rumor = createPrivateMessageRumor({
      ...encodeOpenMarketsBuyerMessage(f.canonical, f.scope),
      id: "",
    })
    const signedRecipientWrap = wrapEvent(rumor, f.buyerKey, f.merchantPubkey)
    const relay = "wss://peer-inbox.conduit.market"
    const declaration = finalizeEvent(
      {
        kind: 10050,
        created_at: rumor.created_at,
        tags: [["relay", relay]],
        content: "",
      },
      f.merchantKey
    )
    const prepared = {
      rumorId: rumor.id,
      signedRecipientWrap,
      route: "declared_inbox" as const,
      routingAuthority: {
        eventId: declaration.id,
        eventCreatedAt: declaration.created_at,
        pubkey: f.merchantPubkey,
        kind: 10050 as const,
        relayUrls: [relay],
      },
      relayPlan: [{ relayUrl: relay, source: "declared" as const }],
    }
    const input = {
      lifecycle: f.lifecycle,
      prepared,
      leaseOwner: "fixture-owner",
    }
    await stageOrderRelayDelivery(input, { repository })
    f.database.close()
    await f.database.open()
    expect(
      (await stageOrderRelayDelivery(input, { repository })).inserted
    ).toBe(false)
    const retained = await f.database.orderLifecycles.get(f.orderId)
    expect(
      JSON.stringify(retained?.orderRelayDelivery?.signedRecipientWrap) ===
        JSON.stringify(signedRecipientWrap)
    ).toBe(true)
    expect(
      unwrapEvent(signedRecipientWrap, f.merchantKey).tags.some(
        (tag) => tag[0] === "type" && tag[1] === "1"
      )
    ).toBe(true)
    await expect(
      stageOrderRelayDelivery(
        { ...input, lifecycle: { ...f.lifecycle, orderWireFormat: "conduit" } },
        { repository }
      )
    ).rejects.toThrow("conflicts")
    await expect(
      stageOrderRelayDelivery(
        {
          ...input,
          prepared: {
            ...prepared,
            signedRecipientWrap: wrapEvent(rumor, f.buyerKey, f.merchantPubkey),
          },
        },
        { repository }
      )
    ).rejects.toThrow("conflicts")
    expect(await f.database.orderLifecycles.count()).toBe(1)
  })

  it.each(["main", "adapter"] as const)(
    "upgrades the installed %s v27 lineage to the complete additive union",
    async (lineage) => {
      const f = fixture()
      const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange }
      const name = `installed-v27-${lineage}-${crypto.randomUUID()}`
      const legacy = new Dexie(name, dependencies)
      legacy.version(27).stores({
        orderLifecycles:
          "orderId, buyerPubkey, merchantPubkey, phase, createdAt",
        eventMarketRosterEvidence:
          lineage === "main"
            ? "id, marketCoordinate, cachedAt, discoveryBytes"
            : "id, marketCoordinate, cachedAt",
        ...(lineage === "adapter"
          ? {
              orderWireFormats:
                "orderId, buyerPubkey, merchantPubkey, createdAt",
            }
          : {}),
      })
      const order = {
        ...f.lifecycle,
        orderWireFormat:
          lineage === "adapter" ? ("open_markets" as const) : undefined,
      }
      const evidence = {
        id: "retained-roster",
        marketCoordinate: "synthetic-coordinate",
        cachedAt: Date.now(),
        discoveryBytes: 17,
      }
      await legacy.table("orderLifecycles").put(order)
      await legacy.table("eventMarketRosterEvidence").put(evidence)
      if (lineage === "adapter")
        await legacy.table("orderWireFormats").put({
          orderId: f.orderId,
          buyerPubkey: f.buyerPubkey,
          merchantPubkey: f.merchantPubkey,
          orderWireFormat: "open_markets",
          createdAt: f.lifecycle.createdAt,
        })
      legacy.close()
      const upgraded = new ConduitDB(name, dependencies)
      databases.push(upgraded)
      expect(await upgraded.orderLifecycles.get(f.orderId)).toEqual(order)
      expect(await upgraded.eventMarketRosterEvidence.get(evidence.id)).toEqual(
        evidence
      )
      expect(
        upgraded.eventMarketRosterEvidence.schema.indexes.some(
          (index) => index.name === "discoveryBytes"
        )
      ).toBe(true)
      expect(await upgraded.orderWireFormats.count()).toBe(
        lineage === "adapter" ? 1 : 0
      )
      expect(
        getOrderWireFormat((await upgraded.orderLifecycles.get(f.orderId))!)
      ).toBe(lineage === "adapter" ? "open_markets" : "conduit")
    }
  )

  it("encrypts a guest numeric payment report only to the declared merchant, without a guest inbox or self-copy", async () => {
    const f = fixture()
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField("Guest invoice"),
      ],
    })
    const report = {
      ...f.canonical,
      id: "",
      tags: [
        ["p", f.merchantPubkey],
        ["type", "payment_proof"],
        ["order", f.orderId],
      ],
      content: JSON.stringify({
        orderId: f.orderId,
        invoice,
        amountMsats: 200_000,
      }),
    }
    let ownInboxChecks = 0
    let reports = 0
    let selfCopies = 0
    const delivered: NDKEvent[] = []
    await publishBuyerOrderMessage(
      report,
      f.merchantPubkey,
      {
        kind: "guest_ephemeral",
        pubkey: f.buyerPubkey,
        signer: { getPublicKey: async () => f.buyerPubkey } as never,
        orderId: f.orderId,
        merchantPubkey: f.merchantPubkey,
      },
      {
        orderContext: f.lifecycle,
        shouldContinue: () => true,
        publishPrivateMessageFn: (input) =>
          publishPrivateMessage({
            ...input,
            recipientInboxRelays: ["wss://peer-inbox.conduit.market"],
            inspectOwnInboxReadiness: async () => {
              ownInboxChecks++
              return { state: "lookup_unavailable" }
            },
            giftWrapFn: (async (rumor, recipient) => {
              if (recipient.pubkey === f.buyerPubkey) selfCopies++
              reports++
              return new NDKEvent(
                undefined,
                wrapEvent(rumor, f.buyerKey, recipient.pubkey)
              )
            }) as never,
            publishFn: (async (event, options) => {
              delivered.push(event)
              return {
                successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
                failedRelayUrls: [],
              }
            }) as never,
          }),
      }
    )
    expect(ownInboxChecks).toBe(0)
    expect(selfCopies).toBe(0)
    expect(reports).toBe(1)
    const rumor = unwrapEvent(delivered[0]!.rawEvent() as never, f.merchantKey)
    expect(rumor.kind).toBe(17)
    expect(rumor.tags).toContainEqual(["payment", "lightning", invoice])
    await expect(
      publishBuyerOrderMessage(
        { ...report, id: "" },
        f.merchantPubkey,
        {
          kind: "guest_ephemeral",
          pubkey: f.buyerPubkey,
          signer: { getPublicKey: async () => f.buyerPubkey } as never,
          orderId: f.orderId,
          merchantPubkey: f.merchantPubkey,
        },
        {
          orderContext: f.lifecycle,
          shouldContinue: () => true,
          publishPrivateMessageFn: (input) =>
            publishPrivateMessage({
              ...input,
              resolveInboxRelays: async () => [],
              compatibilityOrderRoute: { enabled: true },
              publishFn: (async () => {
                throw new Error(
                  "Numeric receipt must never reach compatibility relays"
                )
              }) as never,
            }),
        }
      )
    ).rejects.toThrow()
    expect(reports).toBe(1)
  })

  it("writes the peer's order/report/chat shapes and cannot redirect the approved payload", () => {
    const f = fixture()
    const order = encodeOpenMarketsBuyerMessage(f.canonical, f.scope)
    expect(order.kind).toBe(16)
    expect(order.tags).toContainEqual(["type", "1"])
    expect(order.tags).toContainEqual([
      "item",
      f.lifecycle.items[0]!.productId,
      "1",
    ])
    expect(order.tags).toContainEqual(["amount", "200"])
    expect(order.content).toBe("Synthetic peer order")
    const prepared = createPrivateMessageRumor({ ...order, id: "" })
    for (const orderId of [
      f.orderId,
      parseOrderMessageRumorEvent(prepared).orderId,
    ]) {
      const scope = createValidatedOrderRouteScope({
        rumor: prepared,
        orderId,
        senderPubkey: f.buyerPubkey,
        recipientPubkey: f.merchantPubkey,
      })
      const input = {
        scope,
        rumor: prepared,
        senderPubkey: f.buyerPubkey,
        recipientPubkey: f.merchantPubkey,
      }
      expect(consumeValidatedOrderRouteScope(input)).toBe(true)
      expect(consumeValidatedOrderRouteScope(input)).toBe(false)
    }
    expect(() =>
      createValidatedOrderRouteScope({
        rumor: prepared,
        orderId: crypto.randomUUID(),
        senderPubkey: f.buyerPubkey,
        recipientPubkey: f.merchantPubkey,
      })
    ).toThrow()
    expect(() =>
      encodeOpenMarketsBuyerMessage(f.canonical, {
        ...f.scope,
        merchantPubkey: getPublicKey(generateSecretKey()),
      })
    ).toThrow()
    expect(() =>
      encodeOpenMarketsBuyerMessage(
        {
          ...f.canonical,
          tags: [...f.canonical.tags, ["p", f.merchantPubkey]],
        },
        f.scope
      )
    ).toThrow()
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField("Synthetic invoice"),
      ],
    })
    const report = encodeOpenMarketsBuyerMessage(
      {
        ...f.canonical,
        tags: [
          ["p", f.merchantPubkey],
          ["type", "payment_proof"],
          ["order", f.orderId],
        ],
        content: JSON.stringify({
          invoice,
          amountMsats: 200_000,
          note: "Paid externally",
        }),
      },
      f.scope
    )
    expect(report.kind).toBe(17)
    expect(report.tags).toContainEqual(["payment", "lightning", invoice])
    expect(report.tags.some((tag) => tag[0] === "conduit")).toBe(false)
    const chat = encodeOpenMarketsBuyerMessage(
      {
        ...f.canonical,
        tags: [
          ["p", f.merchantPubkey],
          ["type", "message"],
          ["order", f.orderId],
        ],
        content: JSON.stringify({ note: "Delivery question" }),
      },
      f.scope
    )
    expect(chat.kind).toBe(14)
    expect(chat.tags).toContainEqual(["subject", f.orderId])
  })

  it("projects the complete peer lifecycle only into the exact locally selected buyer order", async () => {
    const f = fixture()
    await pinOrderWireFormat(f.lifecycle, { database: f.database })
    await f.database.orderLifecycles.put(f.lifecycle)
    const signer: NostrKeySigner = {
      pubkey: f.buyerPubkey,
      authMethod: "nip07",
      getPublicKey: async () => f.buyerPubkey,
      signEvent: async (event) => finalizeEvent(event, f.buyerKey),
      encryptNip44: async (peer, text) =>
        v2.encrypt(text, v2.utils.getConversationKey(f.buyerKey, peer)),
      decryptNip44: async (peer, text) =>
        v2.decrypt(text, v2.utils.getConversationKey(f.buyerKey, peer)),
    }
    installProtectedReadSigner(signer, f.buyerPubkey, () => true)
    const authorization = getProtectedReadAuthorization(f.buyerPubkey)!
    let owner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(owner)
    const receive = async (
      rumor: Parameters<typeof wrapEvent>[0],
      key = f.merchantKey
    ) => {
      await owner.ingest(
        await admitFixture(wrapEvent(rumor, key, f.buyerPubkey)),
        ["wss://fixture.example"]
      )
      await owner.waitForDecode()
    }
    const encoded = createPrivateMessageRumor({
      ...encodeOpenMarketsBuyerMessage(f.canonical, f.scope),
      id: "",
    })
    await receive(encoded, f.buyerKey)
    expect(owner.getSnapshot().orderMessages[0]!.orderId).toBe(f.orderId)
    const now = Math.floor(Date.now() / 1000)
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      createdAt: now,
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField("Synthetic peer request"),
      ],
    })
    const peer = (
      type: string,
      extra: string[][],
      content = "Peer update"
    ) => ({
      kind: 16,
      pubkey: f.merchantPubkey,
      created_at: now + 1,
      tags: [
        ["p", f.buyerPubkey],
        ["subject", "order-info"],
        ["order", f.orderId],
        ["type", type],
        ...extra,
      ],
      content,
    })
    await receive(
      peer("2", [
        ["amount", "200"],
        ["payment", "lightning", invoice],
        ["expiration", String(now + 3600)],
      ])
    )
    await receive(peer("3", [["status", "pending"]]))
    expect(
      extractOrderSummary(owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(false)
    const report = createPrivateMessageRumor({
      ...encodeOpenMarketsBuyerMessage(
        {
          ...f.canonical,
          tags: [
            ["p", f.merchantPubkey],
            ["type", "payment_proof"],
            ["order", f.orderId],
          ],
          content: JSON.stringify({
            orderId: f.orderId,
            invoice,
            amountMsats: 200_000,
          }),
        },
        f.scope
      ),
      id: "",
    })
    await receive(report, f.buyerKey)
    expect(
      extractOrderSummary(owner.getSnapshot().orderMessages).paymentReportCount
    ).toBe(1)
    expect(
      extractOrderSummary(owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(false)
    const confirmation = createPrivateMessageRumor(
      peer("3", [["status", "confirmed"]])
    )
    const raw = parseOrderMessageRumorEvent(confirmation)
    expect(raw.type === "status_update" && raw.payload.status).toBe(
      "payment_reported"
    )
    expect(
      projectOwnedNumericOrderMessages(
        [raw],
        [f.lifecycle],
        f.merchantPubkey
      )[0]
    ).toEqual(raw)
    expect(
      projectOwnedNumericOrderMessages(
        [raw],
        [{ ...f.lifecycle, orderWireFormat: "conduit" }],
        f.buyerPubkey
      )[0]
    ).toEqual(raw)
    await receive(confirmation)
    await receive({
      kind: 14,
      pubkey: f.merchantPubkey,
      created_at: now + 2,
      tags: [
        ["p", f.buyerPubkey],
        ["subject", f.orderId],
        ["order", f.orderId],
      ],
      content: "Your parcel is ready",
    })
    await receive(
      peer("4", [
        ["status", "shipped"],
        ["carrier", "Example"],
        ["tracking", "synthetic-tracking"],
      ])
    )
    for (const status of ["processing", "delivered", "exception"]) {
      const update = createPrivateMessageRumor(peer("4", [["status", status]]))
      const raw = parseOrderMessageRumorEvent(update)
      expect(raw.type === "status_update" && raw.payload.status).toBe(
        `fulfillment_${status}_reported`
      )
      await receive(update)
    }
    await receive(peer("3", [["status", "completed"]]))
    const summary = extractOrderSummary(owner.getSnapshot().orderMessages)
    expect(summary.paymentConfirmed).toBe(true)
    expect(summary.shippingUpdateReceived).toBe(true)
    expect(
      owner
        .getSnapshot()
        .orderMessages.some(
          (message) =>
            message.type === "message" && message.orderId === f.orderId
        )
    ).toBe(true)
    expect(
      owner
        .getSnapshot()
        .orderMessages.every((message) => message.orderId === f.orderId)
    ).toBe(true)
    owner.stop()
    owner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(owner)
    await owner.initialize()
    await owner.waitForDecode()
    expect(
      extractOrderSummary(owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(true)
    expect(
      owner
        .getSnapshot()
        .orderMessages.every((message) => message.orderId === f.orderId)
    ).toBe(true)
  })

  it("recovers peer conversation from the saved numeric order when its outgoing history copy is missing", async () => {
    const f = fixture()
    await pinOrderWireFormat(f.lifecycle, { database: f.database })
    await f.database.orderLifecycles.put(f.lifecycle)
    const signer: NostrKeySigner = {
      pubkey: f.buyerPubkey,
      authMethod: "nip07",
      getPublicKey: async () => f.buyerPubkey,
      signEvent: async (event) => finalizeEvent(event, f.buyerKey),
      encryptNip44: async (peer, text) =>
        v2.encrypt(text, v2.utils.getConversationKey(f.buyerKey, peer)),
      decryptNip44: async (peer, text) =>
        v2.decrypt(text, v2.utils.getConversationKey(f.buyerKey, peer)),
    }
    installProtectedReadSigner(signer, f.buyerPubkey, () => true)
    const authorization = getProtectedReadAuthorization(f.buyerPubkey)!
    let owner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(owner)
    for (const key of [f.merchantKey, generateSecretKey()]) {
      const rumor = {
        kind: 14,
        pubkey: getPublicKey(key),
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", f.buyerPubkey],
          ["subject", f.orderId],
          ["order", f.orderId],
        ],
        content: "Synthetic recovery conversation",
      }
      await owner.ingest(
        await admitFixture(wrapEvent(rumor, key, f.buyerPubkey)),
        ["wss://fixture.example"]
      )
      await owner.waitForDecode()
    }
    expect(owner.getSnapshot().directMessages.length).toBe(2)
    expect(owner.getSnapshot().orderMessages.length).toBe(1)
    expect(
      owner
        .getSnapshot()
        .orderMessages.every(
          (message) =>
            message.type === "message" &&
            message.orderId === f.orderId &&
            message.senderPubkey === f.merchantPubkey
        )
    ).toBe(true)
    owner.stop()
    owner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(owner)
    await owner.initialize()
    await owner.waitForDecode()
    expect(owner.getSnapshot().orderMessages.length).toBe(1)
    expect(owner.getSnapshot().orderMessages[0]?.orderId === f.orderId).toBe(
      true
    )
  })
})
