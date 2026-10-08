import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb"
// Verify against the crypto primitive installed by the owning core workspace.
const { schnorr } = await import(
  Bun.resolveSync(
    "@noble/curves/secp256k1.js",
    `${import.meta.dir}/../packages/core`
  )
)
const hexToBytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"))
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"
import { nsecEncode, npubEncode } from "nostr-tools/nip19"
import { v2 } from "nostr-tools/nip44"
import { encrypt } from "nostr-tools/nip04"
import { unwrapEvent, wrapEvent } from "nostr-tools/nip59"
import {
  prepareLocalKeyImport,
  restoreLocalKeySigner,
  removeLocalKeyRecord,
  LOCAL_KEY_CAPABILITIES,
} from "../packages/core/src/protocol/local-key"
import { LocalKeyStorage } from "../packages/core/src/protocol/local-key/storage"
import {
  SessionSigner,
  installAccountSigner,
  retireAccountSigner,
  getAccountSigner,
} from "../packages/core/src/protocol/session-signer"
import {
  claimAuthRevision,
  hasAuthSessionAuthority,
  writeAuthSession,
  revokeAuthSessionAuthority,
  parseAuthSession,
  readAuthSession,
  readPendingLocalKeyRemoval,
  type AuthStorage,
  type LocalKeyAuthSession,
} from "../packages/core/src/protocol/auth-session"
import { retireAuthSession } from "../packages/core/src/protocol/auth-session-lifecycle"
import { createProtectedReadSessionLifecycle } from "../packages/core/src/protocol/protected-read-session-lifecycle"
import { getProtectedReadAuthorization } from "../packages/core/src/protocol/protected-read-authorization"

const disposals: Array<() => void> = []
afterEach(() => {
  while (disposals.length) disposals.pop()!()
})

async function setup(factory = new IDBFactory()) {
  const secret = generateSecretKey()
  disposals.push(() => secret.fill(0))
  const pubkey = getPublicKey(secret)
  const input = { value: nsecEncode(secret) } as HTMLInputElement
  const encoded = input.value
  const prepared = prepareLocalKeyImport(input, { factory })
  const signer = await prepared.persist(() => true)
  disposals.push(() => signer.invalidate())
  const event = {
    kind: 1,
    pubkey,
    created_at: 1,
    tags: [],
    content: "synthetic",
  }
  return { secret, pubkey, input, encoded, signer, event, factory }
}

async function corrupt(factory: IDBFactory, value: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("conduit-local-key", 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error("test storage open failed"))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("record", "readwrite")
      tx.objectStore("record").put(value, "active")
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () =>
        reject(new Error("test storage write failed"))
    })
  } finally {
    db.close()
  }
}

