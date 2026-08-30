import { describe, expect, it } from "bun:test"
import { NDKUser } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey, type VerifiedEvent } from "nostr-tools"

import {
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  NdkBunkerSignerAdapter,
  RemoteSignerError,
  bumpAuthRevision,
  claimAuthRevision,
  cleanupInvalidatedAuthSession,
  forgetAuthSession,
  logoutRemoteSigner,
  prepareRemoteSignerSessionStorage,
  pairRemoteSigner,
  pairRemoteSignerFromNostrConnect,
  parseAuthSession,
  parseBunkerUri,
  persistRemoteSignerSession,
  readAuthRevision,
  requiresRemoteSignerSessionCleanup,
  revokeAuthSessionAuthority,
  rollbackAndAbandonRemoteSignerConnection,
  rollbackNewRemoteSignerSession,
  readAuthSession,
  restoreRemoteSigner,
  type AuthStorage,
  type Nip46AuthSession,
  type RemoteBunkerSigner,
  type RemoteSignerAdapterInvalidation,
  type RemoteSignerKeyVault,
} from "../packages/core/src/protocol/remote-signer"

const REMOTE_PUBKEY = "1".repeat(64)
const USER_SECRET = Uint8Array.from([...new Uint8Array(31), 23])
const USER_PUBKEY = getPublicKey(USER_SECRET)
const OTHER_PUBKEY = "3".repeat(64)
const CLIENT_PRIVATE_KEY = new Uint8Array(32).fill(4)
const CLIENT_PRIVATE_KEY_HEX = "04".repeat(32)
const CLIENT_KEY_ID = "client-key-reference"
const BUNKER_URI = `bunker://${REMOTE_PUBKEY}?relay=wss%3A%2F%2Frelay.example&secret=pair-secret`

class MemoryStorage implements AuthStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class MemoryKeyVault implements RemoteSignerKeyVault {
  readonly values = new Map<string, string>()

  async prepare(): Promise<void> {}

  async store(id: string, clientPrivateKey: string): Promise<void> {
    this.values.set(id, clientPrivateKey)
  }

  async load(id: string): Promise<string | null> {
    return this.values.get(id) ?? null
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

function seededKeyVault(): MemoryKeyVault {
  const vault = new MemoryKeyVault()
  vault.values.set(CLIENT_KEY_ID, CLIENT_PRIVATE_KEY_HEX)
  return vault
}

function fakeSigner(
  overrides: Partial<RemoteBunkerSigner> = {}
): RemoteBunkerSigner {
  return {
    bp: {
      pubkey: REMOTE_PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    },
    sendRequest: async (method) => (method === "connect" ? "ack" : "ok"),
    ping: async () => undefined,
    getPublicKey: async () => USER_PUBKEY,
    switchRelays: async () => false,
    signEvent: async (event) => finalizeEvent(event, USER_SECRET),
    nip04Encrypt: async (_pubkey, value) => `04:${value}`,
    nip04Decrypt: async (_pubkey, value) => value.replace("04:", ""),
    nip44Encrypt: async (_pubkey, value) => `44:${value}`,
    nip44Decrypt: async (_pubkey, value) => value.replace("44:", ""),
    logout: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }
}

function session(overrides: Partial<Nip46AuthSession> = {}): Nip46AuthSession {
  return {
    version: 1,
    type: "nip46",
    clientKeyId: CLIENT_KEY_ID,
    remoteSignerPubkey: REMOTE_PUBKEY,
    relayUrls: ["wss://relay.example"],
    userPubkey: USER_PUBKEY,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

describe("remote signer parsing and storage", () => {
  it("checks encrypted browser storage before remote pairing", async () => {
    let prepared = false
    await prepareRemoteSignerSessionStorage({
      prepare: async () => {
        prepared = true
      },
      store: async () => undefined,
      load: async () => null,
      remove: async () => undefined,
    })
    expect(prepared).toBe(true)

    await expect(
      prepareRemoteSignerSessionStorage({
        prepare: async () => {
          throw new TypeError(
            "undefined is not an object (evaluating 'crypto.subtle.generateKey')"
          )
        },
        store: async () => undefined,
        load: async () => null,
        remove: async () => undefined,
      })
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "prepare session storage",
      message: expect.stringContaining("HTTPS"),
    })
  })

  it("accepts only valid signer-issued bunker URIs", () => {
    expect(parseBunkerUri(BUNKER_URI)).toEqual({
      pubkey: REMOTE_PUBKEY,
      relays: ["wss://relay.example"],
      secret: "pair-secret",
    })
    for (const invalid of [
      `nostrconnect://${REMOTE_PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
      `bunker://${REMOTE_PUBKEY}`,
      `bunker://${REMOTE_PUBKEY}?relay=https%3A%2F%2Frelay.example`,
      "not-a-uri",
    ]) {
      expect(() => parseBunkerUri(invalid)).toThrow(RemoteSignerError)
    }
  })

  it("represents legacy raw hex auth as a NIP-07 session", () => {
    expect(parseAuthSession(USER_PUBKEY)).toEqual({
      version: 1,
      type: "nip07",
      userPubkey: USER_PUBKEY,
    })
  })

  it("writes only public session metadata and stores the client key in a vault", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    expect(
      await persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: false,
        },
        storage,
        keyVault
      )
    ).toBe(true)
    expect(readAuthSession(storage)).toEqual(session())
    expect(storage.getItem(AUTH_STORAGE_KEY)).not.toContain("pair-secret")
    expect(storage.getItem(AUTH_STORAGE_KEY)).not.toContain("bunker://")
    expect(storage.getItem(AUTH_STORAGE_KEY)).not.toContain(
      CLIENT_PRIVATE_KEY_HEX
    )
    expect(keyVault.values.get(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)
    expect(forgetAuthSession(storage)).toBe(true)
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it("treats an inaccessible browser storage getter as unavailable", () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window"
    )
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new Error("Storage access denied")
        },
      },
    })

