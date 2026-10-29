import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import {
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  hasAuthSessionAuthority,
  revokeAuthSessionAuthority,
  type AuthSession,
  type AuthStorage,
} from "../packages/core/src/protocol/auth-session"
import {
  NostrSignerError,
  type AccountSignerOperationOptions,
} from "../packages/core/src/protocol/nostr-event-signer"
import { Nip07SessionSigner } from "../packages/core/src/protocol/nip07-signer"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
afterEach(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(timeoutMs = 1000) {
  // Keys and payloads are disposable fixtures, never external account material.
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const peer = getPublicKey(generateSecretKey())
  const session: AuthSession = {
    version: 1,
    type: "nip07",
    userPubkey: pubkey,
    authClaim: "original-claim",
  }
  const values = new Map([
    [AUTH_STORAGE_KEY, JSON.stringify(session)],
    [AUTH_REVISION_STORAGE_KEY, session.authClaim!],
  ])
  const storage: AuthStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
  let holdIdentity = false
  let holdDispatch = false
  let capabilities = { signEvent: true, nip44: true, nip04Decrypt: true }
  const identityEntered = deferred<void>()
  const identity = deferred<string>()
  const dispatched = deferred<void>()
  const dispatch = deferred<void>()
  const calls: string[] = []
  const keyCall = async (operation: string) => {
    calls.push(operation)
    dispatched.resolve()
    if (holdDispatch) await dispatch.promise
    return `synthetic-${operation}`
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      nostr: {
        getPublicKey: async () => {
          if (!holdIdentity) return pubkey
          identityEntered.resolve()
          return identity.promise
        },
        signEvent: async (draft: Parameters<typeof finalizeEvent>[0]) => {
          await keyCall("sign")
          return finalizeEvent(draft, secret)
        },
        nip44: {
          encrypt: () => keyCall("encrypt"),
          decrypt: () => keyCall("decrypt"),
        },
        nip04: { decrypt: () => keyCall("legacy") },
      },
    },
  })
  const provider = new Nip07SessionSigner({ readinessRetryDelaysMs: [] })
  await provider.getPublicKey()
  const signer = new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: session.authClaim!,
    authMethod: "nip07",
    hasAuthority: () => hasAuthSessionAuthority(session, true, storage),
    getCapabilities: () => capabilities,
    operationTimeoutMs: timeoutMs,
  })
  const operations = {
    sign: (options?: AccountSignerOperationOptions) =>
      signer.signEvent(
        {
          pubkey,
          kind: 1,
          created_at: 1_700_000_000,
          tags: [],
          content: "synthetic",
        },
        options
      ),
    encrypt: (options?: AccountSignerOperationOptions) =>
      signer.encryptNip44(peer, "synthetic", options),
    decrypt: (options?: AccountSignerOperationOptions) =>
      signer.decryptNip44(peer, "synthetic", options),
    legacy: (options?: AccountSignerOperationOptions) =>
      signer.decryptLegacy(peer, "synthetic", options),
  }
  return {
    signer,
    operations,
    calls,
    pubkey,
    peer,
    storage,
    session,
    values,
    identityEntered,
    dispatched,
    holdIdentity: () => {
      holdIdentity = true
    },
    releaseIdentity: () => {
      holdIdentity = false
      identity.resolve(pubkey)
    },
    holdDispatch: () => {
      holdDispatch = true
    },
    releaseDispatch: () => {
      holdDispatch = false
      dispatch.resolve()
    },
    revokeCapabilities: () => {
      capabilities = { signEvent: false, nip44: false, nip04Decrypt: false }
    },
  }
}

const operations = ["sign", "encrypt", "decrypt", "legacy"] as const
for (const operation of operations) {
  describe(`NIP-07 ${operation} authority across identity preflight`, () => {
    for (const change of [
      "logout",
      "same identity replacement",
      "different identity replacement",
      "local cancellation",
      "capability revocation",
      "timeout",
    ] as const) {
      it(`prevents provider dispatch after ${change}`, async () => {
        const f = await fixture(change === "timeout" ? 20 : 1000)
        f.holdIdentity()
        const outcome = f.operations[operation]().catch(
          (error: unknown) => error
        )
        await f.identityEntered.promise
        if (change === "logout") {
          expect(
            revokeAuthSessionAuthority(f.session, f.storage).authorityRevoked
          ).toBe(true)
        } else if (change.includes("replacement")) {
          f.values.set(AUTH_REVISION_STORAGE_KEY, "replacement-claim")
          f.values.set(
            AUTH_STORAGE_KEY,
            JSON.stringify({
              ...f.session,
              authClaim: "replacement-claim",
              userPubkey:
                change === "same identity replacement" ? f.pubkey : f.peer,
            })
          )
        } else if (change === "local cancellation") f.signer.invalidateLocal()
        else if (change === "capability revocation") f.revokeCapabilities()
        if (change === "timeout")
          expect(await outcome).toMatchObject({ code: "timeout" })
        f.releaseIdentity()
        expect(await outcome).toMatchObject({
          code:
            change === "timeout"
              ? "timeout"
              : change === "capability revocation"
                ? "unsupported_operation"
                : "authority_changed",
        })
        // Drain the released preflight even when the outer cancellation won first.
        await Bun.sleep(0)
        expect(f.calls).toEqual([])
      })
    }

    it("honors caller cancellation without revoking later session work", async () => {
      const f = await fixture()
      let current = true
      f.holdIdentity()
      const outcome = f.operations[operation]({
        assertCurrent: () => {
          if (!current) throw new NostrSignerError("authority_changed")
        },
      }).catch((error: unknown) => error)
      await f.identityEntered.promise
      current = false
      f.releaseIdentity()
      expect(await outcome).toMatchObject({ code: "authority_changed" })
      expect(f.calls).toEqual([])
      await f.operations[operation]()
      expect(f.calls).toEqual([operation])
    })

    it("dispatches exactly once when the held identity remains authorized", async () => {
      const f = await fixture()
      f.holdIdentity()
      const result = f.operations[operation]()
      await f.identityEntered.promise
      expect(f.calls).toEqual([])
      f.releaseIdentity()
      await result
      expect(f.calls).toEqual([operation])
    })

    for (const change of ["cancellation", "timeout"] as const) {
      it(`fences a late result after already-dispatched ${change}`, async () => {
        const f = await fixture(change === "timeout" ? 20 : 1000)
        f.holdDispatch()
        const outcome = f.operations[operation]().catch(
          (error: unknown) => error
        )
        await f.dispatched.promise
        if (change === "cancellation") f.signer.invalidateLocal()
        expect(await outcome).toMatchObject({
          code: change === "timeout" ? "timeout" : "authority_changed",
        })
        f.releaseDispatch()
        await Bun.sleep(0)
        expect(f.calls).toEqual([operation])
        if (change === "cancellation") {
          await expect(f.operations[operation]()).rejects.toMatchObject({
            code: "authority_changed",
          })
        } else {
          await f.operations[operation]()
          expect(f.calls).toEqual([operation, operation])
        }
      })
    }
  })
}