describe("contained existing-account local signer", () => {
  test("consumes the input, persists bytes and automatically restores the same public account", async () => {
    const s = await setup()
    expect(s.input.value === "").toBe(true)
    const restored = await restoreLocalKeySigner(s.signer.reference, {
      factory: s.factory,
    })
    disposals.push(() => restored.invalidate())
    expect((await restored.getPublicKey()) === s.pubkey).toBe(true)
    expect(
      restored.reference.localKeyRevision ===
        s.signer.reference.localKeyRevision
    ).toBe(true)
    s.signer.invalidate()
    expect((await restored.getPublicKey()) === s.pubkey).toBe(true)
  })

  test("rejects invalid encodings, public keys, bad checksums and invalid secret scalars without persisting", async () => {
    const s = await setup()
    for (const value of [
      "invalid",
      s.pubkey,
      npubEncode(s.pubkey),
      s.encoded.slice(0, -1),
      nsecEncode(new Uint8Array(32)),
    ]) {
      const input = { value } as HTMLInputElement
      expect(() =>
        prepareLocalKeyImport(input, { factory: s.factory })
      ).toThrow("invalid_response")
      expect(input.value === "").toBe(true)
    }
    expect((await s.signer.getPublicKey()) === s.pubkey).toBe(true)
  })

  test("public operations and reflection never return secret bytes or import text", async () => {
    const s = await setup()
    const publicValues = [
      s.signer,
      s.signer.reference,
      await s.signer.getPublicKey(),
      await s.signer.signEvent(s.event),
    ]
    expect(
      publicValues.some((value) => JSON.stringify(value).includes(s.encoded))
    ).toBe(false)
    expect(Object.getOwnPropertyNames(s.signer).sort()).toEqual(["authMethod"])
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(s.signer)).sort()
    ).toEqual([
      "constructor",
      "decryptLegacy",
      "decryptNip44",
      "encryptNip44",
      "getPublicKey",
      "invalidate",
      "pubkey",
      "reference",
      "signEvent",
    ])
    expect(
      "secret" in s.signer ||
        "privateKey" in s.signer ||
        "getSecretKey" in s.signer
    ).toBe(false)
    const input = { value: s.encoded } as HTMLInputElement
    const capability = prepareLocalKeyImport(input, { factory: s.factory })
    expect(Object.keys(capability).sort()).toEqual([
      "dispose",
      "persist",
      "reference",
    ])
    expect(JSON.stringify(capability).includes(s.encoded)).toBe(false)
    capability.dispose()
    await expect(capability.persist(() => true)).rejects.toThrow("disconnected")
  })

  test("returns a real complete event verified independently with noble Schnorr", async () => {
    const s = await setup()
    const signed = await s.signer.signEvent(s.event)
    expect(verifyEvent(signed)).toBe(true)
    expect(
      schnorr.verify(
        hexToBytes(signed.sig),
        hexToBytes(getEventHash(signed)),
        hexToBytes(s.pubkey)
      )
    ).toBe(true)
    expect(signed.id === getEventHash(s.event)).toBe(true)
    await expect(
      s.signer.signEvent({
        ...s.event,
        pubkey: getPublicKey(generateSecretKey()),
      })
    ).rejects.toThrow("authority_changed")
  })

  test("NIP-44 and decrypt-only NIP-04 interoperate with an independent peer", async () => {
    const s = await setup()
    const peer = generateSecretKey()
    const key = v2.utils.getConversationKey(peer, s.pubkey)
    try {
      const encrypted = await s.signer.encryptNip44(
        getPublicKey(peer),
        "synthetic"
      )
      expect(v2.decrypt(encrypted, key) === "synthetic").toBe(true)
      expect(
        (await s.signer.decryptNip44(
          getPublicKey(peer),
          v2.encrypt("reply", key)
        )) === "reply"
      ).toBe(true)
      expect(
        (await s.signer.decryptLegacy(
          getPublicKey(peer),
          await encrypt(peer, s.pubkey, "legacy")
        )) === "legacy"
      ).toBe(true)
      await expect(
        s.signer.decryptNip44(getPublicKey(peer), "malformed")
      ).rejects.toThrow("invalid_response")
    } finally {
      peer.fill(0)
      key.fill(0)
    }
  })

  test("decrypts the published NIP-44 vector through the actual adapter", async () => {
    // Official public test vector, not a credential: NIPs/44.md, example at
    // https://github.com/nostr-protocol/nips/blob/master/44.md#tests-and-code
    const first = new Uint8Array(32)
    first[31] = 1
    const second = new Uint8Array(32)
    second[31] = 2
    const factory = new IDBFactory()
    const signer = await prepareLocalKeyImport(
      { value: nsecEncode(second) } as HTMLInputElement,
      { factory }
    ).persist(() => true)
    try {
      const payload =
        "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb"
      expect(
        (await signer.decryptNip44(getPublicKey(first), payload)) === "a"
      ).toBe(true)
      const conversation = v2.utils.getConversationKey(
        first,
        getPublicKey(second)
      )
      try {
        expect(v2.encrypt("a", conversation, first) === payload).toBe(true)
      } finally {
        conversation.fill(0)
      }
    } finally {
      signer.invalidate()
      first.fill(0)
      second.fill(0)
    }
  })

  test("NIP-59 kind-14 and kind-16 envelopes interoperate without route-local crypto", async () => {
    const s = await setup()
    const peer = generateSecretKey()
    const envelope = generateSecretKey()
    try {
      for (const kind of [14, 16]) {
        const draft = { ...s.event, kind, tags: [["p", getPublicKey(peer)]] }
        const rumor = { ...draft, id: getEventHash(draft) }
        const seal = await s.signer.signEvent({
          ...s.event,
          kind: 13,
          content: await s.signer.encryptNip44(
            getPublicKey(peer),
            JSON.stringify(rumor)
          ),
        })
        const key = v2.utils.getConversationKey(envelope, getPublicKey(peer))
        const wrap = finalizeEvent(
          {
            ...s.event,
            kind: 1059,
            tags: [["p", getPublicKey(peer)]],
            content: v2.encrypt(JSON.stringify(seal), key),
          },
          envelope
        )
        key.fill(0)
        const decoded = unwrapEvent(wrap, peer)
        expect(
          decoded.kind === kind &&
            decoded.content === rumor.content &&
            !("sig" in decoded)
        ).toBe(true)
        const incoming = wrapEvent(
          { ...draft, pubkey: getPublicKey(peer), tags: [["p", s.pubkey]] },
          peer,
          s.pubkey
        )
        const incomingSeal = JSON.parse(
          await s.signer.decryptNip44(incoming.pubkey, incoming.content)
        )
        expect(verifyEvent(incomingSeal)).toBe(true)
        const received = JSON.parse(
          await s.signer.decryptNip44(incomingSeal.pubkey, incomingSeal.content)
        )
        expect(
          received.kind === kind && received.pubkey === getPublicKey(peer)
        ).toBe(true)
      }
    } finally {
      peer.fill(0)
      envelope.fill(0)
    }
  })

  test("malformed persistent data fails closed without leaking its contents", async () => {
    const s = await setup()
    for (const value of [
      null,
      {},
      { version: 2, revision: "bad" },
      {
        version: 1,
        revision: s.signer.reference.localKeyRevision,
        secret: new Uint8Array(32),
      },
    ]) {
      await corrupt(s.factory, value)
      await expect(
        restoreLocalKeySigner(s.signer.reference, { factory: s.factory })
      ).rejects.toThrow("unavailable")
    }
  })

  test("explicit removal also removes an unusable malformed record", async () => {
    const s = await setup()
    await corrupt(s.factory, {})
    await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
    expect(
      (await new LocalKeyStorage({ factory: s.factory }).read()) === null
    ).toBe(true)
  })

  test("stale deletion preserves an identifiable newer revision with unknown or damaged data", async () => {
    const s = await setup()
    const revision = crypto.randomUUID()
    const deletion = spyOn(FakeObjectStore.prototype, "delete")
    try {
      for (const value of [
        { version: 2, revision },
        { version: 1, revision, secret: new Uint8Array(31) },
      ]) {
        await corrupt(s.factory, value)
        await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
        expect(deletion).not.toHaveBeenCalled()
      }
      await removeLocalKeyRecord(
        { userPubkey: s.pubkey, localKeyRevision: revision },
        { factory: s.factory }
      )
      expect(deletion).toHaveBeenCalledTimes(1)
    } finally {
      deletion.mockRestore()
    }
  })

  test("storage loss notifies the owner once and fences later operations", async () => {
    const s = await setup()
    let invalidations = 0
    const restored = await restoreLocalKeySigner(s.signer.reference, {
      factory: s.factory,
      onInvalidated: () => {
        invalidations++
      },
    })
    await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
    await expect(restored.signEvent(s.event)).rejects.toThrow("disconnected")
    await expect(restored.signEvent(s.event)).rejects.toThrow(
      "authority_changed"
    )
    expect(invalidations).toBe(1)
  })

  test("failed durable deletion retains revoked removal metadata across restart", async () => {
    const s = await setup()
    const values = new Map<string, string>()
    const storage: AuthStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    }
    const claim = claimAuthRevision(storage)
    const session: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...s.signer.reference,
      authClaim: claim.revision,
    }
    writeAuthSession(session, storage)
    revokeAuthSessionAuthority(session, storage, {
      sessionDisposition: "discard",
    })
    const removal = spyOn(
      LocalKeyStorage.prototype,
      "remove"
    ).mockRejectedValue(new Error("synthetic failure"))
    try {
      await expect(
        retireAuthSession(session, {
          storage,
          withLock: async (task) => task(),
        })
      ).rejects.toThrow()
      expect(readAuthSession(storage) === null).toBe(true)
      expect(
        readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
          session.localKeyRevision
      ).toBe(true)
    } finally {
      removal.mockRestore()
    }
    // The browser storage factory is deliberately restored for the real retry.
    const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: s.factory,
    })
    try {
      await retireAuthSession(session, {
        storage,
        withLock: async (task) => task(),
      })
      expect(readPendingLocalKeyRemoval(storage) === null).toBe(true)
      await expect(
        restoreLocalKeySigner(session, { factory: s.factory })
      ).rejects.toThrow("disconnected")
    } finally {
      if (previous) Object.defineProperty(globalThis, "indexedDB", previous)
      else Reflect.deleteProperty(globalThis, "indexedDB")
    }
  })

  test("unavailable and stalled storage produce bounded content-free failures", async () => {
    const s = await setup()
    const throwing = {
      open() {
        throw new Error("private provider detail")
      },
    } as unknown as IDBFactory
    await expect(
      restoreLocalKeySigner(s.signer.reference, { factory: throwing })
    ).rejects.toThrow("unavailable")
    const stalled = {
      open() {
        return {}
      },
    } as unknown as IDBFactory
    await expect(
      restoreLocalKeySigner(s.signer.reference, {
        factory: stalled,
        timeoutMs: 5,
      })
    ).rejects.toThrow("unavailable")
    await expect(
      removeLocalKeyRecord(s.signer.reference, { factory: throwing })
    ).rejects.toThrow("unavailable")
  })

  test("a persistence-write failure does not import or replace the stored account", async () => {
    const s = await setup()
    const write = spyOn(LocalKeyStorage.prototype, "write").mockRejectedValue(
      new Error("synthetic write failure")
    )
    try {
      await expect(
        prepareLocalKeyImport({ value: s.encoded } as HTMLInputElement, {
          factory: s.factory,
        }).persist(() => true)
      ).rejects.toThrow()
    } finally {
      write.mockRestore()
    }
    expect((await s.signer.getPublicKey()) === s.pubkey).toBe(true)
  })

  test("replacement invalidates old operations and stale deletion preserves the new record", async () => {
    const s = await setup()
    const replacement = await setup(s.factory)
    await expect(s.signer.signEvent(s.event)).rejects.toThrow(
      "authority_changed"
    )
    await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
    expect(
      (await replacement.signer.getPublicKey()) === replacement.pubkey
    ).toBe(true)
  })

  test("same-account reimport advances record revision and fences the old signer", async () => {
    const s = await setup()
    const newer = await prepareLocalKeyImport(
      { value: s.encoded } as HTMLInputElement,
      { factory: s.factory }
    ).persist(() => true)
    disposals.push(() => newer.invalidate())
    expect(
      newer.reference.localKeyRevision !== s.signer.reference.localKeyRevision
    ).toBe(true)
    await expect(s.signer.getPublicKey()).rejects.toThrow("authority_changed")
  })

  test("cancellation before persistence leaves no imported account", async () => {
    const s = await setup()
    const cancellation = new AbortController()
    cancellation.abort()
    const prepared = prepareLocalKeyImport(
      { value: s.encoded } as HTMLInputElement,
      { factory: new IDBFactory() }
    )
    await expect(
      prepared.persist(() => true, cancellation.signal)
    ).rejects.toThrow("authority_changed")
  })

  test("stale async completion and invalidation suppress a pending real signature", async () => {
    const s = await setup()
    const original = LocalKeyStorage.prototype.read
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const read = spyOn(LocalKeyStorage.prototype, "read").mockImplementation(
      async function (this: LocalKeyStorage) {
        const record = await original.call(this)
        if (++calls === 2) await held
        return record
      }
    )
    const pending = s.signer.signEvent(s.event)
    try {
      while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1))
      s.signer.invalidate()
      release()
      await expect(pending).rejects.toThrow("authority_changed")
    } finally {
      release()
      read.mockRestore()
    }
  })

  test("logout cancels pending real local work before deletion finishes", async () => {
    const s = await setup()
    let current = true
    const owner = new SessionSigner(s.signer, {
      expectedPubkey: s.pubkey,
      revision: "synthetic-revision",
      authMethod: "local",
      getCapabilities: () => LOCAL_KEY_CAPABILITIES,
      hasAuthority: () => current,
    })
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const read = LocalKeyStorage.prototype.read
    let first = true
    const reading = spyOn(LocalKeyStorage.prototype, "read").mockImplementation(
      async function (this: LocalKeyStorage) {
        const result = await read.call(this)
        if (first) {
          first = false
          entered()
          await paused
        }
        return result
      }
    )
    try {
      const pending = owner.signEvent(s.event)
      await ready
      current = false
      owner.invalidateLocal()
      s.signer.invalidate()
      await expect(pending).rejects.toThrow("authority_changed")
      await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
    } finally {
      release()
      reading.mockRestore()
    }
    await expect(
      restoreLocalKeySigner(s.signer.reference, { factory: s.factory })
    ).rejects.toThrow("disconnected")
  })

  test("durable removal stays absent after a fresh restore", async () => {
    const s = await setup()
    s.signer.invalidate()
    await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
    await expect(
      restoreLocalKeySigner(s.signer.reference, { factory: s.factory })
    ).rejects.toThrow("disconnected")
  })

  test("failed deletion stays failed and transient invalidation preserves the record", async () => {
    const s = await setup()
    s.signer.invalidate()
    const remove = spyOn(LocalKeyStorage.prototype, "remove").mockRejectedValue(
      new Error("synthetic deletion failure")
    )
    try {
      await expect(
        removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
      ).rejects.toThrow()
    } finally {
      remove.mockRestore()
    }
    const restored = await restoreLocalKeySigner(s.signer.reference, {
      factory: s.factory,
    })
    expect((await restored.getPublicKey()) === s.pubkey).toBe(true)
    restored.invalidate()
    await removeLocalKeyRecord(s.signer.reference, { factory: s.factory })
  })
})

