import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  getProfiles,
  type CachedProfile,
  type OrderLifecycle,
} from "@conduit/core"
import {
  createDefaultMerchantInvoiceModule,
  type MerchantPendingInvoice,
  type MerchantPendingInvoiceStore,
} from "../apps/merchant/src/lib/merchant-invoice"
import { checkOrderPaymentAddressUpdate } from "../apps/market/src/lib/order-payment-address"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const originalFetch = globalThis.fetch
const signedProfile = (content: string, created_at: number) =>
  new NDKEvent(
    undefined,
    finalizeEvent({ kind: 0, content, created_at, tags: [] }, secret)
  )

function scenario() {
  const old = signedProfile(
    JSON.stringify({ name: "Synthetic merchant", lud16: "old@pay.lnurl.io" }),
    10
  )
  const durable = new Map<string, CachedProfile>([
    [
      merchant,
      {
        pubkey: merchant,
        name: "Synthetic merchant",
        lud16: "old@pay.lnurl.io",
        rawContent: old.content,
        eventId: old.id,
        eventCreatedAt: 10,
        cachedAt: 1,
      },
    ],
  ])
  let events: NDKEvent[] = []
  let failWrites = true
  let failReads = false
  let failNetwork = false
  __setRelayListTestOverrides({
    fetchEventsFanout: async () => [],
    loadCached: async () => undefined,
    putCached: async () => {},
  })
  __setCommerceTestOverrides({
    getCachedProducts: async () => [],
    getCachedProfiles: async (keys) => {
      if (failReads) throw new Error("Synthetic read failure")
      return keys.map((key) => durable.get(key))
    },
    putCachedProfiles: async (rows) => {
      if (failWrites) throw new Error("Synthetic storage failure")
      rows.forEach((row) => durable.set(row.pubkey, row))
    },
    fetchEventsFanoutWithDiagnostics: async () => {
      if (failNetwork) throw new Error("Synthetic network failure")
      return {
        events,
        attemptedRelayUrls: ["wss://relay.damus.io"],
        successfulRelayUrls: ["wss://relay.damus.io"],
        failedRelayUrls: [],
        cappedRelayUrls: [],
      }
    },
  })
  return {
    durable,
    observe(content: string, timestamp: number) {
      events = [signedProfile(content, timestamp)]
    },
    omit() {
      events = []
    },
    failStorageReads() {
      failReads = true
    },
    failNetwork() {
      failNetwork = true
    },
    repairStorage() {
      failWrites = false
    },
    refresh() {
      return getProfiles({
        pubkeys: [merchant],
        skipCache: true,
        requireCompleteEvidence: true,
        evidenceScope: "payment",
      })
    },
  }
}

function memoryInvoices(): MerchantPendingInvoiceStore {
  const rows = new Map<string, MerchantPendingInvoice>()
  return {
    get: async (pubkey, orderId) => rows.get(`${pubkey}:${orderId}`) ?? null,
    put: async (row) => {
      rows.set(`${row.merchantPubkey}:${row.orderId}`, row)
    },
    delete: async (pubkey, orderId) => {
      rows.delete(`${pubkey}:${orderId}`)
    },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("selected profile authority across consequential callers", () => {
  it("does not turn unreadable retained authority into ordinary outage recovery", async () => {
    const fixture = scenario()
    fixture.repairStorage()
    fixture.observe(JSON.stringify({ name: "Synthetic merchant" }), 20)
    await fixture.refresh()
    fixture.omit()
    fixture.failStorageReads()
    const lifecycle = {
      orderId: "synthetic-storage-read",
      merchantPubkey: merchant,
      merchantLightningAddress: "old@pay.lnurl.io",
      checkoutMode: "external_wallet",
      paymentStatus: "failed",
      invoiceStatus: "failed",
      orderDeliveryStatus: "sent",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "not_applicable",
      phase: "in_progress",
      updatedAt: 1,
      invoice: "synthetic-retained-invoice",
    } as OrderLifecycle
    for (const networkFails of [false, true]) {
      if (networkFails) fixture.failNetwork()
      await expect(
        checkOrderPaymentAddressUpdate(lifecycle, {})
      ).rejects.toThrow("Saved profile authority is unavailable")
      expect(lifecycle.invoice).toBe("synthetic-retained-invoice")
    }
  })

  for (const [name, content] of [
    ["removed", JSON.stringify({ name: "Synthetic merchant" })],
    ["malformed", "invalid-json"],
  ]) {
    it(`keeps ${name} session evidence authoritative for default merchant invoice creation, then recovers`, async () => {
      const fixture = scenario()
      const providerUrls: string[] = []
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        providerUrls.push(String(input))
        throw new Error("Synthetic provider boundary reached")
      }) as typeof fetch
      fixture.observe(content!, 20)
      await fixture.refresh()
      fixture.omit()
      await fixture.refresh()
      expect(fixture.durable.get(merchant)?.eventCreatedAt).toBe(10)
      const invoice = createDefaultMerchantInvoiceModule(memoryInvoices())
      const input = {
        merchantPubkey: merchant,
        buyerPubkey: "b".repeat(64),
        orderId: `synthetic-${name}`,
        amountSats: 50,
        delivery: "buyer_and_self" as const,
        source: { type: "profile_lud16" as const },
      }
      await expect(invoice.createAndDeliver(input)).rejects.toThrow(
        "A valid profile Lightning address is required"
      )
      expect(providerUrls).toEqual([])
      fixture.observe(
        JSON.stringify({ name: "Corrected", lud16: "new@pay.lnurl.io" }),
        30
      )
      fixture.repairStorage()
      await fixture.refresh()
      await expect(invoice.createAndDeliver(input)).rejects.toThrow(
        "Synthetic provider boundary reached"
      )
      expect(providerUrls).toHaveLength(1)
      expect(providerUrls[0]).toContain("/.well-known/lnurlp/new")
      expect(fixture.durable.get(merchant)?.eventCreatedAt).toBe(30)
    })

    it(`keeps ${name} session evidence authoritative for retained-invoice retry, then permits review of a correction`, async () => {
      const fixture = scenario()
      fixture.observe(content!, 20)
      await fixture.refresh()
      fixture.omit()
      const lifecycle = {
        orderId: "synthetic-retained",
        merchantPubkey: merchant,
        merchantLightningAddress: "old@pay.lnurl.io",
        checkoutMode: "external_wallet",
        paymentStatus: "failed",
        invoiceStatus: "failed",
        orderDeliveryStatus: "sent",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        phase: "in_progress",
        updatedAt: 1,
        invoice: "synthetic-retained-invoice",
      } as OrderLifecycle
      const before = structuredClone(lifecycle)
      expect(await checkOrderPaymentAddressUpdate(lifecycle, {})).toEqual({
        status: "current_address_unusable",
      })
      fixture.observe(
        JSON.stringify({ name: "Corrected", lud16: "new@pay.lnurl.io" }),
        30
      )
      expect(await checkOrderPaymentAddressUpdate(lifecycle, {})).toEqual({
        status: "current_address_changed",
      })
      expect(lifecycle).toEqual(before)
      expect(
        (
          await checkOrderPaymentAddressUpdate(
            { ...lifecycle, invoice: undefined },
            {}
          )
        ).status
      ).toBe("updated")
    })
  }
})