    try {
      expect(readAuthSession()).toBeNull()
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "window")
      }
    }
  })

  it("does not commit a stale remote session after vault persistence", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    expect(
      await persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: false,
        },
        storage,
        keyVault,
        () => false
      )
    ).toBe(false)
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(keyVault.values.has(CLIENT_KEY_ID)).toBe(false)
  })

  it("rolls back a new key when its fencing token is lost after metadata write", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    let checks = 0

    expect(
      await persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: false,
        },
        storage,
        keyVault,
        () => {
          checks += 1
          return checks === 1
        }
      )
    ).toBe(false)
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(keyVault.values.has(CLIENT_KEY_ID)).toBe(false)
  })

  it("preserves matching metadata and key when post-write rollback cannot read storage", async () => {
    const backingStorage = new MemoryStorage()
    let storageReadable = true
    const restrictedStorage: AuthStorage = {
      getItem(key) {
        if (!storageReadable) throw new Error("Storage access denied")
        return backingStorage.getItem(key)
      },
      setItem(key, value) {
        backingStorage.setItem(key, value)
      },
      removeItem(key) {
        backingStorage.removeItem(key)
      },
    }
    const keyVault = new MemoryKeyVault()
    let checks = 0

    await expect(
      persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: false,
        },
        restrictedStorage,
        keyVault,
        () => {
          checks += 1
          if (checks === 2) {
            storageReadable = false
            return false
          }
          return true
        }
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "persist session",
    })
    expect(backingStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull()
    expect(keyVault.values.get(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)
  })

  it("rolls back only the losing pairing key, not winning metadata", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    const winner = session({ clientKeyId: crypto.randomUUID() })
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(winner))
    keyVault.values.set(CLIENT_KEY_ID, CLIENT_PRIVATE_KEY_HEX)

    await rollbackNewRemoteSignerSession(
      {
        session: session(),
        clientKeyAlreadyPersisted: false,
      },
      storage,
      keyVault
    )

    expect(readAuthSession(storage)).toEqual(winner)
    expect(keyVault.values.has(CLIENT_KEY_ID)).toBe(false)
  })

  it("classifies a failed rollback key removal", async () => {
    const storage = new MemoryStorage()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session()))

    await expect(
      rollbackNewRemoteSignerSession(
        {
          session: session(),
          clientKeyAlreadyPersisted: false,
        },
        storage,
        {
          prepare: async () => undefined,
          store: async () => undefined,
          load: async () => null,
          remove: async () => {
            throw new Error("Vault removal failed")
          },
        }
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "rollback session",
    })
  })

  it("does not remove a shared key when a restored session loses its claim", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()

    expect(
      await persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: true,
        },
        storage,
        keyVault,
        () => false
      )
    ).toBe(false)
    expect(keyVault.values.get(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)
  })

  it("removes only stale restored metadata after a post-write fencing loss", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    let checks = 0
    const restored = session({ authClaim: crypto.randomUUID() })

    expect(
      await persistRemoteSignerSession(
        {
          session: restored,
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: true,
        },
        storage,
        keyVault,
        () => {
          checks += 1
          return checks === 1
        }
      )
    ).toBe(false)
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(keyVault.values.get(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)
  })

  it("surfaces a failed rollback instead of orphaning it silently", async () => {
    const storage: AuthStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage blocked")
      },
      removeItem: () => undefined,
    }
    const keyVault = new MemoryKeyVault()
    keyVault.remove = async () => {
      throw new Error("vault blocked")
    }

    await expect(
      persistRemoteSignerSession(
        {
          session: session(),
          clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
          clientKeyAlreadyPersisted: false,
        },
        storage,
        keyVault
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "persist session",
    })
  })

  it("rejects malformed persisted sessions", () => {
    expect(
      parseAuthSession(JSON.stringify(session({ relayUrls: ["http://bad"] })))
    ).toBeNull()
  })

  it("creates a unique cross-tab auth fencing token", () => {
    const storage = new MemoryStorage()

    expect(readAuthRevision(storage)).toBe("")
    const first = bumpAuthRevision(storage)
    const second = bumpAuthRevision(storage)
    expect(first).toHaveLength(36)
    expect(second).toHaveLength(36)
    expect(second).not.toBe(first)
    expect(readAuthRevision(storage)).toBe(second)
    expect(storage.getItem(AUTH_REVISION_STORAGE_KEY)).toBe(second)
  })

  it("does not mistake an older readable revision for a newly acquired claim", () => {
    const storage: AuthStorage = {
      getItem: (key) =>
        key === AUTH_REVISION_STORAGE_KEY ? "account-a-claim" : null,
      setItem: () => {
        throw new Error("storage blocked")
      },
      removeItem: () => undefined,
    }

    const claim = claimAuthRevision(storage)

    expect(claim.persisted).toBe(false)
    expect(claim.revision).not.toBe("account-a-claim")
    expect(readAuthRevision(storage)).toBe("account-a-claim")
  })

  it("proves a new authority claim by reading it back", () => {
    const storage = new MemoryStorage()

    const claim = claimAuthRevision(storage)

    expect(claim.persisted).toBe(true)
    expect(readAuthRevision(storage)).toBe(claim.revision)
  })

  it("retains recovery only behind a fresh verified cross-tab fence", () => {
    const storage = new MemoryStorage()
    const expected = session({ authClaim: "account-a-claim" })
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))
    storage.setItem(AUTH_REVISION_STORAGE_KEY, expected.authClaim!)

    const revocation = revokeAuthSessionAuthority(expected, storage)

    expect(revocation).toEqual({
      freshRevisionPersisted: true,
      authorityRevoked: true,
      sessionRetained: true,
    })
    expect(readAuthRevision(storage)).not.toBe(expected.authClaim)
    expect(readAuthSession(storage)).toEqual(expected)
  })

  it("falls back to verified strict revocation when revision writes are blocked", () => {
    const expected = session({ authClaim: "account-a-claim" })
    const values = new Map<string, string>([
      [AUTH_STORAGE_KEY, JSON.stringify(expected)],
      [AUTH_REVISION_STORAGE_KEY, expected.authClaim!],
    ])
    const storage: AuthStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (key === AUTH_REVISION_STORAGE_KEY) {
          throw new Error("revision writes blocked")
        }
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    }

    const revocation = revokeAuthSessionAuthority(expected, storage)

    expect(revocation).toEqual({
      freshRevisionPersisted: false,
      authorityRevoked: true,
      sessionRetained: false,
    })
    expect(storage.getItem(AUTH_REVISION_STORAGE_KEY)).toBe(expected.authClaim)
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBe(JSON.stringify(expected))
    expect(readAuthSession(storage)).toBeNull()
  })

  it("durably rejects a strict session while cleanup is waiting for the auth lock", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session({ authClaim: "strict-session-claim" })
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))
    storage.setItem(AUTH_REVISION_STORAGE_KEY, expected.authClaim!)
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })

    const revocation = revokeAuthSessionAuthority(expected, storage, {
      sessionDisposition: "discard",
    })
    const cleanup = cleanupInvalidatedAuthSession(expected, {
      storage,
      keyVault,
      withLock: async (task) => {
        await cleanupGate
        return task()
      },
    })

    expect(revocation).toEqual({
      freshRevisionPersisted: true,
      authorityRevoked: true,
      sessionRetained: false,
    })
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBe(JSON.stringify(expected))
    expect(readAuthSession(storage)).toBeNull()
    expect(await keyVault.load(expected.clientKeyId)).toBe(
      CLIENT_PRIVATE_KEY_HEX
    )

    let signerContacts = 0
    await expect(
      restoreRemoteSigner(expected, {
        authStorage: storage,
        keyVault,
        createBunkerSigner: () => {
          signerContacts += 1
          return fakeSigner()
        },
      })
    ).rejects.toMatchObject({
      code: "credential_unavailable",
      operation: "load saved session",
    })
    expect(signerContacts).toBe(0)

    releaseCleanup?.()
    await expect(cleanup).resolves.toBe("removed")
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(await keyVault.load(expected.clientKeyId)).toBeNull()
  })

  it("does not claim revocation when shared storage cannot be changed", () => {
    const expected = session({ authClaim: "account-a-claim" })
    const values = new Map<string, string>([
      [AUTH_STORAGE_KEY, JSON.stringify(expected)],
      [AUTH_REVISION_STORAGE_KEY, expected.authClaim!],
    ])
    const storage: AuthStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: () => {
        throw new Error("writes blocked")
      },
      removeItem: () => {
        throw new Error("removal blocked")
      },
    }

    expect(revokeAuthSessionAuthority(expected, storage)).toEqual({
      freshRevisionPersisted: false,
      authorityRevoked: false,
      sessionRetained: false,
    })
  })

  it("does not hide or remove a concurrent replacement when marking strict revocation", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session({ authClaim: "account-a-claim" })
    const replacement = session({
      clientKeyId: "replacement-client-key",
      userPubkey: OTHER_PUBKEY,
      authClaim: "account-b-claim",
    })
    keyVault.values.set(replacement.clientKeyId, "05".repeat(32))
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))

    expect(
      revokeAuthSessionAuthority(expected, storage, {
        sessionDisposition: "discard",
      })
    ).toMatchObject({ authorityRevoked: true, sessionRetained: false })
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(replacement))

    expect(readAuthSession(storage)).toEqual(replacement)
    await expect(
      cleanupInvalidatedAuthSession(expected, { storage, keyVault })
    ).resolves.toBe("replacement")
    expect(readAuthSession(storage)).toEqual(replacement)
    expect(await keyVault.load(expected.clientKeyId)).toBeNull()
    expect(await keyVault.load(replacement.clientKeyId)).toBe("05".repeat(32))
  })

  it("surfaces a blocked auth lock without claiming cleanup", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))

    await expect(
      cleanupInvalidatedAuthSession(expected, {
        storage,
        keyVault,
        withLock: async () => {
          throw new Error("lock blocked")
        },
      })
    ).rejects.toThrow("lock blocked")
    expect(readAuthSession(storage)).toEqual(expected)
    expect(keyVault.values.has(expected.clientKeyId)).toBe(true)
  })

  it("verifies exact invalidated metadata and key retirement", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))

    await expect(
      cleanupInvalidatedAuthSession(expected, { storage, keyVault })
    ).resolves.toBe("removed")
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(keyVault.values.has(expected.clientKeyId)).toBe(false)
  })

  it("preserves replacement metadata while retiring a distinct old key", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session()
    const replacement = session({
      clientKeyId: "replacement-client-key",
      userPubkey: OTHER_PUBKEY,
      authClaim: "account-b-claim",
    })
    keyVault.values.set(replacement.clientKeyId, "05".repeat(32))
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(replacement))

    await expect(
      cleanupInvalidatedAuthSession(expected, { storage, keyVault })
    ).resolves.toBe("replacement")
    expect(readAuthSession(storage)).toEqual(replacement)
    expect(keyVault.values.has(expected.clientKeyId)).toBe(false)
    expect(keyVault.values.has(replacement.clientKeyId)).toBe(true)
  })

  it("never removes a replacement session's shared client key", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session({ authClaim: "account-a-claim" })
    const replacement = session({
      updatedAt: 20,
      authClaim: "replacement-claim",
    })
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(replacement))

    await expect(
      cleanupInvalidatedAuthSession(expected, {
        storage,
        keyVault,
        retireExpectedKeyOnMetadataFailure: true,
      })
    ).resolves.toBe("replacement")
    expect(readAuthSession(storage)).toEqual(replacement)
    expect(keyVault.values.has(expected.clientKeyId)).toBe(true)
  })

  it("retires the exact key on explicit discard when auth metadata is unreadable", async () => {
    const expected = session()
    const storage: AuthStorage = {
      getItem: () => {
        throw new Error("storage unreadable")
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    const keyVault = seededKeyVault()

    await expect(
      cleanupInvalidatedAuthSession(expected, {
        storage,
        keyVault,
        retireExpectedKeyOnMetadataFailure: true,
      })
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The browser could not verify the saved signer session.",
      operation: "retire invalidated signer session",
    })
    expect(await keyVault.load(expected.clientKeyId)).toBeNull()
  })

  it("rejects silently blocked metadata removal before deleting the key", async () => {
    const expected = session()
    const values = new Map<string, string>([
      [AUTH_STORAGE_KEY, JSON.stringify(expected)],
    ])
    const storage: AuthStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: () => undefined,
    }
    const keyVault = seededKeyVault()

    await expect(
      cleanupInvalidatedAuthSession(expected, { storage, keyVault })
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "retire invalidated signer session",
    })
    expect(keyVault.values.has(expected.clientKeyId)).toBe(true)
  })

  it("surfaces key retirement failure after verified metadata removal", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const expected = session()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(expected))
    keyVault.remove = async () => {
      throw new Error("vault blocked")
    }

    await expect(
      cleanupInvalidatedAuthSession(expected, { storage, keyVault })
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "retire invalidated signer session",
    })
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(keyVault.values.has(expected.clientKeyId)).toBe(true)
  })
})

