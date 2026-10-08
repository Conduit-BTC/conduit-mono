import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { getEventHash, verifyEvent } from "nostr-tools/pure"
import {
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  freezeCheckoutSparkPlan,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
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
const RECOVERY_CASES = [
  [3, "initial"],
  [3, "progress"],
  [4, "initial"],
  [4, "progress"],
] as const

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

function state(
  orderId = ORDER_ID,
  merchantPubkey = merchant.pubkey,
  version: 3 | 4 = 3
) {
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
  if (version === 3) return createCheckoutSparkSettledReconciliation(plan)
  // Opaque destination/invoice fixtures exercise the shared recovery schema,
  // not SDK decoding, provider authority, or a native transfer.
  const nativeIdentity = {
    ...plan,
    sparkAddress: "spark-guest-treasury.fixture",
    receiverIdentityPublicKey: `03${"e".repeat(64)}`,
    senderIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
  }
  return createCheckoutSparkSettledReconciliation(
    freezeCheckoutSparkSettledTreasuryPlan({
      ...plan,
      nativeTreasury: {
        schemaVersion: 1,
        sparkAddress: nativeIdentity.sparkAddress,
        receiverIdentityPublicKey: nativeIdentity.receiverIdentityPublicKey,
        senderIdentityPublicKey: nativeIdentity.senderIdentityPublicKey,
        invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId(nativeIdentity),
        invoiceRequest: "spark-guest-treasury-invoice.fixture",
        feePolicy: "zero_required",
        residualPolicy: "unused_commerce_reserves",
      },
    })
  )
}

const initialState = state()
const nativeInitialState = state(ORDER_ID, merchant.pubkey, 4)
type RecoveryPayloadOverrides = {
  state?: ReturnType<typeof state>
  senderPubkey?: string
  preparedAt?: number
  planVersion?: 3 | 4
}

function initialPayload(
  identity: GuestOrderSigningIdentity,
  overrides: RecoveryPayloadOverrides = {}
) {
  return createCheckoutSparkSettledRecoveryPayload({
    state:
      overrides.state ??
      (overrides.planVersion === 4 ? nativeInitialState : initialState),
    senderPubkey: overrides.senderPubkey ?? identity.pubkey,
    preparedAt: overrides.preparedAt ?? PREPARED_AT,
    mnemonic: MNEMONIC,
    accountNumber: 1,
  })
}

function progressPayload(
  identity: GuestOrderSigningIdentity,
  overrides: RecoveryPayloadOverrides = {}
) {
  const initial = initialPayload(identity, overrides)
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
    senderPubkey: overrides.senderPubkey ?? identity.pubkey,
    preparedAt: overrides.preparedAt ?? NOW,
  })
}

function recoveryPayload(
  identity: GuestOrderSigningIdentity,
  version: 3 | 4,
  phase: "initial" | "progress",
  overrides: RecoveryPayloadOverrides = {}
) {
  const input = { ...overrides, planVersion: version }
  return phase === "initial"
    ? initialPayload(identity, input)
    : progressPayload(identity, input)
}

function serialize(
  rumor: ReturnType<typeof buildCheckoutSparkRecoveryRumor>
): string {
  return JSON.stringify(rumor)
}

function capability(identity: GuestOrderSigningIdentity, now = () => NOW) {
  return createGuestCheckoutSparkRecoverySigner(identity, { now })
}

