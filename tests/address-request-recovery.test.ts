import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { z } from "../packages/core/node_modules/zod/index.js"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import { bytesToHex } from "../packages/core/node_modules/@noble/hashes/utils.js"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import type { SignedNostrEvent } from "../packages/core/src/protocol/nostr-event-signer"
import { createAddressRequestWorkflow } from "../packages/core/src/wallets/address-request-workflow"
import { AddressRequestService } from "../packages/core/src/wallets/address-request-service"
import { DexieAddressRequestStore } from "../packages/core/src/wallets/address-request-store"
import { parseAddressRequests } from "../packages/core/src/wallets/address-request-metadata"
import {
  addressNameRequestMessage,
  type AddressNameRequest,
} from "../packages/core/src/wallets/address-name-request"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  SparkRecoveryService,
  type SparkRecoveryTransport,
} from "../packages/core/src/wallets/spark-recovery-service"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery-contract"
import {
  sparkRecoveryNetworkSchema,
  addressRequestsDTag,
  sparkWalletRegistryDTag,
  walletNamesDTag,
} from "../packages/core/src/wallets/spark-recovery-address"
import { parseSparkWalletRegistrySnapshot } from "../packages/core/src/wallets/spark-wallet-registry"
import { WalletNameService } from "../packages/core/src/wallets/wallet-name-service"
import { DexieWalletNameStore } from "../packages/core/src/wallets/wallet-name-store"
import {
  handleAddressGateway,
  type AddressGatewayEnv,
  type ApprovedName,
} from "../apps/address-gateway/src/gateway"

// Frozen pre-extension v1 shape from cee3598: strict readers reject unknown
// fields even though the registry coordinate and version stay the same.
const oldIds = z
  .array(z.uuid())
  .max(128)
  .refine((ids) => new Set(ids).size === ids.length)
const strictV1Registry = z
  .strictObject({
    format: z.literal("conduit.spark.registry"),
    version: z.literal(1),
    ownerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    network: sparkRecoveryNetworkSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    parentEventId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    activeWalletIds: oldIds,
    removedWalletIds: oldIds,
    payInvoiceWalletId: z.uuid().nullable(),
    receiveWalletId: z.uuid().nullable(),
    createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) =>
      value.activeWalletIds.every(
        (id) => !value.removedWalletIds.includes(id)
      ) &&
      [value.payInvoiceWalletId, value.receiveWalletId].every(
        (id) => id === null || value.activeWalletIds.includes(id)
      )
  )

