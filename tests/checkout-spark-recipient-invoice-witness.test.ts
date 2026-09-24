import { describe, expect, it, mock } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  createSelectedProfileContext,
  type LnurlPayMetadata,
  type SelectedProfileContext,
} from "@conduit/core"
import { resolveCheckoutSparkRecipientInvoiceWitness } from "../apps/market/src/lib/checkout-spark-recipient-invoice-witness"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

type ProfileRead = Awaited<
  ReturnType<typeof import("@conduit/core").getProfiles>
>

const NOW_SECONDS = 1_800_000_000
const LUD16 = "seller@wallet.conduit.market"
const CALLBACK = "https://wallet.conduit.market/lnurlp/callback"

function profileContext(): SelectedProfileContext {
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: NOW_SECONDS - 100,
      tags: [],
      content: JSON.stringify({ lud16: LUD16 }),
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
  recipientPubkey: string,
  context: SelectedProfileContext,
  metaOverrides: Partial<ProfileRead["meta"]> = {}
): ProfileRead {
  return {
    data: { [recipientPubkey]: context.profile },
    profileContexts: { [recipientPubkey]: context },
    meta: {
      stale: false,
      degraded: false,
      capped: false,
      ...metaOverrides,
    } as ProfileRead["meta"],
  }
}

function metadata(): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.conduit.market/.well-known/lnurlp/seller",
    lnurl: "lnurl1test",
    callback: CALLBACK,
    minSendable: 1_000,
    maxSendable: 1_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: "[]",
  }
}

function invoice(
  amountSats = 5,
  options: { network?: "mainnet" | "regtest"; createdAt?: number } = {}
): string {
  return makeSignedBolt11Fixture({
    hrp: `${options.network === "regtest" ? "lnbcrt" : "lnbc"}${amountSats * 10}n`,
    createdAt: options.createdAt ?? NOW_SECONDS,
    fields: [
      bolt11PaymentHashField(),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function input(context: SelectedProfileContext, shouldContinue = () => true) {
  return {
    checkoutId: "checkout-recipient-invoice-1",
    recipientPubkey: context.profile.pubkey,
    accountPubkey: "a".repeat(64),
    authenticatedPubkey: "a".repeat(64),
    amountSats: 5,
    network: "mainnet" as const,
    nowSeconds: NOW_SECONDS,
    shouldContinue,
  }
}

describe("checkout Spark recipient invoice witness", () => {
  it("binds a plain exact invoice to a fresh signed recipient profile", async () => {
    const context = profileContext()
    const readProfiles = mock(async () =>
      profileRead(context.profile.pubkey, context)
    )
    const fetchMetadata = mock(async () => metadata())
    const paymentRequest = invoice()
    const fetchInvoice = mock(async () => ({ invoice: paymentRequest }))

    const witness = await resolveCheckoutSparkRecipientInvoiceWitness(
      input(context),
      {
        profile: { readProfiles },
        lnurl: { fetchMetadata, fetchInvoice },
      }
    )

    expect(readProfiles).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkeys: [context.profile.pubkey],
        skipCache: true,
        requireCompleteEvidence: true,
        evidenceScope: "payment",
      })
    )
    expect(fetchMetadata).toHaveBeenCalledWith(LUD16)
    expect(fetchInvoice).toHaveBeenCalledWith(CALLBACK, 5_000)
    expect(witness).toEqual({
      checkoutId: "checkout-recipient-invoice-1",
      recipientPubkey: context.profile.pubkey,
      profileEventId: context.frontier?.eventId,
      profileEventCreatedAt: context.frontier?.eventCreatedAt,
      lud16: LUD16,
      amountSats: 5,
      network: "mainnet",
      paymentRequest,
      paymentHash: "07".repeat(32),
      expiresAt: NOW_SECONDS + 3_600,
    })
    expect(Object.isFrozen(witness)).toBe(true)
  })

  it("refuses stale or mismatched profile evidence before LNURL I/O", async () => {
    const context = profileContext()
    const otherContext = profileContext()
    const fetchMetadata = mock(async () => metadata())
    for (const read of [
      profileRead(context.profile.pubkey, context, { stale: true }),
      profileRead(context.profile.pubkey, otherContext),
    ]) {
      await expect(
        resolveCheckoutSparkRecipientInvoiceWitness(input(context), {
          profile: { readProfiles: async () => read },
          lnurl: { fetchMetadata },
        })
      ).rejects.toThrow("recipient payout address is not verified")
    }
    expect(fetchMetadata).toHaveBeenCalledTimes(0)
  })

  it("stops when the account changes during profile or invoice resolution", async () => {
    const context = profileContext()
    let current = true
    const fetchMetadata = mock(async () => metadata())
    await expect(
      resolveCheckoutSparkRecipientInvoiceWitness(
        input(context, () => current),
        {
          profile: {
            readProfiles: async () => {
              current = false
              return profileRead(context.profile.pubkey, context)
            },
          },
          lnurl: { fetchMetadata },
        }
      )
    ).rejects.toThrow("session changed")
    expect(fetchMetadata).toHaveBeenCalledTimes(0)

    current = true
    const fetchInvoice = mock(async () => ({ invoice: invoice() }))
    await expect(
      resolveCheckoutSparkRecipientInvoiceWitness(
        input(context, () => current),
        {
          profile: {
            readProfiles: async () =>
              profileRead(context.profile.pubkey, context),
          },
          lnurl: {
            fetchMetadata: async () => {
              current = false
              return metadata()
            },
            fetchInvoice,
          },
        }
      )
    ).rejects.toThrow("session changed")
    expect(fetchInvoice).toHaveBeenCalledTimes(0)

    current = true
    await expect(
      resolveCheckoutSparkRecipientInvoiceWitness(
        input(context, () => current),
        {
          profile: {
            readProfiles: async () =>
              profileRead(context.profile.pubkey, context),
          },
          lnurl: {
            fetchMetadata: async () => metadata(),
            fetchInvoice: async () => {
              current = false
              return { invoice: invoice() }
            },
          },
        }
      )
    ).rejects.toThrow("session changed")
  })

  it("rejects an incorrect amount, network, or expiry instead of returning a payout witness", async () => {
    const context = profileContext()
    const cases = [
      invoice(6),
      invoice(5, { network: "regtest" }),
      invoice(5, { createdAt: NOW_SECONDS - 3_600 }),
    ]
    for (const paymentRequest of cases) {
      await expect(
        resolveCheckoutSparkRecipientInvoiceWitness(input(context), {
          profile: {
            readProfiles: async () =>
              profileRead(context.profile.pubkey, context),
          },
          lnurl: {
            fetchMetadata: async () => metadata(),
            fetchInvoice: async () => ({ invoice: paymentRequest }),
          },
        })
      ).rejects.toThrow()
    }
  })
})