function encryptRumor(
  signer: NostrKeySigner,
  rumor: ReturnType<typeof buildCheckoutSparkRecoveryRumor>
) {
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
  it.each(RECOVERY_CASES)(
    "encrypts and signs a real merchant-only NIP-59 v%i %s handoff",
    async (version, phase) => {
      const { identity } = guest()
      const payload = recoveryPayload(identity, version, phase)
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
      expect(verifyEvent(wrapped)).toBe(true)
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
      expect(payload.plan.schemaVersion).toBe(version)
      if (version === 4) {
        expect(payload.state.schemaVersion).toBe(5)
        expect(payload.plan.nativeTreasury).toEqual(
          nativeInitialState.plan.nativeTreasury
        )
      }
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

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      [1, 4, 14, 16, 30_402, 10_059].map(
        (kind) => [version, phase, kind] as const
      )
    )
  )(
    "does not sign v%i %s recovery as kind %i directly",
    async (version, phase, kind) => {
      const { identity } = guest()
      const rumor = structuredClone(
        buildCheckoutSparkRecoveryRumor(
          recoveryPayload(identity, version, phase)
        )
      )
      rumor.kind = kind
      await expect(
        capability(identity).signEvent(rumor as UnsignedNostrEvent)
      ).rejects.toThrow()
    }
  )

  it.each(RECOVERY_CASES)(
    "does not broaden the original guest order signer for v%i %s recovery",
    async (version, phase) => {
      const { identity } = guest()
      capability(identity)
      await expect(
        identity.signer.signEvent(
          buildCheckoutSparkRecoveryRumor(
            recoveryPayload(identity, version, phase)
          ) as UnsignedNostrEvent
        )
      ).rejects.toThrow()
    }
  )

  it.each(RECOVERY_CASES)(
    "rejects other recipients and buyer self-copy for v%i %s without exposing other encryption schemes",
    async (version, phase) => {
      const { identity } = guest()
      const signer = capability(identity)
      const value = serialize(
        buildCheckoutSparkRecoveryRumor(
          recoveryPayload(identity, version, phase)
        )
      )
      for (const recipient of [other.pubkey, identity.pubkey]) {
        await expect(signer.encryptNip44(recipient, value)).rejects.toThrow()
      }
      expect("encrypt" in signer).toBe(false)
      expect("encryptNip04" in signer).toBe(false)
      expect("encryptionEnabled" in signer).toBe(false)
    }
  )

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      (["order", "merchant", "sender"] as const).map(
        (field) => [version, phase, field] as const
      )
    )
  )(
    "rejects canonical v%i %s recovery for another %s",
    async (version, phase, field) => {
      const { identity } = guest()
      const payload = recoveryPayload(
        identity,
        version,
        phase,
        field === "order"
          ? { state: state("another-order", merchant.pubkey, version) }
          : field === "merchant"
            ? { state: state(ORDER_ID, other.pubkey, version) }
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

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      ["p", "type", "order", "checkout", "handoff"].map(
        (name) => [version, phase, name] as const
      )
    )
  )(
    "rejects v%i %s with duplicate %s binding tags",
    async (version, phase, name) => {
      const { identity } = guest()
      const rumor = structuredClone(
        buildCheckoutSparkRecoveryRumor(
          recoveryPayload(identity, version, phase)
        )
      )
      rumor.tags.push([...rumor.tags.find((tag) => tag[0] === name)!])
      rumor.id = getEventHash(rumor)
      await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
    }
  )

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      [
        "extra-tag",
        "generic-order",
        "signed",
        "unknown-payload-field",
        "changed-state",
        "noncanonical-content",
      ].map((change) => [version, phase, change] as const)
    )
  )(
    "rejects v%i %s %s plaintext without granting a seal",
    async (version, phase, change) => {
      const { identity } = guest()
      const payload = recoveryPayload(identity, version, phase)
      const rumor = structuredClone(buildCheckoutSparkRecoveryRumor(payload))
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
      rumor.id = getEventHash(rumor)
      await expect(encryptRumor(capability(identity), rumor)).rejects.toThrow()
    }
  )

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
      JSON.stringify({ ...rumor, extra: "unrelated raw field" })
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

  it.each(RECOVERY_CASES)(
    "rejects an expired guest before v%i %s encryption or authorized seal signing",
    async (version, phase) => {
      const { identity } = guest()
      let clock = NOW
      let signed = 0
      const originalSign = identity.signer.signEvent.bind(identity.signer)
      identity.signer.signEvent = async (event) => {
        signed += 1
        return originalSign(event)
      }
      const signer = capability(identity, () => clock)
      const rumor = buildCheckoutSparkRecoveryRumor(
        recoveryPayload(identity, version, phase)
      )
      const ciphertext = await encryptRumor(signer, rumor)
      clock = identity.expiresAt
      await expect(
        signer.signEvent(seal(identity, ciphertext))
      ).rejects.toThrow()
      expect(signed).toBe(0)
      await expect(encryptRumor(signer, rumor)).rejects.toThrow()
    }
  )

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      (["session", "takeover"] as const).map(
        (boundary) => [version, phase, boundary] as const
      )
    )
  )(
    "rejects v%i %s expiry at %s while encryption is awaiting",
    async (version, phase, boundary) => {
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
      const payload = recoveryPayload(identity, version, phase)
      const pending = encryptRumor(
        signer,
        buildCheckoutSparkRecoveryRumor(payload)
      )
      await started.promise
      clock =
        boundary === "session" ? identity.expiresAt : payload.plan.takeoverAt
      held.resolve()
      await expect(pending).rejects.toThrow()
    }
  )

  it.each(
    RECOVERY_CASES.flatMap(([version, phase]) =>
      (["session", "takeover"] as const).map(
        (boundary) => [version, phase, boundary] as const
      )
    )
  )(
    "consumes v%i %s permission before awaiting sign and rejects expiry at %s",
    async (version, phase, boundary) => {
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
      const payload = recoveryPayload(identity, version, phase)
      const ciphertext = await encryptRumor(
        signer,
        buildCheckoutSparkRecoveryRumor(payload)
      )
      const event = seal(identity, ciphertext)
      const pending = signer.signEvent(event)
      await started.promise
      await expect(signer.signEvent(event)).rejects.toThrow()
      clock =
        boundary === "session" ? identity.expiresAt : payload.plan.takeoverAt
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
