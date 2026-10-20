import * as messaging from "../packages/core/src/protocol/messaging"
import * as commerce from "../packages/core/src/protocol/commerce"
import * as commerceInbox from "../packages/core/src/protocol/commerce-inbox"
import { publishMerchantOrderMessage } from "../packages/core/src/protocol/merchant-order-publish"
import {
  createDefaultMerchantInvoiceModule,
  DexieMerchantPendingInvoiceStore,
  loadMerchantInvoiceReceivingAuthority,
  type MerchantPendingInvoice,
} from "../apps/merchant/src/lib/merchant-invoice"
import { encodeOpenMarketsBuyerMessage } from "../packages/core/src/protocol/commerce-wire"
import { createPrivateMessageRumor } from "../packages/core/src/protocol/private-message-primitives"
import { openMarketsLocalOrderId } from "../packages/core/src/protocol/open-markets-orders"
import {
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { getEventHash, generateSecretKey, getPublicKey } from "nostr-tools"
import { wrapEvent } from "nostr-tools/nip59"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import {
  CommerceInboxStore,
  INBOX_DECODE_RULES_VERSION,
} from "../packages/core/src/protocol/commerce-inbox-store"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  setTestAccountSigner,
  removeTestAccountSigner,
} from "./helpers/plain-signer"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildMerchantOrderRumorTags,
  cachePublishedMerchantOrderMessage,
  EVENT_KINDS,
  getMerchantOrderPublishTarget,
  type ParsedOrderMessage,
} from "@conduit/core"

const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
const leases: Array<ReturnType<typeof setTestAccountSigner>> = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const lease of leases.splice(0)) removeTestAccountSigner(lease)
  for (const database of databases.splice(0)) await database.delete()
})

