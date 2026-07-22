import { describe, expect, it } from "bun:test"
import { NDKUser } from "@nostr-dev-kit/ndk"
import type { VerifiedEvent } from "nostr-tools"

import {
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  NdkBunkerSignerAdapter,
  RemoteSignerError,
  bumpAuthRevision,
  forgetAuthSession,
  logoutRemoteSigner,
  prepareRemoteSignerSessionStorage,
  pairRemoteSigner,
  parseAuthSession,
  parseBunkerUri,
  persistRemoteSignerSession,
  readAuthRevision,
  rollbackNewRemoteSignerSession,
  readAuthSession,
  restoreRemoteSigner,
  type AuthStorage,
  type Nip46AuthSession,
  type RemoteBunkerSigner,
  type RemoteSignerKeyVault,
} from "../packages/core/src/protocol/remote-signer"

const REMOTE_PUBKEY = "1".repeat(64)
const USER_PUBKEY = "2".repeat(64)
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
  const signedEvent = {
    id: "5".repeat(64),
    sig: "6".repeat(128),
    pubkey: USER_PUBKEY,
    kind: 1,
    content: "",
    tags: [],
    created_at: 1,
  } as VerifiedEvent
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
    signEvent: async () => signedEvent,
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
})

describe("remote signer lifecycle", () => {
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
    let relaySwitches = 0
    const onAuthUrl = () => undefined
    const result = await pairRemoteSigner(BUNKER_URI, {
      keyVault: new MemoryKeyVault(),
      generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
      createBunkerSigner: (_key, pointer, params) => {
        factoryPointer = pointer
        authCallback = params.onauth
        const signer = fakeSigner()
        signer.switchRelays = async () => {
          relaySwitches += 1
          signer.bp.relays = ["wss://migrated.example"]
          return true
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
      relayUrls: ["wss://migrated.example"],
      userPubkey: USER_PUBKEY,
      createdAt: 25,
      updatedAt: 25,
    })
    expect(result.session.clientKeyId).toHaveLength(36)
    expect(result.clientPrivateKey).toBe(CLIENT_PRIVATE_KEY_HEX)
    expect(relaySwitches).toBe(1)
    expect(JSON.stringify(result.session)).not.toContain("pair-secret")
    expect(JSON.stringify(result.session)).not.toContain("bunker://")
    expect(result.session.remoteSignerPubkey).not.toBe(
      result.session.userPubkey
    )
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

  it("rejects an insecure relay migration returned by the signer", async () => {
    await expect(
      pairRemoteSigner(BUNKER_URI, {
        keyVault: new MemoryKeyVault(),
        generateClientPrivateKey: () => CLIENT_PRIVATE_KEY,
        createBunkerSigner: () => {
          const signer = fakeSigner()
          signer.switchRelays = async () => {
            signer.bp.relays = ["ws://insecure.example"]
            return true
          }
          return signer
        },
      })
    ).rejects.toMatchObject({
      code: "invalid_response",
      operation: "relay migration",
    })
  })

  it("restores without a pairing secret and verifies the user identity", async () => {
    let pointerSecret: string | null | undefined
    const restored = await restoreRemoteSigner(session(), {
      keyVault: seededKeyVault(),
      createBunkerSigner: (_key, pointer) => {
        pointerSecret = pointer.secret
        return fakeSigner()
      },
      now: () => 30,
    })
    expect(pointerSecret).toBeNull()
    expect(restored.session.updatedAt).toBe(30)

    await expect(
      restoreRemoteSigner(session(), {
        keyVault: seededKeyVault(),
        createBunkerSigner: () =>
          fakeSigner({ getPublicKey: async () => OTHER_PUBKEY }),
      })
    ).rejects.toMatchObject({ code: "session_identity_mismatch" })
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
    expect(
      await adapter.sign({
        pubkey: USER_PUBKEY,
        kind: 1,
        content: "",
        tags: [],
        created_at: 1,
      })
    ).toBe("6".repeat(128))
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

  it("rejects an altered event returned by the remote signer", async () => {
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
      }),
      USER_PUBKEY
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
