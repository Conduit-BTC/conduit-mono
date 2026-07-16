import { describe, expect, it } from "bun:test"
import { createAnonZapProviderAttestation } from "@conduit/core/protocol/anon-zap"
import {
  encodeLnurl,
  type LnurlPayMetadata,
} from "@conduit/core/protocol/lightning"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  formatAnonZapProviderCanaryFailure,
  runAnonZapProviderCanary,
  type AnonZapProviderCanaryConfig,
} from "../scripts/smoke/anon_zap_provider"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const RECIPIENT_SECRET = Uint8Array.from([...new Uint8Array(31), 3])
const PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 4])
const SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 5])
const ATTESTATION_PRIVATE_KEY = "0".repeat(63) + "6"
const RECIPIENT_PUBKEY = getPublicKey(RECIPIENT_SECRET)
const SIGNER_PUBKEY = getPublicKey(SIGNER_SECRET)
const AMOUNT_MSATS = 50_000
const PAY_REQUEST_URL = "https://rizful.example/.well-known/lnurlp/fixture"
const LNURL = encodeLnurl(PAY_REQUEST_URL)

const unsignedTags = [
  ["p", RECIPIENT_PUBKEY],
  ["amount", String(AMOUNT_MSATS)],
  ["lnurl", LNURL],
  ["relays", "wss://relay.example"],
  ["omf", "zapout"],
  ["client", "conduit-market"],
]
const draft = {
  kind: 9734,
  createdAt: 1_800_000_000,
  content: "Zapped out 1 item at https://shop.conduit.market/",
  tags: unsignedTags,
}
const RAW_EVENT = finalizeEvent(
  {
    kind: draft.kind,
    created_at: draft.createdAt,
    content: draft.content,
    tags: [
      ...unsignedTags,
      createAnonZapProviderAttestation(
        draft,
        "test-attestation",
        ATTESTATION_PRIVATE_KEY
      ),
    ],
  },
  SIGNER_SECRET
)

function config(
  overrides: Partial<AnonZapProviderCanaryConfig> = {}
): AnonZapProviderCanaryConfig {
  return {
    boundary: {
      baseUrl: new URL("https://shop.conduit.market"),
      merchantPubkey: RECIPIENT_PUBKEY,
      productAddress: `30402:${RECIPIENT_PUBKEY}:fixture`,
      signerPubkey: SIGNER_PUBKEY,
      expectedLnurl: LNURL,
      attestationPublicKeys: `test-attestation:${getPublicKey(Uint8Array.from([...new Uint8Array(31), 6]))}`,
    },
    lud16: "fixture@rizful.example",
    expectedProviderHost: "rizful.example",
    requestInvoice: true,
    ...overrides,
  }
}

function metadata(overrides: Partial<LnurlPayMetadata> = {}): LnurlPayMetadata {
  return {
    payRequestUrl: PAY_REQUEST_URL,
    lnurl: LNURL,
    callback: "https://rizful.example/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 1_000_000,
    tag: "payRequest",
    allowsNostr: true,
    nostrPubkey: getPublicKey(PROVIDER_SECRET),
    metadata: "[]",
    ...overrides,
  }
}

function dependencies(
  options: {
    providerMetadata?: LnurlPayMetadata
    invoiceError?: Error
    invoiceFor?: (zapRequestJson: string) => string
  } = {}
) {
  return {
    prepareBoundary: async () => ({
      authorization: {
        authorizationToken: "fixture-token",
        expiresAt: 1_800_000_120,
        draft,
        relayUrls: ["wss://relay.example"],
        pricing: {
          items: [],
          itemSubtotalSats: 50,
          shippingCostSats: 0,
          totalSats: 50,
          totalMsats: AMOUNT_MSATS,
        },
      },
      signed: {
        id: RAW_EVENT.id,
        rawEvent: RAW_EVENT,
        requestCreatedAt: RAW_EVENT.created_at,
        lnurl: LNURL,
        relayUrls: ["wss://relay.example"],
        pricing: {
          items: [],
          itemSubtotalSats: 50,
          shippingCostSats: 0,
          totalSats: 50,
          totalMsats: AMOUNT_MSATS,
        },
        authorizationExpiresAt: 1_800_000_120,
      },
    }),
    fetchMetadata: async () => options.providerMetadata ?? metadata(),
    fetchInvoice: async (
      _callback: string,
      _amount: number,
      zapRequestJson: string
    ) => {
      if (options.invoiceError) throw options.invoiceError
      const invoice =
        options.invoiceFor?.(zapRequestJson) ??
        makeBolt11Fixture({
          fields: [
            bolt11PaymentHashField(),
            bolt11DescriptionHashField(zapRequestJson),
          ],
        })
      return { invoice }
    },
    nowSeconds: () => 1_800_000_000,
  }
}