describe("remote signer lifecycle", () => {
  it("rolls back and abandons a newly persisted uncommitted connection", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    let logoutCalls = 0
    const bunkerSigner = fakeSigner({
      logout: async () => {
        logoutCalls += 1
      },
    })
    const connection = await pairRemoteSigner(BUNKER_URI, {
      keyVault,
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: () => bunkerSigner,
    })

    expect(
      await persistRemoteSignerSession(connection, storage, keyVault)
    ).toBe(true)
    expect(readAuthSession(storage)).toEqual(connection.session)
    expect(keyVault.values.has(connection.session.clientKeyId)).toBe(true)

    await rollbackAndAbandonRemoteSignerConnection(
      connection,
      storage,
      keyVault
    )

    expect(readAuthSession(storage)).toBeNull()
    expect(keyVault.values.has(connection.session.clientKeyId)).toBe(false)
    expect(logoutCalls).toBe(1)
    await expect(
      connection.signer.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "payload"
      )
    ).rejects.toThrow("session is unavailable")
  })

  it("preserves a restored session when its uncommitted connection is abandoned", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const storedSession = session()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(storedSession))
    let logoutCalls = 0
    let closeCalls = 0
    const bunkerSigner = fakeSigner({
      logout: async () => {
        logoutCalls += 1
      },
      close: async () => {
        closeCalls += 1
      },
    })
    const connection = await restoreRemoteSigner(storedSession, {
      keyVault,
      createBunkerSigner: () => bunkerSigner,
      now: () => 20,
    })

    expect(
      await persistRemoteSignerSession(connection, storage, keyVault)
    ).toBe(true)

    await rollbackAndAbandonRemoteSignerConnection(
      connection,
      storage,
      keyVault
    )

    expect(readAuthSession(storage)).toEqual(connection.session)
    expect(keyVault.values.get(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)
    expect(logoutCalls).toBe(0)
    expect(closeCalls).toBe(1)
    await expect(
      connection.signer.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "payload"
      )
    ).rejects.toThrow("session is unavailable")
  })

  it("preserves the key and metadata when rollback storage cannot be read", async () => {
    const backingStorage = new MemoryStorage()
    let storageReadable = true
    const restrictedStorage: AuthStorage = {
      getItem(key) {
        if (!storageReadable) throw new Error("Storage access denied")
        return backingStorage.getItem(key)
      },
      setItem(key, value) {
        backingStorage.setItem(key, value)
      },
      removeItem(key) {
        backingStorage.removeItem(key)
      },
    }
    const keyVault = new MemoryKeyVault()
    let logoutCalls = 0
    const bunkerSigner = fakeSigner({
      logout: async () => {
        logoutCalls += 1
      },
    })
    const connection = await pairRemoteSigner(BUNKER_URI, {
      keyVault,
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: () => bunkerSigner,
    })

    expect(
      await persistRemoteSignerSession(connection, restrictedStorage, keyVault)
    ).toBe(true)
    storageReadable = false

    await expect(
      rollbackAndAbandonRemoteSignerConnection(
        connection,
        restrictedStorage,
        keyVault
      )
    ).rejects.toMatchObject({
      operation: "rollback session",
    })
    expect(backingStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull()
    expect(keyVault.values.has(connection.session.clientKeyId)).toBe(true)
    expect(logoutCalls).toBe(1)
    await expect(
      connection.signer.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "payload"
      )
    ).rejects.toThrow("session is unavailable")
  })

  it("does not contact the signer when encrypted storage is unavailable", async () => {
    let signerCreated = false
    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: {
          prepare: async () => {
            throw new Error("SubtleCrypto unavailable")
          },
          store: async () => undefined,
          load: async () => null,
          remove: async () => undefined,
        },
        createBunkerSigner: () => {
          signerCreated = true
          return fakeSigner()
        },
      })
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "prepare session storage",
    })
    expect(signerCreated).toBe(false)
  })

  it("pairs with generated client key and never persists URI secrets", async () => {
    let factoryPointer:
      { pubkey: string; relays: string[]; secret: string | null } | undefined
    let authCallback: ((url: string) => void) | undefined
    const onAuthUrl = () => undefined
    const result = await pairRemoteSigner(BUNKER_URI, {
      keyVault: new MemoryKeyVault(),
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: (_key, pointer, params) => {
        factoryPointer = pointer
        authCallback = params.onauth
        const signer = fakeSigner()
        signer.switchRelays = async () => {
          throw new Error("relay migration must not run during pairing")
        }
        return signer
      },
      onAuthUrl,
      now: () => 25,
    })

    expect(factoryPointer?.pubkey).toBe(REMOTE_PUBKEY)
    expect(factoryPointer?.secret).toBe("pair-secret")
    expect(authCallback).toBe(onAuthUrl)
    expect(result.session).toMatchObject({
      version: 1,
      type: "nip46",
      remoteSignerPubkey: REMOTE_PUBKEY,
      relayUrls: ["wss://relay.example"],
      userPubkey: USER_PUBKEY,
      createdAt: 25,
      updatedAt: 25,
    })
    expect(result.session.clientKeyId).toHaveLength(36)
    expect(result.clientPrivateKey).toBe(CLIENT_PRIVATE_KEY_HEX)
    expect(JSON.stringify(result.session)).not.toContain("pair-secret")
    expect(JSON.stringify(result.session)).not.toContain("bunker://")
    expect(result.session.remoteSignerPubkey).not.toBe(
      result.session.userPubkey
    )
  })

  it("creates an official one-use nostrconnect URI before listening", async () => {
    const calls: string[] = []
    let emittedUri = ""
    const result = await pairRemoteSignerFromNostrConnect(
      ["wss://one.example", "wss://two.example"],
      {
        keyVault: {
          prepare: async () => {
            calls.push("prepare")
          },
          store: async () => undefined,
          load: async () => null,
          remove: async () => undefined,
        },
        generateClientPrivateKey: () => {
          calls.push("key")
          return CLIENT_PRIVATE_KEY
        },
        generatePairingSecret: () => {
          calls.push("secret")
          return "one-use-secret"
        },
        onNostrConnectUri: (uri) => {
          calls.push("callback")
          emittedUri = uri
        },
        createNostrConnectSigner: async (_key, uri, params) => {
          calls.push("listen")
          expect(uri).toBe(emittedUri)
          expect(params.skipSwitchRelays).toBe(true)
          return fakeSigner({
            bp: {
              pubkey: REMOTE_PUBKEY,
              relays: ["wss://one.example", "wss://two.example"],
              secret: "one-use-secret",
            },
            switchRelays: async () => {
              throw new Error("relay migration must not run during pairing")
            },
          })
        },
        clientMetadata: {
          name: "Conduit",
          url: "https://conduit.market",
        },
        now: () => 40,
      }
    )

    expect(calls).toEqual(["prepare", "key", "secret", "callback", "listen"])
    const parsed = new URL(emittedUri)
    expect(parsed.protocol).toBe("nostrconnect:")
    expect(parsed.hostname).toBe(getPublicKey(CLIENT_PRIVATE_KEY))
    expect(parsed.searchParams.getAll("relay")).toEqual([
      "wss://one.example",
      "wss://two.example",
    ])
    expect(parsed.searchParams.get("secret")).toBe("one-use-secret")
    expect(parsed.searchParams.get("perms")?.split(",")).toEqual([
      "sign_event",
      "get_public_key",
      "nip44_encrypt",
      "nip44_decrypt",
      "nip04_decrypt",
    ])
    expect(parsed.searchParams.get("name")).toBe("Conduit")
    expect(result.session).toMatchObject({
      remoteSignerPubkey: REMOTE_PUBKEY,
      userPubkey: USER_PUBKEY,
      relayUrls: ["wss://one.example", "wss://two.example"],
    })
    expect(result.bunkerSigner.bp.secret).toBeNull()
    expect(JSON.stringify(result.session)).not.toContain("one-use-secret")
    expect(JSON.stringify(result.session)).not.toContain("nostrconnect://")
    const storage = new MemoryStorage()
    expect(
      await persistRemoteSignerSession(result, storage, new MemoryKeyVault())
    ).toBe(true)
    expect(storage.getItem(AUTH_STORAGE_KEY)).not.toContain("one-use-secret")
    expect(storage.getItem(AUTH_STORAGE_KEY)).not.toContain("nostrconnect://")
  })

  it("closes a bunker pairing when the caller cancels", async () => {
    const controller = new AbortController()
    let closed = false
    let started: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const pairing = pairRemoteSigner(BUNKER_URI, {
      keyVault: new MemoryKeyVault(),
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      signal: controller.signal,
      createBunkerSigner: () =>
        fakeSigner({
          sendRequest: () => {
            started?.()
            return new Promise(() => undefined)
          },
          close: async () => {
            closed = true
          },
        }),
    })

    await requestStarted
    controller.abort()

    await expect(pairing).rejects.toMatchObject({
      code: "rejected",
      operation: "connect",
    })
    expect(closed).toBe(true)
  })

  it("prepares the vault before nostrconnect key generation or listening", async () => {
    let generated = false
    let listened = false
    await expect(
      pairRemoteSignerFromNostrConnect(
        ["wss://one.example", "wss://two.example"],
        {
          keyVault: {
            prepare: async () => {
              throw new Error("vault unavailable")
            },
            store: async () => undefined,
            load: async () => null,
            remove: async () => undefined,
          },
          generateClientPrivateKey: () => {
            generated = true
            return CLIENT_PRIVATE_KEY
          },
          createNostrConnectSigner: async () => {
            listened = true
            return fakeSigner()
          },
        }
      )
    ).rejects.toMatchObject({ operation: "prepare session storage" })
    expect(generated).toBe(false)
    expect(listened).toBe(false)
  })

  it("aborts and closes timed-out nostrconnect listeners", async () => {
    let listenerAborted = false
    await expect(
      pairRemoteSignerFromNostrConnect(
        ["wss://one.example", "wss://two.example"],
        {
          keyVault: new MemoryKeyVault(),
          generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
          generatePairingSecret: () => "timeout-secret",
          createNostrConnectSigner: (_key, _uri, _params, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  listenerAborted = true
                  reject(new Error("aborted"))
                },
                { once: true }
              )
            }),
          timeoutMs: 1,
        }
      )
    ).rejects.toMatchObject({
      code: "timeout",
      operation: "nostrconnect pairing",
    })
    expect(listenerAborted).toBe(true)
  })

  it("does not leave a listener open after caller abort", async () => {
    const controller = new AbortController()
    let listenerAborted = false
    let markListenerStarted: (() => void) | undefined
    const listenerStarted = new Promise<void>((resolve) => {
      markListenerStarted = resolve
    })
    const pairing = pairRemoteSignerFromNostrConnect(
      ["wss://one.example", "wss://two.example"],
      {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        generatePairingSecret: () => "abort-secret",
        signal: controller.signal,
        createNostrConnectSigner: (_key, _uri, _params, signal) =>
          new Promise((_resolve, reject) => {
            markListenerStarted?.()
            signal.addEventListener(
              "abort",
              () => {
                listenerAborted = true
                reject(new Error("aborted"))
              },
              { once: true }
            )
          }),
      }
    )

    await listenerStarted
    controller.abort()
    await expect(pairing).rejects.toMatchObject({
      code: "rejected",
      operation: "nostrconnect pairing",
    })
    expect(listenerAborted).toBe(true)
  })

  it("rejects invalid response identity and insecure connected relays", async () => {
    await expect(
      pairRemoteSignerFromNostrConnect(
        ["wss://one.example", "wss://two.example"],
        {
          keyVault: new MemoryKeyVault(),
          generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
          generatePairingSecret: () => "identity-secret",
          createNostrConnectSigner: async () =>
            fakeSigner({
              bp: {
                pubkey: "bad",
                relays: ["wss://one.example"],
                secret: null,
              },
            }),
        }
      )
    ).rejects.toMatchObject({ code: "invalid_response" })

    await expect(
      pairRemoteSignerFromNostrConnect(
        ["wss://one.example", "wss://two.example"],
        {
          keyVault: new MemoryKeyVault(),
          generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
          generatePairingSecret: () => "user-secret",
          createNostrConnectSigner: async () =>
            fakeSigner({ getPublicKey: async () => "bad" }),
        }
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      operation: "get public key",
    })

    await expect(
      pairRemoteSignerFromNostrConnect(
        ["wss://one.example", "wss://two.example"],
        {
          keyVault: new MemoryKeyVault(),
          generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
          generatePairingSecret: () => "relay-secret",
          createNostrConnectSigner: async () =>
            fakeSigner({
              bp: {
                pubkey: REMOTE_PUBKEY,
                relays: ["ws://insecure.example"],
                secret: "relay-secret",
              },
            }),
        }
      )
    ).rejects.toMatchObject({
      code: "invalid_response",
      operation: "nostrconnect pairing",
    })
  })

  it("returns typed timeout and rejection errors", async () => {
    const never = new Promise<void>(() => undefined)
    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        createBunkerSigner: () =>
          fakeSigner({ sendRequest: () => never as Promise<string> }),
        timeoutMs: 1,
      })
    ).rejects.toMatchObject({ code: "timeout", operation: "connect" })

    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        createBunkerSigner: () =>
          fakeSigner({
            sendRequest: async () => {
              throw new Error("User rejected request")
            },
          }),
      })
    ).rejects.toMatchObject({ code: "rejected", operation: "connect" })
  })

  it("requires an official or secret-echo connection acknowledgement", async () => {
    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        createBunkerSigner: () =>
          fakeSigner({ sendRequest: async () => "unexpected" }),
      })
    ).rejects.toMatchObject({
      code: "invalid_response",
      operation: "connect",
    })

    const paired = await pairRemoteSigner(BUNKER_URI, {
      keyVault: new MemoryKeyVault(),
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: () =>
        fakeSigner({ sendRequest: async () => "pair-secret" }),
    })
    expect(paired.session.userPubkey).toBe(USER_PUBKEY)
  })

  it("rejects insecure connected relays before creating a session", async () => {
    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        createBunkerSigner: () =>
          fakeSigner({
            bp: {
              pubkey: REMOTE_PUBKEY,
              relays: ["ws://insecure.example"],
              secret: "pair-secret",
            },
          }),
      })
    ).rejects.toMatchObject({
      code: "invalid_response",
      operation: "session setup",
    })
  })

  it("restores without a pairing secret and verifies the user identity", async () => {
    let pointerSecret: string | null | undefined
    const restored = await restoreRemoteSigner(session(), {
      keyVault: seededKeyVault(),
      createBunkerSigner: (_key, pointer) => {
        pointerSecret = pointer.secret
        return fakeSigner({
          switchRelays: async () => {
            throw new Error("relay migration must not run during restore")
          },
        })
      },
      now: () => 30,
    })
    expect(pointerSecret).toBeNull()
    expect(restored.session.updatedAt).toBe(30)
    expect(restored.session.relayUrls).toEqual(["wss://relay.example"])
    expect(restored.bunkerSigner.bp.relays).toEqual(["wss://relay.example"])

    await expect(
      restoreRemoteSigner(session(), {
        keyVault: seededKeyVault(),
        createBunkerSigner: () =>
          fakeSigner({ getPublicKey: async () => OTHER_PUBKEY }),
      })
    ).rejects.toMatchObject({ code: "session_identity_mismatch" })
  })

  it("retains a timed-out session for explicit restore without signing automatically", async () => {
    const storage = new MemoryStorage()
    const keyVault = new MemoryKeyVault()
    const connection = await pairRemoteSigner(BUNKER_URI, {
      keyVault,
      timeoutMs: 1,
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: () =>
        fakeSigner({
          nip44Encrypt: () => new Promise(() => undefined),
        }),
    })
    expect(
      await persistRemoteSignerSession(connection, storage, keyVault)
    ).toBe(true)
    const savedSession = readAuthSession(storage)
    const savedMetadata = storage.getItem(AUTH_STORAGE_KEY)

    await expect(
      connection.signer.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "plaintext",
        "nip44"
      )
    ).rejects.toMatchObject({ code: "timeout" })

    expect(storage.getItem(AUTH_STORAGE_KEY)).toBe(savedMetadata)
    expect(await keyVault.load(connection.session.clientKeyId)).toBe(
      CLIENT_PRIVATE_KEY_HEX
    )

    let signCalls = 0
    const restored = await restoreRemoteSigner(
      savedSession as Nip46AuthSession,
      {
        keyVault,
        createBunkerSigner: () =>
          fakeSigner({
            signEvent: async (event) => {
              signCalls += 1
              return finalizeEvent(event, USER_SECRET)
            },
          }),
      }
    )
    expect(signCalls).toBe(0)

    await restored.signer.sign({
      pubkey: USER_PUBKEY,
      kind: 1,
      content: "explicit retry",
      tags: [],
      created_at: 1,
    })
    expect(signCalls).toBe(1)
  })

  it("retains saved material after a restore timeout for a later explicit attempt", async () => {
    const storage = new MemoryStorage()
    const keyVault = seededKeyVault()
    const savedSession = session()
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(savedSession))
    let closeCalls = 0

    await expect(
      restoreRemoteSigner(savedSession, {
        keyVault,
        timeoutMs: 1,
        createBunkerSigner: () =>
          fakeSigner({
            ping: () => new Promise(() => undefined),
            close: async () => {
              closeCalls += 1
            },
          }),
      })
    ).rejects.toMatchObject({
      code: "timeout",
      operation: "restore ping",
    })
    expect(closeCalls).toBe(1)
    expect(readAuthSession(storage)).toEqual(savedSession)
    expect(await keyVault.load(CLIENT_KEY_ID)).toBe(CLIENT_PRIVATE_KEY_HEX)

    await expect(
      restoreRemoteSigner(savedSession, {
        keyVault,
        createBunkerSigner: () => fakeSigner(),
      })
    ).resolves.toMatchObject({
      session: { userPubkey: USER_PUBKEY },
    })
  })

  it("classifies unreadable saved credentials for strict cleanup before contact", async () => {
    let factoryCalls = 0
    let failure: unknown
    try {
      await restoreRemoteSigner(session(), {
        keyVault: {
          prepare: async () => undefined,
          store: async () => undefined,
          load: async () => {
            throw new Error("storage blocked")
          },
          remove: async () => undefined,
        },
        createBunkerSigner: () => {
          factoryCalls += 1
          return fakeSigner()
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: "credential_unavailable",
      operation: "load saved credential",
    })
    expect(requiresRemoteSignerSessionCleanup(failure)).toBe(true)
    expect(factoryCalls).toBe(0)
  })

  it("always closes after best-effort logout", async () => {
    const calls: string[] = []
    await logoutRemoteSigner(
      fakeSigner({
        logout: async () => {
          calls.push("logout")
          throw new Error("offline")
        },
        close: async () => {
          calls.push("close")
        },
      })
    )
    expect(calls).toEqual(["logout", "close"])
  })
})