test("local account composes with shared authority, protected reads, revision changes and exact cleanup", async () => {
  const s = await setup()
  const values = new Map<string, string>()
  const storage: AuthStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
  const claim = claimAuthRevision(storage)
  const session: LocalKeyAuthSession = {
    version: 1,
    type: "local",
    ...s.signer.reference,
    authClaim: claim.revision,
  }
  expect(writeAuthSession(session, storage)).toBe(true)
  expect(
    parseAuthSession(JSON.stringify({ ...session, secret: s.encoded })) &&
      !JSON.stringify(
        parseAuthSession(JSON.stringify({ ...session, secret: s.encoded }))
      ).includes(s.encoded)
  ).toBe(true)
  const owner = new SessionSigner(s.signer, {
    expectedPubkey: s.pubkey,
    revision: claim.revision,
    authMethod: "local",
    getCapabilities: () => LOCAL_KEY_CAPABILITIES,
    hasAuthority: () => hasAuthSessionAuthority(session, true, storage),
  })
  const lease = createProtectedReadSessionLifecycle()
  const globalFactory = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: s.factory,
  })
  try {
    installAccountSigner(owner, lease, () =>
      hasAuthSessionAuthority(session, true, storage)
    )
    expect(getAccountSigner() === owner).toBe(true)
    expect(getProtectedReadAuthorization(s.pubkey)?.signer === owner).toBe(true)
    expect(verifyEvent(await owner.signEvent(s.event))).toBe(true)
    const ciphertext = await owner.encryptNip44(s.pubkey, "synthetic")
    expect(
      (await owner.decryptNip44(s.pubkey, ciphertext)) === "synthetic"
    ).toBe(true)
    revokeAuthSessionAuthority(session, storage, {
      sessionDisposition: "discard",
    })
    owner.invalidateLocal()
    s.signer.invalidate()
    await expect(owner.signEvent(s.event)).rejects.toThrow("authority_changed")
    await retireAuthSession(session, {
      storage,
      withLock: async (task) => task(),
    })
    await expect(
      restoreLocalKeySigner(s.signer.reference, { factory: s.factory })
    ).rejects.toThrow("disconnected")
  } finally {
    lease.deactivate()
    retireAccountSigner(owner)
    if (globalFactory)
      Object.defineProperty(globalThis, "indexedDB", globalFactory)
    else Reflect.deleteProperty(globalThis, "indexedDB")
  }
})
