import { describe, expect, it } from "bun:test"
import { nip19 } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  allocateProductSupplierShares,
  buildProductListingEventDraft,
  buildProductSupplierAllocation,
  emitProductSupplierAllocationTags,
  parseProductSupplierAllocationTags,
  parseProductEvent,
  PRODUCT_SUPPLIER_ALLOCATION_VERSION,
  PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG,
  resolveProductSupplierAllocationEndpoints,
  resolveProductSupplierPaymentEndpoints,
  type ProductSchema,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const SUPPLIER_A =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
const SUPPLIER_B =
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
const NON_CURVE_PUBKEY = "00".repeat(32)
const MERCHANT_RELAY = "wss://relay.conduit.market/"
const SUPPLIER_A_RELAY = "wss://nos.lol/"
const SUPPLIER_B_RELAY = "wss://relay.ditto.pub/"

function allocationTags(...zapTags: string[][]): string[][] {
  return [
    [
      PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG,
      PRODUCT_SUPPLIER_ALLOCATION_VERSION,
    ],
    ...zapTags,
  ]
}

function signedProductRevision(
  tags: string[][],
  createdAt: number,
  content = "Signed supplier allocation"
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30_402,
      created_at: createdAt,
      tags,
      content,
    },
    MERCHANT_SECRET
  )
}

