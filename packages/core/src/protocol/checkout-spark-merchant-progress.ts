import { getEventHash } from "nostr-tools"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import { EVENT_KINDS } from "./kinds"
import {
  unwrapPrivateMessageEnvelope,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
} from "./messaging"
import type { NostrKeySigner } from "./nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const SNAPSHOT_DOMAIN = "conduit:checkout-spark-merchant-progress:v1"
const HEX_64 = /^[0-9a-f]{64}$/

/** Machine reconciliation data, never takeover authorization or payment proof. */
export interface CheckoutSparkMerchantProgressPayload {
  schemaVersion: 1 | 2 | 3
  type: "checkout_spark_merchant_progress"
  snapshotId: string
  initialHandoffId: string
  merchantPubkey: string
  recordedAt: number
  state: CheckoutSparkSettledReconciliation
}

export type CheckoutSparkMerchantProgressGiftUnwrap = (
  event: PrivateMessageEvent,
  signer: NostrKeySigner
) => Promise<PrivateMessageEvent | null>

export interface OpenCheckoutSparkMerchantProgressWrapResult {
  wrapId: string
  rumorId: string
  payload: CheckoutSparkMerchantProgressPayload
}

function canonicalState(
  input: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  // Restore validates each leg but preserves its own extra fields. Select the
  // wire fields explicitly so private app data cannot enter this envelope.
  return restoreCheckoutSparkSettledReconciliation({
    schemaVersion: state.schemaVersion,
    plan: state.plan,
    credit: state.credit,
    legs: state.legs.map((leg) => ({
      legId: leg.legId,
      allocationSats: leg.allocationSats,
      intent: leg.intent,
      status: leg.status,
      observedAt: leg.observedAt,
      finalFeeSats: leg.finalFeeSats,
      finalDebitSats: leg.finalDebitSats,
      ...(state.schemaVersion >= 4
        ? {
            generation: leg.generation!,
            closedGenerations: leg.closedGenerations!.map((entry) => ({
              ...entry,
              intent: { ...entry.intent },
              closure: { ...entry.closure },
            })),
          }
        : {}),
    })),
    ...(state.schemaVersion === 5
      ? { treasuryFinalization: structuredClone(state.treasuryFinalization) }
      : {}),
    updatedAt: state.updatedAt,
  })
}

