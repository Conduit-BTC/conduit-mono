import { afterEach, describe, expect, it, mock } from "bun:test"
import { readFile } from "node:fs/promises"
import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure"
import {
  connectNip07SignerForAuth,
  getNip07Capabilities,
  hasNip07,
  isTransientNip07ConnectError,
  resolveFailedAuthAttempt,
  type AuthConnectOptions,
  type AuthContextValue,
} from "../packages/core/src/context/AuthContext"
import {
  RemoteSignerError,
  type RemoteSignerConnection,
} from "../packages/core/src/protocol/remote-signer"
import { createProtectedReadSessionLifecycle } from "../packages/core/src/protocol/protected-read-session-lifecycle"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
)
const ACCOUNT_A_SECRET = Uint8Array.from([...new Uint8Array(31), 1])
const ACCOUNT_B_SECRET = Uint8Array.from([...new Uint8Array(31), 2])
const ACCOUNT_A_PUBKEY = getPublicKey(ACCOUNT_A_SECRET)
const ACCOUNT_B_PUBKEY = getPublicKey(ACCOUNT_B_SECRET)

function setTestWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  })
}

function createNip07Window(
  getPublicKey: () => Promise<string>
): Record<string, unknown> {
  return {
    nostr: {
      getPublicKey,
      signEvent: async (event: Record<string, unknown>) => ({
        ...event,
        id: "0".repeat(64),
        pubkey: "a".repeat(64),
        sig: "1".repeat(128),
      }),
    },
  }
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor)
    return
  }

  Reflect.deleteProperty(globalThis, "window")
})

