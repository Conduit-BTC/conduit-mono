import { expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import { bytesToHex } from "../packages/core/node_modules/@noble/hashes/utils.js"
import {
  BreezLightningAddressClient,
  type BreezAddressCheckpoint,
} from "../packages/core/src/wallets/breez-lightning-address"
import {
  createAddressRequestWorkflow,
  type AddressRequestView,
} from "../packages/core/src/wallets/address-request-workflow"
import { addressNameRequestMessage } from "../packages/core/src/wallets/address-name-request"
import {
  addressRequestRecordSchema,
  mergeAddressRequestRecord,
} from "../packages/core/src/wallets/address-request-record"

function fixture(failure: "throttled" | "delayed" | "none") {
  const account = generateSecretKey(),
    wallet = generateSecretKey()
  const identity = bytesToHex(secp256k1.getPublicKey(wallet))
  let view: AddressRequestView | undefined
  let checkpoint: BreezAddressCheckpoint | null = null
  let registered = false,
    ready = false,
    registrations = 0,
    recoveries = 0,
    profiles = 0
  let now = 1_700_000_000_000
  const progress: AddressRequestView[] = []
  const waits: number[] = []
  let active = true,
    walletActive = true,
    approved = true,
    converge = true,
    failProfile = false
  let duringWait: (() => void) | undefined
  let refuseRegistration = false
  let registrationFailure: "rejected" | "lost" | undefined
  let registrationAttempts = 0
  let afterRegistrationSigning: (() => void) | undefined
  const assertCurrent = () => {
    if (!active) throw new Error("Authority changed")
  }
  const client = () =>
    new BreezLightningAddressClient({
      domain: "conduit.cash",
      apiKey: "fixture",
      now: () => now,
      signer: {
        assertActive: assertCurrent,
        getIdentityPublicKey: async () => identity,
        signDigest: async (digest) =>
          secp256k1.sign(digest, wallet, { prehash: false, format: "der" }),
      },
      signAccountProof: async () => {
        if (refuseRegistration) throw new Error("Signature refused")
        afterRegistrationSigning?.()
        return "Nostr fixture"
      },
      runExclusive: async (_scope, operation) => operation(),
      store: {
        read: async () => checkpoint,
        write: async (_scope, value) => {
          checkpoint = value
        },
      },
      fetch: async (input) => {
        const url = String(input)
        if (url.includes(".well-known"))
          return !ready && failure === "delayed"
            ? Response.json("not found", { status: 404 })
            : Response.json({
                tag: "payRequest",
                minSendable: 1,
                maxSendable: 1000,
                callback: "https://conduit.cash/lnurlp/alice/invoice",
                metadata: JSON.stringify([
                  ["text/identifier", "alice@conduit.cash"],
                ]),
              })
        if (url.endsWith("/recover")) {
          recoveries++
          if (registered && !ready && failure === "throttled")
            return Response.json("limited", {
              status: 429,
              headers: { "Retry-After": "60" },
            })
          return registered && (registrationFailure !== "lost" || ready)
            ? Response.json({
                username: "alice",
                lightning_address: "alice@conduit.cash",
                lnurl: "lnurlp://conduit.cash/lnurlp/alice",
              })
            : Response.json("user not found", { status: 404 })
        }
        if (url.endsWith("/available"))
          return Response.json({ available: true })
        registrationAttempts++
        if (registrationFailure === "rejected")
          return Response.json("rejected", { status: 403 })
        registered = true
        registrations++
        if (registrationFailure === "lost") throw new Error("Lost response")
        return Response.json({})
      },
    })
  const workflow = () =>
    createAddressRequestWorkflow({
      owner: getPublicKey(account),
      assertCurrent,
      authorize: async () => {
        assertCurrent()
        if (!walletActive) throw new Error("Wallet changed")
        return async () => {
          assertCurrent()
          if (!walletActive) throw new Error("Wallet changed")
        }
      },
      load: async () => view,
      save: async (_id, record) =>
        (view = {
          record: addressRequestRecordSchema.parse(
            mergeAddressRequestRecord(view?.record, record)
          ),
          publication: "local",
        }),
      signWallet: async (_id, input) => {
        const request = { ...input, sparkIdentity: identity }
        return {
          ...request,
          walletSignature: bytesToHex(
            secp256k1.sign(
              sha256(
                new TextEncoder().encode(addressNameRequestMessage(request))
              ),
              wallet,
              { prehash: false, format: "der" }
            )
          ),
        }
      },
      signAccount: async (draft) => finalizeEvent(draft, account),
      fetch: (async () =>
        Response.json({
          status: approved ? "approved" : "received",
        })) as typeof fetch,
      address: async (_id, register, name, beforeRegister, signal) =>
        register
          ? client().ensure(name, {
              activateApprovedName: true,
              retryKnownNonSubmissionOnly: register === "retry",
              beforeRegister,
              signal,
            })
          : client().lookup(),
      publishProfile: async () => {
        profiles++
        if (failProfile) throw new Error("Profile confirmation unavailable")
        return "a".repeat(64)
      },
      now: () => now,
      wait: async (ms) => {
        waits.push(ms)
        now += ms
        if (converge) ready = true
        duringWait?.()
      },
    })
  return {
    workflow,
    progress,
    waits,
    counts: () => ({ registrations, recoveries, profiles }),
    stopConvergence: () => {
      converge = false
    },
    ready: () => {
      ready = true
    },
    revoke: () => {
      active = false
    },
    revokeWallet: () => {
      walletActive = false
    },
    approval: (value: boolean) => {
      approved = value
    },
    profileFailure: (value: boolean) => {
      failProfile = value
    },
    onWait: (callback: () => void) => {
      duringWait = callback
    },
    saved: () => view,
    checkpoint: () => checkpoint,
    replaceCheckpoint: (value: BreezAddressCheckpoint | null) => {
      checkpoint = value
    },
    refuseRegistration: (value: boolean) => {
      refuseRegistration = value
    },
    registrationFailure: (value: typeof registrationFailure) => {
      registrationFailure = value
    },
    registrationAttempts: () => registrationAttempts,
    afterRegistrationSigning: (callback: () => void) => {
      afterRegistrationSigning = callback
    },
  }
}

for (const failure of ["refused", "rejected"] as const) {
  it(`deliberately retries a ${failure} registration on the same approved request after restart`, async () => {
    const f = fixture("none")
    await f
      .workflow()
      .submit("wallet", { desiredName: "alice", token: "fixture" })
    if (failure === "refused") f.refuseRegistration(true)
    else f.registrationFailure("rejected")
    await f.workflow().activate("wallet")
    const retained = f.saved()!.record
    expect(retained.phase).toBe("activating")
    expect(f.checkpoint()?.phase).toBe("selected")
    expect(f.counts().registrations).toBe(0)
    expect(f.registrationAttempts()).toBe(failure === "refused" ? 0 : 1)
    f.refuseRegistration(false)
    f.registrationFailure(undefined)
    const result = await f.workflow().activate("wallet")
    expect(result.record.phase).toBe("complete")
    expect(result.record.payload).toBe(retained.payload)
    expect(result.record.accountProof).toBe(retained.accountProof)
    expect(f.counts().registrations).toBe(1)
    expect(f.counts().profiles).toBe(1)
  })
}

it("keeps absent recovery after a lost submission read-only until ownership and public receiving recover", async () => {
  const f = fixture("none")
  f.stopConvergence()
  f.registrationFailure("lost")
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  await f.workflow().activate("wallet")
  expect(f.checkpoint()?.phase).toBe("registering")
  await f.workflow().activate("wallet")
  expect(f.registrationAttempts()).toBe(1)
  expect(f.counts().profiles).toBe(0)
  f.ready()
  expect((await f.workflow().activate("wallet")).record.phase).toBe("complete")
  expect(f.registrationAttempts()).toBe(1)
})

for (const checkpoint of [
  null,
  { username: "bob", attempts: 1, phase: "selected" },
  { username: "alice", attempts: 1, phase: "registering" },
] as const) {
  it(`does not infer retry permission from an activating request with ${checkpoint === null ? "no" : checkpoint.username === "bob" ? "a different-name" : "an uncertain"} checkpoint`, async () => {
    const f = fixture("none")
    await f
      .workflow()
      .submit("wallet", { desiredName: "alice", token: "fixture" })
    f.refuseRegistration(true)
    await f.workflow().activate("wallet")
    f.refuseRegistration(false)
    f.replaceCheckpoint(checkpoint)
    expect((await f.workflow().activate("wallet")).record.phase).toBe(
      "activating"
    )
    expect(f.registrationAttempts()).toBe(0)
    expect(f.counts().profiles).toBe(0)
    expect(f.checkpoint()).toEqual(checkpoint)
  })
}

for (const authority of ["approval", "account", "wallet"] as const) {
  it(`revalidates ${authority} before retrying a positively unsubmitted registration`, async () => {
    const f = fixture("none")
    await f
      .workflow()
      .submit("wallet", { desiredName: "alice", token: "fixture" })
    f.refuseRegistration(true)
    await f.workflow().activate("wallet")
    f.refuseRegistration(false)
    if (authority === "approval") f.approval(false)
    else if (authority === "account") f.revoke()
    else f.revokeWallet()
    await expect(f.workflow().activate("wallet")).rejects.toThrow()
    expect(f.registrationAttempts()).toBe(0)
    expect(f.counts().profiles).toBe(0)
  })
}

it("retains positive non-submission when cancelled after signing but before dispatch", async () => {
  const f = fixture("none"),
    controller = new AbortController()
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  f.afterRegistrationSigning(() => controller.abort())
  await expect(
    f.workflow().activate("wallet", { signal: controller.signal })
  ).rejects.toThrow()
  expect(f.saved()?.record.phase).toBe("activating")
  expect(f.checkpoint()?.phase).toBe("selected")
  expect(f.registrationAttempts()).toBe(0)
  f.afterRegistrationSigning(() => {})
  expect((await f.workflow().activate("wallet")).record.phase).toBe("complete")
  expect(f.registrationAttempts()).toBe(1)
})

for (const authority of ["account", "wallet"] as const) {
  it(`fences ${authority} changes during registration signing on a deliberate retry`, async () => {
    const f = fixture("none")
    await f
      .workflow()
      .submit("wallet", { desiredName: "alice", token: "fixture" })
    f.refuseRegistration(true)
    await f.workflow().activate("wallet")
    f.refuseRegistration(false)
    f.afterRegistrationSigning(() =>
      authority === "account" ? f.revoke() : f.revokeWallet()
    )
    await expect(f.workflow().activate("wallet")).rejects.toThrow()
    expect(f.registrationAttempts()).toBe(0)
    expect(f.checkpoint()?.phase).toBe("selected")
    expect(f.counts().profiles).toBe(0)
  })
}

it("fits a fresh activation in three recoveries with no follow-up display read", async () => {
  const f = fixture("none"),
    workflow = f.workflow()
  await workflow.submit("wallet", { desiredName: "alice", token: "fixture" })
  const result = await workflow.activate("wallet")
  expect(result.activation?.address?.publicLookup).toBe("verified")
  expect(f.counts()).toEqual({ registrations: 1, recoveries: 3, profiles: 1 })
})

it("bounds retries and resumes retained uncertainty after restart without a second registration", async () => {
  const f = fixture("throttled")
  f.stopConvergence()
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  const pending = await f.workflow().activate("wallet")
  expect(pending).toMatchObject({
    record: { phase: "activating" },
    activation: {
      step: "registration",
      reason: "rate_limited",
      exhausted: true,
    },
  })
  expect(f.waits).toHaveLength(3)
  expect(f.counts().profiles).toBe(0)
  // Transient view evidence is never part of the old-compatible persisted record.
  expect(f.saved()?.activation).toBeUndefined()
  f.ready()
  expect((await f.workflow().activate("wallet")).record.phase).toBe("complete")
  expect(f.counts().registrations).toBe(1)
})

it("keeps public verification distinct from ownership and stops before profile publication", async () => {
  const f = fixture("delayed")
  f.stopConvergence()
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  const result = await f.workflow().activate("wallet")
  expect(result.activation).toMatchObject({
    step: "public_lookup",
    reason: "not_found",
    exhausted: true,
    address: { publicLookup: "unavailable" },
  })
  expect(f.counts().profiles).toBe(0)
})

for (const change of ["account", "wallet", "cancel"] as const) {
  it(`stops reconciliation after ${change} changes without publishing`, async () => {
    const f = fixture("throttled"),
      controller = new AbortController()
    f.onWait(() =>
      change === "cancel"
        ? controller.abort()
        : change === "wallet"
          ? f.revokeWallet()
          : f.revoke()
    )
    await f
      .workflow()
      .submit("wallet", { desiredName: "alice", token: "fixture" })
    await expect(
      f.workflow().activate("wallet", { signal: controller.signal })
    ).rejects.toThrow()
    expect(f.counts()).toEqual({ registrations: 1, recoveries: 3, profiles: 0 })
  })
}

it("revalidates approval on restart even with retained registration progress", async () => {
  const f = fixture("throttled")
  f.stopConvergence()
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  await f.workflow().activate("wallet")
  f.ready()
  f.approval(false)
  await expect(f.workflow().activate("wallet")).rejects.toThrow(
    "Gateway approval"
  )
  expect(f.counts().profiles).toBe(0)
})

it("resumes profile publication after fresh verification without repeating registration", async () => {
  const f = fixture("none")
  await f
    .workflow()
    .submit("wallet", { desiredName: "alice", token: "fixture" })
  f.profileFailure(true)
  await expect(f.workflow().activate("wallet")).rejects.toThrow(
    "Profile confirmation"
  )
  expect(f.saved()?.record.phase).toBe("registered")
  f.profileFailure(false)
  expect((await f.workflow().activate("wallet")).record.phase).toBe("complete")
  expect(f.counts()).toEqual({ registrations: 1, recoveries: 4, profiles: 2 })
})

for (const failure of ["throttled", "delayed"] as const) {
  it(`reconciles successful registration with ${failure} confirmation without registering twice`, async () => {
    const f = fixture(failure),
      workflow = f.workflow()
    await workflow.submit("wallet", { desiredName: "alice", token: "fixture" })
    const result = await workflow.activate("wallet", {
      onProgress: (view) => f.progress.push(view),
    })
    expect(result.record.phase).toBe("complete")
    expect(f.counts()).toEqual({ registrations: 1, recoveries: 4, profiles: 1 })
    expect(f.waits).toHaveLength(1)
    if (failure === "throttled")
      expect(f.waits[0]).toBeGreaterThanOrEqual(60_000)
  })
}