test("signed name request completes after approval and restores on another storage context", async () => {
  const accountSecret = generateSecretKey()
  const walletSecret = generateSecretKey()
  const secondWalletSecret = generateSecretKey()
  const owner = getPublicKey(accountSecret)
  const identity = bytesToHex(secp256k1.getPublicKey(walletSecret))
  const secondIdentity = bytesToHex(secp256k1.getPublicKey(secondWalletSecret))
  const conversation = v2.utils.getConversationKey(accountSecret, owner)
  const signer = new SessionSigner(
    {
      pubkey: owner,
      getPublicKey: async () => owner,
      signEvent: async (draft) => finalizeEvent(draft, accountSecret),
      encryptNip44: async (_peer, plaintext) =>
        v2.encrypt(plaintext, conversation),
      decryptNip44: async (_peer, ciphertext) =>
        v2.decrypt(ciphertext, conversation),
      decryptLegacy: async () => {
        throw new Error("unused")
      },
    },
    {
      expectedPubkey: owner,
      revision: crypto.randomUUID(),
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: false,
      }),
      hasAuthority: () => true,
    }
  )
  const relayUrls = [
    "wss://relay.conduit.market",
    "wss://relay.damus.io",
    "wss://nos.lol",
  ]
  const relays = new Map(
    relayUrls.map((url) => [url, new Map<string, SignedNostrEvent>()])
  )
  let optionalUnavailable = false
  const transport: SparkRecoveryTransport = {
    async publish(url, event) {
      const events = relays.get(url)!
      const address = event.tags.find((tag) => tag[0] === "d")?.[1]
      for (const old of events.values())
        if (
          old.pubkey === event.pubkey &&
          old.kind === event.kind &&
          old.tags.find((tag) => tag[0] === "d")?.[1] === address
        )
          events.delete(old.id)
      events.set(event.id, structuredClone(event))
      return "acked"
    },
    async read(url, _owner, eventId, _authorized, address) {
      if (optionalUnavailable && address === addressRequestsDTag("mainnet"))
        return { status: "unavailable", events: [] }
      return {
        status: "complete",
        events: [...relays.get(url)!.values()].filter(
          (event) =>
            (!eventId || event.id === eventId) &&
            (!address ||
              event.tags.some((tag) => tag[0] === "d" && tag[1] === address))
        ),
      }
    },
  }
  const dbA = new ConduitDB(`address-probe-a-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const dbB = new ConduitDB(`address-probe-b-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const sqlite = new Database(":memory:")
  sqlite.exec(
    readFileSync(
      new URL(
        "../apps/address-gateway/migrations/0001_address_requests.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  let approved: ApprovedName[] = []
  let registered = false
  let registrations = 0
  const originalProfile = {
    name: "Merchant profile",
    about: "Keep this biography",
    lud06: "lnurl-legacy",
    extension: { keep: true },
  }
  let publishedProfile: Event | null = null
  let profileUpdates = 0
  const env: AddressGatewayEnv = {
    ADDRESS_REQUESTS: {
      prepare(sql) {
        let values: unknown[] = []
        const statement = {
          bind(...next: unknown[]) {
            values = next
            return statement
          },
          async first<T>() {
            return sqlite.query(sql).get(...(values as never[])) as T | null
          },
          async run() {
            const r = sqlite.query(sql).run(...(values as never[]))
            return { success: true, meta: { changes: r.changes } }
          },
        }
        return statement
      },
    },
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ALLOWED_ORIGINS: "https://shop.conduit.market",
    TURNSTILE_HOSTNAMES: "shop.conduit.market",
    TURNSTILE_SECRET_KEY: "controlled",
    BREEZ_DOMAIN_API_KEY: "controlled",
    BREEZ_PROXY_SHARED_SECRET: "controlled",
    PROVIDER_PROXY_QUALIFIED: "false",
  }
  const challenge = (async () =>
    Response.json({
      success: true,
      hostname: "shop.conduit.market",
      action: "address_name_request",
    })) as typeof fetch
  const service = (db: ConduitDB) =>
    new SparkRecoveryService({
      signer,
      currentSigner: () => signer,
      store: new DexieSparkRecoveryStore(db),
      transport,
      deriveIdentity: async (bundle) =>
        bundle.accountNumber === 2 ? secondIdentity : identity,
    })
  const metadata = (db: ConduitDB) =>
    new AddressRequestService({
      signer,
      currentSigner: () => signer,
      store: new DexieAddressRequestStore(db),
      transport,
    })
  const first = service(dbA)
  const walletId = crypto.randomUUID()
  const secondWalletId = crypto.randomUUID()
  try {
    const mnemonic = generateSparkMnemonic()
    const backup = await first.prepare(
      { mnemonic, network: "mainnet", accountNumber: 1 },
      walletId
    )
    expect((await first.deliver(backup.eventId)).ready).toBe(true)
    const added = await first.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    expect((await first.deliver(added)).ready).toBe(true)
    const secondBackup = await first.prepare(
      {
        mnemonic: generateSparkMnemonic(),
        network: "mainnet",
        accountNumber: 2,
      },
      secondWalletId,
      backup.eventId
    )
    expect((await first.deliver(secondBackup.eventId)).ready).toBe(true)
    expect(
      (
        await first.deliver(
          await first.prepareRegistry("mainnet", {
            type: "add",
            walletId: secondWalletId,
          })
        )
      ).ready
    ).toBe(true)
    const namesA = new DexieWalletNameStore(dbA)
    await namesA.queue(owner, "mainnet", walletId, "Pending local name")
    const pendingToken = (await namesA.load(owner, "mainnet")).pending[walletId]
      .token
    const workflow = (
      recovery: SparkRecoveryService,
      requests: AddressRequestService
    ) =>
      createAddressRequestWorkflow({
        owner,
        assertCurrent() {},
        async load(id) {
          const discovery = await recovery.discover(false, "mainnet")
          const saved = await requests.load("mainnet", discovery)
          const record = saved.records[id]
          return record
            ? {
                record,
                publication: saved.confirmed ? "confirmed" : "local",
              }
            : undefined
        },
        async save(id, record) {
          const discovery = await recovery.discover(false, "mainnet")
          const saved = await requests.save("mainnet", discovery, id, record)
          return {
            record: saved.records[id],
            publication: saved.confirmed ? "confirmed" : "local",
          }
        },
        async signWallet(
          _id,
          input: Omit<AddressNameRequest, "sparkIdentity">
        ) {
          const draft = { ...input, sparkIdentity: identity }
          return {
            ...draft,
            walletSignature: bytesToHex(
              secp256k1.sign(
                sha256(
                  new TextEncoder().encode(addressNameRequestMessage(draft))
                ),
                walletSecret,
                { prehash: false, format: "der" }
              )
            ),
          }
        },
        signAccount: (draft) => signer.signEvent(draft),
        fetch: (async (url, init) =>
          handleAddressGateway(
            new Request(url, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                Origin: "https://shop.conduit.market",
              },
            }),
            env,
            approved,
            challenge,
            Math.floor(Date.now() / 1000)
          )) as typeof fetch,
        async address(_id, register, name) {
          if (register) {
            registrations++
            registered = true
          }
          return registered
            ? {
                status: "registered",
                username: name,
                address: `${name}@conduit.cash`,
                lnurl: "",
                publicLookup: "verified",
                zapAdvertised: false,
                receiveEvidence: "unverified",
              }
            : { status: "absent" }
        },
        async publishProfile(address) {
          profileUpdates++
          const retained = Object.fromEntries(
            Object.entries(originalProfile).filter(([key]) => key !== "lud06")
          )
          publishedProfile = finalizeEvent(
            {
              kind: 0,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: JSON.stringify({ ...retained, lud16: address }),
            },
            accountSecret
          )
          return publishedProfile.id
        },
      })
    const flowA = workflow(first, metadata(dbA))
    optionalUnavailable = true
    await expect(
      flowA.submit(walletId, { desiredName: "saved-name", token: "controlled" })
    ).rejects.toThrow("Finish wallet sync")
    expect(
      sqlite.query("SELECT COUNT(*) AS count FROM name_requests").get()
    ).toEqual({ count: 0 })
    const retained = await new DexieAddressRequestStore(dbA).load(
      owner,
      "mainnet"
    )
    expect(retained.operation).toBeDefined()
    const originalBytes = parseAddressRequests(
      await signer.decryptNip44(owner, retained.operation!.event.content),
      retained.operation!.event,
      "mainnet"
    ).requests[walletId].payload
    optionalUnavailable = false
    const submitted = await flowA.submit(walletId, {
      desiredName: "saved-name",
      token: "controlled",
    })
    expect(submitted.record.phase).toBe("received")
    expect(submitted.record.payload).toBe(originalBytes)
    expect((await namesA.load(owner, "mainnet")).pending[walletId].token).toBe(
      pendingToken
    )
    const row = sqlite
      .query("SELECT signed_payload FROM name_requests")
      .get() as { signed_payload: string }
    expect(row.signed_payload).toBe(submitted.record.payload)
    const signedRequestRegistry = await first.discover(false, "mainnet")
    const registryEvent = relays
      .get(relayUrls[0])!
      .get(signedRequestRegistry.registryEventId!)!
    const plaintext = await signer.decryptNip44(owner, registryEvent.content)
    const snapshot = JSON.parse(plaintext)
    expect(strictV1Registry.safeParse(snapshot).success).toBe(true)
    expect(
      parseSparkWalletRegistrySnapshot(plaintext, registryEvent)
        .addressNameRequests
    ).toBeUndefined()
    expect(snapshot.activeWalletIds).toHaveLength(2)
    expect(registryEvent.tags.find((tag) => tag[0] === "d")?.[1]).toBe(
      sparkWalletRegistryDTag("mainnet")
    )
    const requestEvent = [...relays.get(relayUrls[0])!.values()].find((event) =>
      event.tags.some(
        (tag) => tag[0] === "d" && tag[1] === addressRequestsDTag("mainnet")
      )
    )!
    expect(verifyEvent(requestEvent)).toBe(true)
    expect(
      parseAddressRequests(
        await signer.decryptNip44(owner, requestEvent.content),
        requestEvent,
        "mainnet"
      ).requests[walletId]
    ).toEqual(submitted.record)
    const successor = await first.prepareRegistry("mainnet", {
      type: "main",
      walletId: secondWalletId,
    })
    expect(successor).not.toBe(signedRequestRegistry.registryEventId)
    expect((await first.deliver(successor)).ready).toBe(true)
    const successorEvent = relays.get(relayUrls[0])!.get(successor)!
    expect(
      strictV1Registry.safeParse(
        JSON.parse(await signer.decryptNip44(owner, successorEvent.content))
      ).success
    ).toBe(true)
    expect((await namesA.load(owner, "mainnet")).pending[walletId].token).toBe(
      pendingToken
    )
    const fresh = service(dbB)
    expect(
      (await new DexieSparkRecoveryStore(dbB).load(owner)).records
    ).toHaveLength(0)
    const discovery = await fresh.discover(false, "mainnet")
    expect(
      discovery.candidates.some((candidate) => candidate.walletId === walletId)
    ).toBe(true)
    expect(discovery.registry?.activeWalletIds).toHaveLength(2)
    expect(discovery.registry?.addressNameRequests).toBeUndefined()
    optionalUnavailable = true
    expect(
      (await fresh.discover(false, "mainnet")).registry?.activeWalletIds
    ).toHaveLength(2)
    expect(await workflow(fresh, metadata(dbB)).load(walletId)).toBeUndefined()
    expect(registrations).toBe(0)
    expect(profileUpdates).toBe(0)
    optionalUnavailable = false
    const flowB = workflow(fresh, metadata(dbB))
    expect((await flowB.load(walletId))?.record.phase).toBe("received")
    approved = [
      {
        name: "saved-name",
        ownerPubkey: owner,
        sparkIdentity: identity,
        registration: true,
      },
    ]
    expect((await flowB.check(walletId))?.record.phase).toBe("approved")
    const activated = await flowB.activate(walletId)
    expect(activated.record.phase).toBe("complete")
    expect(publishedProfile && verifyEvent(publishedProfile)).toBe(true)
    expect(JSON.parse(publishedProfile!.content)).toEqual({
      name: "Merchant profile",
      about: "Keep this biography",
      extension: { keep: true },
      lud16: "saved-name@conduit.cash",
    })
    expect(activated.record.profileEventId).toBe(publishedProfile!.id)
    expect(registrations).toBe(1)
    const restored = await workflow(service(dbA), metadata(dbA)).load(walletId)
    expect(restored?.record).toEqual(activated.record)
    expect(restored?.publication).toBe("confirmed")
    expect(
      (await workflow(service(dbA), metadata(dbA)).check(walletId))?.record
        .phase
    ).toBe("complete")
    expect(
      (await workflow(service(dbA), metadata(dbA)).activate(walletId)).record
        .phase
    ).toBe("complete")
    expect(registrations).toBe(1)
    expect(profileUpdates).toBe(1)
    expect((await namesA.load(owner, "mainnet")).pending[walletId].token).toBe(
      pendingToken
    )
    const names = new WalletNameService({
      signer,
      currentSigner: () => signer,
      store: namesA,
      transport,
    })
    const nameSync = await names.sync(
      "mainnet",
      await first.discover(false, "mainnet")
    )
    expect(nameSync.ready).toBe(true)
    expect(nameSync.names[walletId]).toBe("Pending local name")
    expect(walletNamesDTag("mainnet")).not.toBe(
      sparkWalletRegistryDTag("mainnet")
    )
    const namesEvent = [...relays.get(relayUrls[0])!.values()].find((event) =>
      event.tags.some(
        (tag) => tag[0] === "d" && tag[1] === walletNamesDTag("mainnet")
      )
    )
    expect(namesEvent).toBeDefined()
    expect(verifyEvent(namesEvent!)).toBe(true)
    expect(
      (await workflow(service(dbB), metadata(dbB)).load(walletId))?.record.phase
    ).toBe("complete")
    expect((await namesA.load(owner, "mainnet")).pending).toEqual({})
  } finally {
    sqlite.close()
    await dbA.delete()
    await dbB.delete()
  }
})
