import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  buildProductDeletionTarget,
  isProductDeletedByNip09,
  parseProductAddressCoordinate,
  productDeletionEvidenceFromSignedEvent,
  resolveProductDeletion,
  validateProductDeletionEvent,
  type ProductDeletionCandidate,
  type ProductDeletionEvidence,
} from "@conduit/core/protocol/product-deletion"

const MERCHANT_A_SECRET = new Uint8Array(32).fill(1)
const MERCHANT_B_SECRET = new Uint8Array(32).fill(2)
const MERCHANT_A = getPublicKey(MERCHANT_A_SECRET)
const MERCHANT_B = getPublicKey(MERCHANT_B_SECRET)
const PRODUCT_EVENT_A = "a".repeat(64)
const PRODUCT_EVENT_B = "b".repeat(64)
const DELETION_EVENT_A = "c".repeat(64)
const DELETION_EVENT_B = "d".repeat(64)

function product(
  overrides: Partial<ProductDeletionCandidate> = {}
): ProductDeletionCandidate {
  return {
    authorPubkey: MERCHANT_A,
    eventId: PRODUCT_EVENT_A,
    addressId: `30402:${MERCHANT_A}:coffee`,
    createdAt: 200,
    ...overrides,
  }
}

function exactEvidence(
  overrides: Partial<Extract<ProductDeletionEvidence, { target: "event" }>> = {}
): ProductDeletionEvidence {
  return {
    target: "event",
    deletionEventId: DELETION_EVENT_A,
    authorPubkey: MERCHANT_A,
    deletedAt: 100,
    eventId: PRODUCT_EVENT_A,
    ...overrides,
  }
}

function addressEvidence(
  overrides: Partial<
    Extract<ProductDeletionEvidence, { target: "address" }>
  > = {}
): ProductDeletionEvidence {
  return {
    target: "address",
    deletionEventId: DELETION_EVENT_A,
    authorPubkey: MERCHANT_A,
    deletedAt: 200,
    addressId: `30402:${MERCHANT_A}:coffee`,
    ...overrides,
  }
}

describe("product deletion coordinates", () => {
  it("parses a full kind 30402 coordinate without losing colons in d", () => {
    expect(
      parseProductAddressCoordinate(`30402:${MERCHANT_A}:category:coffee:dark`)
    ).toEqual({
      kind: 30402,
      authorPubkey: MERCHANT_A,
      dTag: "category:coffee:dark",
      addressId: `30402:${MERCHANT_A}:category:coffee:dark`,
    })
  })

  it("rejects incomplete, wrong-kind, and malformed-author coordinates", () => {
    expect(parseProductAddressCoordinate(`30402:${MERCHANT_A}`)).toBeNull()
    expect(parseProductAddressCoordinate(`30402:${MERCHANT_A}:`)).toBeNull()
    expect(
      parseProductAddressCoordinate(`30023:${MERCHANT_A}:coffee`)
    ).toBeNull()
    expect(
      parseProductAddressCoordinate("30402:not-a-pubkey:coffee")
    ).toBeNull()
  })
})

