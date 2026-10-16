import {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
  giftWrap,
} from "@nostr-dev-kit/ndk"
import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetFutureMarketHandoffTestState,
  archiveFutureMarketPrivateDelivery,
  buildFutureMarketHandoffAck,
  buildFutureMarketPrivateRumor,
  buildFutureMarketRevocation,
  compactCompletedFutureMarketDelivery,
  getFutureMarketTerminalHistory,
  loadFutureMarketPrivateDeliveries,
  readFutureMarketHandoffAcks,
  readFutureMarketReadyReceipts,
  saveFutureMarketPrivateDelivery,
} from "@conduit/core/protocol/future-market-handoff"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  __resetInboxDeclarationCache,
  getNdk,
  getAccountSigner,
} from "@conduit/core"
import {
  setTestAccountSigner as setSigner,
  removeTestAccountSigner as removeSigner,
} from "./helpers/plain-signer"

import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"

let privateOwner: CommerceInbox | null = null
const privateDatabases: ConduitDB[] = []
afterEach(async () => {
  privateOwner?.stop()
  privateOwner = null
  __resetProtectedReadSigner()
  for (const db of privateDatabases.splice(0)) await db.delete()
  __resetFutureMarketHandoffTestState()
  __resetCommerceTestOverrides()
  __resetInboxDeclarationCache()
})

function quotaStorage(limitBytes: number) {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      let bytes = 0
      for (const [storedKey, storedValue] of values) {
        if (storedKey !== key)
          bytes += 2 * (storedKey.length + storedValue.length)
      }
      bytes += 2 * (key.length + value.length)
      if (bytes > limitBytes)
        throw new DOMException("Quota exceeded", "QuotaExceededError")
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

function readyPayload(merchant: string, organizer: string, claimRef: string) {
  return {
    version: 2 as const,
    type: "future_market_ready" as const,
    releaseAuthorized: true as const,
    claimRef,
    merchantPubkey: merchant,
    organizerPubkey: organizer,
    market: {
      coordinate: `30409:${organizer}:fair`,
      eventId: "1".repeat(64),
      createdAt: 100_000,
    },
    calendar: {
      coordinate: `31923:${organizer}:fair`,
      eventId: "2".repeat(64),
      createdAt: 100_000,
    },
    grant: { eventId: "3".repeat(64), createdAt: 99_000 },
    items: [
      {
        product: {
          coordinate: `30402:${merchant}:item`,
          eventId: "4".repeat(64),
          createdAt: 101_000,
        },
        quantity: 1,
      },
    ],
    issuedAt: 210,
  }
}

async function wrappedMessage(
  payload:
    | ReturnType<typeof readyPayload>
    | ReturnType<typeof buildFutureMarketRevocation>
    | ReturnType<typeof buildFutureMarketHandoffAck>,
  signer: NDKPrivateKeySigner,
  recipientPubkey: string
) {
  const rumor = buildFutureMarketPrivateRumor(payload)
  const wrap = await giftWrap(
    new NDKEvent(getNdk(), rumor as never),
    new NDKUser({ pubkey: recipientPubkey }),
    signer,
    {
      rumorKind: rumor.kind,
    }
  )
  return { rumor, wrap }
}

function setPrivateRead(wraps: NDKEvent[], available = true) {
  const signer = getAccountSigner()!
  if (!privateOwner) {
    installProtectedReadSigner(signer, signer.pubkey, () => true)
    const database = new ConduitDB(`future-storage-${crypto.randomUUID()}`, {
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    })
    privateDatabases.push(database)
    const authorization = getProtectedReadAuthorization(signer.pubkey)!
    privateOwner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, database)
    )
  }
  __setCommerceTestOverrides({
    getCommerceInbox: () => privateOwner!,
    resolveInboxRelayUrls: async () => ["wss://handoff-storage.test"],
    readProtectedInbox: async () => {
      const events = available
        ? wraps.map((wrap) => wrap.rawEvent() as never)
        : []
      return {
        events,
        coverage: available ? "complete" : "unavailable",
        auth: {
          state: "not_challenged",
          challengedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
        relayResult: {
          status: available ? "success" : "failed",
          observations: available ? [{ type: "eose", relayIndex: 0 }] : [],
          relays: [
            {
              relayIndex: 0,
              status: available ? "success" : "failed",
              auth: "not_challenged",
              eventCount: events.length,
              duplicateCount: 0,
              malformedCount: 0,
              unusableCount: 0,
            },
          ],
          attemptedCount: 1,
          completedCount: available ? 1 : 0,
          failedCount: available ? 0 : 1,
          authoritativeEmpty: available && events.length === 0,
        },
      }
    },
  })
}