describe("NDK remote signer adapter", () => {
  it("supports signing and NIP-44/NIP-04 encryption methods", async () => {
    const adapter = new NdkBunkerSignerAdapter(fakeSigner(), USER_PUBKEY)
    const peer = new NDKUser({ pubkey: OTHER_PUBKEY })

    expect(await adapter.encryptionEnabled()).toEqual(["nip04", "nip44"])
    expect(await adapter.encryptionEnabled("nip44")).toEqual(["nip44"])
    expect(await adapter.encrypt(peer, "hello", "nip44")).toBe("44:hello")
    expect(await adapter.decrypt(peer, "44:hello", "nip44")).toBe("hello")
    expect(await adapter.encrypt(peer, "hello", "nip04")).toBe("04:hello")
    expect(await adapter.decrypt(peer, "04:hello", "nip04")).toBe("hello")
    const signature = await adapter.sign({
      pubkey: USER_PUBKEY,
      kind: 1,
      content: "",
      tags: [],
      created_at: 1,
    })
    expect(signature).toHaveLength(128)
    expect((await adapter.user()).pubkey).toBe(USER_PUBKEY)
  })

  it("applies per-operation timeouts", async () => {
    let closeCalls = 0
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        nip44Encrypt: () => new Promise(() => undefined),
        close: async () => {
          closeCalls += 1
        },
      }),
      USER_PUBKEY,
      { timeoutMs: 1 }
    )
    await expect(
      adapter.encrypt(new NDKUser({ pubkey: OTHER_PUBKEY }), "hello", "nip44")
    ).rejects.toMatchObject({ code: "timeout", operation: "nip44 encrypt" })
    expect(closeCalls).toBe(1)
    await expect(
      adapter.encrypt(new NDKUser({ pubkey: OTHER_PUBKEY }), "again", "nip44")
    ).rejects.toMatchObject({ code: "unavailable" })
  })

  it("emits one recoverable lifecycle transition for a timed-out adapter", async () => {
    let encryptCalls = 0
    let closeCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        nip44Encrypt: () => {
          encryptCalls += 1
          return new Promise(() => undefined)
        },
        close: async () => {
          closeCalls += 1
        },
      }),
      USER_PUBKEY,
      {
        timeoutMs: 1,
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )

    let causalError: RemoteSignerError | null = null
    try {
      await adapter.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "hello",
        "nip44"
      )
    } catch (error) {
      if (error instanceof RemoteSignerError) causalError = error
    }

    expect(causalError).toMatchObject({
      code: "timeout",
      operation: "nip44 encrypt",
    })
    expect(transitions).toHaveLength(1)
    expect(transitions[0]).toMatchObject({
      reason: "request_timeout",
      source: adapter,
      sessionDisposition: "retain_for_restore",
      error: causalError,
    })

    await expect(
      adapter.encrypt(new NDKUser({ pubkey: OTHER_PUBKEY }), "again", "nip44")
    ).rejects.toMatchObject({ code: "unavailable", cause: causalError })
    expect(encryptCalls).toBe(1)
    expect(closeCalls).toBe(1)
    expect(transitions).toHaveLength(1)
  })

  it("closes and emits only once when concurrent requests time out", async () => {
    let closeCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        nip44Encrypt: () => new Promise(() => undefined),
        nip44Decrypt: () => new Promise(() => undefined),
        close: async () => {
          closeCalls += 1
        },
      }),
      USER_PUBKEY,
      {
        timeoutMs: 1,
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )
    const peer = new NDKUser({ pubkey: OTHER_PUBKEY })

    const results = await Promise.allSettled([
      adapter.encrypt(peer, "plaintext", "nip44"),
      adapter.decrypt(peer, "ciphertext", "nip44"),
    ])

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])
    expect(transitions).toHaveLength(1)
    expect(closeCalls).toBe(1)
  })

  it("does not emit a stale failure after manual disposal", async () => {
    let closeCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        nip44Encrypt: () => new Promise(() => undefined),
        close: async () => {
          closeCalls += 1
        },
      }),
      USER_PUBKEY,
      {
        timeoutMs: 1,
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )

    const request = adapter.encrypt(
      new NDKUser({ pubkey: OTHER_PUBKEY }),
      "plaintext",
      "nip44"
    )
    adapter.invalidate()

    await expect(request).rejects.toMatchObject({ code: "timeout" })
    expect(transitions).toEqual([])
    expect(closeCalls).toBe(0)
  })

  it("does not let a lifecycle callback replace the causal error", async () => {
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        nip44Encrypt: () => new Promise(() => undefined),
      }),
      USER_PUBKEY,
      {
        timeoutMs: 1,
        onAdapterInvalidated: () => {
          throw new Error("UI callback failed")
        },
      }
    )

    await expect(
      adapter.encrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "plaintext",
        "nip44"
      )
    ).rejects.toMatchObject({
      code: "timeout",
      operation: "nip44 encrypt",
    })
  })

  it("rejects an altered event returned by the remote signer", async () => {
    let encryptCalls = 0
    let closeCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        signEvent: async (event) =>
          ({
            ...event,
            content: "changed",
            id: "5".repeat(64),
            sig: "6".repeat(128),
            pubkey: USER_PUBKEY,
          }) as VerifiedEvent,
        nip44Encrypt: async () => {
          encryptCalls += 1
          return "ciphertext"
        },
        close: async () => {
          closeCalls += 1
        },
      }),
      USER_PUBKEY,
      {
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )

    await expect(
      adapter.sign({
        pubkey: USER_PUBKEY,
        kind: 1,
        content: "original",
        tags: [],
        created_at: 1,
      })
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      adapter.encrypt(new NDKUser({ pubkey: OTHER_PUBKEY }), "secret", "nip44")
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(encryptCalls).toBe(0)
    expect(closeCalls).toBe(1)
    expect(transitions).toHaveLength(1)
    expect(transitions[0]).toMatchObject({
      reason: "integrity_failure",
      sessionDisposition: "discard",
    })
  })

  it("rejects a signer that mutates submitted tags in place", async () => {
    const tags = [["subject", "original"]]
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        signEvent: async (event) => {
          event.tags[0]![1] = "changed"
          return finalizeEvent(event, USER_SECRET)
        },
      }),
      USER_PUBKEY
    )

    await expect(
      adapter.sign({
        pubkey: USER_PUBKEY,
        kind: 1,
        content: "original",
        tags,
        created_at: 1,
      })
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(tags).toEqual([["subject", "original"]])
  })

  it("invalidates the adapter when the remote signer changes accounts", async () => {
    let decryptCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        signEvent: async (event) =>
          ({
            ...event,
            id: "5".repeat(64),
            sig: "6".repeat(128),
            pubkey: OTHER_PUBKEY,
          }) as VerifiedEvent,
        nip44Decrypt: async () => {
          decryptCalls += 1
          return "plaintext"
        },
      }),
      USER_PUBKEY,
      {
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )

    await expect(
      adapter.sign({
        pubkey: USER_PUBKEY,
        kind: 1,
        content: "original",
        tags: [],
        created_at: 1,
      })
    ).rejects.toMatchObject({ code: "session_identity_mismatch" })
    await expect(
      adapter.decrypt(
        new NDKUser({ pubkey: OTHER_PUBKEY }),
        "ciphertext",
        "nip44"
      )
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(decryptCalls).toBe(0)
    expect(transitions[0]).toMatchObject({
      reason: "integrity_failure",
      sessionDisposition: "discard",
      error: { code: "session_identity_mismatch" },
    })
  })

  it("rejects an invalid signature over an unchanged remote event", async () => {
    let encryptCalls = 0
    const transitions: RemoteSignerAdapterInvalidation[] = []
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({
        signEvent: async (event) => ({
          ...finalizeEvent(event, USER_SECRET),
          sig: "0".repeat(128),
        }),
        nip44Encrypt: async () => {
          encryptCalls += 1
          return "ciphertext"
        },
      }),
      USER_PUBKEY,
      {
        onAdapterInvalidated: (transition) => transitions.push(transition),
      }
    )

    await expect(
      adapter.sign({
        pubkey: USER_PUBKEY,
        kind: 1,
        content: "original",
        tags: [],
        created_at: 1,
      })
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      adapter.encrypt(new NDKUser({ pubkey: OTHER_PUBKEY }), "secret", "nip44")
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(encryptCalls).toBe(0)
    expect(transitions[0]).toMatchObject({
      reason: "integrity_failure",
      sessionDisposition: "discard",
      error: { code: "invalid_response" },
    })
  })

  it("rejects an in-flight operation after the session is invalidated", async () => {
    let resolveSigned: ((event: VerifiedEvent) => void) | undefined
    const signed = new Promise<VerifiedEvent>((resolve) => {
      resolveSigned = resolve
    })
    const adapter = new NdkBunkerSignerAdapter(
      fakeSigner({ signEvent: () => signed }),
      USER_PUBKEY
    )
    const request = adapter.sign({
      pubkey: USER_PUBKEY,
      kind: 1,
      content: "",
      tags: [],
      created_at: 1,
    })
    adapter.invalidate()
    resolveSigned?.({
      id: "5".repeat(64),
      sig: "6".repeat(128),
      pubkey: USER_PUBKEY,
      kind: 1,
      content: "",
      tags: [],
      created_at: 1,
    } as VerifiedEvent)

    await expect(request).rejects.toMatchObject({ code: "unavailable" })
  })
})
