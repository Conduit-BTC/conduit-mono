import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { verifyEvent } from "nostr-tools/pure"
import {
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  freezeCheckoutSparkPlan,
  freezeCheckoutSparkSettledPlan,
  parseCheckoutSparkRecoveryRumor,
  recordCheckoutSparkSettledCredit,
  type NostrKeySigner,
  type UnsignedNostrEvent,
} from "@conduit/core"
import {
  clearSessionGuestOrderSigningIdentity,
  createGuestCheckoutSparkRecoverySigner,
  createSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
  GUEST_ORDER_SESSION_TTL_MS,
  type GuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

// Disposable local keys and the public BIP-39 example; no wallet/provider opens.
const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
const other = plainTestSigner(NDKPrivateKeySigner.generate())
const CREATED_AT = Math.floor(Date.now() / 1_000) * 1_000
const PREPARED_AT = CREATED_AT + 1_000
const NOW = CREATED_AT + 3_000
const ORDER_ID = "guest-router-recovery-fixture"
const MNEMONIC = createRuntimeMnemonic()

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

function guest() {
  const storage = memoryStorage()
  const identity = createSessionGuestOrderSigningIdentity(
    ORDER_ID,
    merchant.pubkey,
    { storage, nowMs: CREATED_AT }
  )
  return { identity, storage }
}

function state(orderId = ORDER_ID, merchantPubkey = merchant.pubkey) {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "guest-router-checkout",
    orderId,
    merchantPubkey,
    walletId: "guest-router-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${merchantPubkey}:fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "guest-router-receive",
      paymentRequest: makeSignedBolt11Fixture({
        hrp: "lnbc1220n",
        createdAt: CREATED_AT / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(3)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 122,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchantPubkey,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
        weightSats: 10,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
  return createCheckoutSparkSettledReconciliation(plan)
}

const initialState = state()

function initialPayload(
  identity: GuestOrderSigningIdentity,
  overrides: {
    state?: ReturnType<typeof state>
    senderPubkey?: string
    preparedAt?: number
  } = {}
) {
  return createCheckoutSparkSettledRecoveryPayload({
    state: overrides.state ?? initialState,
    senderPubkey: overrides.senderPubkey ?? identity.pubkey,
    preparedAt: overrides.preparedAt ?? PREPARED_AT,
    mnemonic: MNEMONIC,
    accountNumber: 1,
  })
}

function progressPayload(identity: GuestOrderSigningIdentity) {
  const initial = initialPayload(identity)
  const credited = recordCheckoutSparkSettledCredit(initial.state, {
    requestId: initial.plan.funding.requestId,
    paymentHash: initial.plan.funding.paymentHash,
    receiverIdentityPublicKey: initial.plan.funding.receiverIdentityPublicKey,
    transferId: "guest-router-credit",
    grossSats: 122,
    creditedSats: 120,
    observedAt: CREATED_AT + 2_000,
  })
  return createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: initial.handoffId,
    state: credited,
    senderPubkey: identity.pubkey,
    preparedAt: NOW,
  })
}

function serialize(rumor: NDKEvent): string {
  return JSON.stringify(rumor.rawEvent())
}

function capability(identity: GuestOrderSigningIdentity, now = () => NOW) {
  return createGuestCheckoutSparkRecoverySigner(identity, { now })
}

function encryptRumor(signer: NostrKeySigner, rumor: NDKEvent) {
  return signer.encryptNip44(merchant.pubkey, serialize(rumor))
}

function seal(
  identity: GuestOrderSigningIdentity,
  content: string
): UnsignedNostrEvent {
  return {
    kind: 13,
    pubkey: identity.pubkey,
    created_at: Math.floor(NOW / 1_000),
    tags: [],
    content,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("bounded guest Spark recovery wrapping capability", () => {
  it.each(["initial", "progress"] as const)(
    "encrypts and signs a real merchant-only NIP-59 %s handoff",
    async (phase) => {
      const { identity } = guest()
      const payload =
        phase === "initial"
          ? initialPayload(identity)
          : progressPayload(identity)
      const rumor = buildCheckoutSparkRecoveryRumor(payload)
      const signer = capability(identity)
      const wrapped = await wrapPrivateMessage(
        rumor,
        new NDKUser({ pubkey: merchant.pubkey }),
        signer
      )
      expect(wrapped.kind).toBe(1059)
      expect(wrapped.tags.filter((tag) => tag[0] === "p")).toEqual([
        ["p", merchant.pubkey],
      ])
      expect(wrapped.pubkey).not.toBe(identity.pubkey)
      expect(wrapped.verifySignature(false)).toBe(true)
      expect(wrapped.content).not.toContain(MNEMONIC)
      expect(wrapped.content).not.toContain(ORDER_ID)

      const sealed = JSON.parse(
        await merchant.decrypt(
          new NDKUser({ pubkey: wrapped.pubkey }),
          wrapped.content,
          "nip44"
        )
      )
      expect(sealed.kind).toBe(13)
      expect(sealed.tags).toEqual([])
      expect(sealed.pubkey).toBe(identity.pubkey)
      expect(verifyEvent(sealed)).toBe(true)
      const opened = JSON.parse(
        await merchant.decrypt(
          new NDKUser({ pubkey: identity.pubkey }),
          sealed.content,
          "nip44"
        )
      )
      expect(opened.sig).toBeUndefined()
      expect(
        parseCheckoutSparkRecoveryRumor(new NDKEvent(undefined, opened))
      ).toEqual(payload)
      expect(payload.plan.schemaVersion).toBe(3)
      if (phase === "progress") {
        expect(JSON.stringify(payload)).not.toContain(MNEMONIC)
        expect(JSON.stringify(payload)).not.toContain("accountNumber")
      }
      await expect(
        other.decrypt(
          new NDKUser({ pubkey: wrapped.pubkey }),
          wrapped.content,
          "nip44"
        )
      ).rejects.toThrow()
    }
  )

  it("allows exactly one empty-tag seal for an authorized ciphertext", async () => {
    const { identity } = guest()
    const signer = capability(identity)
    await expect(
      signer.signEvent(seal(identity, "unapproved-ciphertext"))
    ).rejects.toThrow()
    const ciphertext = await encryptRumor(
      signer,
      buildCheckoutSparkRecoveryRumor(initialPayload(identity))
    )
    const event = new NDKEvent(undefined, seal(identity, ciphertext))
    Object.assign(event, await signer.signEvent(seal(identity, ciphertext)))
    expect(event.verifySignature(false)).toBe(true)
    await expect(
      signer.signEvent(event.rawEvent() as UnsignedNostrEvent)
    ).rejects.toThrow()
  })

  it("rejects altered seal pubkeys, content, tags and kinds before delegating signing", async () => {
    const { identity } = guest()
    let signed = 0
    const original = identity.signer.signEvent.bind(identity.signer)
    identity.signer.signEvent = async (event) => {
      signed += 1
      return original(event)
    }
    const signer = capability(identity)
    const ciphertext = await encryptRumor(
      signer,
      buildCheckoutSparkRecoveryRumor(initialPayload(identity))
    )
    for (const patch of [
      { pubkey: other.pubkey },
      { content: `${ciphertext}changed` },
      { tags: [["p", merchant.pubkey]] },
      { kind: 16 },
      { kind: 1059 },
    ]) {
      await expect(
        signer.signEvent({ ...seal(identity, ciphertext), ...patch })
      ).rejects.toThrow()
    }
    expect(signed).toBe(0)
  })

  it.each([1, 4, 14, 16, 30_402, 10_059])(
    "does not sign generic/private/public/order kind %s directly",
    async (kind) => {
      const { identity } = guest()
      const rumor = buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      rumor.kind = kind
      await expect(
        capability(identity).signEvent(rumor.rawEvent() as UnsignedNostrEvent)
      ).rejects.toThrow()
    }
  )

  it("does not broaden the original guest order signer's recovery permissions", async () => {
    const { identity } = guest()
    capability(identity)
    await expect(
      identity.signer.signEvent(
        buildCheckoutSparkRecoveryRumor(
          initialPayload(identity)
        ).rawEvent() as UnsignedNostrEvent
      )
    ).rejects.toThrow()
  })

  it("rejects another recipient and buyer self-copy without exposing NIP-04 or implicit-scheme encryption", async () => {
    const { identity } = guest()
    const signer = capability(identity)
    const value = serialize(
      buildCheckoutSparkRecoveryRumor(initialPayload(identity))
    )
    for (const recipient of [other.pubkey, identity.pubkey]) {
      await expect(signer.encryptNip44(recipient, value)).rejects.toThrow()
    }
    expect("encrypt" in signer).toBe(false)
    expect("encryptNip04" in signer).toBe(false)
    expect("encryptionEnabled" in signer).toBe(false)
  })

  it.each(["order", "merchant", "sender"] as const)(
    "rejects an otherwise canonical recovery for another %s",
    async (field) => {
      const { identity } = guest()
      const payload = initialPayload(
        identity,
        field === "order"
          ? { state: state("another-order") }
          : field === "merchant"
            ? { state: state(ORDER_ID, other.pubkey) }
            : { senderPubkey: other.pubkey }
      )
      const rumor = buildCheckoutSparkRecoveryRumor(payload)
      expect(parseCheckoutSparkRecoveryRumor(rumor)).toEqual(payload)
      await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
    }
  )

  it("rejects a valid legacy recovery payload and plan", async () => {
    const { identity } = guest()
    const plan = freezeCheckoutSparkPlan({
      checkoutId: initialState.plan.checkoutId,
      orderId: ORDER_ID,
      merchantPubkey: merchant.pubkey,
      walletId: initialState.plan.walletId,
      network: "mainnet",
      createdAt: CREATED_AT,
      takeoverAt: initialState.plan.takeoverAt,
      funding: { ...initialState.plan.funding, requiredNetSats: 122 },
      obligations: [
        {
          kind: "merchant",
          recipientId: merchant.pubkey,
          paymentRequest: "lnbc-legacy-merchant-fixture",
          amountSats: 10,
          maxFeeSats: 0,
        },
        {
          kind: "conduit",
          recipientId: "conduit-tester@rizful.com",
          paymentRequest: "lnbc-legacy-fee-fixture",
          amountSats: 111,
          maxFeeSats: 1,
        },
      ],
    })
    const payload = createCheckoutSparkRecoveryPayload({
      plan,
      senderPubkey: identity.pubkey,
      mnemonic: MNEMONIC,
      accountNumber: 1,
      preparedAt: PREPARED_AT,
    })
    const rumor = buildCheckoutSparkRecoveryRumor(payload)
    expect(parseCheckoutSparkRecoveryRumor(rumor)).toEqual(payload)
    await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
  })

  it.each(["p", "type", "order", "checkout", "handoff"])(
    "rejects duplicate %s binding tags",
    async (name) => {
      const { identity } = guest()
      const rumor = buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      rumor.tags.push([...rumor.tags.find((tag) => tag[0] === name)!])
      rumor.id = rumor.getEventHash()
      await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
    }
  )

  it.each([
    "extra-tag",
    "generic-order",
    "signed",
    "unknown-payload-field",
    "changed-state",
    "noncanonical-content",
  ])("rejects %s plaintext without granting a seal", async (change) => {
    const { identity } = guest()
    const payload = initialPayload(identity)
    const rumor = buildCheckoutSparkRecoveryRumor(payload)
    if (change === "extra-tag") rumor.tags.push(["extra", "not-canonical"])
    if (change === "generic-order")
      rumor.tags.find((tag) => tag[0] === "type")![1] = "order"
    if (change === "signed") rumor.sig = "a".repeat(128)
    if (change === "unknown-payload-field")
      rumor.content = JSON.stringify({ ...payload, extra: true })
    if (change === "changed-state")
      rumor.content = JSON.stringify({
        ...payload,
        state: { ...payload.state, updatedAt: PREPARED_AT + 1 },
      })
    if (change === "noncanonical-content")
      rumor.content = JSON.stringify(payload, null, 2)
    rumor.id = rumor.getEventHash()
    await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
  })

  it("rejects malformed JSON and generic message encryption", async () => {
    const { identity } = guest()
    const signer = capability(identity)
    for (const value of ["hello merchant", "{", "null", "[]", "{}"]) {
      await expect(
        signer.encryptNip44(merchant.pubkey, value)
      ).rejects.toThrow()
    }
  })

  it("encrypts only the rebuilt canonical rumor, excluding unrelated raw fields", async () => {
    const { identity } = guest()
    const rumor = buildCheckoutSparkRecoveryRumor(initialPayload(identity))
    const signer = capability(identity)
    const ciphertext = await signer.encryptNip44(
      merchant.pubkey,
      JSON.stringify({ ...rumor.rawEvent(), extra: "unrelated raw field" })
    )
    const opened = await merchant.decrypt(
      new NDKUser({ pubkey: identity.pubkey }),
      ciphertext,
      "nip44"
    )
    expect(opened).toBe(serialize(rumor))
    expect(opened).not.toContain("unrelated raw field")
  })

  it("requires an active, exact-length guest session and matching underlying key", () => {
    const { identity } = guest()
    for (const time of [
      CREATED_AT - 1,
      identity.expiresAt,
      identity.expiresAt + 1,
      Number.NaN,
      Infinity,
      NOW + 0.5,
    ]) {
      expect(() => capability(identity, () => time)).toThrow()
    }
    for (const changed of [
      { ...identity, createdAt: NOW + 1 },
      { ...identity, expiresAt: identity.expiresAt + 1 },
      { ...identity, pubkey: other.pubkey },
      { ...identity, signer: other },
    ]) {
      expect(() => capability(changed)).toThrow()
    }
    expect(identity.expiresAt - identity.createdAt).toBe(
      GUEST_ORDER_SESSION_TTL_MS
    )
  })

  it("rejects preparation before this guest session, in the future, or use at takeover", async () => {
    const { identity } = guest()
    const signer = capability(identity)
    const future = initialPayload(identity, { preparedAt: NOW + 1 })
    await expect(
      encryptRumor(signer, buildCheckoutSparkRecoveryRumor(future))
    ).rejects.toThrow()
    const laterIdentity = {
      ...identity,
      createdAt: PREPARED_AT + 1,
      expiresAt: PREPARED_AT + 1 + GUEST_ORDER_SESSION_TTL_MS,
    }
    await expect(
      encryptRumor(
        capability(laterIdentity),
        buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      )
    ).rejects.toThrow()
    await expect(
      encryptRumor(
        capability(identity, () => initialState.plan.takeoverAt),
        buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      )
    ).rejects.toThrow()
  })

  it.each(["session", "takeover"] as const)(
    "rejects expiry at %s while encryption is awaiting",
    async (boundary) => {
      const { identity } = guest()
      let clock = NOW
      const started = deferred()
      const held = deferred()
      const original = identity.signer.encryptNip44.bind(identity.signer)
      identity.signer.encryptNip44 = async (...args) => {
        const ciphertext = await original(...args)
        started.resolve()
        await held.promise
        return ciphertext
      }
      const signer = capability(identity, () => clock)
      const pending = encryptRumor(
        signer,
        buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      )
      await started.promise
      clock =
        boundary === "session"
          ? identity.expiresAt
          : initialState.plan.takeoverAt
      held.resolve()
      await expect(pending).rejects.toThrow()
    }
  )

  it.each(["session", "takeover"] as const)(
    "consumes permission before awaiting sign and rejects expiry at %s",
    async (boundary) => {
      const { identity } = guest()
      let clock = NOW
      const started = deferred()
      const held = deferred()
      const original = identity.signer.signEvent.bind(identity.signer)
      identity.signer.signEvent = async (event) => {
        const signature = await original(event)
        started.resolve()
        await held.promise
        return signature
      }
      const signer = capability(identity, () => clock)
      const ciphertext = await encryptRumor(
        signer,
        buildCheckoutSparkRecoveryRumor(initialPayload(identity))
      )
      const event = seal(identity, ciphertext)
      const pending = signer.signEvent(event)
      await started.promise
      await expect(signer.signEvent(event)).rejects.toThrow()
      clock =
        boundary === "session"
          ? identity.expiresAt
          : initialState.plan.takeoverAt
      held.resolve()
      await expect(pending).rejects.toThrow()
    }
  )

  it("does not expose decryption, raw private material or signer serialization", async () => {
    const { identity } = guest()
    const signer = capability(identity)
    expect(signer.pubkey).toBe(identity.pubkey)
    expect(await signer.getPublicKey()).toBe(identity.pubkey)
    for (const field of [
      "privateKey",
      "nsec",
      "signer",
      "identity",
      "toPayload",
      "user",
      "userSync",
      "blockUntilReady",
    ])
      expect(field in signer).toBe(false)
    await expect(
      signer.decryptNip44(merchant.pubkey, "ciphertext")
    ).rejects.toThrow()
    await expect(
      signer.decryptLegacy(merchant.pubkey, "ciphertext")
    ).rejects.toThrow()
    expect(JSON.stringify(signer)).not.toContain("privateKey")
    expect(JSON.stringify(signer)).not.toContain(MNEMONIC)
  })

  it("reuses the same bounded guest key after same-tab restoration", async () => {
    const { identity, storage } = guest()
    try {
      const restored = getSessionGuestOrderSigningIdentity(
        ORDER_ID,
        storage,
        NOW
      )
      expect(restored?.pubkey).toBe(identity.pubkey)
      expect(restored?.expiresAt).toBe(identity.expiresAt)
      const signer = capability(restored!)
      const rumor = buildCheckoutSparkRecoveryRumor(initialPayload(restored!))
      const ciphertext = await encryptRumor(signer, rumor)
      const event = new NDKEvent(undefined, seal(restored!, ciphertext))
      Object.assign(event, await signer.signEvent(seal(restored!, ciphertext)))
      expect(event.pubkey).toBe(identity.pubkey)
      expect(event.verifySignature(false)).toBe(true)
    } finally {
      clearSessionGuestOrderSigningIdentity(ORDER_ID, storage)
    }
  })
})
