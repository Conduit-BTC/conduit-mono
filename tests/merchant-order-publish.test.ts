import * as messaging from "../packages/core/src/protocol/messaging"
import * as commerce from "../packages/core/src/protocol/commerce"
import * as commerceInbox from "../packages/core/src/protocol/commerce-inbox"
import { publishMerchantOrderMessage } from "../packages/core/src/protocol/merchant-order-publish"
import {
  createDefaultMerchantInvoiceModule,
  type MerchantPendingInvoice,
} from "../apps/merchant/src/lib/merchant-invoice"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { getEventHash } from "nostr-tools"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
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
