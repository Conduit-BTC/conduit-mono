import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { createHash } from "node:crypto"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { bytesToHex } from "../packages/core/node_modules/@noble/hashes/utils.js"
import { addressNameRequestMessage } from "../packages/core/src/wallets/address-name-request"
import { createAddressRequestWorkflow } from "../packages/core/src/wallets/address-request-workflow"
import { mergeAddressRequestRecord } from "../packages/core/src/wallets/address-request-record"
import {
  PortableWalletSync,
  type PortableWalletAccount,
  type PortableWalletStore,
} from "../packages/core/src/wallets/portable-wallet-sync"
import {
  PORTABLE_WALLET_PREFIX,
  PORTABLE_WALLET_TAG,
  compareWalletEvents,
  type PortableWalletRecord,
} from "../packages/core/src/wallets/portable-wallet-record"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import {
  NostrSignerError,
  type AccountSigner,
  type SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import type { WalletRecordTransport } from "../packages/core/src/wallets/portable-wallet-transport"

function fixture() {
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const key = v2.utils.getConversationKey(secret, owner)
  let current = true,
    denied = false,
    now = 1_000_000
  let decrypts = 0
  const signer: AccountSigner = {
    pubkey: owner,
    revision: "fixture",
    authMethod: "nip07",
    capabilities: { nip44: true, signEvent: true, nip04Decrypt: false },
    getPublicKey: async () => owner,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (_peer, text) => v2.encrypt(text, key),
    decryptNip44: async (_peer, text) => {
      decrypts++
      if (denied) throw new NostrSignerError("authorization_denied")
      return v2.decrypt(text, key)
    },
    decryptLegacy: async () => {
      throw new Error("No legacy decryption")
    },
  }
  const relays = ["wss://one.example", "wss://two.example"]
  const data = new Map(relays.map((r) => [r, [] as SignedNostrEvent[]]))
  const offline = new Set<string>()
  const sent: string[] = []
  let ack = "acked"
  const transport: WalletRecordTransport = {
    read: async (url, _owner, id, check) => {
      check()
      if (offline.has(url)) return { status: "unavailable", events: [] }
      return {
        status: "complete",
        events: data.get(url)!.filter((e) => !id || e.id === id),
      }
    },
    publish: async (url, event, check) => {
      check()
      sent.push(event.id)
      if (offline.has(url)) return "timed_out"
      const d = event.tags.find((t) => t[0] === "d")?.[1]
      const events = data.get(url)!
      const previous = events.find(
        (e) => e.tags.find((t) => t[0] === "d")?.[1] === d
      )
      if (!previous || compareWalletEvents(event, previous) < 0)
        data.set(url, [...events.filter((e) => e !== previous), event])
      return ack
    },
  }
  const deriveIdentity = async (bundle: {
    mnemonic: string
    accountNumber: number
    network: string
  }) =>
    bytesToHex(
      secp256k1.getPublicKey(
        new Uint8Array(
          createHash("sha256").update(JSON.stringify(bundle)).digest()
        )
      )
    )
  // The identity fixture deliberately uses only the recovery tuple, as the native adapter does.
  const derive = (b: {
    mnemonic: string
    accountNumber: number
    network: string
  }) =>
    deriveIdentity({
      mnemonic: b.mnemonic,
      accountNumber: b.accountNumber,
      network: b.network,
    })
  function device() {
    let account: PortableWalletAccount = { ownerPubkey: owner, wallets: {} }
    let projected: PortableWalletRecord[] = []
    const store: PortableWalletStore = {
      load: async () => structuredClone(account),
      save: async (next) => {
        account = structuredClone(next)
      },
    }
    const make = () =>
      new PortableWalletSync({
        signer,
        store,
        transport,
        relays,
        deriveIdentity: derive,
        now: () => now,
        assertCurrent: () => {
          if (!current) throw new NostrSignerError("authority_changed")
        },
        project: async (records) => {
          projected = records
        },
      })
    let service = make()
    return {
      get service() {
        return service
      },
      restart: () => {
        service = make()
      },
      account: () => account,
      projected: () => projected,
      replace: (next: PortableWalletAccount) => {
        account = next
      },
    }
  }
  const bundle = (accountNumber = 0) => ({
    mnemonic: generateSparkMnemonic(),
    network: "mainnet" as const,
    accountNumber,
  })
  return {
    owner,
    signer,
    device,
    bundle,
    data,
    relays,
    offline,
    sent,
    derive,
    decrypts: () => decrypts,
    deny: () => {
      denied = true
    },
    approve: () => {
      denied = false
    },
    revoke: () => {
      current = false
    },
    tick: () => {
      now += 1000
    },
    loseAck: () => {
      ack = "timed_out"
    },
    forge: async (record: PortableWalletRecord, timestamp: number) =>
      finalizeEvent(
        {
          pubkey: owner,
          kind: 30078,
          created_at: timestamp,
          tags: [
            ["d", PORTABLE_WALLET_PREFIX + record.walletId],
            ["t", PORTABLE_WALLET_TAG],
          ],
          content: v2.encrypt(JSON.stringify(record), key),
        },
        secret
      ),
  }
}

describe("complete Portable Wallet records", () => {
  it("imports an explicit recovery tuple and restores two independent wallets on a fresh device", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const first = await a.service.import(f.bundle(), "Daily")
    const second = await a.service.import(f.bundle(7), "Savings")
    await a.service.update(first.walletId, {
      lightningAddress: "daily@breez.tips",
    })
    await a.service.sync()
    await b.service.sync()
    expect(
      b
        .projected()
        .map((r) => r.name)
        .sort()
    ).toEqual(["Daily", "Savings"])
    expect((await b.service.get(first.walletId)).lightningAddress).toBe(
      "daily@breez.tips"
    )
    expect((await b.service.get(second.walletId)).accountNumber).toBe(7)
    expect(b.service.snapshot.status).toBe("ready")
    expect(JSON.stringify(a.account()).includes(first.mnemonic)).toBe(false)
  })
  it("renames atomically in both directions without a second metadata event", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Before")
    await a.service.sync()
    await b.service.sync()
    await b.service.update(r.walletId, { name: "Merchant" })
    await b.service.sync()
    await a.service.sync()
    expect((await a.service.get(r.walletId)).name).toBe("Merchant")
    await a.service.update(r.walletId, { name: "Shop" })
    await a.service.sync()
    await b.service.sync()
    expect((await b.service.get(r.walletId)).name).toBe("Shop")
    expect(f.data.get(f.relays[0])?.length).toBe(1)
  })
  it("chooses newest valid per wallet despite divergent relay heads and duplicates", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Old")
    await a.service.sync()
    const old = f.data.get(f.relays[0])![0]
    await a.service.update(r.walletId, { name: "New" })
    await a.service.sync()
    f.data.set(f.relays[1], [old, old])
    await b.service.sync()
    expect((await b.service.get(r.walletId)).name).toBe("New")
  })
  it("ignores malformed newer records and restores unrelated valid wallets", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Valid")
    await a.service.sync()
    const invalid = await f.forge(
      { ...r, identityPublicKey: "02" + "0".repeat(64) },
      9000
    )
    f.data.get(f.relays[0])!.push(invalid)
    await b.service.sync()
    expect((await b.service.get(r.walletId)).name).toBe("Valid")
    expect(b.service.snapshot.invalidCount).toBe(1)
  })
  it("uses the NIP-01 lowest event ID tie-break independent of arrival", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Local")
    const one = await f.forge({ ...r, name: "One" }, 2000)
    const two = await f.forge({ ...r, name: "Two" }, 2000)
    f.data.set(f.relays[0], [one, two])
    f.data.set(f.relays[1], [two, one])
    await a.service.sync()
    await b.service.sync()
    expect(a.account().wallets[r.walletId].event.id).toBe(
      [one, two].sort(compareWalletEvents)[0].id
    )
    expect((await a.service.get(r.walletId)).name).toBe(
      (await b.service.get(r.walletId)).name
    )
  })
  it("retains offline edits through restart and retries identical signed bytes", async () => {
    const f = fixture(),
      a = f.device()
    const r = await a.service.import(f.bundle(), "Original")
    for (const relay of f.relays) f.offline.add(relay)
    await a.service.update(r.walletId, { name: "Offline" })
    const eventId = a.account().wallets[r.walletId].event.id
    await a.service.sync()
    a.restart()
    f.offline.clear()
    await a.service.sync()
    expect(f.sent.every((id) => id === eventId)).toBe(true)
    expect(a.service.snapshot.status).toBe("ready")
  })
  it("accepts positive records during a relay outage without claiming full coverage", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Available")
    await a.service.sync()
    f.offline.add(f.relays[1])
    await b.service.sync()
    expect((await b.service.get(r.walletId)).name).toBe("Available")
    expect(b.service.snapshot.coverage).toBe("partial")
  })
  it("does not turn a lost ACK into another signed operation", async () => {
    const f = fixture(),
      a = f.device()
    await a.service.import(f.bundle(), "Wallet")
    f.loseAck()
    await a.service.sync()
    expect(new Set(f.sent).size).toBe(1)
    expect(a.service.snapshot.status).toBe("ready")
  })
  it("deduplicates seed imports but keeps different accounts distinct", async () => {
    const f = fixture(),
      a = f.device(),
      bundle = f.bundle()
    const first = await a.service.import(bundle, "First")
    const again = await a.service.import(bundle, "Ignored duplicate name")
    const other = await a.service.import(
      { ...bundle, accountNumber: 1 },
      "Other"
    )
    expect(first.walletId).toBe(again.walletId)
    expect(other.walletId === first.walletId).toBe(false)
    expect(Object.keys(a.account().wallets).length).toBe(2)
    expect((await a.service.get(first.walletId)).name).toBe("First")
  })
  it("retains a removal across stale relay responses and fresh-device discovery", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Removed")
    await a.service.sync()
    const active = f.data.get(f.relays[0])![0]
    await a.service.update(r.walletId, { lifecycle: "removed" })
    await a.service.sync()
    f.data.set(f.relays[1], [active])
    await b.service.sync()
    expect((await b.service.get(r.walletId)).lifecycle).toBe("removed")
    await expect(
      b.service.update(r.walletId, { name: "Stale edit" })
    ).rejects.toThrow("removed")
  })
  it("coalesces simultaneous consumers into one discovery", async () => {
    const f = fixture(),
      a = f.device()
    await a.service.import(f.bundle(), "Wallet")
    const one = a.service.sync(),
      two = a.service.sync()
    expect(one === two).toBe(true)
    await one
    expect(f.sent.length).toBe(2)
  })
  it("validates signatures before asking a signer to decrypt", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Wallet")
    const event = a.account().wallets[r.walletId].event
    f.data.set(f.relays[0], [{ ...event, content: event.content + "changed" }])
    const before = f.decrypts()
    await b.service.sync()
    expect(f.decrypts()).toBe(before)
    expect(b.projected().length).toBe(0)
  })
  it("stops on signer denial and does not continue through other wallets", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    await a.service.import(f.bundle(), "One")
    await a.service.import(f.bundle(), "Two")
    await a.service.sync()
    f.deny()
    const before = f.decrypts()
    await expect(b.service.sync()).rejects.toThrow("authorization_denied")
    expect(f.decrypts() - before).toBe(1)
    expect(b.projected().length).toBe(0)
  })
  it("fences writes after authority revocation", async () => {
    const f = fixture(),
      a = f.device()
    const r = await a.service.import(f.bundle(), "Wallet")
    f.revoke()
    await expect(
      a.service.update(r.walletId, { name: "Late" })
    ).rejects.toThrow("authority_changed")
    expect(f.sent.length).toBe(0)
  })
  it("ignores old recovery events rather than interpreting or migrating them", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const r = await a.service.import(f.bundle(), "Wallet")
    const event = a.account().wallets[r.walletId].event
    const old = await f.signer.signEvent({
      ...event,
      tags: [["d", "conduit:spark:wallet:v1:old"]],
    })
    f.data.set(f.relays[0], [old])
    await b.service.sync()
    expect(b.projected().length).toBe(0)
    expect(f.sent.length).toBe(0)
  })
})