async function createMerchantOwner(signer = NDKPrivateKeySigner.generate()) {
  const lease = setTestAccountSigner(signer)
  leases.push(lease)
  const pubkey = (await signer.user()).pubkey
  installProtectedReadSigner(lease, pubkey, () => true)
  const authorization = getProtectedReadAuthorization(pubkey)!
  const database = new ConduitDB(`merchant-send-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const owner = new CommerceInbox(
    authorization,
    lease,
    new CommerceInboxStore(authorization, database)
  )
  owners.push(owner)
  return { signer, lease, pubkey, owner, database, authorization }
}

function statusInput(merchantPubkey: string) {
  return {
    merchantPubkey,
    buyerPubkey: "b".repeat(64),
    orderId: "merchant-accepted-order",
    type: "status_update" as const,
    tags: [["status", "accepted"]],
    payload: { status: "accepted", note: "private-accepted-note" },
    delivery: "buyer_and_self" as const,
  }
}

describe("merchant order publish", () => {
  it.each(["named_history", "pending_invoice", "paid_checkpoint"])(
    "preserves installed numeric extension order recovery through %s",
    async (evidence) => {
      const account = await createMerchantOwner()
      const buyer = generateSecretKey()
      const buyerPubkey = getPublicKey(buyer)
      const wireOrderId = "installed-numeric-order"
      const now = Math.floor(Date.now() / 1000)
      const amountMsats = 200_000
      const invoice = makeBolt11Fixture({
        hrp: "lnbc2000n",
        createdAt: now,
        fields: [bolt11PaymentHashField()],
      })
      const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
        account.owner
      )
      const rumors: messaging.PrivateMessageEvent[] = []
      const publish = spyOn(
        messaging,
        "publishPrivateMessage"
      ).mockImplementation(async (input) => {
        rumors.push(structuredClone(input.rumor))
        await input.onRecipientAccepted?.({
          successfulRelayUrls: ["wss://fixture.example"],
        } as never)
        return { selfCopyError: null, deliveryRoute: "declared_inbox" } as never
      })
      const confirmation = {
        ...statusInput(account.pubkey),
        buyerPubkey,
        orderId: wireOrderId,
        payload: { status: "paid" },
        tags: [["status", "paid"]],
        authenticatedPubkey: account.pubkey,
        paidInvoiceConfirmation: { invoice, amountMsats },
      }
      try {
        if (evidence === "paid_checkpoint")
          await publishMerchantOrderMessage(confirmation)
        const initial = createPrivateMessageRumor({
          kind: 16,
          pubkey: buyerPubkey,
          created_at: now,
          tags: [
            ["p", account.pubkey],
            ["type", "order"],
            ["order", wireOrderId],
            ["amount", "200"],
            ["currency", "SATS"],
          ],
          content: JSON.stringify({
            id: wireOrderId,
            buyerPubkey,
            merchantPubkey: account.pubkey,
            buyerIdentityKind: "signed_in",
            items: [
              {
                productId: `30402:${account.pubkey}:book`,
                format: "digital",
                quantity: 1,
                priceAtPurchase: 200,
                currency: "SATS",
              },
            ],
            subtotal: 200,
            currency: "SATS",
            createdAt: now * 1000,
          }),
        })
        const numeric = encodeOpenMarketsBuyerMessage(initial, {
          buyerPubkey,
          merchantPubkey: account.pubkey,
          orderId: wireOrderId,
        })
        await account.owner.ingest(
          wrapEvent(
            createPrivateMessageRumor({
              ...numeric,
              id: "",
              tags: numeric.tags.map((tag) =>
                tag[0] === "p" ? [...tag, "wss://peer-hint.example"] : tag
              ),
            }),
            buyer,
            account.pubkey
          )
        )
        if (evidence === "named_history") {
          for (const [type, payload] of [
            ["payment_request", { invoice, amount: 200, currency: "SATS" }],
            ["status_update", { status: "paid" }],
            [
              "shipping_update",
              {
                trackingNumber: "synthetic-installed-tracking",
                carrier: "Example",
              },
            ],
          ] as const) {
            await account.owner.ingest(
              wrapEvent(
                {
                  kind: 16,
                  pubkey: account.pubkey,
                  created_at: now + 1,
                  tags: [
                    ["p", buyerPubkey],
                    ["order", wireOrderId],
                    ["type", type],
                  ],
                  content: JSON.stringify(payload),
                },
                Buffer.from(account.signer.privateKey!, "hex"),
                account.pubkey
              )
            )
          }
        }
        const pending: MerchantPendingInvoice = {
          id: `${account.pubkey}:${wireOrderId}`,
          merchantPubkey: account.pubkey,
          buyerPubkey,
          orderId: wireOrderId,
          invoice,
          invoiceExpiresAt: now + 3600,
          amountMsats,
          delivery: "buyer_and_self",
          source: "wallet",
          receivingWallet: {
            walletId: "installed-wallet",
            providerId: "spark",
            network: "mainnet",
            requestId: "installed-invoice",
          },
          deliveryState: "pending",
          updatedAt: now * 1000,
        }
        if (evidence === "pending_invoice")
          await account.database.merchantPendingInvoices.put(pending)
        await account.owner.waitForDecode()
        const alias = openMarketsLocalOrderId(
          wireOrderId,
          buyerPubkey,
          account.pubkey
        )
        if (evidence === "named_history") {
          expect(
            account.owner
              .getSnapshot()
              .orderMessages.filter((m) => m.type !== "order")
          ).toHaveLength(3)
          expect(
            new Set(
              account.owner.getSnapshot().orderMessages.map((m) => m.orderId)
            ).size
          ).toBe(1)
        }
        const store = new DexieMerchantPendingInvoiceStore(
          account.database.merchantPendingInvoices
        )
        if (evidence === "pending_invoice") {
          expect(await store.get(account.pubkey, alias)).toEqual(pending)
          expect(
            await store.get(
              account.pubkey,
              openMarketsLocalOrderId(
                wireOrderId,
                "c".repeat(64),
                account.pubkey
              )
            )
          ).toBeNull()
          const authority = {
            merchantPubkey: account.pubkey,
            buyerPubkey,
            orderId: alias,
            invoice,
            amountMsats,
          }
          expect(
            await loadMerchantInvoiceReceivingAuthority(authority, store)
          ).toEqual(pending.receivingWallet)
          expect(
            await loadMerchantInvoiceReceivingAuthority(
              { ...authority, buyerPubkey: "c".repeat(64) },
              store
            )
          ).toBeNull()
          const module = createDefaultMerchantInvoiceModule(store)
          expect(
            (
              await module.getStatus({
                merchantPubkey: account.pubkey,
                buyerPubkey,
                orderId: alias,
              })
            ).state
          ).toBe("pending")
          await expect(
            module.createAndDeliver({
              merchantPubkey: account.pubkey,
              buyerPubkey,
              orderId: alias,
              amountSats: 200,
              delivery: "buyer_and_self",
              source: { type: "manual", invoice },
            })
          ).rejects.toThrow(/saved invoice still needs delivery/i)
          await module.retryDelivery({
            merchantPubkey: account.pubkey,
            buyerPubkey,
            orderId: alias,
            authenticatedPubkey: account.pubkey,
          })
          expect(rumors.at(-1)?.tags).toContainEqual([
            "type",
            "payment_request",
          ])
          expect(rumors.at(-1)?.tags).toContainEqual(["order", wireOrderId])
        }
        const originals = JSON.stringify(
          (await account.database.commerceInboxWrappers.toArray()).map(
            (row) => row.event
          )
        )
        await account.database.commerceInboxWrappers
          .toCollection()
          .modify({ rulesVersion: 5 })
        account.owner.stop()
        const reloaded = new CommerceInbox(
          account.authorization,
          account.lease,
          new CommerceInboxStore(account.authorization, account.database)
        )
        owners.push(reloaded)
        await reloaded.initialize()
        await reloaded.waitForDecode()
        expect(
          JSON.stringify(
            (await account.database.commerceInboxWrappers.toArray()).map(
              (row) => row.event
            )
          )
        ).toBe(originals)
        expect(
          (await account.database.commerceInboxWrappers.toArray()).every(
            (row) => row.rulesVersion === INBOX_DECODE_RULES_VERSION
          )
        ).toBe(true)
        getOwner.mockReturnValue(reloaded)
        await publishMerchantOrderMessage({ ...confirmation, orderId: alias })
        const selected = rumors.at(-1)!
        expect(selected.tags).toContainEqual(["type", "status_update"])
        expect(selected.tags).toContainEqual(["order", wireOrderId])
        expect(selected.tags.some((tag) => tag[0] === "conduit")).toBe(false)
        if (evidence === "paid_checkpoint") expect(selected).toEqual(rumors[0])
        expect(
          await account.database.commerceInboxDeliveries
            .filter((row) => row.kind === "merchant_paid_confirmation")
            .count()
        ).toBe(1)
        if (evidence === "pending_invoice") {
          expect(
            await account.database.merchantPendingInvoices.get(pending.id)
          ).toMatchObject({
            id: pending.id,
            orderId: wireOrderId,
            invoice,
            receivingWallet: pending.receivingWallet,
            deliveryState: "sent",
          })
          await store.delete(account.pubkey, alias)
          expect(await account.database.merchantPendingInvoices.count()).toBe(0)
        }
      } finally {
        publish.mockRestore()
        getOwner.mockRestore()
      }
    }
  )

  it("selects numeric replies from the retained order and reuses one paid confirmation after reload", async () => {
    const account = await createMerchantOwner()
    const buyer = generateSecretKey()
    const buyerPubkey = getPublicKey(buyer)
    await account.owner.ingest(
      wrapEvent(
        {
          kind: 16,
          pubkey: buyerPubkey,
          created_at: 1_800_000_000,
          tags: [
            ["p", account.pubkey],
            ["subject", "Order"],
            ["type", "1"],
            ["order", "peer-order"],
            ["amount", "200"],
            ["item", `30402:${account.pubkey}:book`, "1"],
          ],
          content: "Please confirm delivery",
        },
        buyer,
        account.pubkey
      )
    )
    const snapshot = await account.owner.waitForDecode()
    const orderId = snapshot.orderMessages[0]!.orderId
    const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
      account.owner
    )
    const rumors: messaging.PrivateMessageEvent[] = []
    const publish = spyOn(
      messaging,
      "publishPrivateMessage"
    ).mockImplementation(async (input) => {
      rumors.push(structuredClone(input.rumor))
      await input.onRecipientAccepted?.({
        successfulRelayUrls: ["wss://fixture.example"],
      } as never)
      return { selfCopyError: null, deliveryRoute: "declared_inbox" } as never
    })
    try {
      const input = {
        ...statusInput(account.pubkey),
        buyerPubkey,
        orderId,
        payload: { status: "paid" },
        tags: [["status", "paid"]],
        authenticatedPubkey: account.pubkey,
        paidInvoiceConfirmation: {
          invoice: "synthetic-checkpoint-invoice",
          amountMsats: 200_000,
        },
      }
      await publishMerchantOrderMessage(input)
      account.owner.stop()
      const reloaded = new CommerceInbox(
        account.authorization,
        account.lease,
        new CommerceInboxStore(account.authorization, account.database)
      )
      owners.push(reloaded)
      await reloaded.initialize()
      getOwner.mockReturnValue(reloaded)
      await publishMerchantOrderMessage(input)
      expect(rumors.length).toBe(2)
      expect(rumors[0]!.id === rumors[1]!.id).toBe(true)
      expect(
        rumors[0]!.tags.some((tag) => tag[0] === "type" && tag[1] === "3")
      ).toBe(true)
      expect(
        rumors[0]!.tags.some(
          (tag) => tag[0] === "status" && tag[1] === "confirmed"
        )
      ).toBe(true)
      expect(
        rumors[0]!.tags.some(
          (tag) => tag[0] === "order" && tag[1] === "peer-order"
        )
      ).toBe(true)
      expect(
        reloaded
          .getSnapshot()
          .orderMessages.filter((message) => message.type === "status_update")
          .length
      ).toBe(1)
    } finally {
      publish.mockRestore()
      getOwner.mockRestore()
    }
  })

  it.each(["current", "revoked", "same_principal", "replaced"] as const)(
    "retains accepted numeric Merchant notes in both views with a %s session",
    async (change) => {
      const account = await createMerchantOwner()
      const buyer = generateSecretKey()
      const buyerPubkey = getPublicKey(buyer)
      await account.owner.ingest(
        wrapEvent(
          {
            kind: 16,
            pubkey: buyerPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", account.pubkey],
              ["subject", "Order"],
              ["type", "1"],
              ["order", "merchant-note-order"],
              ["amount", "200"],
              ["item", `30402:${account.pubkey}:book`, "1"],
            ],
            content: "Synthetic retained order",
          },
          buyer,
          account.pubkey
        )
      )
      const snapshot = await account.owner.waitForDecode()
      const orderId = snapshot.orderMessages[0]!.orderId
      const note = "Synthetic accepted numeric Merchant note"
      const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
        account.owner
      )
      let replacement: Awaited<ReturnType<typeof createMerchantOwner>> | null =
        null
      let sends = 0
      const publish = spyOn(
        messaging,
        "publishPrivateMessage"
      ).mockImplementation(async (input) => {
        sends++
        expect(input.rumor.kind).toBe(14)
        expect(input.recipientPubkey).toBe(buyerPubkey)
        expect(input.rumor.tags).toContainEqual([
          "subject",
          "merchant-note-order",
        ])
        if (change === "revoked") __resetProtectedReadSigner()
        else if (change !== "current")
          replacement = await createMerchantOwner(
            change === "same_principal"
              ? account.signer
              : NDKPrivateKeySigner.generate()
          )
        await input.onRecipientAccepted?.({
          successfulRelayUrls: ["wss://fixture.example"],
        } as never)
        return {
          deliveryRoute: "declared_inbox",
          selfDeliveryStatus: "failed",
          selfCopyError: "Synthetic self-copy refusal",
        } as never
      })
      const warning = spyOn(console, "warn").mockImplementation(() => {})
      try {
        const result = await publishMerchantOrderMessage({
          ...statusInput(account.pubkey),
          buyerPubkey,
          orderId,
          type: "message",
          tags: [],
          payload: { note },
          authenticatedPubkey: account.pubkey,
        })
        expect(sends).toBe(1)
        expect(getOwner).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
          recipient: "accepted",
          selfCopy: "pending",
          localHistory: change === "current" ? "saved" : "unavailable",
        })
        if (change !== "current") {
          expect(result.checkpointFailure).toBe(true)
          expect(account.owner.getSnapshot().directMessages).toHaveLength(0)
          if (replacement)
            expect(
              await replacement.database.commerceInboxRecords.count()
            ).toBe(0)
          return
        }
        const assertViews = (owner: CommerceInbox) => {
          expect(
            owner
              .getSnapshot()
              .directMessages.filter(
                (message) =>
                  message.senderPubkey === account.pubkey &&
                  message.content === note
              )
          ).toHaveLength(1)
          expect(
            owner
              .getSnapshot()
              .orderMessages.filter(
                (message) =>
                  message.type === "message" &&
                  message.orderId === orderId &&
                  message.payload.note === note
              )
          ).toHaveLength(1)
        }
        assertViews(account.owner)
        const projections = await account.owner.store.projections()
        expect(
          projections.filter(({ projection }) => projection.kind === "direct")
        ).toHaveLength(1)
        expect(
          projections.filter(
            ({ projection }) =>
              projection.kind === "order" &&
              projection.message.type === "message"
          )
        ).toHaveLength(0)
        expect(
          JSON.stringify(await account.database.commerceInboxRecords.toArray())
        ).not.toContain(note)
        account.owner.stop()
        const reloaded = new CommerceInbox(
          account.authorization,
          account.lease,
          new CommerceInboxStore(account.authorization, account.database)
        )
        owners.push(reloaded)
        await reloaded.initialize()
        assertViews(reloaded)
        expect(sends).toBe(1)
      } finally {
        warning.mockRestore()
        publish.mockRestore()
        getOwner.mockRestore()
      }
    }
  )

  it("targets the merchant for a guest-only operational record", () => {
    const rumor = new NDKEvent()
    rumor.id = "guest-status-rumor"
    rumor.created_at = 100
    rumor.kind = EVENT_KINDS.ORDER
    rumor.pubkey = "merchant"
    rumor.tags = buildMerchantOrderRumorTags({
      buyerPubkey: "guest",
      orderId: "guest-order",
      type: "status_update",
      tags: [["status", "paid"]],
    })
    rumor.content = JSON.stringify({ status: "paid" })

    const target = getMerchantOrderPublishTarget(
      {
        merchantPubkey: "merchant",
        buyerPubkey: "guest",
        orderId: "guest-order",
        delivery: "self_only",
      },
      rumor
    )

    expect(rumor.tags).toContainEqual(["p", "guest"])
    expect(target.recipientPubkey).toBe("merchant")
    expect(target.selfCopy).toBe(false)
  })

  it("does not turn a post-delivery cache failure into a publish retry", async () => {
    const message = {} as ParsedOrderMessage
    const owner = {} as CommerceInbox
    const warning = spyOn(console, "warn").mockImplementation(() => {})

    expect(
      await cachePublishedMerchantOrderMessage(message, owner, async () => {})
    ).toBe(true)
    expect(
      await cachePublishedMerchantOrderMessage(message, owner, async () => {
        throw new Error("storage unavailable")
      })
    ).toBe(false)
    expect(warning).toHaveBeenCalledTimes(1)
    warning.mockRestore()
  })

  it("saves encrypted sender history at recipient ACK before a held and refused self-copy", async () => {
    const account = await createMerchantOwner()
    const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
      account.owner
    )
    let releaseSelf!: () => void
    let signalAccepted!: () => void
    const selfGate = new Promise<void>((resolve) => {
      releaseSelf = resolve
    })
    const accepted = new Promise<void>((resolve) => {
      signalAccepted = resolve
    })
    let recipientSends = 0
    let deliveryBoundary = 0
    const publish = spyOn(
      messaging,
      "publishPrivateMessage"
    ).mockImplementation(async (input) => {
      await input.onRecipientDeliveryStarting?.()
      recipientSends += 1
      await input.onRecipientAccepted?.({
        successfulRelayUrls: ["wss://merchant-send.example"],
      } as never)
      signalAccepted()
      await selfGate
      return {
        deliveryRoute: "declared_inbox",
        selfDeliveryStatus: "failed",
        selfCopyError: "self signing refused",
      } as never
    })
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const sending = publishMerchantOrderMessage({
        ...statusInput(account.pubkey),
        onRecipientDeliveryStarting: () => {
          deliveryBoundary++
        },
      })
      await accepted
      expect(await account.database.commerceInboxRecords.count()).toBe(1)
      releaseSelf()
      const result = await sending
      expect(recipientSends).toBe(1)
      expect(deliveryBoundary).toBe(1)
      expect(result).toMatchObject({
        recipient: "accepted",
        selfCopy: "pending",
        localHistory: "saved",
      })
      const records = await account.database.commerceInboxRecords.toArray()
      expect(JSON.stringify(records)).not.toContain("private-accepted-note")

      const reloaded = new CommerceInbox(
        account.authorization,
        account.lease,
        new CommerceInboxStore(account.authorization, account.database)
      )
      owners.push(reloaded)
      await reloaded.initialize()
      expect(reloaded.getSnapshot().orderMessages).toHaveLength(1)
      expect(reloaded.getSnapshot().orderMessages[0]?.payload).toMatchObject({
        status: "accepted",
        note: "private-accepted-note",
      })
    } finally {
      releaseSelf()
      warning.mockRestore()
      publish.mockRestore()
      getOwner.mockRestore()
    }
  })

  it("recognizes a saved encrypted invoice after its sent-state checkpoint fails", async () => {
    const account = await createMerchantOwner()
    const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
      account.owner
    )
    const publish = spyOn(
      messaging,
      "publishPrivateMessage"
    ).mockImplementation(async (input) => {
      await input.onRecipientAccepted?.({
        successfulRelayUrls: ["wss://merchant-send.example"],
      } as never)
      return {
        deliveryRoute: "declared_inbox",
        selfDeliveryStatus: "full_success",
      } as never
    })
    const invoice = "invoice-reference"
    try {
      await publishMerchantOrderMessage({
        ...statusInput(account.pubkey),
        type: "payment_request",
        tags: [],
        payload: { invoice, amount: 21, currency: "SATS" },
      })
      const saved: MerchantPendingInvoice = {
        id: `${account.pubkey}:merchant-accepted-order`,
        merchantPubkey: account.pubkey,
        buyerPubkey: "b".repeat(64),
        orderId: "merchant-accepted-order",
        invoice,
        amountMsats: 21_000,
        delivery: "buyer_and_self",
        source: "manual",
        invoiceExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        deliveryState: "pending",
        deliveryAttempted: true,
        updatedAt: Date.now(),
      }
      const module = createDefaultMerchantInvoiceModule({
        get: async () => saved,
        put: async () => {},
        delete: async () => {},
      })
      expect(
        await module.getStatus({
          merchantPubkey: account.pubkey,
          buyerPubkey: saved.buyerPubkey,
          orderId: saved.orderId,
        })
      ).toEqual({ state: "accepted_unrecorded" })
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      publish.mockRestore()
      getOwner.mockRestore()
    }
  })

  it.each(["revoked", "same_principal", "replaced"] as const)(
    "keeps one accepted recipient send after %s before local checkpoint",
    async (change) => {
      const account = await createMerchantOwner()
      let currentOwner = account.owner
      const getOwner = spyOn(
        commerceInbox,
        "getCommerceInbox"
      ).mockImplementation(() => currentOwner)
      let replacement: Awaited<ReturnType<typeof createMerchantOwner>> | null =
        null
      let recipientSends = 0
      const publish = spyOn(
        messaging,
        "publishPrivateMessage"
      ).mockImplementation(async (input) => {
        recipientSends += 1
        if (change === "revoked") __resetProtectedReadSigner()
        else {
          replacement = await createMerchantOwner(
            change === "same_principal"
              ? account.signer
              : NDKPrivateKeySigner.generate()
          )
          currentOwner = replacement.owner
        }
        await input.onRecipientAccepted?.({
          successfulRelayUrls: ["wss://merchant-send.example"],
        } as never)
        return {
          deliveryRoute: "declared_inbox",
          selfDeliveryStatus: "full_success",
          selfCopyError: null,
        } as never
      })
      try {
        const result = await publishMerchantOrderMessage(
          statusInput(account.pubkey)
        )
        expect(recipientSends).toBe(1)
        expect(getOwner).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
          recipient: "accepted",
          localHistory: "unavailable",
          checkpointFailure: true,
        })
        expect(await account.database.commerceInboxRecords.count()).toBe(0)
        const replacementAccount = replacement as Awaited<
          ReturnType<typeof createMerchantOwner>
        > | null
        if (replacementAccount)
          expect(
            await replacementAccount.database.commerceInboxRecords.count()
          ).toBe(0)
      } finally {
        publish.mockRestore()
        getOwner.mockRestore()
      }
    }
  )
})

it.each([
  {
    type: "payment_request" as const,
    payload: { invoice: "synthetic-invoice", amount: 200, currency: "SATS" },
  },
  { type: "status_update" as const, payload: { status: "confirmed" } },
  {
    type: "shipping_update" as const,
    payload: { carrier: "synthetic", trackingNumber: "synthetic-tracking" },
  },
])(
  "publishes merchant $type with the deployed named grammar",
  async ({ type, payload }) => {
    const merchantSigner = NDKPrivateKeySigner.generate()
    const lease = setTestAccountSigner(merchantSigner)
    const pubkey = (await merchantSigner.user()).pubkey
    const cache = spyOn(commerce, "cacheParsedOrderMessage").mockResolvedValue()
    const owner = {} as CommerceInbox
    const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
      owner
    )
    const publish = spyOn(
      messaging,
      "publishPrivateMessage"
    ).mockImplementation(async ({ rumor }) => {
      expect(rumor.tags.find((tag) => tag[0] === "type")?.[1]).toBe(type)
      expect(rumor.tags.some((tag) => tag[0] === "conduit")).toBe(false)
      expect(JSON.parse(rumor.content)).toMatchObject(payload)
      expect(rumor.id).toBe(
        getEventHash({ ...rumor, kind: 16, created_at: rumor.created_at! })
      )
      return { selfCopyError: null, deliveryRoute: "declared_inbox" } as never
    })
    try {
      const result = await publishMerchantOrderMessage({
        merchantPubkey: pubkey,
        buyerPubkey: "b".repeat(64),
        orderId: "legacy-order",
        ...{ wireOrderId: "caller-metadata-cannot-select-a-writer" },
        type,
        payload,
        delivery: "buyer_and_self",
      })
      expect(publish).toHaveBeenCalledTimes(1)
      expect(cache).toHaveBeenCalledTimes(1)
      expect(cache).toHaveBeenCalledWith(expect.anything(), owner)
      expect(result.localHistory).toBe("saved")
    } finally {
      publish.mockRestore()
      cache.mockRestore()
      getOwner.mockRestore()
      removeTestAccountSigner(lease)
    }
  }
)

it("retries the original inventory acceptance rumor after an interrupted notification", async () => {
  const account = await createMerchantOwner()
  const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockReturnValue(
    account.owner
  )
  const captured: string[] = []
  const acceptedAt = Date.now() - 60_000
  const publish = spyOn(messaging, "publishPrivateMessage").mockImplementation(
    async (input) => {
      captured.push(JSON.stringify(input.rumor))
      if (captured.length === 1)
        throw new Error("Recipient delivery interrupted")
      await input.onRecipientAccepted?.({
        successfulRelayUrls: ["wss://merchant-send.example"],
      } as never)
      return {
        deliveryRoute: "declared_inbox",
        selfDeliveryStatus: "full_success",
      } as never
    }
  )
  const input = {
    ...statusInput(account.pubkey),
    inventoryAcceptanceAt: acceptedAt,
  }
  let clock: ReturnType<typeof spyOn> | undefined
  try {
    await expect(publishMerchantOrderMessage(input)).rejects.toThrow(
      "Recipient delivery interrupted"
    )
    clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    await publishMerchantOrderMessage(input)
    expect(captured.length).toBe(2)
    expect(captured[0] === captured[1]).toBe(true)
    const rumor = JSON.parse(captured[1]!)
    expect(rumor.created_at).toBe(Math.floor(acceptedAt / 1000))
    expect(JSON.parse(rumor.content).createdAt).toBe(acceptedAt)
    await expect(
      publishMerchantOrderMessage({ ...input, payload: { status: "paid" } })
    ).rejects.toThrow("Invalid inventory acceptance notification")
  } finally {
    clock?.mockRestore()
    publish.mockRestore()
    getOwner.mockRestore()
  }
})