describe("NIP-09 product deletion resolution", () => {
  it("honors an author-scoped exact e target without a timestamp gate", () => {
    const resolution = resolveProductDeletion(product(), [exactEvidence()])

    expect(resolution.deleted).toBe(true)
    expect(resolution.matchedBy).toBe("event")
  })

  it("honors exact e evidence created at the Unix epoch", () => {
    const resolution = resolveProductDeletion(product(), [
      exactEvidence({ deletedAt: 0 }),
    ])

    expect(resolution.deleted).toBe(true)
    expect(resolution.matchedBy).toBe("event")
  })

  it("does not let another author delete the same exact event id", () => {
    expect(
      isProductDeletedByNip09(product(), [
        exactEvidence({ authorPubkey: MERCHANT_B }),
      ])
    ).toBe(false)
  })

  it("applies an address deletion cutoff inclusively", () => {
    expect(
      isProductDeletedByNip09(product({ createdAt: 199 }), [
        addressEvidence({ deletedAt: 200 }),
      ])
    ).toBe(true)
    expect(
      isProductDeletedByNip09(product({ createdAt: 200 }), [
        addressEvidence({ deletedAt: 200 }),
      ])
    ).toBe(true)
  })

  it("keeps a genuinely newer replacement at the deleted address", () => {
    expect(
      isProductDeletedByNip09(product({ createdAt: 201 }), [
        addressEvidence({ deletedAt: 200 }),
      ])
    ).toBe(false)
  })

  it("isolates the same d tag across merchant authors", () => {
    expect(
      isProductDeletedByNip09(
        product({
          authorPubkey: MERCHANT_B,
          eventId: PRODUCT_EVENT_B,
          addressId: `30402:${MERCHANT_B}:coffee`,
        }),
        [addressEvidence()]
      )
    ).toBe(false)
  })

  it("does not broaden malformed legacy address metadata", () => {
    expect(
      isProductDeletedByNip09(
        product({ eventId: PRODUCT_EVENT_B, addressId: "coffee" }),
        [addressEvidence()]
      )
    ).toBe(false)
  })

  it("prefers exact evidence deterministically when both targets match", () => {
    const resolution = resolveProductDeletion(product(), [
      addressEvidence({ deletionEventId: DELETION_EVENT_B }),
      exactEvidence(),
    ])

    expect(resolution.deleted).toBe(true)
    expect(resolution.matchedBy).toBe("event")
    if (resolution.deleted) {
      expect(resolution.evidence.deletionEventId).toBe(DELETION_EVENT_A)
    }
  })
})

describe("safe product deletion target construction", () => {
  it("builds exact and full-address targets with stable scoped identities", () => {
    const target = buildProductDeletionTarget({
      authorPubkey: MERCHANT_A,
      eventId: PRODUCT_EVENT_A.toUpperCase(),
      addressId: `30402:${MERCHANT_A}:category:coffee`,
    })

    expect(target).toEqual({
      authorPubkey: MERCHANT_A,
      eventId: PRODUCT_EVENT_A,
      addressId: `30402:${MERCHANT_A}:category:coffee`,
      eventKey: `e:${MERCHANT_A}:${PRODUCT_EVENT_A}`,
      addressKey: `a:30402:${MERCHANT_A}:category:coffee`,
      tags: [
        ["e", PRODUCT_EVENT_A],
        ["a", `30402:${MERCHANT_A}:category:coffee`],
        ["k", "30402"],
      ],
    })
  })

  it("falls back to exact e for legacy products with bad address metadata", () => {
    expect(
      buildProductDeletionTarget({
        authorPubkey: MERCHANT_A,
        eventId: PRODUCT_EVENT_A,
        addressId: "coffee",
      }).tags
    ).toEqual([
      ["e", PRODUCT_EVENT_A],
      ["k", "30402"],
    ])
  })

  it("falls back to a valid full address when the event id is unavailable", () => {
    expect(
      buildProductDeletionTarget({
        authorPubkey: MERCHANT_A,
        eventId: "legacy-event-id",
        addressId: `30402:${MERCHANT_A}:coffee`,
      }).tags
    ).toEqual([
      ["a", `30402:${MERCHANT_A}:coffee`],
      ["k", "30402"],
    ])
  })

  it("ignores a foreign-author address instead of broadening its scope", () => {
    const target = buildProductDeletionTarget({
      authorPubkey: MERCHANT_A,
      eventId: PRODUCT_EVENT_A,
      addressId: `30402:${MERCHANT_B}:coffee`,
    })

    expect(target.addressId).toBeNull()
    expect(target.tags).toEqual([
      ["e", PRODUCT_EVENT_A],
      ["k", "30402"],
    ])
  })

  it("refuses deletion when neither exact nor address identity is safe", () => {
    expect(() =>
      buildProductDeletionTarget({
        authorPubkey: MERCHANT_A,
        eventId: "legacy-event-id",
        addressId: "coffee",
      })
    ).toThrow(
      "Product deletion requires a valid event id or same-author product address."
    )
    expect(() =>
      buildProductDeletionTarget({
        authorPubkey: MERCHANT_A,
        addressId: `30402:${MERCHANT_B}:coffee`,
      })
    ).toThrow(
      "Product deletion requires a valid event id or same-author product address."
    )
  })
})