describe("future handoff storage", () => {
  it("rejects an oversized pending signed delivery before exhausting the origin quota", () => {
    const merchantSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(generateSecretKey())
    // A ready rumor can embed signed market, calendar, grant, and product
    // evidence. Its encrypted gift wraps are much larger than a short DM.
    const ciphertext = "A".repeat(120_000)
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", organizer]],
        content: ciphertext,
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", merchant]],
        content: ciphertext,
      },
      merchantSecret
    )
    const storage = quotaStorage(5 * 1024 * 1024)
    let accepted = 0
    let stoppedByCapacity = false
    for (let index = 1; index <= 100; index += 1) {
      const id = index.toString(16).padStart(64, "0")
      try {
        saveFutureMarketPrivateDelivery(
          merchant,
          {
            version: 2,
            type: "future_market_ready",
            rumorId: id,
            readyReceiptId: id,
            claimRef: id,
            senderPubkey: merchant,
            recipientPubkey: organizer,
            signedRecipientWrap: recipientWrap,
            signedSelfWrap: selfWrap,
          },
          storage
        )
        accepted += 1
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        expect((cause as Error).message).toContain("recovery storage is full")
        stoppedByCapacity = true
        break
      }
    }
    expect(stoppedByCapacity).toBe(true)
    expect(accepted).toBeGreaterThan(0)
    expect(
      loadFutureMarketPrivateDeliveries(merchant, storage, {
        pendingOnly: true,
      })
    ).toHaveLength(accepted)
  })

  it("keeps exact pending wraps through a failed archive index write", () => {
    const merchantSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(generateSecretKey())
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", organizer]],
        content: "encrypted-recipient",
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", merchant]],
        content: "encrypted-self",
      },
      merchantSecret
    )
    const id = "a".repeat(64)
    const storage = quotaStorage(5 * 1024 * 1024)
    const record = {
      version: 2 as const,
      type: "future_market_ready" as const,
      rumorId: id,
      readyReceiptId: id,
      claimRef: id,
      senderPubkey: merchant,
      recipientPubkey: organizer,
      signedRecipientWrap: recipientWrap,
      signedSelfWrap: selfWrap,
    }
    saveFutureMarketPrivateDelivery(merchant, record, storage)
    const archiveKey = `conduit:future-market-handoff-delivery:v2:archive:${merchant}`
    const interrupted = {
      ...storage,
      setItem: (key: string, value: string) => {
        if (key === archiveKey)
          throw new DOMException("Interrupted", "QuotaExceededError")
        storage.setItem(key, value)
      },
    }
    expect(() =>
      archiveFutureMarketPrivateDelivery(merchant, id, interrupted)
    ).toThrow("Interrupted")
    expect(
      loadFutureMarketPrivateDeliveries(merchant, storage, {
        pendingOnly: true,
      })
    ).toHaveLength(1)
    archiveFutureMarketPrivateDelivery(merchant, id, storage)
    expect(loadFutureMarketPrivateDeliveries(merchant, storage)).toEqual([
      JSON.parse(JSON.stringify(record)),
    ])
  })

  it("preserves exact pending bytes and the claim fence when the marker write fails", () => {
    const merchantSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(generateSecretKey())
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", organizer]],
        content: "encrypted-recipient",
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", merchant]],
        content: "encrypted-self",
      },
      merchantSecret
    )
    const backing = quotaStorage(5 * 1024 * 1024)
    const storage = {
      ...backing,
      setItem: (key: string, value: string) => {
        if (key.includes(":claim:"))
          throw new DOMException("Interrupted", "QuotaExceededError")
        backing.setItem(key, value)
      },
    }
    const original = {
      version: 2 as const,
      type: "future_market_ready" as const,
      rumorId: "a".repeat(64),
      readyReceiptId: "a".repeat(64),
      claimRef: "b".repeat(64),
      senderPubkey: merchant,
      recipientPubkey: organizer,
      signedRecipientWrap: recipientWrap,
      signedSelfWrap: selfWrap,
    }
    expect(() =>
      saveFutureMarketPrivateDelivery(merchant, original, storage)
    ).toThrow("Interrupted")
    expect(
      loadFutureMarketPrivateDeliveries(merchant, storage, {
        pendingOnly: true,
      })
    ).toHaveLength(1)
    expect(() =>
      saveFutureMarketPrivateDelivery(
        merchant,
        {
          ...original,
          rumorId: "c".repeat(64),
          readyReceiptId: "c".repeat(64),
        },
        storage
      )
    ).toThrow("already owns this claim")
  })

  it("reserves pending count and bytes for revocation after many ready retries", () => {
    const merchantSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(generateSecretKey())
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", organizer]],
        content: "encrypted-recipient",
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", merchant]],
        content: "encrypted-self",
      },
      merchantSecret
    )
    const storage = quotaStorage(5 * 1024 * 1024)
    const pending: Array<
      Parameters<typeof saveFutureMarketPrivateDelivery>[1]
    > = []
    for (let index = 1; index <= 96; index += 1) {
      const id = index.toString(16).padStart(64, "0")
      pending.push({
        version: 2,
        type: "future_market_ready",
        rumorId: id,
        readyReceiptId: id,
        claimRef: id,
        senderPubkey: merchant,
        recipientPubkey: organizer,
        signedRecipientWrap: recipientWrap,
        signedSelfWrap: selfWrap,
      })
    }
    storage.setItem(
      `conduit:future-market-handoff-delivery:v2:${merchant}`,
      JSON.stringify(pending)
    )
    const extraId = "f".repeat(64)
    expect(() =>
      saveFutureMarketPrivateDelivery(
        merchant,
        {
          version: 2,
          type: "future_market_ready",
          rumorId: extraId,
          readyReceiptId: extraId,
          claimRef: extraId,
          senderPubkey: merchant,
          recipientPubkey: organizer,
          signedRecipientWrap: recipientWrap,
          signedSelfWrap: selfWrap,
        },
        storage
      )
    ).toThrow("Pending handoff deliveries need recovery")
    saveFutureMarketPrivateDelivery(
      merchant,
      {
        version: 2,
        type: "future_market_revoked",
        rumorId: extraId,
        readyReceiptId: "1".padStart(64, "0"),
        claimRef: "1".padStart(64, "0"),
        senderPubkey: merchant,
        recipientPubkey: organizer,
        signedRecipientWrap: recipientWrap,
        signedSelfWrap: selfWrap,
      },
      storage
    )
    expect(
      loadFutureMarketPrivateDeliveries(merchant, storage, {
        pendingOnly: true,
      })
    ).toHaveLength(97)
  })

  it("compacts an authenticated organizer revocation without restoring release on a partial read", async () => {
    const merchantSecret = generateSecretKey()
    const organizerSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(organizerSecret)
    const merchantSigner = new NDKPrivateKeySigner(
      Buffer.from(merchantSecret).toString("hex")
    )
    const organizerSigner = new NDKPrivateKeySigner(
      Buffer.from(organizerSecret).toString("hex")
    )
    const ready = await wrappedMessage(
      readyPayload(merchant, organizer, "a".repeat(64)),
      merchantSigner,
      organizer
    )
    const revoked = await wrappedMessage(
      buildFutureMarketRevocation({
        receipt: readyPayload(merchant, organizer, "a".repeat(64)),
        readyReceiptId: ready.rumor.id,
        issuedAt: 211,
      }),
      merchantSigner,
      organizer
    )
    const storage = quotaStorage(5 * 1024 * 1024)
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage"
    )
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    })
    const lease = setSigner(organizerSigner)
    try {
      setPrivateRead([ready.wrap, revoked.wrap])
      const first = await readFutureMarketReadyReceipts({
        organizerPubkey: organizer,
      })
      expect(first.claims[0]?.state).toBe("revoked")
      const terminal = getFutureMarketTerminalHistory(organizer, "a".repeat(64))
      expect(terminal?.revoked).toBe(true)
      expect(
        JSON.parse(
          storage.getItem(
            `conduit:future-market-handoff-observed:v2:${organizer}`
          ) ?? "{}"
        )
      ).toEqual({})

      __resetFutureMarketHandoffTestState()
      setPrivateRead([ready.wrap])
      const degraded = await readFutureMarketReadyReceipts({
        organizerPubkey: organizer,
      })
      expect(degraded.claims[0]?.state).toBe("revoked")
    } finally {
      removeSigner(lease)
      if (descriptor)
        Object.defineProperty(globalThis, "localStorage", descriptor)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  it("retains exact ACK completion across restart until a signed completed order can compact it", async () => {
    const merchantSecret = generateSecretKey()
    const organizerSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(organizerSecret)
    const merchantSigner = new NDKPrivateKeySigner(
      Buffer.from(merchantSecret).toString("hex")
    )
    const organizerSigner = new NDKPrivateKeySigner(
      Buffer.from(organizerSecret).toString("hex")
    )
    const claimRef = "b".repeat(64)
    const receipt = readyPayload(merchant, organizer, claimRef)
    const readySelf = await wrappedMessage(receipt, merchantSigner, merchant)
    const readyRecipient = await wrappedMessage(
      receipt,
      merchantSigner,
      organizer
    )
    const ack = await wrappedMessage(
      buildFutureMarketHandoffAck({
        receipt,
        readyReceiptId: readySelf.rumor.id,
        handedOutAt: 212,
      }),
      organizerSigner,
      merchant
    )
    const storage = quotaStorage(5 * 1024 * 1024)
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage"
    )
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    })
    const lease = setSigner(merchantSigner)
    try {
      saveFutureMarketPrivateDelivery(
        merchant,
        {
          version: 2,
          type: "future_market_ready",
          rumorId: readySelf.rumor.id,
          readyReceiptId: readySelf.rumor.id,
          claimRef,
          senderPubkey: merchant,
          recipientPubkey: organizer,
          signedRecipientWrap: readyRecipient.wrap.rawEvent(),
          signedSelfWrap: readySelf.wrap.rawEvent(),
        },
        storage
      )
      archiveFutureMarketPrivateDelivery(merchant, readySelf.rumor.id, storage)
      setPrivateRead([readySelf.wrap, ack.wrap])
      const first = await readFutureMarketHandoffAcks({
        merchantPubkey: merchant,
        readyReceiptId: readySelf.rumor.id,
        receipt,
      })
      expect(first.exactAck?.id).toBe(ack.rumor.id)
      __resetFutureMarketHandoffTestState()
      setPrivateRead([], false)
      const recovered = await readFutureMarketHandoffAcks({
        merchantPubkey: merchant,
        readyReceiptId: readySelf.rumor.id,
        receipt,
      })
      expect(recovered.exactAck?.id).toBe(ack.rumor.id)
      expect(loadFutureMarketPrivateDeliveries(merchant, storage)).toHaveLength(
        1
      )

      const navigatorDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator"
      )
      const lockNames: string[] = []
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          locks: {
            request: async (
              name: string,
              operation: () => Promise<unknown>
            ) => {
              lockNames.push(name)
              entered()
              await held
              return operation()
            },
          },
        },
      })
      try {
        const compaction = compactCompletedFutureMarketDelivery(
          merchant,
          claimRef,
          "complete",
          storage
        )
        await started
        expect(
          loadFutureMarketPrivateDeliveries(merchant, storage)
        ).toHaveLength(1)
        expect(
          getFutureMarketTerminalHistory(merchant, claimRef, storage)?.compacted
        ).toBe(false)
        release()
        await compaction
        const compactedRead = await readFutureMarketHandoffAcks({
          merchantPubkey: merchant,
          readyReceiptId: readySelf.rumor.id,
          receipt,
        })
        expect(compactedRead.exactAck).toBeNull()
        expect(lockNames).toHaveLength(2)
        expect(lockNames[0]).toBe(lockNames[1])
      } finally {
        release()
        if (navigatorDescriptor)
          Object.defineProperty(globalThis, "navigator", navigatorDescriptor)
        else Reflect.deleteProperty(globalThis, "navigator")
      }
      expect(loadFutureMarketPrivateDeliveries(merchant, storage)).toEqual([])
      expect(
        getFutureMarketTerminalHistory(merchant, claimRef, storage)?.compacted
      ).toBe(true)
      expect(() =>
        saveFutureMarketPrivateDelivery(
          merchant,
          {
            version: 2,
            type: "future_market_ready",
            rumorId: "f".repeat(64),
            readyReceiptId: "f".repeat(64),
            claimRef,
            senderPubkey: merchant,
            recipientPubkey: organizer,
            signedRecipientWrap: readyRecipient.wrap.rawEvent(),
            signedSelfWrap: readySelf.wrap.rawEvent(),
          },
          storage
        )
      ).toThrow("already owns this claim")
    } finally {
      removeSigner(lease)
      if (descriptor)
        Object.defineProperty(globalThis, "localStorage", descriptor)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  it("continues authenticating terminal claims beyond a former 5 MiB ciphertext archive", async () => {
    const merchantSecret = generateSecretKey()
    const organizerSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const organizer = getPublicKey(organizerSecret)
    const merchantSigner = new NDKPrivateKeySigner(
      Buffer.from(merchantSecret).toString("hex")
    )
    const organizerSigner = new NDKPrivateKeySigner(
      Buffer.from(organizerSecret).toString("hex")
    )
    const largeEvidence = [30409, 31923, 3841].map((kind, index) =>
      finalizeEvent(
        { kind, created_at: 100, tags: [], content: "a".repeat(8_000 + index) },
        organizerSecret
      )
    )
    const storage = quotaStorage(5 * 1024 * 1024)
    const legacyStorage = quotaStorage(5 * 1024 * 1024)
    const legacyObserved: Record<string, unknown> = {}
    let legacyQuotaAt: number | null = null
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage"
    )
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    })
    const lease = setSigner(organizerSigner)
    let formerArchiveBytes = 0
    try {
      for (let index = 1; index <= 60; index += 1) {
        const claimRef = index.toString(16).padStart(64, "0")
        const receipt = {
          ...readyPayload(merchant, organizer, claimRef),
          authorityEvidence: largeEvidence,
        }
        const ready = await wrappedMessage(receipt, merchantSigner, organizer)
        const revoked = await wrappedMessage(
          buildFutureMarketRevocation({
            receipt,
            readyReceiptId: ready.rumor.id,
            issuedAt: 211,
          }),
          merchantSigner,
          organizer
        )
        formerArchiveBytes +=
          2 *
          (JSON.stringify(ready.wrap.rawEvent()).length +
            JSON.stringify(revoked.wrap.rawEvent()).length)
        if (legacyQuotaAt === null) {
          legacyObserved[ready.rumor.id] = ready.wrap.rawEvent()
          legacyObserved[revoked.rumor.id] = revoked.wrap.rawEvent()
          try {
            legacyStorage.setItem("observed", JSON.stringify(legacyObserved))
          } catch (cause) {
            expect(cause).toMatchObject({ name: "QuotaExceededError" })
            legacyQuotaAt = index
          }
        }
        setPrivateRead([ready.wrap, revoked.wrap])
        const read = await readFutureMarketReadyReceipts({
          organizerPubkey: organizer,
        })
        expect(
          read.claims.find((claim) => claim.receipt.id === ready.rumor.id)
            ?.state
        ).toBe("revoked")
      }
      expect(formerArchiveBytes).toBeGreaterThan(5 * 1024 * 1024)
      expect(legacyQuotaAt).not.toBeNull()
      const storedBytes = [...storage.values].reduce(
        (bytes, [key, value]) => bytes + 2 * (key.length + value.length),
        0
      )
      expect(storedBytes).toBeLessThan(512 * 1024)
    } finally {
      removeSigner(lease)
      if (descriptor)
        Object.defineProperty(globalThis, "localStorage", descriptor)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  }, 30_000)
})
