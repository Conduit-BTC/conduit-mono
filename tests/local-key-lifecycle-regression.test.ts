import { expect, spyOn, test } from "bun:test"
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb"
import { generateSecretKey } from "nostr-tools/pure"
import { nsecEncode } from "nostr-tools/nip19"
import {
  prepareLocalKeyImport,
  restoreLocalKeySigner,
  removeLocalKeyRecord,
  reconcileLocalKeyRecord,
  LOCAL_KEY_CAPABILITIES,
} from "../packages/core/src/protocol/local-key"
import {
  LocalKeyStorage,
  clearRecord,
} from "../packages/core/src/protocol/local-key/storage"
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
  await removeLocalKeyRecord(first.reference, {
    factory,
    predecessor: "retire",
    replacement: second.reference,
  })
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

for (const [selection, malformed] of (
  ["candidate", "predecessor", "unreadable", "external"] as const
).flatMap((selection) =>
  [false, true].map((malformed) => [selection, malformed] as const)
)) {
  test(`retirement coordinates staged lineage with ${selection} metadata; malformed=${malformed}`, async () => {
    const factory = new IDBFactory()
    const old = await prepare(factory).persist(() => true)
    await old.commit(() => true)
    const candidate = await prepare(factory).persist(() => true)
    if (malformed) {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = factory.open("conduit-local-key", 1)
        request.onsuccess = () => resolve(request.result)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("record", "readwrite")
          const store = tx.objectStore("record")
          const read = store.get("candidate")
          read.onsuccess = () => {
            store.put({ ...read.result, version: 0 }, "candidate")
            clearRecord(read.result)
          }
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(new Error("FIXTURE_CORRUPTION_FAILED"))
        })
      } finally {
        db.close()
      }
    }
    const session: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...candidate.reference,
    }
    const previous: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...old.reference,
    }
    const values = new Map<string, string>()
    let unreadable = false
    const storage: AuthStorage = {
      getItem(key) {
        if (unreadable && key === AUTH_STORAGE_KEY)
          throw new Error("synthetic read failure")
        return values.get(key) ?? null
      },
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    }
    writeAuthSession(
      selection === "external"
        ? { version: 1, type: "nip07", userPubkey: previous.userPubkey }
        : selection === "predecessor"
          ? previous
          : session,
      storage
    )
    unreadable = selection === "unreadable"
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: factory,
    })
    try {
      const retire = () =>
        retireAuthSession(session, {
          storage,
          withLock: async (task) => task(),
          retireExpectedCredentialsOnMetadataFailure: true,
        })
      if (unreadable) {
        await expect(retire()).rejects.toThrow("removal is incomplete")
        unreadable = false
        expect(
          readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
            session.localKeyRevision
        ).toBe(true)
        // The journal prevents restoration; both records remain available for
        // exact lineage deletion once selection can be verified again.
        if (!malformed) {
          const retained = await new LocalKeyStorage({ factory }).read(
            session.localKeyRevision
          )
          expect(retained?.revision === session.localKeyRevision).toBe(true)
          clearRecord(retained)
        }
      }
      await retire()
      expect(readPendingLocalKeyRemoval(storage)).toBeNull()
      await expect(
        restoreLocalKeySigner(session, { factory })
      ).rejects.toThrow()
      if (selection === "predecessor") {
        const restored = await restoreLocalKeySigner(previous, { factory })
        expect((await restored.getPublicKey()) === previous.userPubkey).toBe(
          true
        )
        restored.invalidate()
      } else {
        if (selection === "external")
          expect(readAuthSession(storage)?.type).toBe("nip07")
        else expect(readAuthSession(storage)).toBeNull()
        expect(await new LocalKeyStorage({ factory }).read()).toBeNull()
      }
    } finally {
      old.invalidate()
      candidate.invalidate()
      if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor)
      else Reflect.deleteProperty(globalThis, "indexedDB")
    }
  })
}