describe("wallet convergence after interruption", () => {
  it("retains an offline rename through denied consent and restart, merging it into the newest complete record", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device()
    const wallet = await a.service.import(f.bundle(), "Before")
    await a.service.sync()
    await b.service.sync()
    await b.service.update(wallet.walletId, {
      lightningAddress: "new@breez.tips",
    })
    await b.service.sync()
    a.restart()
    f.deny()
    await expect(
      a.service.update(wallet.walletId, { name: "After" })
    ).rejects.toThrow()
    expect(a.account().pendingNames?.[wallet.walletId]).toBe("After")
    a.restart()
    f.approve()
    await a.service.sync({ priority: "foreground" })
    const restored = await a.service.get(wallet.walletId)
    expect(restored.name).toBe("After")
    expect(restored.lightningAddress).toBe("new@breez.tips")
    expect(a.account().pendingNames?.[wallet.walletId]).toBeUndefined()
    await b.service.sync()
    expect((await b.service.get(wallet.walletId)).name).toBe("After")
  })

  it("republishes the same signed bytes when a previously observed relay loses its copy", async () => {
    const f = fixture(),
      a = f.device()
    const wallet = await a.service.import(f.bundle(), "Retained")
    await a.service.sync()
    const saved = a.account().wallets[wallet.walletId].event
    f.data.set(f.relays[0], [])
    const prior = f.sent.length
    await a.service.sync()
    expect(f.sent.slice(prior)).toEqual([saved.id])
    expect(f.data.get(f.relays[0])?.[0]).toEqual(saved)
    expect(a.service.snapshot.status).toBe("ready")
  })

  it("does not let callers mutate the verified decrypted cache", async () => {
    const f = fixture(),
      a = f.device()
    const wallet = await a.service.import(f.bundle(), "Original")
    const exposed = await a.service.get(wallet.walletId)
    exposed.name = "Mutated"
    expect((await a.service.get(wallet.walletId)).name).toBe("Original")
  })

  it("explicit seed import completes pending setup and reactivates the same removed identity", async () => {
    const f = fixture(),
      a = f.device(),
      bundle = f.bundle()
    const pending = await a.service.import(bundle, "Existing", {}, true)
    await a.service.update(pending.walletId, { lifecycle: "removed" })
    const imported = await a.service.import(bundle, "Ignored duplicate name")
    expect(imported.walletId).toBe(pending.walletId)
    expect(imported.lifecycle).toBe("active")
    expect(imported.setupPending).toBe(false)
    expect(imported.name).toBe("Existing")
  })
})

