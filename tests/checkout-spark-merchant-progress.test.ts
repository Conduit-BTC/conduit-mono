import { describe, expect, it } from "bun:test"
import {
  giftWrap as legacyGiftWrap,
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
} from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { unwrapPrivateMessageEnvelope } from "../packages/core/src/protocol/messaging"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
} from "nostr-tools/pure"
import type { PrivateMessageEvent } from "../packages/core/src/protocol/messaging"

import {
  buildCheckoutSparkMerchantProgressRumor,
  createCheckoutSparkMerchantProgress,
  openCheckoutSparkMerchantProgressWrap,
  parseCheckoutSparkMerchantProgress,
  parseCheckoutSparkMerchantProgressRumor,
} from "@conduit/core/protocol/checkout-spark-merchant-progress"
import {
  inspectCheckoutSparkRecoveryWrap,
  openCheckoutSparkRecoveryWrap,
} from "@conduit/core/protocol/checkout-spark-recovery"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { getNdk } from "@conduit/core/protocol/ndk"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const HANDOFF_ID = "1".repeat(64)
// Disposable in-memory fixture keys only; no account signer or provider is used.
const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
const other = plainTestSigner(NDKPrivateKeySigner.generate())

/** Independent retained-client interop fixture; production remains NDK-neutral. */
function giftWrap(
  rumor: PrivateMessageEvent,
  recipient: NDKUser,
  signer: typeof merchant
) {
  return legacyGiftWrap(
    new NDKEvent(getNdk(), rumor as never),
    recipient,
    signer
  )
}

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function creditedState() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-progress-checkout",
    orderId: "merchant-progress-order",
    merchantPubkey: merchant.pubkey,
    walletId: "merchant-progress-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchant.pubkey}:progress-fixture`,
          productEventId: "e".repeat(64),
          merchantPubkey: merchant.pubkey,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-progress-receive",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant.pubkey,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "f".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: {
            type: "conduit_allowlist",
            policy: "local_router_canary",
          },
        },
      },
    ],
  })
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "synthetic-receive-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 2_000,
    }
  )
}

const credit = creditedState()
function preparedState(preparedAt = TAKEOVER_AT) {
  const leg = credit.legs[0]!
  return prepareCheckoutSparkSettledLeg(credit, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(credit.plan, leg.legId),
    paymentRequest: invoice(995, 8),
    paymentHash: "08".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt,
  })
}

const state = preparedState()
function payload() {
  return createCheckoutSparkMerchantProgress({
    initialHandoffId: HANDOFF_ID,
    state,
  })
}

function changedAtPath(
  value: unknown,
  path: string[],
  replacement: unknown
): unknown {
  const changed = structuredClone(value) as Record<string, unknown>
  let target = changed
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>
  }
  target[path.at(-1)!] = replacement
  return changed
}

function changedRumor(
  change: (rumor: PrivateMessageEvent) => void
): PrivateMessageEvent {
  const rumor = buildCheckoutSparkMerchantProgressRumor(payload())
  change(rumor)
  rumor.id = getEventHash(rumor)
  return rumor
}

function signedOuter(tags: string[][], kind = 1059): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind,
      created_at: CREATED_AT / 1_000,
      tags,
      content: "fixture-ciphertext",
    },
    generateSecretKey()
  )
}