async function recordOperation(
  factory: IDBFactory,
  slot: "active" | "candidate",
  apply: (value: unknown, store: IDBObjectStore) => void
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("conduit-local-key", 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error("FIXTURE_OPEN_FAILED"))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("record", "readwrite")
      const store = tx.objectStore("record")
      const read = store.get(slot)
      read.onsuccess = () => {
        try {
          apply(read.result, store)
        } finally {
          clearRecord(read.result)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(new Error("FIXTURE_TRANSACTION_FAILED"))
    })
  } finally {
    db.close()
  }
}

async function withFixture(
  slot: "active" | "candidate",
  run: (fixture: {
    factory: IDBFactory
    session: LocalKeyAuthSession
    secret: Uint8Array
    storage: AuthStorage
    values: Map<string, string>
    retire: () => ReturnType<typeof retireAuthSession>
  }) => Promise<void>
) {
  const factory = new IDBFactory()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
  })
  const secret = generateSecretKey()
  try {
    const signer = await prepareLocalKeyImport({
      value: nsecEncode(secret),
    } as HTMLInputElement).persist(() => true)
    if (slot === "active") await signer.commit(() => true)
    const session: LocalKeyAuthSession = {
      version: 1,
      type: "local",
      ...signer.reference,
    }
    signer.invalidate()
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
    expect(writeAuthSession(session, storage)).toBe(true)
    await run({
      factory,
      session,
      secret,
      storage,
      values,
      retire: () =>
        retireAuthSession(session, {
          storage,
          withLock: async (task) => task(),
        }),
    })
  } finally {
    secret.fill(0)
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor)
    else Reflect.deleteProperty(globalThis, "indexedDB")
  }
}

for (const slot of ["active", "candidate"] as const) {
  for (const malformed of [false, true]) {
    test(`retirement erases exact ${slot} bytes before clearing retry metadata; malformed=${malformed}`, async () => {
      await withFixture(slot, async ({ factory, secret, storage, retire }) => {
        await recordOperation(factory, slot, (value, store) => {
          store.put({ ...(value as object), version: malformed ? 0 : 1 }, slot)
        })
        await retire()
        expect(readAuthSession(storage) === null).toBe(true)
        expect(readPendingLocalKeyRemoval(storage) === null).toBe(true)
        let absent = false
        let retained = false
        await recordOperation(factory, slot, (value) => {
          absent = value === undefined
          const bytes = (value as { secret?: Uint8Array } | undefined)?.secret
          retained =
            bytes instanceof Uint8Array &&
            bytes.every((byte, i) => byte === secret[i])
        })
        expect(absent).toBe(true)
        expect(retained).toBe(false)
      })
    })
  }

  test(`stale retirement preserves a different revision with damaged ${slot} schema`, async () => {
    await withFixture(slot, async ({ factory, session, retire }) => {
      const replacementRevision = crypto.randomUUID()
      await recordOperation(factory, slot, (value, store) => {
        store.put(
          { ...(value as object), version: 0, revision: replacementRevision },
          slot
        )
      })
      await retire()
      let preserved = false
      await recordOperation(factory, slot, (value) => {
        preserved =
          (value as { revision?: string })?.revision === replacementRevision
      })
      expect(preserved).toBe(true)
      expect(session.localKeyRevision === replacementRevision).toBe(false)
    })
  })
}

