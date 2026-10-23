import { expect, spyOn, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { generateSecretKey } from "nostr-tools/pure"
import { nsecEncode } from "nostr-tools/nip19"
import {
  prepareLocalKeyImport,
  restoreLocalKeySigner,
  removeLocalKeyRecord,
  reconcileLocalKeyRecord,
  LOCAL_KEY_CAPABILITIES,
} from "../packages/core/src/protocol/local-key"
import { LocalKeyStorage } from "../packages/core/src/protocol/local-key/storage"
import {
  AUTH_STORAGE_KEY,
  claimAuthRevision,
  hasAuthSessionAuthority,
  readAuthSession,
  readPendingLocalKeyRemoval,
  revokeAuthSessionAuthority,
  rollbackAuthSession,
  writeAuthSession,
  type AuthStorage,
  type LocalKeyAuthSession,
} from "../packages/core/src/protocol/auth-session"
import { retireAuthSession } from "../packages/core/src/protocol/auth-session-lifecycle"
import {
  SessionSigner,
  installAccountSigner,
  retireAccountSigner,
  getAccountSigner,
} from "../packages/core/src/protocol/session-signer"
import { createProtectedReadSessionLifecycle } from "../packages/core/src/protocol/protected-read-session-lifecycle"

function prepare(factory: IDBFactory) {
  const secret = generateSecretKey()
  try {
    return prepareLocalKeyImport(
      { value: nsecEncode(secret) } as HTMLInputElement,
      { factory }
    )
  } finally {
    secret.fill(0)
  }
}

test("cancellation after replacement write preserves the previous restorable key", async () => {
  const factory = new IDBFactory()
  const previous = await prepare(factory).persist(() => true)
  await previous.commit(() => true)
  let current = true
  const original = LocalKeyStorage.prototype.write
  const write = spyOn(LocalKeyStorage.prototype, "write").mockImplementation(
    async function (this: LocalKeyStorage, ...args) {
      await original.apply(this, args)
      current = false
    }
  )
  try {
    await expect(prepare(factory).persist(() => current)).rejects.toThrow(
      "authority_changed"
    )
    const restored = await restoreLocalKeySigner(previous.reference, {
      factory,
    })
    expect(
      (await restored.getPublicKey()) === previous.reference.userPubkey
    ).toBe(true)
    restored.invalidate()
  } finally {
    write.mockRestore()
    previous.invalidate()
  }
})

test("partial storage failure leaves verified removal recovery after reload", async () => {
  const factory = new IDBFactory()
  const signer = await prepare(factory).persist(() => true)
  await signer.commit(() => true)
  const session: LocalKeyAuthSession = {
    version: 1,
    type: "local",
    ...signer.reference,
  }
  const values = new Map<string, string>()
  let failing = false
  const storage: AuthStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (failing && key !== AUTH_STORAGE_KEY)
        throw new Error("synthetic storage failure")
      values.set(key, value)
    },
    removeItem(key) {
      if (failing) throw new Error("synthetic storage failure")
      values.delete(key)
    },
  }
  writeAuthSession(session, storage)
  failing = true
  signer.invalidate()
  revokeAuthSessionAuthority(session, storage, {
    sessionDisposition: "discard",
  })
  const removal = spyOn(LocalKeyStorage.prototype, "remove").mockRejectedValue(
    new Error("synthetic deletion failure")
  )
  try {
    await expect(
      retireAuthSession(session, { storage, withLock: async (task) => task() })
    ).rejects.toThrow()
    failing = false
    // New reads model a restart after the transient storage outage ends.
    expect(readAuthSession(storage) === null).toBe(true)
    expect(
      readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
        session.localKeyRevision
    ).toBe(true)
  } finally {
    removal.mockRestore()
  }
  const globalFactory = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
  })
  try {
    await retireAuthSession(session, {
      storage,
      withLock: async (task) => task(),
    })
    expect(readPendingLocalKeyRemoval(storage)).toBeNull()
    expect(readAuthSession(storage)).toBeNull()
    await expect(restoreLocalKeySigner(session, { factory })).rejects.toThrow(
      "disconnected"
    )
  } finally {
    if (globalFactory)
      Object.defineProperty(globalThis, "indexedDB", globalFactory)
    else Reflect.deleteProperty(globalThis, "indexedDB")
  }
})