describe("checkout Spark merchant machine progress", () => {
  it("round-trips canonical state with deterministic, handoff-and-state-bound identity", () => {
    const expected = payload()
    expect(
      parseCheckoutSparkMerchantProgress(structuredClone(expected))
    ).toEqual(expected)
    expect(
      createCheckoutSparkMerchantProgress({
        initialHandoffId: HANDOFF_ID,
        state,
      })
    ).toEqual(expected)
    expect(expected.merchantPubkey).toBe(state.plan.merchantPubkey)
    expect(expected.recordedAt).toBe(TAKEOVER_AT)
    expect(expected.snapshotId).toMatch(/^[0-9a-f]{64}$/)
    expect(
      createCheckoutSparkMerchantProgress({
        initialHandoffId: "2".repeat(64),
        state,
      }).snapshotId
    ).not.toBe(expected.snapshotId)
    const intent = state.legs[0]!.intent!
    const submitted = recordCheckoutSparkSettledLegStatus(state, {
      legId: intent.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "submitted",
      observedAt: TAKEOVER_AT + 1,
    })
    expect(
      createCheckoutSparkMerchantProgress({
        initialHandoffId: HANDOFF_ID,
        state: submitted,
      }).snapshotId
    ).not.toBe(expected.snapshotId)
    expect(state.legs[0]!.status).toBe("prepared")
  })

  it("requires a prepared intent and a state update at or after takeover", () => {
    for (const invalid of [
      credit,
      { ...credit, updatedAt: TAKEOVER_AT },
      preparedState(TAKEOVER_AT - 1),
    ]) {
      expect(() =>
        createCheckoutSparkMerchantProgress({
          initialHandoffId: HANDOFF_ID,
          state: invalid,
        })
      ).toThrow("progress is invalid")
    }
    for (const initialHandoffId of [
      "",
      "a",
      "A".repeat(64),
      ` ${HANDOFF_ID}`,
    ]) {
      expect(() =>
        createCheckoutSparkMerchantProgress({ initialHandoffId, state })
      ).toThrow("progress is invalid")
    }
  })

  it("canonicalizes creator input and omits app-only order or recovery data at every depth", () => {
    let extended: unknown = state
    const paths = [
      ["mnemonic"],
      ["plan", "fullOrder"],
      ["plan", "funding", "wallet"],
      ["plan", "commerceQuote", "lines", "0", "shippingAddress"],
      ["plan", "recipients", "0", "destination", "source", "privateNote"],
      ["credit", "privateNote"],
      ["legs", "0", "mnemonic"],
      ["legs", "0", "intent", "privateNote"],
    ]
    for (const path of paths)
      extended = changedAtPath(extended, path, "private-fixture-only")
    const canonical = createCheckoutSparkMerchantProgress({
      initialHandoffId: HANDOFF_ID,
      state: extended as typeof state,
    })
    expect(canonical).toEqual(payload())
    expect(JSON.stringify(canonical)).not.toContain("private-fixture-only")
    expect(Object.keys(canonical)).toEqual([
      "schemaVersion",
      "type",
      "snapshotId",
      "initialHandoffId",
      "merchantPubkey",
      "recordedAt",
      "state",
    ])
  })

  it("rejects unknown fields, missing data, altered bindings and forged snapshot identities", () => {
    const expected = payload()
    const changes: [string[], unknown][] = [
      [["wallet"], {}],
      [["fullOrder"], undefined],
      [["schemaVersion"], 2],
      [["type"], "checkout_spark_recovery_progress"],
      [["snapshotId"], "a".repeat(64)],
      [["initialHandoffId"], "2".repeat(64)],
      [["merchantPubkey"], other.pubkey],
      [["recordedAt"], TAKEOVER_AT + 1],
      [["state", "mnemonic"], "private-fixture-only"],
      [["state", "plan", "orderId"], "wrong-order"],
      [["state", "plan", "funding", "extra"], undefined],
      [["state", "plan", "recipients", "0", "destination", "extra"], true],
      [["state", "credit", "creditedSats"], 1_110],
      [["state", "legs", "0", "extra"], "private-fixture-only"],
      [["state", "legs", "0", "intent", "transferId"], "wrong-transfer"],
      [["state", "legs", "0", "intent", "extra"], true],
      [["state", "legs", "0", "status"], "paid"],
    ]
    for (const [path, value] of changes) {
      expect(() =>
        parseCheckoutSparkMerchantProgress(changedAtPath(expected, path, value))
      ).toThrow("progress is invalid")
    }
    for (const malformed of [
      null,
      undefined,
      [],
      {},
      "not-json",
      { ...expected, state: null },
    ]) {
      expect(() => parseCheckoutSparkMerchantProgress(malformed)).toThrow(
        "progress is invalid"
      )
    }
    const missing = { ...expected } as Partial<typeof expected>
    delete missing.snapshotId
    expect(() => parseCheckoutSparkMerchantProgress(missing)).toThrow(
      "progress is invalid"
    )
  })

  it("emits an unsigned merchant-to-self kind-16 rumor with exact canonical tags and timestamp", () => {
    const expected = payload()
    const rumor = buildCheckoutSparkMerchantProgressRumor(expected)
    expect(rumor.kind).toBe(16)
    expect(rumor.pubkey).toBe(merchant.pubkey)
    expect(rumor.sig).toBeUndefined()
    expect(rumor.created_at).toBe(Math.floor(expected.recordedAt / 1_000))
    expect(rumor.tags).toEqual([
      ["p", merchant.pubkey],
      ["type", expected.type],
      ["order", state.plan.orderId],
    ])
    expect(rumor.content).toBe(JSON.stringify(expected))
    expect(rumor.id).toBe(getEventHash(rumor))
    expect(parseCheckoutSparkMerchantProgressRumor(rumor)).toEqual(expected)
  })

  it("rejects rehashed rumors with wrong direction, kind, tags, timestamp or noncanonical content", () => {
    const changes: ((rumor: NDKEvent) => void)[] = [
      (rumor) => {
        rumor.kind = 14
      },
      (rumor) => {
        rumor.pubkey = other.pubkey
      },
      (rumor) => {
        rumor.created_at! += 1
      },
      (rumor) => {
        rumor.sig = "0".repeat(128)
      },
      (rumor) => {
        rumor.tags[0] = ["p", other.pubkey]
      },
      (rumor) => {
        rumor.tags[0]!.push("relay-hint")
      },
      (rumor) => {
        rumor.tags[1] = ["type", "checkout_spark_recovery_progress"]
      },
      (rumor) => {
        rumor.tags[2] = ["order", "different-order"]
      },
      (rumor) => {
        rumor.tags.push(["p", merchant.pubkey])
      },
      (rumor) => {
        rumor.tags.push(["amount", "1000"])
      },
      (rumor) => {
        rumor.tags.splice(0, 1)
      },
      (rumor) => {
        rumor.content = JSON.stringify(payload(), null, 2)
      },
      (rumor) => {
        rumor.content = "not-json"
      },
    ]
    for (const change of changes) {
      expect(() =>
        parseCheckoutSparkMerchantProgressRumor(changedRumor(change))
      ).toThrow("rumor is invalid")
    }
    const wrongId = buildCheckoutSparkMerchantProgressRumor(payload())
    wrongId.id = "a".repeat(64)
    expect(() => parseCheckoutSparkMerchantProgressRumor(wrongId)).toThrow(
      "rumor is invalid"
    )
  })

  it("opens a real locally encrypted merchant self-wrap without reading NDK's cache", async () => {
    const expected = payload()
    const rumor = buildCheckoutSparkMerchantProgressRumor(expected)
    const wrapped = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      merchant
    )
    const ndk = getNdk()
    const previousCache = ndk.cacheAdapter
    let cacheReads = 0
    ndk.cacheAdapter = {
      getDecryptedEvent: async () => {
        cacheReads += 1
        return rumor
      },
    } as unknown as NonNullable<typeof ndk.cacheAdapter>
    try {
      const opened = await openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap: wrapped.rawEvent() as SignedPublicNostrEvent,
        signer: merchant,
      })
      expect(opened).toEqual({
        wrapId: wrapped.id,
        rumorId: rumor.id,
        payload: expected,
      })
      expect(cacheReads).toBe(0)
      expect(wrapped.content).not.toContain("merchant-progress-order")
      expect(wrapped.content).not.toContain(
        state.legs[0]!.intent!.paymentRequest
      )
    } finally {
      ndk.cacheAdapter = previousCache
    }
  })

  it("rejects an actual wrap opened by the wrong signer and a seal signed by someone other than the rumor author", async () => {
    const rumor = buildCheckoutSparkMerchantProgressRumor(payload())
    const wrapped = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      merchant
    )
    await expect(
      openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap: wrapped.rawEvent() as SignedPublicNostrEvent,
        signer: other,
      })
    ).rejects.toThrow("wrap is invalid")
    const mismatchedSeal = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      other
    )
    await expect(
      openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap:
          mismatchedSeal.rawEvent() as SignedPublicNostrEvent,
        signer: merchant,
      })
    ).rejects.toThrow("wrap is invalid")
    const wrongRecipient = await giftWrap(
      rumor,
      new NDKUser({ pubkey: other.pubkey }),
      merchant
    )
    await expect(
      openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap:
          wrongRecipient.rawEvent() as SignedPublicNostrEvent,
        signer: other,
      })
    ).rejects.toThrow("wrap is invalid")
  })

  it("rejects invalid signatures, kinds and ambiguous recipients before attempting unwrap", async () => {
    let unwrapCalls = 0
    const invalidSignature = signedOuter([["p", merchant.pubkey]])
    invalidSignature.content = "modified-after-signature"
    const invalid = [
      invalidSignature,
      signedOuter([["p", merchant.pubkey]], 16),
      signedOuter([]),
      signedOuter([["p", other.pubkey]]),
      signedOuter([
        ["p", merchant.pubkey],
        ["p", merchant.pubkey],
      ]),
      signedOuter([["p", merchant.pubkey, "unexpected-field"]]),
      signedOuter([["p", merchant.pubkey], ["p"]]),
    ]
    for (const signedRecipientWrap of invalid) {
      await expect(
        openCheckoutSparkMerchantProgressWrap({
          signedRecipientWrap,
          signer: merchant,
          giftUnwrap: async () => {
            unwrapCalls += 1
            return buildCheckoutSparkMerchantProgressRumor(payload())
          },
        })
      ).rejects.toThrow("wrap is invalid")
    }
    expect(unwrapCalls).toBe(0)
  })

  it("passes a fresh NDK-less event to the unwrap seam and rejects missing or malformed inner data", async () => {
    const signedRecipientWrap = signedOuter([["p", merchant.pubkey]])
    for (const result of [
      null,
      changedRumor((rumor) => {
        rumor.tags[0] = ["p", other.pubkey]
      }),
    ]) {
      await expect(
        openCheckoutSparkMerchantProgressWrap({
          signedRecipientWrap,
          signer: merchant,
          giftUnwrap: async (wrapped, signer) => {
            expect("ndk" in wrapped).toBe(false)
            expect(wrapped).toEqual(signedRecipientWrap)
            expect(signer).toBe(merchant)
            return result
          },
        })
      ).rejects.toThrow("wrap is invalid")
    }
    await expect(
      openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap,
        signer: merchant,
        giftUnwrap: async () => {
          throw new Error("private-error-must-not-escape")
        },
      })
    ).rejects.toThrow("Checkout Spark merchant progress wrap is invalid.")
  })

  it("pins the validated signed envelope before awaiting signer identity", async () => {
    const signedRecipientWrap = signedOuter([["p", merchant.pubkey]])
    const original = structuredClone(signedRecipientWrap)
    const signer = {
      getPublicKey: async () => {
        signedRecipientWrap.content = "changed-while-awaiting-signer"
        signedRecipientWrap.id = "a".repeat(64)
        signedRecipientWrap.tags = [["p", other.pubkey]]
        return merchant.pubkey
      },
    } as NostrKeySigner
    const rumor = buildCheckoutSparkMerchantProgressRumor(payload())
    const result = await openCheckoutSparkMerchantProgressWrap({
      signedRecipientWrap,
      signer,
      giftUnwrap: async (wrapped) => {
        expect(wrapped).toEqual(original)
        return rumor
      },
    })
    expect(result.wrapId).toBe(original.id)
    expect(result.rumorId).toBe(rumor.id)
  })

  it("inspects Merchant progress after one fresh authenticated unwrap without treating it as buyer authority", async () => {
    const expected = payload()
    const rumor = buildCheckoutSparkMerchantProgressRumor(expected)
    const wrapped = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      merchant
    )
    const signedRecipientWrap = wrapped.rawEvent() as SignedPublicNostrEvent
    const ndk = getNdk()
    const previousCache = ndk.cacheAdapter
    let cacheReads = 0
    let cacheWrites = 0
    let unwraps = 0
    ndk.cacheAdapter = {
      getDecryptedEvent: async () => {
        cacheReads += 1
        return rumor
      },
      addDecryptedEvent: async () => {
        cacheWrites += 1
      },
    } as unknown as NonNullable<typeof ndk.cacheAdapter>
    try {
      const outcome = await inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap,
        signer: merchant,
        giftUnwrap: async (event, signer) => {
          unwraps += 1
          expect("ndk" in event).toBe(false)
          return unwrapPrivateMessageEnvelope(event, signer)
        },
      })
      expect(outcome).toEqual({
        status: "merchant_progress",
        wrapId: wrapped.id,
        rumorId: rumor.id,
        payload: expected,
      })
      expect(unwraps).toBe(1)
      expect(cacheReads).toBe(0)
      expect(cacheWrites).toBe(0)
      await expect(
        openCheckoutSparkRecoveryWrap({ signedRecipientWrap, signer: merchant })
      ).rejects.toThrow("recovery wrap is invalid")
    } finally {
      ndk.cacheAdapter = previousCache
    }
  })

  it("rejects mixed machine markers, malformed progress and a non-self merchant instead of ignoring them", async () => {
    const signedRecipientWrap = signedOuter([["p", merchant.pubkey]])
    const rumors = [
      ...[
        "order",
        "checkout_spark_recovery",
        "checkout_spark_recovery_progress",
        "checkout_spark_merchant_progress",
      ].map((type) =>
        changedRumor((rumor) => {
          rumor.tags.push(["type", type])
        })
      ),
      changedRumor((rumor) => {
        rumor.kind = 14
      }),
      changedRumor((rumor) => {
        rumor.content = "not-json"
      }),
      changedRumor((rumor) => {
        rumor.tags[0] = ["p", other.pubkey]
      }),
    ]
    for (const rumor of rumors) {
      expect(
        await inspectCheckoutSparkRecoveryWrap({
          signedRecipientWrap,
          signer: merchant,
          giftUnwrap: async () => rumor,
        })
      ).toEqual({ status: "malformed", wrapId: signedRecipientWrap.id })
    }
    const nonSelfWrap = signedOuter([["p", other.pubkey]])
    expect(
      await inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap: nonSelfWrap,
        signer: other,
        giftUnwrap: async () =>
          buildCheckoutSparkMerchantProgressRumor(payload()),
      })
    ).toEqual({ status: "malformed", wrapId: nonSelfWrap.id })
    for (const tags of [
      [["p", merchant.pubkey, "unexpected-field"]],
      [["p", merchant.pubkey], ["p"]],
    ]) {
      const malformedRecipient = signedOuter(tags)
      expect(
        await inspectCheckoutSparkRecoveryWrap({
          signedRecipientWrap: malformedRecipient,
          signer: merchant,
          giftUnwrap: async () =>
            buildCheckoutSparkMerchantProgressRumor(payload()),
        })
      ).toEqual({ status: "malformed", wrapId: malformedRecipient.id })
    }
  })

  it("keeps failed seal authentication retryable and ordinary private messages ignored", async () => {
    const rumor = buildCheckoutSparkMerchantProgressRumor(payload())
    const mismatchedSeal = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      other
    )
    expect(
      await inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap:
          mismatchedSeal.rawEvent() as SignedPublicNostrEvent,
        signer: merchant,
      })
    ).toEqual({ status: "decrypt_failed", wrapId: mismatchedSeal.id })
    const ordinary = changedRumor((event) => {
      event.kind = 14
      event.tags = [["p", merchant.pubkey]]
      event.content = "synthetic ordinary private message"
    })
    const wrapped = signedOuter([["p", merchant.pubkey]])
    expect(
      await inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap: wrapped,
        signer: merchant,
        giftUnwrap: async () => ordinary,
      })
    ).toEqual({ status: "ignored", wrapId: wrapped.id })
  })

  it("pins inspected signed ciphertext across the signer identity await", async () => {
    const signedRecipientWrap = signedOuter([["p", merchant.pubkey]])
    const original = structuredClone(signedRecipientWrap)
    const signer = {
      getPublicKey: async () => {
        signedRecipientWrap.content = "changed-while-awaiting-signer"
        signedRecipientWrap.tags = [["p", other.pubkey]]
        return merchant.pubkey
      },
    } as NostrKeySigner
    const rumor = buildCheckoutSparkMerchantProgressRumor(payload())
    const outcome = await inspectCheckoutSparkRecoveryWrap({
      signedRecipientWrap,
      signer,
      giftUnwrap: async (event) => {
        expect(event).toEqual(original)
        return rumor
      },
    })
    expect(outcome.status).toBe("merchant_progress")
    expect(outcome.wrapId).toBe(original.id)
  })
})
