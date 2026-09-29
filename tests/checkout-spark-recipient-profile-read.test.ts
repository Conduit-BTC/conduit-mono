import { describe, expect, it, mock } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  createSelectedProfileContext,
  type SelectedProfileContext,
} from "@conduit/core"
import { readCheckoutSparkRecipientPayoutAddress } from "../apps/market/src/lib/checkout-spark-recipient-profile"

type ProfileRead = Awaited<
  ReturnType<typeof import("@conduit/core").getProfiles>
>

function signedProfileContext(): SelectedProfileContext {
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: 1_750_000_000,
      tags: [],
      content: JSON.stringify({ lud16: "seller@example.com" }),
    },
    generateSecretKey()
  )
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

function profileRead(
  context: SelectedProfileContext,
  overrides: Partial<ProfileRead["meta"]> = {}
): ProfileRead {
  return {
    data: { [context.profile.pubkey]: context.profile },
    profileContexts: { [context.profile.pubkey]: context },
    meta: {
      stale: false,
      degraded: false,
      capped: false,
      ...overrides,
    } as ProfileRead["meta"],
  }
}

describe("checkout Spark recipient profile read", () => {
  it("uses one final payment-scope read and passes its selected frontier to core", async () => {
    const context = signedProfileContext()
    const shouldContinue = () => true
    const readProfiles = mock(async () => profileRead(context))

    const result = await readCheckoutSparkRecipientPayoutAddress(
      {
        recipientPubkey: context.profile.pubkey,
        accountPubkey: "a".repeat(64),
        authenticatedPubkey: "a".repeat(64),
        shouldContinue,
      },
      { readProfiles }
    )

    expect(readProfiles).toHaveBeenCalledTimes(1)
    expect(readProfiles).toHaveBeenCalledWith({
      pubkeys: [context.profile.pubkey],
      accountPubkey: "a".repeat(64),
      authenticatedPubkey: "a".repeat(64),
      shouldContinue,
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })
    expect(result).toEqual({
      state: "ready",
      recipientPubkey: context.profile.pubkey,
      lud16: "seller@example.com",
      profileEventId: context.frontier?.eventId,
      profileEventCreatedAt: context.frontier?.eventCreatedAt,
    })
  })

  it("blocks an invalid recipient or changed session before a profile read", async () => {
    const readProfiles = mock(async () => profileRead(signedProfileContext()))
    await expect(
      readCheckoutSparkRecipientPayoutAddress(
        { recipientPubkey: "npub-not-hex", shouldContinue: () => true },
        { readProfiles }
      )
    ).rejects.toThrow("recipient pubkey is invalid")
    await expect(
      readCheckoutSparkRecipientPayoutAddress(
        {
          recipientPubkey: "a".repeat(64),
          shouldContinue: () => false,
        },
        { readProfiles }
      )
    ).rejects.toThrow("session changed")
    expect(readProfiles).toHaveBeenCalledTimes(0)
  })

  it("discards a settled read when the session changes during the await", async () => {
    const context = signedProfileContext()
    let current = true
    const readProfiles = mock(async () => {
      current = false
      return profileRead(context)
    })
    await expect(
      readCheckoutSparkRecipientPayoutAddress(
        {
          recipientPubkey: context.profile.pubkey,
          shouldContinue: () => current,
        },
        { readProfiles }
      )
    ).rejects.toThrow("session changed")
    expect(readProfiles).toHaveBeenCalledTimes(1)
  })

  it("does not use display data or an incomplete final read as payment authority", async () => {
    const context = signedProfileContext()
    const incomplete = profileRead(context, { degraded: true })
    expect(
      await readCheckoutSparkRecipientPayoutAddress(
        {
          recipientPubkey: context.profile.pubkey,
          shouldContinue: () => true,
        },
        { readProfiles: async () => incomplete }
      )
    ).toEqual({ state: "unavailable", reason: "read_incomplete" })

    const displayOnly: ProfileRead = {
      ...profileRead(context),
      profileContexts: {},
    }
    expect(
      await readCheckoutSparkRecipientPayoutAddress(
        {
          recipientPubkey: context.profile.pubkey,
          shouldContinue: () => true,
        },
        { readProfiles: async () => displayOnly }
      )
    ).toEqual({ state: "unavailable", reason: "profile_unavailable" })
  })
})
