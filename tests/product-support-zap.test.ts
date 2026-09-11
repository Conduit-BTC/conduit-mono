import { afterEach, describe, expect, it, mock } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"

import {
  buildProductSupportZapRequest,
  getProductSupportZapDisclosure,
  normalizeProductSupportZapNote,
  prepareProductSupportZapInvoice,
  PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS,
  resolveProductSupportPaymentAddress,
  type ProductSupportZapDependencies,
} from "../packages/core/src/protocol/product-support-zap"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getProfiles,
} from "../packages/core/src/protocol/commerce"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
} from "../packages/core/src/protocol/relay-list"
import { createInMemoryOwnerRelayListEvidenceRepository } from "../packages/core/src/protocol/owner-relay-list-evidence"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import {
  __resetNdkTestState,
  fetchEventsFanoutDetailed,
} from "../packages/core/src/protocol/ndk"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"
import {
  validateLightningInvoiceForPayment,
  validateZapInvoiceDescriptionBinding,
} from "../packages/core/src/protocol/lightning"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const SHOPPER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const PROVIDER_SECRET = generateSecretKey()
const SHOPPER_PUBKEY = getPublicKey(SHOPPER_SECRET)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:coffee-mug`

const profileCapabilities = {
  sortModes: [],
  textSearch: false,
  protectedSummaries: false,
  canonicalFreshness: false,
  cursorPagination: false,
}

function profileResult(
  lud16?: string,
  overrides: Partial<{
    source: "public" | "local_cache"
    stale: boolean
    degraded: boolean
    capped: boolean
  }> = {}
) {
  return {
    data: {
      [MERCHANT_PUBKEY]: {
        pubkey: MERCHANT_PUBKEY,
        ...(lud16 ? { lud16 } : {}),
      },
    },
    meta: {
      source: "public" as const,
      stale: false,
      degraded: false,
      capped: false,
      capabilities: profileCapabilities,
      fetchedAt: 1_700_000_000_000,
      ...overrides,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function actualDisclosureFields(event: {
  content: string
  tags: string[][]
}): string[] {
  const tagNames = new Set(event.tags.map((tag) => tag[0]))
  return [
    "zap_request_type",
    "shopper_identity_and_signature",
    "timestamp",
    ...(event.content ? ["public_note"] : []),
    ...(tagNames.has("amount") ? ["amount"] : []),
    ...(tagNames.has("p") ? ["merchant_reference"] : []),
    ...(tagNames.has("a") && tagNames.has("k")
      ? ["product_reference_and_kind"]
      : []),
    ...(tagNames.has("lnurl") ? ["lightning_endpoint"] : []),
    ...(tagNames.has("relays") ? ["receipt_relays"] : []),
    ...(tagNames.has("client") ? ["client_attribution"] : []),
  ]
}

function signer(
  pubkey = SHOPPER_PUBKEY,
  secret = SHOPPER_SECRET
): NostrEventSigner {
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
  }
}

function lnurlMetadata(
  overrides: Partial<{
    allowsNostr: boolean
    nostrPubkey: string
    minSendable: number
    maxSendable: number
  }> = {}
) {
  return {
    payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
    lnurl: "lnurl1product",
    callback: "https://pay.example/zap",
    minSendable: 1_000,
    maxSendable: 1_000_000_000,
    tag: "payRequest" as const,
    allowsNostr: true,
    nostrPubkey: PROVIDER_PUBKEY,
    metadata: "[]",
    ...overrides,
  }
}

function dependencies(overrides: Partial<ProductSupportZapDependencies> = {}) {
  return {
    getProfiles: mock(async () => profileResult("merchant@example.com")),
    fetchLnurlPayMetadata: mock(async () => lnurlMetadata()),
    fetchZapInvoice: mock(async () => ({ invoice: "lnbc1bound" })),
    validateLightningInvoiceForPayment: mock(() => ({
      ok: true as const,
      metadata: {
        msats: 21_000,
        sats: 21,
        currency: "MSATS" as const,
        createdAt: 1_700_000_001,
        expiresAt: 1_700_003_601,
      },
    })),
    ...overrides,
  } satisfies ProductSupportZapDependencies
}

describe("product support zap request", () => {
  it("builds one canonical NIP-57 product target with the note only in content", () => {
    const draft = buildProductSupportZapRequest({
      shopperPubkey: SHOPPER_PUBKEY.toUpperCase(),
      recipientPubkey: MERCHANT_PUBKEY.toUpperCase(),
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 21_000,
      lnurl: "lnurl1product",
      relayUrls: [
        "wss://relay.example/",
        "wss://relay.example",
        "http://insecure.example",
      ],
      note: "  great\r\nproduct 🔥  ",
      nowSeconds: 1_700_000_000,
    })

    expect(draft).toMatchObject({
      kind: 9734,
      pubkey: SHOPPER_PUBKEY,
      created_at: 1_700_000_000,
      content: "great\nproduct 🔥",
    })
    expect(draft.tags.slice(0, 6)).toEqual([
      ["p", MERCHANT_PUBKEY],
      ["amount", "21000"],
      ["lnurl", "lnurl1product"],
      ["relays", "wss://relay.example"],
      ["a", PRODUCT_ADDRESS],
      ["k", "30402"],
    ])
    expect(draft.tags.some((tag) => tag[0] === "omf")).toBe(false)
    expect(draft.content).not.toContain("nostr:")
  })

  it("preserves the target while an empty note stays empty", () => {
    const draft = buildProductSupportZapRequest({
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 1_000,
      lnurl: "lnurl1product",
      relayUrls: ["wss://relay.example"],
      note: " \r\n\t ",
      nowSeconds: 1_700_000_000,
    })

    expect(draft.content).toBe("")
    expect(draft.tags).toContainEqual(["a", PRODUCT_ADDRESS])
  })

  it("derives provider disclosure from the built field inventory with or without client attribution", () => {
    const built = buildProductSupportZapRequest({
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 21_000,
      lnurl: "lnurl1product",
      relayUrls: ["wss://relay.example"],
      note: "public note",
      nowSeconds: 1_700_000_000,
    })
    const withoutClient = {
      ...built,
      tags: built.tags.filter((tag) => tag[0] !== "client"),
    }
    const withClient = {
      ...withoutClient,
      tags: [
        ...withoutClient.tags,
        [
          "client",
          "Conduit Market",
          `31990:${PROVIDER_PUBKEY}:market`,
          "wss://relay.example",
        ],
      ],
    }

    for (const event of [withoutClient, withClient]) {
      const includesClientAttribution = event.tags.some(
        (tag) => tag[0] === "client"
      )
      const disclosure = getProductSupportZapDisclosure({
        note: event.content,
        includeClientAttribution: includesClientAttribution,
      })

      expect(disclosure.publicFields).toEqual(actualDisclosureFields(event))
      expect(disclosure.preSubmitCopy).toContain(
        "sends a signed public zap request to the merchant's Lightning provider, even if you never pay it"
      )
      expect(disclosure.preSubmitCopy).toContain(
        "may publish that request inside a public zap receipt on Nostr"
      )
      expect(
        disclosure.preSubmitCopy.includes("Conduit Market attribution")
      ).toBe(includesClientAttribution)
    }
  })

  it("normalizes controls and truncates by Unicode code point", () => {
    const note = `${"a".repeat(279)}🔥b\u0000`
    const normalized = normalizeProductSupportZapNote(note)

    expect(Array.from(normalized)).toHaveLength(
      PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS
    )
    expect(normalized).toBe(`${"a".repeat(279)}🔥`)
    expect(normalized.endsWith("\ud83d")).toBe(false)
  })

  it("rejects invalid identity, target, amount, LNURL, or relay inputs", () => {
    const valid = {
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 21_000,
      lnurl: "lnurl1product",
      relayUrls: ["wss://relay.example"],
      nowSeconds: 1_700_000_000,
    }

    expect(() =>
      buildProductSupportZapRequest({ ...valid, shopperPubkey: "invalid" })
    ).toThrow("shopper")
    expect(() =>
      buildProductSupportZapRequest({
        ...valid,
        recipientPubkey: PROVIDER_PUBKEY,
      })
    ).toThrow("recipient")
    expect(() =>
      buildProductSupportZapRequest({ ...valid, amountMsats: 1.5 })
    ).toThrow("amount")
    expect(() =>
      buildProductSupportZapRequest({ ...valid, lnurl: "https://pay.example" })
    ).toThrow("LNURL")
    expect(() =>
      buildProductSupportZapRequest({
        ...valid,
        relayUrls: ["ws://insecure.example"],
      })
    ).toThrow("relay")
  })
})

describe("product support payment profile evidence", () => {
  it("uses a complete live rotation and never revives a cached address removed by the live profile", async () => {
    const rotatedProfiles = mock(async () =>
      profileResult("rotated@wallet.example")
    )
    await expect(
      resolveProductSupportPaymentAddress(MERCHANT_PUBKEY, {
        getProfiles: rotatedProfiles,
      })
    ).resolves.toBe("rotated@wallet.example")
    expect(rotatedProfiles).toHaveBeenCalledWith({
      pubkeys: [MERCHANT_PUBKEY],
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })

    const removedProfiles = mock(async () => profileResult())
    await expect(
      resolveProductSupportPaymentAddress(MERCHANT_PUBKEY, {
        getProfiles: removedProfiles,
      })
    ).rejects.toThrow("current profile does not include")
  })

  it("fails closed when the exact payment-profile read is partial or unavailable", async () => {
    const partialProfiles = mock(async () =>
      profileResult("merchant@example.com", { degraded: true })
    )
    await expect(
      resolveProductSupportPaymentAddress(MERCHANT_PUBKEY, {
        getProfiles: partialProfiles,
      })
    ).rejects.toThrow("could not be confirmed from relays")

    const unavailableProfiles = mock(async () => {
      throw new Error("relay unavailable")
    })
    await expect(
      resolveProductSupportPaymentAddress(MERCHANT_PUBKEY, {
        getProfiles: unavailableProfiles,
      })
    ).rejects.toThrow("could not be confirmed from relays")
  })
})

describe("product support zap invoice preparation", () => {
  it("signs the exact public request and asks for a description-bound invoice", async () => {
    const deps = dependencies()
    const invoice = await prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        amountSats: 21,
        note: "nice mug",
        relayUrls: ["wss://relay.example"],
        nowSeconds: 1_700_000_000,
      },
      deps
    )

    expect(invoice).toBe("lnbc1bound")
    expect(deps.getProfiles).toHaveBeenCalledTimes(2)
    expect(deps.getProfiles).toHaveBeenNthCalledWith(1, {
      accountPubkey: SHOPPER_PUBKEY,
      authenticatedPubkey: SHOPPER_PUBKEY,
      shouldContinue: undefined,
      pubkeys: [MERCHANT_PUBKEY],
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })
    expect(deps.fetchLnurlPayMetadata).toHaveBeenCalledWith(
      "merchant@example.com"
    )
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(1)
    const zapRequestJson = deps.fetchZapInvoice.mock.calls[0]?.[2]
    expect(deps.fetchZapInvoice).toHaveBeenCalledWith(
      "https://pay.example/zap",
      21_000,
      expect.any(String),
      "lnurl1product"
    )
    expect(JSON.parse(zapRequestJson ?? "{}")).toMatchObject({
      kind: 9734,
      pubkey: SHOPPER_PUBKEY,
      content: "nice mug",
      tags: expect.arrayContaining([
        ["p", MERCHANT_PUBKEY],
        ["a", PRODUCT_ADDRESS],
        ["amount", "21000"],
        ["lnurl", "lnurl1product"],
        ["relays", "wss://relay.example"],
      ]),
    })
    expect(deps.validateLightningInvoiceForPayment).toHaveBeenCalledWith({
      invoice: "lnbc1bound",
      expectedAmountMsats: 21_000,
    })
  })

  it("does not copy caller-supplied commerce-private fields into the public event", async () => {
    const deps = dependencies()
    await prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        amountSats: 21,
        note: "public note",
        relayUrls: ["wss://relay.example"],
        nowSeconds: 1_700_000_000,
        orderId: "private-order",
        shippingAddress: "private-address",
        invoice: "private-invoice",
        walletSecret: "private-secret",
      } as Parameters<typeof prepareProductSupportZapInvoice>[0] &
        Record<string, string>,
      deps
    )

    const emitted = deps.fetchZapInvoice.mock.calls[0]?.[2] ?? ""
    expect(emitted).toContain("public note")
    for (const privateValue of [
      "private-order",
      "private-address",
      "private-invoice",
      "private-secret",
    ]) {
      expect(emitted).not.toContain(privateValue)
    }
  })

  it("fails before signing when the endpoint cannot issue public zaps", async () => {
    const sign = mock(signer().signEvent)
    const deps = dependencies({
      fetchLnurlPayMetadata: mock(async () =>
        lnurlMetadata({ allowsNostr: false })
      ),
    })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: { ...signer(), signEvent: sign },
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("does not support public zaps")
    expect(sign).toHaveBeenCalledTimes(0)
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(0)
  })

  it("fails closed for invalid provider identity or an out-of-range amount", async () => {
    const invalidProvider = dependencies({
      fetchLnurlPayMetadata: mock(async () =>
        lnurlMetadata({ nostrPubkey: "f".repeat(64) })
      ),
    })
    const input = {
      signer: signer(),
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountSats: 21,
      relayUrls: ["wss://relay.example"],
    }

    await expect(
      prepareProductSupportZapInvoice(input, invalidProvider)
    ).rejects.toThrow("receipt key")

    const outOfRange = dependencies({
      fetchLnurlPayMetadata: mock(async () =>
        lnurlMetadata({ minSendable: 50_000, maxSendable: 100_000 })
      ),
    })
    await expect(
      prepareProductSupportZapInvoice(input, outOfRange)
    ).rejects.toThrow("outside the merchant wallet range")
  })

  it("rejects signer authority changes and altered signed requests before invoice fetch", async () => {
    const changedAuthority = dependencies()
    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(MERCHANT_PUBKEY, MERCHANT_SECRET),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        changedAuthority
      )
    ).rejects.toThrow("does not match")
    expect(changedAuthority.fetchZapInvoice).toHaveBeenCalledTimes(0)

    const alteredRequest = dependencies()
    const alteringSigner: NostrEventSigner = {
      ...signer(),
      signEvent: async (event) =>
        finalizeEvent({ ...event, content: "changed" }, SHOPPER_SECRET),
    }
    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: alteringSigner,
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          note: "original",
          relayUrls: ["wss://relay.example"],
        },
        alteredRequest
      )
    ).rejects.toThrow("altered")
    expect(alteredRequest.fetchZapInvoice).toHaveBeenCalledTimes(0)
  })

  it("discards preparation when the selected target changes during metadata lookup", async () => {
    const metadataGate = deferred<ReturnType<typeof lnurlMetadata>>()
    const fetchMetadata = mock(() => metadataGate.promise)
    const signEvent = mock(signer().signEvent)
    const deps = dependencies({ fetchLnurlPayMetadata: fetchMetadata })
    let isCurrent = true
    const preparation = prepareProductSupportZapInvoice(
      {
        signer: { ...signer(), signEvent },
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        amountSats: 21,
        relayUrls: ["wss://relay.example"],
        isCurrent: () => isCurrent,
      },
      deps
    )

    while (fetchMetadata.mock.calls.length === 0) await Promise.resolve()
    isCurrent = false
    metadataGate.resolve(lnurlMetadata())

    await expect(preparation).rejects.toThrow("target changed")
    expect(signEvent).toHaveBeenCalledTimes(0)
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(0)
  })

  it("discards the invoice when the selected target changes while the provider request is pending", async () => {
    const invoiceGate = deferred<{ invoice: string }>()
    const fetchInvoice = mock(() => invoiceGate.promise)
    const deps = dependencies({ fetchZapInvoice: fetchInvoice })
    let isCurrent = true
    const preparation = prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        amountSats: 21,
        relayUrls: ["wss://relay.example"],
        isCurrent: () => isCurrent,
      },
      deps
    )

    while (fetchInvoice.mock.calls.length === 0) await Promise.resolve()
    isCurrent = false
    invoiceGate.resolve({ invoice: "lnbc1superseded" })

    await expect(preparation).rejects.toThrow("target changed")
    expect(deps.getProfiles).toHaveBeenCalledTimes(1)
  })

  it("discards an invoice when the merchant rotates the address during preparation", async () => {
    let profileRead = 0
    const getProfiles = mock(async () => {
      profileRead += 1
      return profileResult(
        profileRead === 1 ? "merchant@example.com" : "rotated@wallet.example"
      )
    })
    const deps = dependencies({ getProfiles })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("Lightning address changed")
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(1)
    expect(getProfiles).toHaveBeenCalledTimes(2)
  })

  it("does not surface an invoice that fails amount, network, or expiry validation", async () => {
    const deps = dependencies({
      validateLightningInvoiceForPayment: mock(() => ({
        ok: false as const,
        reason: "The invoice amount does not match.",
        metadata: {
          msats: 1_000,
          sats: 1,
          currency: "MSATS" as const,
          createdAt: 1_700_000_001,
          expiresAt: 1_700_003_601,
        },
      })),
    })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("invoice amount does not match")
  })

  it("rejects an invoice that expires during the final payment-profile confirmation", async () => {
    const profileGate = deferred<ReturnType<typeof profileResult>>()
    const confirmationStarted = deferred<void>()
    const createdAt = 1_800_000_000
    let nowSeconds = createdAt
    let profileReads = 0
    const validateInvoice = mock(
      (input: Parameters<typeof validateLightningInvoiceForPayment>[0]) =>
        validateLightningInvoiceForPayment({ ...input, nowSeconds })
    )
    const deps = dependencies({
      getProfiles: mock(async () => {
        profileReads += 1
        if (profileReads === 1) return profileResult("merchant@example.com")
        confirmationStarted.resolve()
        return profileGate.promise
      }),
      fetchZapInvoice: mock(async (_callback, _amount, zapRequestJson) => {
        const invoice = makeBolt11Fixture({
          hrp: "lnbc210n",
          createdAt,
          fields: [
            bolt11PaymentHashField(),
            bolt11DescriptionHashField(zapRequestJson),
            { tag: "x", words: [1] },
          ],
        })
        expect(
          validateZapInvoiceDescriptionBinding({ invoice, zapRequestJson })
        ).toMatchObject({ ok: true })
        return { invoice }
      }),
      validateLightningInvoiceForPayment: validateInvoice,
    })
    const preparation = prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        amountSats: 21,
        relayUrls: ["wss://relay.example"],
        nowSeconds: createdAt,
      },
      deps
    )

    await confirmationStarted.promise
    expect(validateInvoice.mock.results[0]?.value).toMatchObject({ ok: true })
    nowSeconds = createdAt + 1
    profileGate.resolve(profileResult("merchant@example.com"))

    await expect(preparation).rejects.toThrow("expired")
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(1)
    expect(validateInvoice).toHaveBeenCalledTimes(2)
  })

  it("rejects a valid description-bound invoice that exceeds level-M QR capacity", async () => {
    let oversizedInvoice = ""
    const deps = dependencies({
      fetchZapInvoice: mock(
        async (
          _callback: string,
          _amountMsats: number,
          zapRequestJson: string
        ) => {
          oversizedInvoice = makeBolt11Fixture({
            hrp: "lnbc210n",
            fields: [
              bolt11PaymentHashField(),
              bolt11DescriptionHashField(zapRequestJson),
              ...Array.from({ length: 3 }, () => ({
                tag: "s",
                words: new Array<number>(1_023).fill(1),
              })),
            ],
          })
          expect(
            validateZapInvoiceDescriptionBinding({
              invoice: oversizedInvoice,
              zapRequestJson,
            })
          ).toMatchObject({ ok: true })
          return { invoice: oversizedInvoice }
        }
      ),
      validateLightningInvoiceForPayment,
    })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("too large to display as a QR code")
    expect(new TextEncoder().encode(oversizedInvoice).length).toBeGreaterThan(
      2_331
    )
  })
})

describe("product support account profile authority", () => {
  const allowedRelay = "wss://shopper-read.example"
  const excludedRelay = "wss://shopper-excluded.example"

  afterEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    __resetNdkTestState()
  })

  async function installProfileNetwork(empty = false) {
    const repository = createInMemoryOwnerRelayListEvidenceRepository()
    const signedEvent = finalizeEvent(
      {
        kind: 10002,
        created_at: 1_700_000_000,
        tags: empty
          ? []
          : [
              ["r", allowedRelay, "read"],
              ["r", excludedRelay, "read"],
            ],
        content: "",
      },
      SHOPPER_SECRET
    )
    await repository.reconcile({
      pubkey: SHOPPER_PUBKEY,
      observations: [
        {
          signedEvent,
          sourceRelayUrls: [allowedRelay],
          observedAt: Date.now(),
          completeObservedAt: Date.now(),
        },
      ],
      lookup: {
        observedAt: Date.now(),
        coverage: "complete",
        hadEvent: true,
        eventId: signedEvent.id,
      },
    })
    __setRelayListTestOverrides({ loadCached: async () => undefined })
    __setCommerceTestOverrides({
      ownerRelayListEvidenceRepository: repository,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) => ({
          ...emptyAccountNetworkLocalState(pubkey),
          exclusions: [
            {
              relayUrl: excludedRelay,
              committedAt: Date.now(),
              relayListFrontier: { eventId: null, createdAt: null },
              inboxDeclarationFrontier: { eventId: null, createdAt: null },
            },
          ],
        }),
      },
      getCachedProducts: async () => [],
      getCachedProfiles: async () => [undefined],
      putCachedProfiles: async () => undefined,
      fetchEventsFanoutDetailed: (filter, options) =>
        fetchEventsFanoutDetailed(filter, {
          ...options,
          reuseRelayConnections: false,
        }),
    })
    const profile = finalizeEvent(
      {
        kind: 0,
        created_at: 1_700_000_000,
        tags: [],
        content: JSON.stringify({ lud16: "merchant@example.com" }),
      },
      MERCHANT_SECRET
    )
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    const opened: string[] = []
    class ProfileWebSocket {
      static OPEN = 1
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      constructor(url: string) {
        opened.push(url)
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.(new Event("open"))
        })
      }
      send(payload: string) {
        const [type, subscription] = JSON.parse(payload)
        if (type !== "REQ") return
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", subscription, profile]),
          } as MessageEvent<string>)
          this.onmessage?.({
            data: JSON.stringify(["EOSE", subscription]),
          } as MessageEvent<string>)
        })
      }
      close() {
        this.readyState = 3
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: ProfileWebSocket,
    })
    return {
      opened,
      restore: () => {
        __resetNdkTestState()
        if (original) Object.defineProperty(globalThis, "WebSocket", original)
        else Reflect.deleteProperty(globalThis, "WebSocket")
      },
    }
  }

  function input(isCurrent = () => true) {
    return {
      signer: signer(),
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountSats: 21,
      relayUrls: [allowedRelay],
      isCurrent,
    }
  }

  it("uses the shopper's signed read membership and exclusions for both confirmations", async () => {
    const network = await installProfileNetwork()
    try {
      await expect(
        prepareProductSupportZapInvoice(input(), dependencies({ getProfiles }))
      ).resolves.toBe("lnbc1bound")
      expect(network.opened).toEqual([allowedRelay, allowedRelay])
    } finally {
      network.restore()
    }
  })

  it("does not substitute global relays for a signed empty shopper read set", async () => {
    const network = await installProfileNetwork(true)
    const deps = dependencies({ getProfiles })
    try {
      await expect(
        prepareProductSupportZapInvoice(input(), deps)
      ).rejects.toThrow("could not be confirmed")
      expect(network.opened).toEqual([])
      expect(deps.fetchLnurlPayMetadata).not.toHaveBeenCalled()
    } finally {
      network.restore()
    }
  })

  it.each([1, 2])(
    "starts no queued profile I/O after confirmation %i loses live authority",
    async (confirmation) => {
      const network = await installProfileNetwork()
      const entered = deferred<void>()
      const release = deferred<void>()
      let current = true
      let calls = 0
      __setCommerceTestOverrides({
        fetchEventsFanoutDetailed: async (filter, options) => {
          calls += 1
          if (calls === confirmation) {
            entered.resolve()
            await release.promise
          }
          return fetchEventsFanoutDetailed(filter, {
            ...options,
            reuseRelayConnections: false,
          })
        },
      })
      const deps = dependencies({ getProfiles })
      const preparation = prepareProductSupportZapInvoice(
        input(() => current),
        deps
      )
      try {
        await entered.promise
        current = false
        release.resolve()
        await expect(preparation).rejects.toThrow()
        expect(network.opened).toEqual(confirmation === 1 ? [] : [allowedRelay])
        expect(deps.fetchLnurlPayMetadata).toHaveBeenCalledTimes(
          confirmation - 1
        )
      } finally {
        release.resolve()
        network.restore()
      }
    }
  )
})