function product(
  allocation: ProductSchema["supplierAllocation"]
): ProductSchema {
  return {
    id: `30402:${MERCHANT}:split-product`,
    pubkey: MERCHANT,
    title: "Split product",
    summary: "Signed supplier allocation",
    price: 100,
    currency: "SAT",
    type: "simple",
    specifications: [],
    format: "digital",
    visibility: "public",
    images: [{ url: "https://example.com/product.png" }],
    tags: ["split", "supplier", "test"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    supplierAllocation: allocation,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  }
}

describe("product supplier allocations", () => {
  it("normalizes npub and nprofile authoring identities into NIP-57 zap tags", () => {
    const result = buildProductSupplierAllocation({
      merchantPubkey: MERCHANT,
      merchantWeight: 5,
      merchantRelayHint: "wss://relay.conduit.market",
      suppliers: [
        {
          identity: nip19.npubEncode(SUPPLIER_A),
          relayHint: SUPPLIER_A_RELAY,
          weight: "3",
        },
        {
          identity: nip19.nprofileEncode({
            pubkey: SUPPLIER_B,
            relays: ["wss://relay.ditto.pub"],
          }),
          weight: 2,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tags).toEqual([
      [PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG, "1"],
      ["zap", MERCHANT, MERCHANT_RELAY, "5"],
      ["zap", SUPPLIER_A, SUPPLIER_A_RELAY, "3"],
      ["zap", SUPPLIER_B, SUPPLIER_B_RELAY, "2"],
    ])
    expect(emitProductSupplierAllocationTags(result.allocation)).toEqual(
      result.tags
    )
  })

  it("rejects duplicate recipients, non-positive weights, and missing suppliers", () => {
    const duplicate = buildProductSupplierAllocation({
      merchantPubkey: MERCHANT,
      merchantWeight: 1,
      merchantRelayHint: MERCHANT_RELAY,
      suppliers: [
        { identity: MERCHANT, relayHint: SUPPLIER_A_RELAY, weight: 1 },
      ],
    })
    const nonPositive = buildProductSupplierAllocation({
      merchantPubkey: MERCHANT,
      merchantWeight: 1,
      merchantRelayHint: MERCHANT_RELAY,
      suppliers: [
        { identity: SUPPLIER_A, relayHint: SUPPLIER_A_RELAY, weight: 0 },
      ],
    })

    expect(duplicate).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "duplicate_recipient",
        "duplicate_merchant",
        "missing_supplier",
      ]),
    })
    expect(nonPositive).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(["invalid_weight", "missing_supplier"]),
    })
  })

  it("rejects hex-shaped authoring and signed recipients that are not BIP-340 keys", () => {
    expect(
      buildProductSupplierAllocation({
        merchantPubkey: NON_CURVE_PUBKEY,
        merchantWeight: 1,
        merchantRelayHint: MERCHANT_RELAY,
        suppliers: [
          {
            identity: SUPPLIER_A,
            relayHint: SUPPLIER_A_RELAY,
            weight: 1,
          },
        ],
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(["invalid_author", "missing_merchant"]),
    })

    expect(
      buildProductSupplierAllocation({
        merchantPubkey: MERCHANT,
        merchantWeight: 1,
        merchantRelayHint: MERCHANT_RELAY,
        suppliers: [
          {
            identity: NON_CURVE_PUBKEY,
            relayHint: SUPPLIER_A_RELAY,
            weight: 1,
          },
        ],
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(["invalid_recipient", "missing_supplier"]),
    })

    expect(
      parseProductSupplierAllocationTags({
        merchantPubkey: MERCHANT,
        tags: allocationTags(
          ["zap", MERCHANT, MERCHANT_RELAY, "1"],
          ["zap", NON_CURVE_PUBKEY, SUPPLIER_A_RELAY, "1"]
        ),
      })
    ).toMatchObject({
      state: "invalid",
      issues: expect.arrayContaining(["invalid_recipient", "missing_supplier"]),
    })
  })

  it("parses signed terms with their exact revision and fails malformed evidence closed", () => {
    const validEvent = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"]
      ),
      1_800_000_000
    )
    const valid = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: validEvent.tags,
      signedRevisionEvent: validEvent,
    })
    const malformedEvent = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER_A, "https://not-a-relay.example", "1"]
      ),
      1_800_000_001
    )
    const malformed = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: malformedEvent.tags,
      signedRevisionEvent: malformedEvent,
    })

    expect(valid).toMatchObject({
      state: "valid",
      revisionEventId: validEvent.id,
      revisionCreatedAt: 1_800_000_000,
      revisionEvent: validEvent,
    })
    expect(malformed).toMatchObject({
      state: "invalid",
      revisionEventId: malformedEvent.id,
      issues: expect.arrayContaining([
        "invalid_relay_hint",
        "missing_supplier",
      ]),
    })

    expect(
      parseProductSupplierAllocationTags({
        merchantPubkey: MERCHANT,
        tags: [["zap", SUPPLIER_A, "wss://nos.lol", "1"]],
      })
    ).toEqual({ state: "absent", recipients: [], issues: [] })
    expect(
      parseProductSupplierAllocationTags({
        merchantPubkey: MERCHANT,
        tags: [
          [PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG, "2"],
          ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
          ["zap", SUPPLIER_A, "wss://nos.lol", "1"],
        ],
      })
    ).toMatchObject({
      state: "invalid",
      issues: expect.arrayContaining(["invalid_version"]),
    })
  })

  it("does not grant payment revision authority to unsigned or tampered event projections", async () => {
    const signed = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"]
      ),
      1_800_000_000
    )
    const unsigned = parseProductEvent({
      content: signed.content,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      tags: signed.tags,
      id: signed.id,
      kind: signed.kind,
    })
    const tampered = parseProductEvent({
      ...signed,
      id: "a".repeat(64),
    })

    expect(unsigned.supplierAllocation?.state).toBe("valid")
    expect(unsigned.supplierAllocation?.revisionEventId).toBeUndefined()
    expect(unsigned.supplierAllocation?.revisionCreatedAt).toBeUndefined()
    expect(tampered.supplierAllocation?.state).toBe("valid")
    expect(tampered.supplierAllocation?.revisionEventId).toBeUndefined()
    expect(tampered.supplierAllocation?.revisionCreatedAt).toBeUndefined()

    const readiness = await resolveProductSupplierPaymentEndpoints(
      unsigned.supplierAllocation,
      {
        [MERCHANT]: { lud16: "merchant@example.com" },
        [SUPPLIER_A]: { lud16: "supplier@example.com" },
      },
      {
        expectedNetwork: "mainnet",
        fetchMetadata: async () => {
          throw new Error("must not fetch without a signed exact revision")
        },
      }
    )
    expect(readiness).toMatchObject({
      state: "invalid",
      recipients: [
        expect.objectContaining({ reason: "revision_missing" }),
        expect.objectContaining({ reason: "revision_missing" }),
      ],
    })
  })

  it("keeps legacy listings absent and represents replacement revisions independently", () => {
    const legacy = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: [["title", "Legacy listing"]],
    })
    const firstEvent = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"]
      ),
      10
    )
    const first = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: firstEvent.tags,
      signedRevisionEvent: firstEvent,
    })
    const replacementEvent = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "1"],
        ["zap", SUPPLIER_B, "wss://relay.ditto.pub", "1"]
      ),
      11
    )
    const replacement = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: replacementEvent.tags,
      signedRevisionEvent: replacementEvent,
    })

    expect(legacy).toEqual({ state: "absent", recipients: [], issues: [] })
    expect(first.revisionEventId).toBe(firstEvent.id)
    expect(replacement.revisionEventId).toBe(replacementEvent.id)
    expect(first.recipients.map((recipient) => recipient.pubkey)).toContain(
      SUPPLIER_A
    )
    expect(
      replacement.recipients.map((recipient) => recipient.pubkey)
    ).toContain(SUPPLIER_B)

    const removalDraft = buildProductListingEventDraft({
      product: product(undefined),
      dTag: "split-product",
    })
    expect(removalDraft.tags.some((tag) => tag[0] === "zap")).toBe(false)
    expect(
      parseProductEvent({
        ...removalDraft,
        id: "cc".repeat(32),
        pubkey: MERCHANT,
        created_at: 12,
      }).supplierAllocation
    ).toEqual({ state: "absent", recipients: [], issues: [] })
  })

  it("assigns deterministic integer rounding residue to the merchant", () => {
    const allocation = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "2"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"],
        ["zap", SUPPLIER_B, "wss://relay.ditto.pub", "1"]
      ),
    })

    expect(allocateProductSupplierShares(10, allocation)).toEqual([
      { pubkey: MERCHANT, role: "merchant", sats: 6 },
      { pubkey: SUPPLIER_A, role: "supplier", sats: 2 },
      { pubkey: SUPPLIER_B, role: "supplier", sats: 2 },
    ])
  })

  it("projects recipient Lightning endpoint readiness without treating it as payment proof", () => {
    const allocation = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "1"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"]
      ),
    })

    expect(
      resolveProductSupplierAllocationEndpoints(allocation, {
        [MERCHANT]: { lud16: "merchant@example.com" },
      })
    ).toMatchObject({ state: "unavailable" })
    expect(
      resolveProductSupplierAllocationEndpoints(allocation, {
        [MERCHANT]: { lud16: "merchant@example.com" },
        [SUPPLIER_A]: { lud16: "not-an-address" },
      })
    ).toMatchObject({ state: "invalid" })
    expect(
      resolveProductSupplierAllocationEndpoints(allocation, {
        [MERCHANT]: { lud16: "Merchant@Example.com" },
        [SUPPLIER_A]: { lud16: "supplier@example.com" },
      })
    ).toMatchObject({
      state: "ready",
      recipients: [
        expect.objectContaining({ lud16: "merchant@example.com" }),
        expect.objectContaining({ lud16: "supplier@example.com" }),
      ],
    })

    expect(
      resolveProductSupplierAllocationEndpoints(
        {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1 ? { ...recipient, pubkey: NON_CURVE_PUBKEY } : recipient
          ),
        },
        {
          [MERCHANT]: { lud16: "merchant@example.com" },
          [NON_CURVE_PUBKEY]: { lud16: "supplier@example.com" },
        }
      )
    ).toMatchObject({ state: "invalid" })
  })

  it("resolves coordinator-ready endpoints with frozen revision, range, and network fields", async () => {
    const signedRevision = signedProductRevision(
      allocationTags(
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER_A, "wss://nos.lol", "1"]
      ),
      1_800_000_000
    )
    const allocation = parseProductSupplierAllocationTags({
      merchantPubkey: MERCHANT,
      tags: signedRevision.tags,
      signedRevisionEvent: signedRevision,
    })
    const result = await resolveProductSupplierPaymentEndpoints(
      allocation,
      {
        [MERCHANT]: { lud16: "merchant@example.com" },
        [SUPPLIER_A]: { lud16: "supplier@example.com" },
      },
      {
        expectedNetwork: "mainnet",
        fetchMetadata: async (lud16) => ({
          payRequestUrl: `https://example.com/.well-known/lnurlp/${lud16.split("@")[0]}`,
          lnurl: "LNURL1TEST",
          callback: "https://example.com/callback",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
          allowsNostr: true,
          nostrPubkey: lud16.startsWith("merchant") ? MERCHANT : SUPPLIER_A,
          metadata: "[]",
        }),
      }
    )

    expect(result).toMatchObject({
      state: "ready",
      revisionEventId: signedRevision.id,
      revisionCreatedAt: 1_800_000_000,
      recipients: [
        {
          pubkey: MERCHANT,
          role: "merchant",
          weight: 3,
          state: "ready",
          expectedNetwork: "mainnet",
          minSendableMsats: 1_000,
          maxSendableMsats: 100_000_000,
        },
        {
          pubkey: SUPPLIER_A,
          role: "supplier",
          weight: 1,
          state: "ready",
          expectedNetwork: "mainnet",
          minSendableMsats: 1_000,
          maxSendableMsats: 100_000_000,
        },
      ],
    })

    const mutatedAllocations = [
      {
        allocation: {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1 ? { ...recipient, pubkey: SUPPLIER_B } : recipient
          ),
        },
      },
      {
        allocation: {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1
              ? { ...recipient, role: "merchant" as const }
              : recipient
          ),
        },
      },
      {
        allocation: {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1 ? { ...recipient, weight: 2 } : recipient
          ),
        },
      },
      {
        allocation: {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1
              ? { ...recipient, relayHint: SUPPLIER_B_RELAY }
              : recipient
          ),
        },
      },
      {
        allocation: {
          ...allocation,
          revisionEvent: {
            ...allocation.revisionEvent!,
            content: "Mutated after signature verification",
          },
        },
      },
    ]

    for (const mutation of mutatedAllocations) {
      let metadataFetches = 0
      const mutationResult = await resolveProductSupplierPaymentEndpoints(
        mutation.allocation,
        {
          [MERCHANT]: { lud16: "merchant@example.com" },
          [SUPPLIER_A]: { lud16: "supplier@example.com" },
          [SUPPLIER_B]: { lud16: "other@example.com" },
        },
        {
          expectedNetwork: "mainnet",
          fetchMetadata: async () => {
            metadataFetches += 1
            throw new Error("must not fetch for mutated signed terms")
          },
        }
      )

      expect(metadataFetches).toBe(0)
      expect(mutationResult).toMatchObject({
        state: "invalid",
        recipients: [
          expect.objectContaining({ reason: "revision_invalid" }),
          expect.objectContaining({ reason: "revision_invalid" }),
        ],
      })
    }

    expect(
      await resolveProductSupplierPaymentEndpoints(
        {
          ...allocation,
          recipients: allocation.recipients.map((recipient, index) =>
            index === 1 ? { ...recipient, pubkey: NON_CURVE_PUBKEY } : recipient
          ),
        },
        {
          [MERCHANT]: { lud16: "merchant@example.com" },
          [NON_CURVE_PUBKEY]: { lud16: "supplier@example.com" },
        },
        {
          expectedNetwork: "mainnet",
          fetchMetadata: async () => {
            throw new Error("must not fetch for a non-curve recipient")
          },
        }
      )
    ).toMatchObject({
      state: "invalid",
      recipients: [
        expect.objectContaining({ reason: "allocation_invalid" }),
        expect.objectContaining({ reason: "allocation_invalid" }),
      ],
    })

    expect(
      await resolveProductSupplierPaymentEndpoints(
        {
          ...allocation,
          revisionEventId: undefined,
          revisionCreatedAt: undefined,
        },
        {
          [MERCHANT]: { lud16: "merchant@example.com" },
          [SUPPLIER_A]: { lud16: "supplier@example.com" },
        },
        {
          expectedNetwork: "mainnet",
          fetchMetadata: async () => {
            throw new Error("must not fetch without an exact revision")
          },
        }
      )
    ).toMatchObject({
      state: "invalid",
      recipients: [
        expect.objectContaining({ reason: "revision_missing" }),
        expect.objectContaining({ reason: "revision_missing" }),
      ],
    })

    const unsupported = await resolveProductSupplierPaymentEndpoints(
      allocation,
      {
        [MERCHANT]: { lud16: "merchant@example.com" },
        [SUPPLIER_A]: { lud16: "supplier@example.com" },
      },
      {
        expectedNetwork: "mainnet",
        fetchMetadata: async () => ({
          payRequestUrl: "https://example.com/.well-known/lnurlp/user",
          lnurl: "LNURL1TEST",
          callback: "https://example.com/callback",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
          allowsNostr: false,
          metadata: "[]",
        }),
      }
    )
    expect(unsupported).toMatchObject({
      state: "unavailable",
      recipients: [
        expect.objectContaining({ reason: "nostr_unsupported" }),
        expect.objectContaining({ reason: "nostr_unsupported" }),
      ],
    })

    const invalidNostrPubkey = await resolveProductSupplierPaymentEndpoints(
      allocation,
      {
        [MERCHANT]: { lud16: "merchant@example.com" },
        [SUPPLIER_A]: { lud16: "supplier@example.com" },
      },
      {
        expectedNetwork: "mainnet",
        fetchMetadata: async () => ({
          payRequestUrl: "https://example.com/.well-known/lnurlp/user",
          lnurl: "LNURL1TEST",
          callback: "https://example.com/callback",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
          allowsNostr: true,
          nostrPubkey: NON_CURVE_PUBKEY,
          metadata: "[]",
        }),
      }
    )
    expect(invalidNostrPubkey).toMatchObject({
      state: "invalid",
      recipients: [
        expect.objectContaining({ reason: "nostr_pubkey_invalid" }),
        expect.objectContaining({ reason: "nostr_pubkey_invalid" }),
      ],
    })
  })

  it("round-trips signed allocation terms through kind-30402 product events", () => {
    const authored = buildProductSupplierAllocation({
      merchantPubkey: MERCHANT,
      merchantWeight: 3,
      merchantRelayHint: MERCHANT_RELAY,
      suppliers: [
        {
          identity: SUPPLIER_A,
          relayHint: SUPPLIER_A_RELAY,
          weight: 1,
        },
      ],
    })
    expect(authored.ok).toBe(true)
    if (!authored.ok) return

    const draft = buildProductListingEventDraft({
      product: product(authored.allocation),
      dTag: "split-product",
    })
    const signed = signedProductRevision(
      draft.tags,
      1_800_000_000,
      draft.content
    )
    const parsed = parseProductEvent(signed)

    expect(
      draft.tags.filter(
        (tag) =>
          tag[0] === "zap" || tag[0] === PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG
      )
    ).toEqual(authored.tags)
    expect(parsed.supplierAllocation).toMatchObject({
      state: "valid",
      revisionEventId: signed.id,
      revisionCreatedAt: 1_800_000_000,
    })
    expect(() =>
      buildProductListingEventDraft({
        product: product({
          state: "invalid",
          recipients: [],
          issues: ["missing_merchant"],
        }),
        dTag: "malformed-split-product",
      })
    ).toThrow("supplier allocation evidence is malformed")
    expect(() =>
      buildProductListingEventDraft({
        product: {
          ...product(authored.allocation),
          pubkey: SUPPLIER_B,
        },
        dTag: "wrong-author-split-product",
      })
    ).toThrow("merchant must match the product author")
  })
})