describe("anonymous zap provider canary", () => {
  it("sends the exact deployed signer event and validates its invoice", async () => {
    let receivedRequest = ""
    const deps = dependencies()
    const result = await runAnonZapProviderCanary(config(), {
      ...deps,
      async fetchInvoice(callback, amount, zapRequestJson, lnurl) {
        receivedRequest = zapRequestJson
        expect(callback).toBe("https://rizful.example/lnurl/callback")
        expect(amount).toBe(AMOUNT_MSATS)
        expect(lnurl).toBe(LNURL)
        return deps.fetchInvoice(callback, amount, zapRequestJson, lnurl)
      },
    })

    expect(result).toEqual({ status: "passed", invoiceRequested: true })
    expect(receivedRequest).toBe(JSON.stringify(RAW_EVENT))
  })

  it("can stop after the deployed boundary and live provider metadata", async () => {
    let invoiceCalls = 0
    const deps = dependencies()
    const result = await runAnonZapProviderCanary(
      config({ requestInvoice: false }),
      {
        ...deps,
        async fetchInvoice(...args) {
          invoiceCalls += 1
          return deps.fetchInvoice(...args)
        },
      }
    )

    expect(result).toEqual({ status: "passed", invoiceRequested: false })
    expect(invoiceCalls).toBe(0)
  })

  it("rejects provider host, LNURL, NIP-57, and amount-range mismatches", async () => {
    for (const providerMetadata of [
      metadata({ callback: "https://other.example/lnurl/callback" }),
      metadata({ lnurl: encodeLnurl("https://rizful.example/other") }),
      metadata({ allowsNostr: false }),
      metadata({ minSendable: AMOUNT_MSATS + 1 }),
    ]) {
      const error = await runAnonZapProviderCanary(
        config(),
        dependencies({ providerMetadata })
      ).catch((caught) => caught)

      expect(formatAnonZapProviderCanaryFailure(error)).toBe(
        "Anon zap provider canary failed at metadata_validation."
      )
    }
  })

  it("separates boundary, callback, and invoice validation failures", async () => {
    const boundaryError = await runAnonZapProviderCanary(config(), {
      ...dependencies(),
      prepareBoundary: async () => {
        throw new Error("private boundary detail")
      },
    }).catch((caught) => caught)
    const callbackError = await runAnonZapProviderCanary(
      config(),
      dependencies({ invoiceError: new Error("private provider detail") })
    ).catch((caught) => caught)
    const invalidInvoice = await runAnonZapProviderCanary(
      config(),
      dependencies({ invoiceFor: () => "invalid-invoice" })
    ).catch((caught) => caught)

    expect(formatAnonZapProviderCanaryFailure(boundaryError)).toBe(
      "Anon zap provider canary failed at boundary."
    )
    expect(formatAnonZapProviderCanaryFailure(callbackError)).toBe(
      "Anon zap provider canary failed at invoice."
    )
    expect(formatAnonZapProviderCanaryFailure(invalidInvoice)).toBe(
      "Anon zap provider canary failed at invoice_validation."
    )
    expect(formatAnonZapProviderCanaryFailure(callbackError)).not.toContain(
      "private provider detail"
    )
  })
})