describe("NIP-07 availability", () => {
  it("requires the mandatory NIP-07 getPublicKey and signEvent methods", () => {
    setTestWindow({
      nostr: {
        getPublicKey: async () => "a".repeat(64),
      },
    })

    expect(hasNip07()).toBe(false)

    setTestWindow({
      nostr: {
        getPublicKey: async () => "a".repeat(64),
        signEvent: async (event: Record<string, unknown>) => ({
          ...event,
          id: "0".repeat(64),
          pubkey: "a".repeat(64),
          sig: "1".repeat(128),
        }),
      },
    })

    expect(hasNip07()).toBe(true)
    expect(getNip07Capabilities()).toEqual({
      signEvent: true,
      nip44: false,
      nip04: false,
    })
  })

  it("recognizes transient extension bridge failures", () => {
    expect(
      isTransientNip07ConnectError(
        new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      )
    ).toBe(true)
    expect(
      isTransientNip07ConnectError(
        new Error("The message port closed before a response was received.")
      )
    ).toBe(true)
    expect(
      isTransientNip07ConnectError(new Error("User rejected access"))
    ).toBe(false)
  })

  it("retries transient signer bridge failures with a fresh NIP-07 signer", async () => {
    let calls = 0
    setTestWindow(
      createNip07Window(async () => {
        calls += 1
        if (calls === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist."
          )
        }

        return "a".repeat(64)
      })
    )

    const { user } = await connectNip07SignerForAuth("interactive", {
      retryDelaysMs: [0],
    })

    expect(calls).toBe(2)
    expect(user.pubkey).toBe("a".repeat(64))
  })

  it("does not retry signer rejection errors", async () => {
    let calls = 0
    setTestWindow(
      createNip07Window(async () => {
        calls += 1
        throw new Error("User rejected access")
      })
    )

    await expect(
      connectNip07SignerForAuth("interactive", {
        retryDelaysMs: [0],
      })
    ).rejects.toThrow("User rejected access")
    expect(calls).toBe(1)
  })

  it("replaces exhausted transient bridge failures with actionable copy", async () => {
    setTestWindow(
      createNip07Window(async () => {
        throw new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      })
    )

    await expect(
      connectNip07SignerForAuth("interactive", {
        retryDelaysMs: [0],
      })
    ).rejects.toThrow("Your signer extension was not ready yet")
  })

  it("does not expose an event to a NIP-07 extension after its account changes", async () => {
    let activePubkey = ACCOUNT_A_PUBKEY
    let signCalls = 0
    const invalidationCodes: string[] = []
    setTestWindow({
      nostr: {
        getPublicKey: async () => activePubkey,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => {
          signCalls += 1
          return finalizeEvent(event, ACCOUNT_B_SECRET)
        },
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive", {
      onSessionInvalidated: (error) => invalidationCodes.push(error.code),
    })
    activePubkey = ACCOUNT_B_PUBKEY
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = []
    event.content = "private draft"

    await expect(event.sign(signer)).rejects.toThrow("signer account changed")
    expect(signCalls).toBe(0)
    expect(invalidationCodes).toEqual(["identity_changed"])
  })

  it("rejects a NIP-07 event signed by an account that changes during approval", async () => {
    let signCalls = 0
    setTestWindow({
      nostr: {
        getPublicKey: async () => ACCOUNT_A_PUBKEY,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => {
          signCalls += 1
          return finalizeEvent(event, ACCOUNT_B_SECRET)
        },
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = []
    event.content = "private draft"

    await expect(event.sign(signer)).rejects.toThrow(
      "signed with a different account"
    )
    expect(signCalls).toBe(1)
  })

  it("rejects an account switch that occurs while NIP-07 approval is open", async () => {
    let getPublicKeyCalls = 0
    setTestWindow({
      nostr: {
        getPublicKey: async () => {
          getPublicKeyCalls += 1
          return getPublicKeyCalls < 3 ? ACCOUNT_A_PUBKEY : ACCOUNT_B_PUBKEY
        },
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => finalizeEvent(event, ACCOUNT_A_SECRET),
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = []
    event.content = "private draft"

    await expect(event.sign(signer)).rejects.toThrow("signer account changed")
    expect(getPublicKeyCalls).toBe(3)
  })

  it("rejects a NIP-07 response that changes the signed payload", async () => {
    setTestWindow({
      nostr: {
        getPublicKey: async () => ACCOUNT_A_PUBKEY,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) =>
          finalizeEvent(
            { ...event, content: `${event.content} changed` },
            ACCOUNT_A_SECRET
          ),
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = []
    event.content = "private draft"

    await expect(event.sign(signer)).rejects.toThrow(
      "signer changed the event payload"
    )
  })

  it("rejects a NIP-07 bridge that mutates the submitted tag array", async () => {
    setTestWindow({
      nostr: {
        getPublicKey: async () => ACCOUNT_A_PUBKEY,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => {
          event.tags[0]![1] = "changed"
          return finalizeEvent(event, ACCOUNT_A_SECRET)
        },
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = [["subject", "original"]]
    event.content = "public note"

    await expect(event.sign(signer)).rejects.toThrow(
      "signer changed the event payload"
    )
    expect(event.tags).toEqual([["subject", "original"]])
  })

  it("accepts an unchanged event from the connected NIP-07 account", async () => {
    setTestWindow({
      nostr: {
        getPublicKey: async () => ACCOUNT_A_PUBKEY,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => finalizeEvent(event, ACCOUNT_A_SECRET),
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    const event = new NDKEvent()
    event.kind = 1
    event.created_at = 1_700_000_000
    event.tags = []
    event.content = "public note"

    await event.sign(signer)

    expect(event.pubkey).toBe(ACCOUNT_A_PUBKEY)
    expect(verifyEvent(event.rawEvent())).toBe(true)
  })

  it("does not expose encryption plaintext after the NIP-07 account changes", async () => {
    let activePubkey = ACCOUNT_A_PUBKEY
    let encryptCalls = 0
    setTestWindow({
      nostr: {
        getPublicKey: async () => activePubkey,
        signEvent: async (event: {
          created_at: number
          kind: number
          tags: string[][]
          content: string
        }) => finalizeEvent(event, ACCOUNT_A_SECRET),
        nip44: {
          encrypt: async () => {
            encryptCalls += 1
            return "ciphertext"
          },
          decrypt: async () => "plaintext",
        },
      },
    })

    const { signer } = await connectNip07SignerForAuth("interactive")
    activePubkey = ACCOUNT_B_PUBKEY

    await expect(
      signer.encrypt(
        new NDKUser({ pubkey: ACCOUNT_B_PUBKEY }),
        "private message",
        "nip44"
      )
    ).rejects.toThrow("signer account changed")
    expect(encryptCalls).toBe(0)
  })
})

describe("NIP-46 AuthContext API", () => {
  it("replaces and clears the exact protected-read session lease idempotently", () => {
    const installed: string[] = []
    const removed: string[] = []
    let sequence = 0
    const lifecycle = createProtectedReadSessionLifecycle({
      install: (_signer, expectedPubkey) => {
        sequence += 1
        const lease = {
          sessionScope: `scope-${sequence}`,
          expectedPubkey,
        }
        installed.push(`${lease.sessionScope}:${expectedPubkey}`)
        return lease
      },
      remove: (lease) => {
        removed.push(`${lease.sessionScope}:${lease.expectedPubkey}`)
      },
    })
    const signer = {
      authMethod: "nip07",
      getPublicKey: async () => ACCOUNT_A_PUBKEY,
      signEvent: async () => {
        throw new Error("not used")
      },
    } satisfies NostrEventSigner

    const first = lifecycle.activate(signer, ACCOUNT_A_PUBKEY, () => true)
    const second = lifecycle.activate(signer, ACCOUNT_B_PUBKEY, () => true)
    expect(lifecycle.currentLease()).toBe(second)
    expect(installed).toEqual([
      `scope-1:${ACCOUNT_A_PUBKEY}`,
      `scope-2:${ACCOUNT_B_PUBKEY}`,
    ])
    expect(removed).toEqual([`${first.sessionScope}:${ACCOUNT_A_PUBKEY}`])

    lifecycle.deactivate()
    lifecycle.deactivate()
    expect(lifecycle.currentLease()).toBeNull()
    expect(removed).toEqual([
      `${first.sessionScope}:${ACCOUNT_A_PUBKEY}`,
      `${second.sessionScope}:${ACCOUNT_B_PUBKEY}`,
    ])
  })

  it("routes AuthProvider connect, disconnect, storage switch, and unmount through the lease lifecycle", async () => {
    const source = await readFile(
      "packages/core/src/context/AuthContext.tsx",
      "utf8"
    )

    expect(source).toContain("createProtectedReadSessionLifecycle()")
    expect(source).toContain("protectedReadSessionLifecycle.current.activate(")
    expect(source).toContain(
      "protectedReadSessionLifecycle.current.deactivate()"
    )
    expect(source).not.toContain("installProtectedReadSigner(")
    expect(source).not.toContain("removeProtectedReadSigner(")
  })

  it("exposes the client-initiated flow discriminator and ephemeral URI", () => {
    const options = {
      method: "nip46",
      nip46Flow: "nostrconnect",
    } satisfies AuthConnectOptions
    const uri: AuthContextValue["nostrConnectUri"] = null

    expect(options.nip46Flow).toBe("nostrconnect")
    expect(uri).toBeNull()
  })

  it("preflights the client before persistence and installs before ownership commit", async () => {
    const source = await readFile(
      "packages/core/src/context/AuthContext.tsx",
      "utf8"
    )
    const connectStart = source.indexOf("const connectWithoutLock")
    const connectEnd = source.indexOf(
      "const connect = useCallback",
      connectStart
    )
    const connectAttempt = source.slice(connectStart, connectEnd)
    const prepareClient = connectAttempt.indexOf("getNdk()")
    const persistRemote = connectAttempt.indexOf("persistRemoteSignerSession(")
    const persistNip07 = connectAttempt.indexOf(
      "sessionPersisted = writeAuthSession(session)"
    )
    const finalAuthorityFence = connectAttempt.indexOf(
      "if (!attemptIsCurrent())",
      persistNip07
    )
    const installSigner = connectAttempt.indexOf("setSigner(sessionSigner)")
    const commitRemote = connectAttempt.indexOf(
      "remoteConnection.current = connectedRemote"
    )
    const releasePendingRemote = connectAttempt.indexOf(
      "uncommittedRemote = null",
      commitRemote
    )
    const catchStart = connectAttempt.indexOf("} catch (err)")
    const catchEnd = connectAttempt.indexOf("} finally", catchStart)
    const catchBlock = connectAttempt.slice(catchStart, catchEnd)

    expect(prepareClient).toBeGreaterThan(-1)
    expect(persistRemote).toBeGreaterThan(prepareClient)
    expect(persistNip07).toBeGreaterThan(prepareClient)
    expect(finalAuthorityFence).toBeGreaterThan(persistNip07)
    expect(installSigner).toBeGreaterThan(finalAuthorityFence)
    expect(installSigner).toBeGreaterThan(persistRemote)
    expect(commitRemote).toBeGreaterThan(installSigner)
    expect(releasePendingRemote).toBeGreaterThan(installSigner)
    expect(catchBlock).toContain("resolveFailedAuthAttempt({")
  })

  it("surfaces a cancelled attempt's failed rollback without replacing a newer signer state", async () => {
    const cleanupFailure = new RemoteSignerError(
      "unavailable",
      "Vault removal failed",
      { operation: "rollback session" }
    )
    const rollbackAndAbandon = mock(async () => {
      throw cleanupFailure
    })
    const uncommittedRemote = {} as RemoteSignerConnection

    const cancelled = await resolveFailedAuthAttempt({
      failure: new Error("Pairing cancelled"),
      uncommittedRemote,
      remotePersistenceStarted: true,
      getAttemptState: () => ({
        attemptIsCurrent: false,
        attemptOwnsEpoch: false,
        replacementActive: false,
      }),
      rollbackAndAbandon,
    })

    expect(rollbackAndAbandon).toHaveBeenCalledTimes(1)
    expect(cancelled.kind).toBe("cleanup-error")
    if (cancelled.kind === "cleanup-error") {
      expect(cancelled.reject).toBe(false)
      expect(cancelled.message).toContain("could not erase")
      expect(cancelled.message).toContain("Clear this site's storage")
    }

    const currentRollback = mock(async () => {
      throw cleanupFailure
    })
    const current = await resolveFailedAuthAttempt({
      failure: new Error("Signer installation failed"),
      uncommittedRemote,
      remotePersistenceStarted: true,
      getAttemptState: () => ({
        attemptOwnsEpoch: true,
        attemptIsCurrent: true,
        replacementActive: false,
      }),
      rollbackAndAbandon: currentRollback,
    })
    expect(currentRollback).toHaveBeenCalledTimes(1)
    expect(current.kind).toBe("cleanup-error")
    if (current.kind === "cleanup-error") {
      expect(current.reject).toBe(true)
    }

    expect(
      await resolveFailedAuthAttempt({
        failure: cleanupFailure,
        uncommittedRemote: null,
        remotePersistenceStarted: true,
        getAttemptState: () => ({
          attemptOwnsEpoch: false,
          attemptIsCurrent: false,
          replacementActive: true,
        }),
      })
    ).toEqual({ kind: "ignore" })
  })

  it("keeps a persistence error on the normal path after rollback succeeds", async () => {
    const persistenceFailure = new RemoteSignerError(
      "unavailable",
      "Could not save signer session",
      { operation: "persist session" }
    )
    const rollbackAndAbandon = mock(async () => undefined)
    const uncommittedRemote = {} as RemoteSignerConnection

    expect(
      await resolveFailedAuthAttempt({
        failure: persistenceFailure,
        uncommittedRemote,
        remotePersistenceStarted: true,
        getAttemptState: () => ({
          attemptOwnsEpoch: true,
          attemptIsCurrent: true,
          replacementActive: false,
        }),
        rollbackAndAbandon,
      })
    ).toEqual({ kind: "continue", failure: persistenceFailure })
    expect(rollbackAndAbandon).toHaveBeenCalledTimes(1)
  })

  it("rejects a current authority failure and ignores unrelated stale failures", async () => {
    const currentAuthorityFailure = await resolveFailedAuthAttempt({
      failure: new Error("storage denied"),
      uncommittedRemote: null,
      remotePersistenceStarted: false,
      getAttemptState: () => ({
        attemptIsCurrent: false,
        attemptOwnsEpoch: true,
        replacementActive: false,
      }),
    })

    expect(currentAuthorityFailure.kind).toBe("authority-retry")
    if (currentAuthorityFailure.kind === "authority-retry") {
      expect(currentAuthorityFailure.reject).toBe(true)
    }
    expect(
      await resolveFailedAuthAttempt({
        failure: new Error("stale"),
        uncommittedRemote: null,
        remotePersistenceStarted: false,
        getAttemptState: () => ({
          attemptIsCurrent: false,
          attemptOwnsEpoch: false,
          replacementActive: false,
        }),
      })
    ).toEqual({ kind: "ignore" })
  })

  it("keeps an ordinary current failure on the normal error path", async () => {
    const failure = new Error("Signer rejected access")

    expect(
      await resolveFailedAuthAttempt({
        failure,
        uncommittedRemote: null,
        remotePersistenceStarted: false,
        getAttemptState: () => ({
          attemptIsCurrent: true,
          attemptOwnsEpoch: true,
          replacementActive: false,
        }),
      })
    ).toEqual({ kind: "continue", failure })
  })

  it("rechecks replacement ownership after an asynchronous rollback failure", async () => {
    let releaseRollback: (() => void) | undefined
    let markRollbackStarted: (() => void) | undefined
    const rollbackStarted = new Promise<void>((resolve) => {
      markRollbackStarted = resolve
    })
    const rollbackPending = new Promise<void>((resolve) => {
      releaseRollback = resolve
    })
    let state = {
      attemptIsCurrent: true,
      attemptOwnsEpoch: true,
      replacementActive: false,
    }
    const resolution = resolveFailedAuthAttempt({
      failure: new Error("Signer installation failed"),
      uncommittedRemote: {} as RemoteSignerConnection,
      remotePersistenceStarted: true,
      getAttemptState: () => state,
      rollbackAndAbandon: async () => {
        markRollbackStarted?.()
        await rollbackPending
        throw new RemoteSignerError("unavailable", "Vault removal failed", {
          operation: "rollback session",
        })
      },
    })

    await rollbackStarted
    state = {
      attemptIsCurrent: false,
      attemptOwnsEpoch: false,
      replacementActive: true,
    }
    releaseRollback?.()

    expect(await resolution).toEqual({ kind: "ignore" })
  })
})