/** Compare data and exact keys, including unknown fields whose value is undefined. */
function matchesCanonicalData(value: unknown, canonical: unknown): boolean {
  if (canonical === null || typeof canonical !== "object") {
    return value === canonical
  }
  if (Array.isArray(canonical)) {
    return (
      Array.isArray(value) &&
      value.length === canonical.length &&
      canonical.every((entry, index) =>
        matchesCanonicalData(value[index], entry)
      )
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const expected = canonical as Record<string, unknown>
  const actual = value as Record<string, unknown>
  const keys = Object.keys(expected)
  return (
    Object.keys(actual).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(actual, key) &&
        matchesCanonicalData(actual[key], expected[key])
    )
  )
}

export function createCheckoutSparkMerchantProgress(input: {
  initialHandoffId: string
  state: CheckoutSparkSettledReconciliation
}): CheckoutSparkMerchantProgressPayload {
  try {
    if (
      typeof input.initialHandoffId !== "string" ||
      !HEX_64.test(input.initialHandoffId)
    ) {
      throw new Error("Invalid handoff")
    }
    const state = canonicalState(input.state)
    if (
      state.updatedAt < state.plan.takeoverAt ||
      !state.legs.some((leg) => leg.intent !== null)
    ) {
      throw new Error("Missing post-handoff progress")
    }
    return {
      schemaVersion:
        state.schemaVersion === 5 ? 3 : state.schemaVersion === 4 ? 2 : 1,
      type: "checkout_spark_merchant_progress",
      snapshotId: bytesToHex(
        sha256(
          new TextEncoder().encode(
            JSON.stringify([
              state.schemaVersion === 5
                ? "conduit:checkout-spark-merchant-progress:v3"
                : state.schemaVersion === 4
                  ? "conduit:checkout-spark-merchant-progress:v2"
                  : SNAPSHOT_DOMAIN,
              input.initialHandoffId,
              state,
            ])
          )
        )
      ),
      initialHandoffId: input.initialHandoffId,
      merchantPubkey: state.plan.merchantPubkey,
      recordedAt: state.updatedAt,
      state,
    }
  } catch {
    throw new Error("Checkout Spark merchant progress is invalid.")
  }
}

export function parseCheckoutSparkMerchantProgress(
  value: unknown
): CheckoutSparkMerchantProgressPayload {
  try {
    const candidate = value as CheckoutSparkMerchantProgressPayload
    const canonical = createCheckoutSparkMerchantProgress({
      initialHandoffId: candidate.initialHandoffId,
      state: candidate.state,
    })
    if (!matchesCanonicalData(value, canonical)) throw new Error("Invalid data")
    return canonical
  } catch {
    throw new Error("Checkout Spark merchant progress is invalid.")
  }
}

function rumorTags(payload: CheckoutSparkMerchantProgressPayload): string[][] {
  return [
    ["p", payload.merchantPubkey],
    ["type", payload.type],
    ["order", payload.state.plan.orderId],
  ]
}

export function buildCheckoutSparkMerchantProgressRumor(
  input: CheckoutSparkMerchantProgressPayload
): PrivateMessageRumor {
  const payload = parseCheckoutSparkMerchantProgress(input)
  const rumor: PrivateMessageRumor = {
    id: "",
    pubkey: payload.merchantPubkey,
    kind: EVENT_KINDS.ORDER,
    created_at: Math.floor(payload.recordedAt / 1_000),
    tags: [],
    content: "",
  }
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = payload.merchantPubkey
  rumor.created_at = Math.floor(payload.recordedAt / 1_000)
  rumor.tags = rumorTags(payload)
  rumor.content = JSON.stringify(payload)
  rumor.id = getEventHash({ ...rumor, created_at: rumor.created_at! })
  return rumor
}

export function parseCheckoutSparkMerchantProgressRumor(
  rumor: PrivateMessageEvent
): CheckoutSparkMerchantProgressPayload {
  try {
    if (
      rumor.kind !== EVENT_KINDS.ORDER ||
      rumor.sig !== undefined ||
      !HEX_64.test(rumor.id) ||
      rumor.id !== getEventHash({ ...rumor, created_at: rumor.created_at! })
    ) {
      throw new Error("Invalid rumor identity")
    }
    const payload = parseCheckoutSparkMerchantProgress(
      JSON.parse(rumor.content)
    )
    if (
      rumor.pubkey !== payload.merchantPubkey ||
      rumor.created_at !== Math.floor(payload.recordedAt / 1_000) ||
      !matchesCanonicalData(rumor.tags, rumorTags(payload)) ||
      rumor.content !== JSON.stringify(payload)
    ) {
      throw new Error("Invalid rumor binding")
    }
    return payload
  } catch {
    throw new Error("Checkout Spark merchant progress rumor is invalid.")
  }
}

/** Authenticate this merchant-to-self envelope afresh, without a decrypted cache. */
export async function openCheckoutSparkMerchantProgressWrap(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NostrKeySigner
  giftUnwrap?: CheckoutSparkMerchantProgressGiftUnwrap
}): Promise<OpenCheckoutSparkMerchantProgressWrapResult> {
  try {
    const wrap = structuredClone(input.signedRecipientWrap)
    if (
      !isValidSignedPublicNostrEvent(wrap) ||
      wrap.kind !== EVENT_KINDS.GIFT_WRAP
    ) {
      throw new Error("Invalid wrap")
    }
    const signerPubkey = await input.signer.getPublicKey()
    const recipients = wrap.tags.filter((tag) => tag[0] === "p")
    if (
      !HEX_64.test(signerPubkey) ||
      !matchesCanonicalData(recipients, [["p", signerPubkey]])
    ) {
      throw new Error("Invalid recipient")
    }
    // The shared plain unwrap verifies the seal afresh without a decrypted cache.
    const wrapped = wrap
    const rumor = input.giftUnwrap
      ? await input.giftUnwrap(wrapped, input.signer)
      : await unwrapPrivateMessageEnvelope(wrapped, input.signer)
    if (!rumor) throw new Error("Missing rumor")
    const payload = parseCheckoutSparkMerchantProgressRumor(rumor)
    if (payload.merchantPubkey !== signerPubkey) {
      throw new Error("Invalid merchant")
    }
    return { wrapId: wrap.id, rumorId: rumor.id, payload }
  } catch {
    throw new Error("Checkout Spark merchant progress wrap is invalid.")
  }
}