for (const failure of ["deletion", "metadata"] as const) {
  test(`malformed candidate ${failure} failure retains journal until restart retry succeeds`, async () => {
    await withFixture(
      "candidate",
      async ({ factory, session, storage, values, retire }) => {
        await recordOperation(factory, "candidate", (value, store) => {
          store.put({ ...(value as object), version: 0 }, "candidate")
        })
        const originalRemove = storage.removeItem
        let deletion: ReturnType<typeof spyOn> | undefined
        try {
          if (failure === "deletion") {
            deletion = spyOn(
              FakeObjectStore.prototype,
              "delete"
            ).mockImplementation(() => {
              throw new Error("SYNTHETIC_DELETE_FAILURE")
            })
          } else {
            storage.removeItem = (key) => {
              if (key === AUTH_STORAGE_KEY)
                throw new Error("SYNTHETIC_METADATA_FAILURE")
              originalRemove(key)
            }
          }
          await expect(retire()).rejects.toThrow(
            failure === "deletion" ? "removal is incomplete" : "could not erase"
          )
          expect(
            readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
              session.localKeyRevision
          ).toBe(true)
        } finally {
          deletion?.mockRestore()
          storage.removeItem = originalRemove
        }
        // Fresh public metadata reads model restart recovery, without restore's
        // candidate reconciliation masking a failed explicit retirement.
        const restartedStorage: AuthStorage = {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value)
          },
          removeItem: (key) => {
            values.delete(key)
          },
        }
        const pending = readPendingLocalKeyRemoval(restartedStorage)
        expect(pending !== null).toBe(true)
        await retireAuthSession(pending!, {
          storage: restartedStorage,
          withLock: async (task) => task(),
        })
        expect(readAuthSession(restartedStorage) === null).toBe(true)
        expect(readPendingLocalKeyRemoval(restartedStorage) === null).toBe(true)
        let absent = false
        await recordOperation(factory, "candidate", (value) => {
          absent = value === undefined
        })
        expect(absent).toBe(true)
      }
    )
  })
}

test("unidentifiable candidate retains removal journal and visible retry failure", async () => {
  await withFixture(
    "candidate",
    async ({ factory, session, storage, retire }) => {
      await recordOperation(factory, "candidate", (value, store) => {
        store.put({ ...(value as object), revision: null }, "candidate")
      })
      await expect(retire()).rejects.toThrow("removal is incomplete")
      expect(
        readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
          session.localKeyRevision
      ).toBe(true)
      let retained = false
      await recordOperation(factory, "candidate", (value) => {
        retained = value !== undefined
      })
      expect(retained).toBe(true)
    }
  )
})

for (const missing of ["lineage", "predecessor identity"] as const) {
  test(`malformed candidate with unknown ${missing} preserves both slots for verified retry`, async () => {
    await withFixture(
      "candidate",
      async ({ factory, session, secret, storage, retire }) => {
        const predecessorRevision = crypto.randomUUID()
        await recordOperation(factory, "active", (_value, store) => {
          store.put(
            {
              version: 0,
              revision:
                missing === "predecessor identity" ? null : predecessorRevision,
              secret,
            },
            "active"
          )
        })
        await recordOperation(factory, "candidate", (value, store) => {
          store.put(
            {
              ...(value as object),
              version: 0,
              previousRevision:
                missing === "lineage" ? undefined : predecessorRevision,
            },
            "candidate"
          )
        })
        await expect(retire()).rejects.toThrow("removal is incomplete")
        expect(
          readPendingLocalKeyRemoval(storage)?.localKeyRevision ===
            session.localKeyRevision
        ).toBe(true)
        for (const slot of ["active", "candidate"] as const) {
          let retained = false
          await recordOperation(factory, slot, (value) => {
            retained = value !== undefined
          })
          expect(retained).toBe(true)
        }
        // Repair only the synthetic damaged public identities, then retry through
        // the actual journal path; signing-schema validity is still absent.
        await recordOperation(factory, "active", (value, store) => {
          store.put(
            { ...(value as object), revision: predecessorRevision },
            "active"
          )
        })
        await recordOperation(factory, "candidate", (value, store) => {
          store.put(
            { ...(value as object), previousRevision: predecessorRevision },
            "candidate"
          )
        })
        await retireAuthSession(readPendingLocalKeyRemoval(storage)!, {
          storage,
          withLock: async (task) => task(),
        })
        for (const slot of ["active", "candidate"] as const) {
          let absent = false
          await recordOperation(factory, slot, (value) => {
            absent = value === undefined
          })
          expect(absent).toBe(true)
        }
        expect(readPendingLocalKeyRemoval(storage) === null).toBe(true)
      }
    )
  })
}
