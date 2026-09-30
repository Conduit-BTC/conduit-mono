import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"
import { resolveCheckoutSparkRecipientPayoutAddress as resolveRecipientCore } from "../packages/core/src/protocol/checkout-spark-recipient-profile"
import {
  createSelectedProfileContext,
  type SelectedProfileContext,
} from "../packages/core/src/protocol/profile-cache"

const COMPLETE_READ = { stale: false, degraded: false, capped: false }

function resolveCheckoutSparkRecipientPayoutAddress(
  input: Omit<Parameters<typeof resolveRecipientCore>[0], "readMeta"> & {
    readMeta?: Parameters<typeof resolveRecipientCore>[0]["readMeta"]
  }
) {
  return resolveRecipientCore({
    ...input,
    readMeta: input.readMeta ?? COMPLETE_READ,
  })
}

function signedProfileContext(
  content: Record<string, unknown>
): SelectedProfileContext {
  const secretKey = generateSecretKey()
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: 1_750_000_000,
      tags: [],
      content: JSON.stringify(content),
    },
    secretKey
  )
  expect(verifyEvent(event)).toBe(true)
  expect(event.pubkey).toBe(getPublicKey(secretKey))
  return createSelectedProfileContext({
    pubkey: event.pubkey,
    row: {
      pubkey: event.pubkey,
      eventId: event.id,
      eventCreatedAt: event.created_at,
      rawContent: event.content,
      cachedAt: Date.now(),
    },
    observed: true,
    readComplete: true,
  })
}

describe("checkout Spark recipient payout address evidence", () => {
  it("uses the exact signed selected profile frontier, not a display-profile address", () => {
    const context = signedProfileContext({ lud16: "seller@example.com" })
    context.profile.lud16 = "attacker@example.com"

    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey: context.profile.pubkey,
        context,
      })
    ).toEqual({
      state: "ready",
      recipientPubkey: context.profile.pubkey,
      lud16: "seller@example.com",
      profileEventId: context.frontier?.eventId,
      profileEventCreatedAt: context.frontier?.eventCreatedAt,
    })
  })

  it("rejects a selected profile belonging to a different allocated recipient", () => {
    const context = signedProfileContext({ lud16: "seller@example.com" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey: getPublicKey(generateSecretKey()),
        context,
      })
    ).toEqual({ state: "invalid", reason: "recipient_mismatch" })
  })

  it("keeps retained, unobserved, missing, and incomplete evidence unavailable", () => {
    const context = signedProfileContext({ lud16: "seller@example.com" })
    const recipientPubkey = context.profile.pubkey
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey,
        context: undefined,
      })
    ).toEqual({ state: "unavailable", reason: "profile_unavailable" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey,
        context: { ...context, freshness: "retained" },
      })
    ).toEqual({ state: "unavailable", reason: "profile_not_observed" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey,
        context: { ...context, freshness: "unobserved" },
      })
    ).toEqual({ state: "unavailable", reason: "profile_not_observed" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey,
        context: { ...context, readComplete: false },
      })
    ).toEqual({ state: "unavailable", reason: "read_incomplete" })
  })

  it("fails closed on incomplete or missing read metadata", () => {
    const context = signedProfileContext({ lud16: "seller@example.com" })
    const recipientPubkey = context.profile.pubkey
    for (const readMeta of [
      { stale: true, degraded: false, capped: false },
      { stale: false, degraded: true, capped: false },
      { stale: false, degraded: false, capped: true },
      { stale: false, degraded: false },
      undefined,
    ]) {
      expect(
        resolveRecipientCore({
          recipientPubkey,
          context,
          readMeta: readMeta as Parameters<
            typeof resolveRecipientCore
          >[0]["readMeta"],
        })
      ).toEqual({ state: "unavailable", reason: "read_incomplete" })
    }
  })

  it("rejects an invalid frontier or invalid recipient address", () => {
    const context = signedProfileContext({ lud16: "not-an-address" })
    const recipientPubkey = context.profile.pubkey
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({ recipientPubkey, context })
    ).toEqual({ state: "invalid", reason: "payment_address_invalid" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey,
        context: {
          ...context,
          frontier: { ...context.frontier!, validity: "malformed" },
        },
      })
    ).toEqual({ state: "invalid", reason: "profile_frontier_invalid" })
  })

  it("keeps a signed profile without an address unavailable", () => {
    const context = signedProfileContext({ name: "Seller" })
    expect(
      resolveCheckoutSparkRecipientPayoutAddress({
        recipientPubkey: context.profile.pubkey,
        context,
      })
    ).toEqual({ state: "unavailable", reason: "payment_address_missing" })
  })
})
