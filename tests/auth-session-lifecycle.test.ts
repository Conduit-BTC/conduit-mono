import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import {
  connectNip07SignerForAuth,
  resolveFailedAuthAttempt,
} from "../packages/core/src/context/AuthContext"
import {
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  claimAuthRevision,
  hasAuthSessionAuthority,
  parseAuthSession,
  readAuthSession,
  resolveAuthConnectionMethod,
  revokeAuthSessionAuthority,
  writeAuthSession,
  type AuthSession,
  type AuthStorage,
} from "../packages/core/src/protocol/auth-session"
import { retireAuthSession } from "../packages/core/src/protocol/auth-session-lifecycle"
import { createProtectedReadSessionLifecycle } from "../packages/core/src/protocol/protected-read-session-lifecycle"
import { getProtectedReadAuthorization } from "../packages/core/src/protocol/protected-read-authorization"
import {
  pairRemoteSigner,
  persistRemoteSignerSession,
  restoreRemoteSigner,
  rollbackAndAbandonRemoteSignerConnection,
  type RemoteBunkerSigner,
} from "../packages/core/src/protocol/remote-signer"
import type { RemoteSignerKeyVault } from "../packages/core/src/protocol/remote-signer-vault"
import {
  getAccountSigner,
  installAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"

const secret = generateSecretKey()
const pubkey = getPublicKey(secret)
const remotePubkey = getPublicKey(generateSecretKey())
const capabilities = { signEvent: true, nip44: true, nip04Decrypt: true }
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const leases: ReturnType<typeof createProtectedReadSessionLifecycle>[] = []
const owners: SessionSigner[] = []

function storage(): AuthStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
function vault() {
  const values = new Map<string, string>()
  const keyVault: RemoteSignerKeyVault = {
    prepare: async () => undefined,
    store: async (id, key) => {
      values.set(id, key)
    },
    load: async (id) => values.get(id) ?? null,
    remove: async (id) => {
      values.delete(id)
    },
  }
  return { values, keyVault }
}
function remote(
  overrides: Partial<RemoteBunkerSigner> = {}
): RemoteBunkerSigner {
  return {
    bp: {
      pubkey: remotePubkey,
      relays: ["wss://signer.example"],
      secret: null,
    },
    sendRequest: async (method) => (method === "switch_relays" ? null : "ack"),
    ping: async () => undefined,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
    nip44Encrypt: async (_peer, text) => text,
    nip44Decrypt: async (_peer, text) => text,
    nip04Encrypt: async (_peer, text) => text,
    nip04Decrypt: async (_peer, text) => text,
    logout: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }
}
function lifecycle() {
  const result = createProtectedReadSessionLifecycle()
  leases.push(result)
  return result
}
function bind(
  provider: ConstructorParameters<typeof SessionSigner>[0],
  session: AuthSession,
  store: AuthStorage
) {
  const signer = new SessionSigner(provider, {
    expectedPubkey: session.userPubkey,
    revision: session.authClaim!,
    authMethod: session.type,
    getCapabilities: () => capabilities,
    hasAuthority: () => hasAuthSessionAuthority(session, true, store),
  })
  owners.push(signer)
  return signer
}
function claimed(session: AuthSession, store: AuthStorage): AuthSession {
  const claim = claimAuthRevision(store)
  expect(claim.persisted).toBe(true)
  return { ...session, authClaim: claim.revision }
}
const draft = {
  pubkey,
  kind: 1,
  created_at: 1_700_000_000,
  tags: [],
  content: "synthetic",
}

afterEach(() => {
  leases.splice(0).forEach((lease) => lease.deactivate())
  owners.splice(0).forEach(retireAccountSigner)
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

describe("composed auth session ownership", () => {
  it("connects and restores NIP-07 through the shared claim and installed owner", async () => {
    const store = storage()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: store,
        nostr: {
          getPublicKey: async () => pubkey,
          signEvent: async (event: typeof draft) =>
            finalizeEvent(event, secret),
        },
      },
    })
    for (const mode of ["interactive", "restore"] as const) {
      const saved = readAuthSession(store)
      expect(resolveAuthConnectionMethod(mode, saved)).toBe("nip07")
      const connected = await connectNip07SignerForAuth(mode)
      const session = claimed(
        { version: 1, type: "nip07", userPubkey: connected.pubkey },
        store
      )
      expect(writeAuthSession(session, store)).toBe(true)
      const signer = bind(connected.signer, session, store)
      installAccountSigner(signer, lifecycle(), () =>
        hasAuthSessionAuthority(session, true, store)
      )
      expect(getAccountSigner()).toBe(signer)
      expect(getProtectedReadAuthorization(pubkey)?.signer).toBe(signer)
      expect(verifyEvent(await signer.signEvent(draft))).toBe(true)
    }
    expect(owners[0]!.revision).not.toBe(owners[1]!.revision)
    await expect(owners[0]!.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("pairs, restores and reconnects the same NIP-46 credential without stale cleanup deleting it", async () => {
    const store = storage()
    const { keyVault, values } = vault()
    const connection = await pairRemoteSigner(
      `bunker://${remotePubkey}?relay=wss%3A%2F%2Fsigner.example`,
      { keyVault, createBunkerSigner: () => remote() }
    )
    connection.session = claimed(
      connection.session,
      store
    ) as typeof connection.session
    expect(await persistRemoteSignerSession(connection, store, keyVault)).toBe(
      true
    )
    const first = bind(connection.signer, connection.session, store)
    installAccountSigner(first, lifecycle(), () =>
      hasAuthSessionAuthority(connection.session, true, store)
    )
    const oldSession = { ...connection.session }
    const restored = await restoreRemoteSigner(connection.session, {
      authStorage: store,
      keyVault,
      createBunkerSigner: () => remote(),
    })
    restored.session = claimed(
      restored.session,
      store
    ) as typeof restored.session
    expect(await persistRemoteSignerSession(restored, store, keyVault)).toBe(
      true
    )
    const second = bind(restored.signer, restored.session, store)
    installAccountSigner(second, lifecycle(), () =>
      hasAuthSessionAuthority(restored.session, true, store)
    )
    expect(verifyEvent(await second.signEvent(draft))).toBe(true)
    expect(getAccountSigner()).toBe(second)
    await expect(first.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(
      await retireAuthSession(oldSession, { storage: store, keyVault })
    ).toBe("replacement")
    expect(values.has(restored.session.clientKeyId)).toBe(true)
    expect(readAuthSession(store)).toEqual(restored.session)
  })

  for (const restored of [false, true]) {
    it(`failed ${restored ? "restored" : "new"} NIP-46 installation exposes no account and ${restored ? "preserves" : "rolls back"} credentials`, async () => {
      const store = storage()
      const { keyVault, values } = vault()
      let closes = 0
      let logouts = 0
      const provider = () =>
        remote({
          close: async () => {
            closes++
          },
          logout: async () => {
            logouts++
          },
        })
      let connection = await pairRemoteSigner(
        `bunker://${remotePubkey}?relay=wss%3A%2F%2Fsigner.example`,
        { keyVault, createBunkerSigner: provider }
      )
      if (restored) {
        expect(
          await persistRemoteSignerSession(connection, store, keyVault)
        ).toBe(true)
        connection = await restoreRemoteSigner(connection.session, {
          authStorage: store,
          keyVault,
          createBunkerSigner: provider,
        })
      }
      connection.session = claimed(
        connection.session,
        store
      ) as typeof connection.session
      expect(
        await persistRemoteSignerSession(connection, store, keyVault)
      ).toBe(true)
      const signer = bind(connection.signer, connection.session, store)
      const failedLease = createProtectedReadSessionLifecycle({
        install: () => {
          throw new Error("synthetic installation failure")
        },
        remove: () => undefined,
      })
      expect(() =>
        installAccountSigner(signer, failedLease, () => true)
      ).toThrow("synthetic installation failure")
      const resolution = await resolveFailedAuthAttempt({
        failure: new Error("synthetic installation failure"),
        uncommittedRemote: connection,
        remotePersistenceStarted: true,
        getAttemptState: () => ({
          attemptIsCurrent: true,
          attemptOwnsEpoch: true,
          replacementActive: false,
        }),
        rollbackAndAbandon: (attempt) =>
          rollbackAndAbandonRemoteSignerConnection(attempt, store, keyVault),
      })
      expect(resolution.kind).toBe("continue")
      expect(getAccountSigner()).toBeUndefined()
      expect(getProtectedReadAuthorization(pubkey)).toBeNull()
      expect(values.has(connection.session.clientKeyId)).toBe(restored)
      expect(readAuthSession(store)).toEqual(
        restored ? connection.session : null
      )
      expect(restored ? closes : logouts).toBe(1)
    })
  }

  it("rejects pending operation results synchronously on logout before credential cleanup settles", async () => {
    const store = storage()
    const { keyVault, values } = vault()
    let release!: (value: string) => void
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
      started = resolve
    })
    const connection = await pairRemoteSigner(
      `bunker://${remotePubkey}?relay=wss%3A%2F%2Fsigner.example`,
      {
        keyVault,
        createBunkerSigner: () =>
          remote({
            nip44Encrypt: async () => {
              started()
              return new Promise((resolve) => {
                release = resolve
              })
            },
          }),
      }
    )
    connection.session = claimed(
      connection.session,
      store
    ) as typeof connection.session
    expect(await persistRemoteSignerSession(connection, store, keyVault)).toBe(
      true
    )
    const signer = bind(connection.signer, connection.session, store)
    const reads = lifecycle()
    installAccountSigner(signer, reads, () =>
      hasAuthSessionAuthority(connection.session, true, store)
    )
    const pending = signer.encryptNip44(pubkey, "synthetic")
    const rejected = pending.catch((error: unknown) => error)
    await dispatched
    expect(
      revokeAuthSessionAuthority(connection.session, store, {
        sessionDisposition: "discard",
      }).authorityRevoked
    ).toBe(true)
    reads.deactivate()
    retireAccountSigner(signer)
    expect(await rejected).toMatchObject({ code: "authority_changed" })
    expect(values.has(connection.session.clientKeyId)).toBe(true)
    expect(getAccountSigner()).toBeUndefined()
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    release("late synthetic result")
    await retireAuthSession(connection.session, { storage: store, keyVault })
    expect(values.size).toBe(0)
    expect(readAuthSession(store)).toBeNull()
  })

  it("rolls back the protected lease when authority changes during installation", async () => {
    const store = storage()
    const session = claimed(
      { version: 1, type: "nip07", userPubkey: pubkey },
      store
    )
    expect(writeAuthSession(session, store)).toBe(true)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        nostr: {
          getPublicKey: async () => pubkey,
          signEvent: async (event: typeof draft) =>
            finalizeEvent(event, secret),
        },
      },
    })
    const connected = await connectNip07SignerForAuth("interactive")
    const signer = bind(connected.signer, session, store)
    let removed = 0
    const reads = createProtectedReadSessionLifecycle({
      install: (_signer, expectedPubkey) => {
        store.setItem(AUTH_REVISION_STORAGE_KEY, "another-tab")
        return { sessionScope: "synthetic", expectedPubkey }
      },
      remove: () => {
        removed++
      },
    })
    expect(() =>
      installAccountSigner(signer, reads, () =>
        hasAuthSessionAuthority(session, true, store)
      )
    ).toThrow()
    expect(removed).toBe(1)
    expect(reads.currentLease()).toBeNull()
    expect(getAccountSigner()).toBeUndefined()
    await expect(signer.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("cancels pairing without disturbing an installed replacement, even after late approval", async () => {
    const store = storage()
    const { keyVault, values } = vault()
    const saved = claimed(
      { version: 1, type: "nip07", userPubkey: pubkey },
      store
    )
    expect(writeAuthSession(saved, store)).toBe(true)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        nostr: {
          getPublicKey: async () => pubkey,
          signEvent: async (event: typeof draft) =>
            finalizeEvent(event, secret),
        },
      },
    })
    const connected = await connectNip07SignerForAuth("interactive")
    const winner = bind(connected.signer, saved, store)
    installAccountSigner(winner, lifecycle(), () =>
      hasAuthSessionAuthority(saved, true, store)
    )
    const controller = new AbortController()
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
      started = resolve
    })
    let approve!: (value: string) => void
    let closed = 0
    const pairing = pairRemoteSigner(
      `bunker://${remotePubkey}?relay=wss%3A%2F%2Fsigner.example`,
      {
        keyVault,
        signal: controller.signal,
        createBunkerSigner: () =>
          remote({
            sendRequest: async () => {
              started()
              return new Promise((resolve) => {
                approve = resolve
              })
            },
            close: async () => {
              closed++
            },
          }),
      }
    ).catch((error: unknown) => error)
    await dispatched
    controller.abort()
    expect(await pairing).toMatchObject({ code: "rejected" })
    approve("ack")
    await Promise.resolve()
    expect(closed).toBe(1)
    expect(values.size).toBe(0)
    expect(readAuthSession(store)).toEqual(saved)
    expect(getAccountSigner()).toBe(winner)
    expect(verifyEvent(await winner.signEvent(draft))).toBe(true)
  })

  it("retires an old provider credential while preserving a different account's metadata and owner", async () => {
    const store = storage()
    const { keyVault, values } = vault()
    const old = await pairRemoteSigner(
      `bunker://${remotePubkey}?relay=wss%3A%2F%2Fsigner.example`,
      { keyVault, createBunkerSigner: () => remote() }
    )
    old.session = claimed(old.session, store) as typeof old.session
    expect(await persistRemoteSignerSession(old, store, keyVault)).toBe(true)
    const first = bind(old.signer, old.session, store)
    installAccountSigner(first, lifecycle(), () =>
      hasAuthSessionAuthority(old.session, true, store)
    )
    const nextSecret = generateSecretKey()
    const nextPubkey = getPublicKey(nextSecret)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        nostr: {
          getPublicKey: async () => nextPubkey,
          signEvent: async (event: typeof draft) =>
            finalizeEvent(event, nextSecret),
        },
      },
    })
    const connected = await connectNip07SignerForAuth("interactive")
    const replacement = claimed(
      { version: 1, type: "nip07", userPubkey: connected.pubkey },
      store
    )
    expect(writeAuthSession(replacement, store)).toBe(true)
    const second = bind(connected.signer, replacement, store)
    installAccountSigner(second, lifecycle(), () =>
      hasAuthSessionAuthority(replacement, true, store)
    )
    expect(
      await retireAuthSession(old.session, { storage: store, keyVault })
    ).toBe("replacement")
    expect(values.size).toBe(0)
    expect(readAuthSession(store)).toEqual(replacement)
    expect(getAccountSigner()).toBe(second)
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    expect(getProtectedReadAuthorization(nextPubkey)?.signer).toBe(second)
    await expect(first.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(
      verifyEvent(await second.signEvent({ ...draft, pubkey: nextPubkey }))
    ).toBe(true)
  })

  it("keeps restore dispatch and unpersisted NIP-07 metadata distinct from current authority", () => {
    const store = storage()
    const saved = claimed(
      { version: 1, type: "nip07", userPubkey: pubkey },
      store
    )
    expect(hasAuthSessionAuthority(saved, false, store)).toBe(true)
    expect(hasAuthSessionAuthority(saved, true, store)).toBe(false)
    expect(() =>
      resolveAuthConnectionMethod("restore", saved, "nip46")
    ).toThrow("saved signer method changed")
    store.setItem(AUTH_REVISION_STORAGE_KEY, "another-tab")
    expect(hasAuthSessionAuthority(saved, false, store)).toBe(false)
    expect(
      parseAuthSession(
        JSON.stringify({
          version: 1,
          type: "local",
          userPubkey: pubkey,
        })
      )
    ).toBeNull()
    expect(store.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })
})