describe("address progress in the complete wallet", () => {
  it("restores immutable request evidence and requires fresh gateway approval before activation", async () => {
    const f = fixture(),
      a = f.device(),
      b = f.device(),
      bundle = f.bundle(3)
    const wallet = await a.service.import(bundle, "Address wallet")
    const privateKey = new Uint8Array(
      createHash("sha256")
        .update(
          JSON.stringify({
            mnemonic: bundle.mnemonic,
            accountNumber: bundle.accountNumber,
            network: bundle.network,
          })
        )
        .digest()
    )
    let approved = false,
      registered = false,
      registrations = 0,
      profiles = 0
    const bodies: string[] = []
    const workflow = (service: PortableWalletSync) =>
      createAddressRequestWorkflow({
        owner: f.owner,
        assertCurrent() {},
        async load(id) {
          const record = (await service.get(id)).addressRequest
          return record ? { record, publication: "local" } : undefined
        },
        async save(id, next) {
          const record = mergeAddressRequestRecord(
            (await service.get(id)).addressRequest,
            next
          )
          await service.update(id, { addressRequest: record })
          return { record, publication: "local" }
        },
        async signWallet(_id, input) {
          const draft = { ...input, sparkIdentity: wallet.identityPublicKey }
          return {
            ...draft,
            walletSignature: bytesToHex(
              secp256k1.sign(
                new Uint8Array(
                  createHash("sha256")
                    .update(addressNameRequestMessage(draft))
                    .digest()
                ),
                privateKey,
                { prehash: false, format: "der" }
              )
            ),
          }
        },
        signAccount: (draft) => f.signer.signEvent(draft),
        fetch: (async (_url, init) => {
          bodies.push(String(init?.body))
          return Response.json({ status: approved ? "approved" : "received" })
        }) as typeof fetch,
        async address(_id, register) {
          if (register) {
            registered = true
            registrations++
          }
          return registered
            ? {
                status: "registered",
                address: "alice@conduit.cash",
                username: "alice",
                lnurl: "lnurl-fixture",
                publicLookup: "verified",
                zapAdvertised: false,
                receiveEvidence: "unverified",
              }
            : { status: "absent" }
        },
        async publishProfile() {
          profiles++
          return "a".repeat(64)
        },
      })
    await workflow(a.service).submit(wallet.walletId, {
      desiredName: "alice",
      token: "fixture",
    })
    const proof = (await a.service.get(wallet.walletId)).addressRequest!
    await a.service.sync()
    await b.service.sync()
    expect((await b.service.get(wallet.walletId)).addressRequest).toEqual(proof)
    await expect(workflow(b.service).activate(wallet.walletId)).rejects.toThrow(
      "Gateway approval could not be confirmed"
    )
    expect(registrations).toBe(0)
    expect(profiles).toBe(0)
    approved = true
    await workflow(b.service).activate(wallet.walletId)
    await workflow(b.service).activate(wallet.walletId)
    expect(registrations).toBe(1)
    expect(profiles).toBe(1)
    expect(bodies.every((body) => body === proof.payload)).toBe(true)
    await b.service.sync()
    await a.service.sync()
    const restored = (await a.service.get(wallet.walletId)).addressRequest!
    expect(restored.phase).toBe("complete")
    expect(restored.accountProof).toBe(proof.accountProof)
  })
})