for (const failure of ["metadata", "installation", "promotion"] as const) {
  test(`replacement ${failure} failure restores the previous account and removes only the candidate`, async () => {
    const factory = new IDBFactory()
    const old = await prepare(factory).persist(() => true)
    await old.commit(() => true)
    const values = new Map<string, string>()
    let blockMetadata = false
    const storage: AuthStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem(key, value) {
        if (blockMetadata && key === AUTH_STORAGE_KEY)
          throw new Error("synthetic write failure")
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    }
    const previous: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...old.reference,
      authClaim: claimAuthRevision(storage).revision,
    }
    writeAuthSession(previous, storage)
    const candidate = await prepare(factory).persist(() => true)
    const session: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...candidate.reference,
      authClaim: claimAuthRevision(storage).revision,
    }
    const hasAuthority = () => hasAuthSessionAuthority(session, true, storage)
    const owner = new SessionSigner(candidate, {
      expectedPubkey: session.userPubkey,
      revision: session.authClaim!,
      authMethod: "local",
      getCapabilities: () => LOCAL_KEY_CAPABILITIES,
      hasAuthority,
    })
    const lease = createProtectedReadSessionLifecycle(
      failure === "installation"
        ? {
            install: () => {
              throw new Error("synthetic installation failure")
            },
            remove: () => {},
          }
        : undefined
    )
    const promotion =
      failure === "promotion"
        ? spyOn(LocalKeyStorage.prototype, "commit").mockRejectedValue(
            new Error("synthetic commit failure")
          )
        : null
    try {
      blockMetadata = failure === "metadata"
      await expect(
        (async () => {
          if (!writeAuthSession(session, storage))
            throw new Error("synthetic metadata failure")
          installAccountSigner(owner, lease, hasAuthority)
          await candidate.commit(hasAuthority)
        })()
      ).rejects.toThrow()
      owner.invalidateLocal()
      retireAccountSigner(owner)
      lease.deactivate()
      candidate.invalidate()
      blockMetadata = false
      expect(rollbackAuthSession(session, previous, storage)).toBe(true)
      await removeLocalKeyRecord(session, { factory })
      expect(
        readAuthSession(storage)?.localKeyRevision === previous.localKeyRevision
      ).toBe(true)
      const restored = await restoreLocalKeySigner(previous, { factory })
      expect((await restored.getPublicKey()) === previous.userPubkey).toBe(true)
      expect(getAccountSigner()).toBeUndefined()
      restored.invalidate()
      await expect(
        restoreLocalKeySigner(session, { factory })
      ).rejects.toThrow()
    } finally {
      promotion?.mockRestore()
      owner.invalidateLocal()
      retireAccountSigner(owner)
      lease.deactivate()
      old.invalidate()
      candidate.invalidate()
    }
  })
}

test("concurrent replacement cannot evict a staged key or delete a later committed account", async () => {
  const factory = new IDBFactory()
  const old = await prepare(factory).persist(() => true)
  await old.commit(() => true)
  const first = await prepare(factory).persist(() => true)
  await expect(prepare(factory).persist(() => true)).rejects.toThrow(
    "authority_changed"
  )
  expect((await old.getPublicKey()) === old.reference.userPubkey).toBe(true)
  await first.commit(() => true)
  await expect(old.getPublicKey()).rejects.toThrow("authority_changed")
  const second = await prepare(factory).persist(() => true)
  await second.commit(() => true)
  await removeLocalKeyRecord(first.reference, { factory })
  expect((await second.getPublicKey()) === second.reference.userPubkey).toBe(
    true
  )
  old.invalidate()
  first.invalidate()
  second.invalidate()
})

test("restart reconciles abandoned staging and completes a persisted installation", async () => {
  const factory = new IDBFactory()
  const old = await prepare(factory).persist(() => true)
  await old.commit(() => true)
  const abandoned = await prepare(factory).persist(() => true)
  abandoned.invalidate()
  await reconcileLocalKeyRecord(old.reference, { factory })
  await expect(
    restoreLocalKeySigner(abandoned.reference, { factory })
  ).rejects.toThrow()
  const candidate = await prepare(factory).persist(() => true)
  candidate.invalidate()
  await reconcileLocalKeyRecord(candidate.reference, { factory })
  const restarted = await restoreLocalKeySigner(candidate.reference, {
    factory,
  })
  await restarted.commit(() => true)
  expect(
    (await restarted.getPublicKey()) === candidate.reference.userPubkey
  ).toBe(true)
  await expect(
    restoreLocalKeySigner(old.reference, { factory })
  ).rejects.toThrow()
  old.invalidate()
  restarted.invalidate()
})

test("complete persistence and deletion failure explicitly reports unresolved restart safety", async () => {
  const factory = new IDBFactory()
  const signer = await prepare(factory).persist(() => true)
  await signer.commit(() => true)
  const session: LocalKeyAuthSession = {
    version: 1,
    type: "local",
    ...signer.reference,
  }
  const raw = JSON.stringify(session)
  const storage: AuthStorage = {
    getItem: (key) => (key === AUTH_STORAGE_KEY ? raw : null),
    setItem: () => {
      throw new Error("synthetic storage failure")
    },
    removeItem: () => {
      throw new Error("synthetic storage failure")
    },
  }
  const removal = spyOn(LocalKeyStorage.prototype, "remove").mockRejectedValue(
    new Error("synthetic deletion failure")
  )
  try {
    signer.invalidate()
    revokeAuthSessionAuthority(session, storage, {
      sessionDisposition: "discard",
    })
    await expect(
      retireAuthSession(session, { storage, withLock: async (task) => task() })
    ).rejects.toThrow("restart safety could not be secured")
  } finally {
    removal.mockRestore()
  }
})