describe("signed deletion evidence", () => {
  it("returns the exact validated event and parsed targets from one safe boundary", () => {
    const signed = finalizeEvent(
      {
        kind: 5,
        created_at: 300,
        content: "",
        tags: [
          ["e", PRODUCT_EVENT_A],
          ["a", `30402:${MERCHANT_A}:coffee`],
        ],
      },
      MERCHANT_A_SECRET
    )

    const validated = validateProductDeletionEvent(signed)

    expect(validated?.signedEvent).toEqual({
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    })
    expect(validated?.signedEvent).not.toBe(signed)
    expect(validated?.signedEvent.tags).not.toBe(signed.tags)
    expect(validated?.evidence).toEqual([
      {
        target: "event",
        deletionEventId: signed.id,
        authorPubkey: MERCHANT_A,
        deletedAt: 300,
        eventId: PRODUCT_EVENT_A,
      },
      {
        target: "address",
        deletionEventId: signed.id,
        authorPubkey: MERCHANT_A,
        deletedAt: 300,
        addressId: `30402:${MERCHANT_A}:coffee`,
      },
    ])
  })

  it("accepts a signed exact e deletion created at the Unix epoch", () => {
    const signed = finalizeEvent(
      {
        kind: 5,
        created_at: 0,
        content: "",
        tags: [["e", PRODUCT_EVENT_A]],
      },
      MERCHANT_A_SECRET
    )

    expect(productDeletionEvidenceFromSignedEvent(signed)).toEqual([
      {
        target: "event",
        deletionEventId: signed.id,
        authorPubkey: MERCHANT_A,
        deletedAt: 0,
        eventId: PRODUCT_EVENT_A,
      },
    ])
  })

  it("validates the signed kind-5 identity and keeps only safe product targets", () => {
    const signed = finalizeEvent(
      {
        kind: 5,
        created_at: 300,
        content: "",
        tags: [
          ["e", PRODUCT_EVENT_A],
          ["e", "not-an-event-id"],
          ["a", `30402:${MERCHANT_A}:category:coffee`],
          ["a", `30402:${MERCHANT_B}:coffee`],
          ["a", `30023:${MERCHANT_A}:article`],
        ],
      },
      MERCHANT_A_SECRET
    )

    expect(productDeletionEvidenceFromSignedEvent(signed)).toEqual([
      {
        target: "event",
        deletionEventId: signed.id,
        authorPubkey: MERCHANT_A,
        deletedAt: 300,
        eventId: PRODUCT_EVENT_A,
      },
      {
        target: "address",
        deletionEventId: signed.id,
        authorPubkey: MERCHANT_A,
        deletedAt: 300,
        addressId: `30402:${MERCHANT_A}:category:coffee`,
      },
    ])
  })

  it("rejects a tampered signature and non-deletion signed events", () => {
    const signedDeletion = finalizeEvent(
      {
        kind: 5,
        created_at: 300,
        content: "",
        tags: [["e", PRODUCT_EVENT_A]],
      },
      MERCHANT_A_SECRET
    )
    const signedProduct = finalizeEvent(
      {
        kind: 30402,
        created_at: 300,
        content: "",
        tags: [["d", "coffee"]],
      },
      MERCHANT_A_SECRET
    )

    expect(
      productDeletionEvidenceFromSignedEvent({
        ...signedDeletion,
        content: "tampered",
      })
    ).toBeNull()
    expect(productDeletionEvidenceFromSignedEvent(signedProduct)).toBeNull()
  })
})
