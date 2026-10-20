import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  checkoutSparkEventMarketBindingDigestValue,
  freezeCheckoutSparkEventMarketBinding,
  matchesCheckoutSparkOrderEventMarketSnapshot,
} from "@conduit/core/protocol/checkout-spark-event-market"
import { computeEventMarketAssignmentDTag } from "@conduit/core/protocol/event-market-assignment"
import type { CheckoutSparkCommerceQuote } from "@conduit/core/protocol/checkout-spark-reconciliation"

const merchantPubkey = getPublicKey(generateSecretKey())
const organizerPubkey = getPublicKey(generateSecretKey())
const hash = () => randomBytes(32).toString("hex")
const marketCoordinate = `30409:${organizerPubkey}:fair`
const occurrenceCoordinate = `31923:${organizerPubkey}:fair-day`
const acceptedAtMs = 1_010_000

function line(product = "apples") {
  const productCoordinate = `30402:${merchantPubkey}:${product}`
  return {
    productCoordinate,
    productEventId: hash(),
    assignmentCoordinate: `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag(
      {
        marketCoordinate,
        occurrenceCoordinate,
        productCoordinate,
      }
    )}`,
    assignmentEventId: hash(),
    quantity: 1,
  }
}

function fixture() {
  const marketEventId = hash()
  const grantEventId = hash()
  const input = {
    schemaVersion: 1 as const,
    organizerPubkey,
    marketCoordinate,
    marketEventId,
    occurrenceCoordinate,
    occurrenceEventId: hash(),
    grantEventId,
    grantAncestryEventIds: [grantEventId],
    observedDeletionEventIds: [] as string[],
    mode: "merchant_present" as "merchant_present" | "organizer_handoff",
    assignment: "Booth 1",
    lines: [line()],
    organizerFee: {
      state: "active" as const,
      marketCoordinate,
      organizerPubkey,
      eventId: marketEventId,
      createdAt: 1_000,
      basisPoints: 250,
      minimumSats: 5,
      lightningAddress: "organizer@example.com",
      expiresAt: 1_100,
    },
    organizerFeeSats: 25,
  }
  const commerceQuote: CheckoutSparkCommerceQuote = {
    commerceTotalSats: 1_000,
    lines: input.lines.map((entry) => ({
      productCoordinate: entry.productCoordinate,
      productEventId: entry.productEventId,
      merchantPubkey,
      quantity: entry.quantity,
      unitMerchandiseSats: 1_000,
      unitShippingSats: 0,
    })),
  }
  return {
    input,
    context: { merchantPubkey, commerceQuote, acceptedAtMs },
  }
}

describe("frozen Event Market checkout binding", () => {
  it("copies and freezes exact event references without claiming signature authority", () => {
    const { input, context } = fixture()
    const frozen = freezeCheckoutSparkEventMarketBinding(input, context)
    expect(frozen).toEqual(input)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.lines)).toBe(true)
    expect(Object.isFrozen(frozen.lines[0])).toBe(true)
    expect(Object.isFrozen(frozen.organizerFee)).toBe(true)
    expect(Object.isFrozen(frozen.grantAncestryEventIds)).toBe(true)
    expect(Object.isFrozen(frozen.observedDeletionEventIds)).toBe(true)
    input.lines[0]!.quantity = 2
    input.organizerFee.minimumSats = 99
    expect(frozen.lines[0]!.quantity).toBe(1)
    expect(frozen.organizerFee).toHaveProperty("minimumSats", 5)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it("binds the optional organizer schedule and freezes its copy", () => {
    const { input, context } = fixture()
    const schedule = {
      coordinate: `31924:${organizerPubkey}:fair-schedule`,
      eventId: hash(),
    }
    const frozen = freezeCheckoutSparkEventMarketBinding(
      { ...input, schedule },
      context
    )
    expect(frozen.schedule).toEqual(schedule)
    expect(Object.isFrozen(frozen.schedule)).toBe(true)
    schedule.eventId = hash()
    expect(frozen.schedule?.eventId).not.toBe(schedule.eventId)
  })

  it("requires one exact stock pool for every organizer-handoff line", () => {
    const { input, context } = fixture()
    input.mode = "organizer_handoff"
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, context)
    ).toThrow()
    const stockPoolId = hash()
    const handoff = {
      ...input,
      lines: input.lines.map((entry) => ({ ...entry, stockPoolId })),
    }
    expect(
      freezeCheckoutSparkEventMarketBinding(handoff, context).lines[0]
        ?.stockPoolId
    ).toBe(stockPoolId)
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        { ...handoff, mode: "merchant_present" },
        context
      )
    ).toThrow()
  })

  it("binds complete unique admission ancestry and observed deletion evidence sets", () => {
    const { input, context } = fixture()
    const ancestor = hash()
    const deletion = hash()
    const complete = {
      ...input,
      grantAncestryEventIds: [ancestor, input.grantEventId],
      observedDeletionEventIds: [deletion],
    }
    const frozen = freezeCheckoutSparkEventMarketBinding(complete, context)
    expect(frozen.grantAncestryEventIds).toEqual(
      [ancestor, input.grantEventId].sort()
    )
    expect(frozen.observedDeletionEventIds).toEqual([deletion])
    for (const changed of [
      { ...input, grantAncestryEventIds: [] },
      { ...input, grantAncestryEventIds: [ancestor] },
      {
        ...input,
        grantAncestryEventIds: [input.grantEventId, input.grantEventId],
      },
      {
        ...input,
        grantAncestryEventIds: [
          input.grantEventId,
          ...Array.from({ length: 128 }, hash),
        ],
      },
      { ...input, observedDeletionEventIds: [deletion, deletion] },
      { ...input, observedDeletionEventIds: Array.from({ length: 129 }, hash) },
      { ...input, observedDeletionEventIds: ["malformed"] },
    ]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(changed, context)
      ).toThrow()
    }
    const digest = checkoutSparkEventMarketBindingDigestValue(frozen)
    expect(
      checkoutSparkEventMarketBindingDigestValue({
        ...frozen,
        grantAncestryEventIds: [input.grantEventId],
      })
    ).not.toEqual(digest)
    expect(
      checkoutSparkEventMarketBindingDigestValue({
        ...frozen,
        observedDeletionEventIds: [],
      })
    ).not.toEqual(digest)
    expect(
      checkoutSparkEventMarketBindingDigestValue({
        ...frozen,
        grantAncestryEventIds: [...frozen.grantAncestryEventIds].reverse(),
      })
    ).toEqual(digest)
  })

  it("retains a variation parent only when its exact coordinate matches the quote family", () => {
    const { input, context } = fixture()
    const parentProduct = {
      coordinate: `30402:${merchantPubkey}:fruit-family`,
      eventId: hash(),
    }
    const parentInput = {
      ...input,
      lines: input.lines.map((entry) => ({ ...entry, parentProduct })),
    }
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(parentInput, context)
    ).toThrow()
    context.commerceQuote.lines = context.commerceQuote.lines.map((entry) => ({
      ...entry,
      variation: {
        familyCoordinate: parentProduct.coordinate,
        specifications: [{ key: "size", value: "large" }],
      },
    }))
    const frozen = freezeCheckoutSparkEventMarketBinding(parentInput, context)
    expect(frozen.lines[0]?.parentProduct).toEqual(parentProduct)
    expect(Object.isFrozen(frozen.lines[0]?.parentProduct)).toBe(true)
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, context)
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...parentInput,
          lines: [
            {
              ...parentInput.lines[0]!,
              parentProduct: {
                ...parentProduct,
                coordinate: `30402:${organizerPubkey}:fruit-family`,
              },
            },
          ],
        },
        context
      )
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...parentInput,
          lines: [
            {
              ...parentInput.lines[0]!,
              parentProduct: { ...parentProduct, extra: true },
            },
          ],
        },
        context
      )
    ).toThrow()
    const changed = {
      ...frozen,
      lines: [
        {
          ...frozen.lines[0]!,
          parentProduct: { ...parentProduct, eventId: hash() },
        },
      ],
    }
    expect(checkoutSparkEventMarketBindingDigestValue(changed)).not.toEqual(
      checkoutSparkEventMarketBindingDigestValue(frozen)
    )
  })

  it("preserves self-selling only in merchant-present mode", () => {
    const { input, context } = fixture()
    const selfMarket = `30409:${merchantPubkey}:fair`
    const selfOccurrence = `31923:${merchantPubkey}:fair-day`
    const selfInput = {
      ...input,
      organizerPubkey: merchantPubkey,
      marketCoordinate: selfMarket,
      occurrenceCoordinate: selfOccurrence,
      lines: input.lines.map((entry) => ({
        ...entry,
        assignmentCoordinate: `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag(
          {
            marketCoordinate: selfMarket,
            occurrenceCoordinate: selfOccurrence,
            productCoordinate: entry.productCoordinate,
          }
        )}`,
      })),
      organizerFee: {
        ...input.organizerFee,
        organizerPubkey: merchantPubkey,
        marketCoordinate: selfMarket,
      },
    }
    expect(freezeCheckoutSparkEventMarketBinding(selfInput, context).mode).toBe(
      "merchant_present"
    )
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...selfInput,
          mode: "organizer_handoff",
          lines: selfInput.lines.map((entry) => ({
            ...entry,
            stockPoolId: hash(),
          })),
        },
        context
      )
    ).toThrow()
  })

  it("calculates organizer fees from commerce only, including shipping and ceil rounding", () => {
    const { input, context } = fixture()
    context.commerceQuote.lines = context.commerceQuote.lines.map((entry) => ({
      ...entry,
      unitShippingSats: 1,
    }))
    context.commerceQuote.commerceTotalSats = 1_001
    input.organizerFeeSats = 26
    expect(
      freezeCheckoutSparkEventMarketBinding(input, context).organizerFeeSats
    ).toBe(26)
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        { ...input, organizerFeeSats: 25 },
        context
      )
    ).toThrow()
  })

  it("permits a positive minimum fee on zero-priced commerce and an all-free binding", () => {
    const { input, context } = fixture()
    context.commerceQuote.lines = context.commerceQuote.lines.map((entry) => ({
      ...entry,
      unitMerchandiseSats: 0,
    }))
    context.commerceQuote.commerceTotalSats = 0
    input.organizerFeeSats = 5
    expect(
      freezeCheckoutSparkEventMarketBinding(input, context).organizerFeeSats
    ).toBe(5)
    const {
      basisPoints,
      minimumSats,
      lightningAddress,
      expiresAt,
      ...binding
    } = input.organizerFee
    void basisPoints
    void minimumSats
    void lightningAddress
    void expiresAt
    expect(
      freezeCheckoutSparkEventMarketBinding(
        {
          ...input,
          organizerFee: { ...binding, state: "disabled" },
          organizerFeeSats: 0,
        },
        context
      ).organizerFeeSats
    ).toBe(0)
  })

  for (const state of ["absent", "disabled", "revoked"] as const) {
    it(`requires a zero amount for ${state} organizer terms`, () => {
      const { input, context } = fixture()
      const organizerFee = {
        state,
        marketCoordinate,
        organizerPubkey,
        eventId: input.marketEventId,
        createdAt: input.organizerFee.createdAt,
      }
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(
          { ...input, organizerFee },
          context
        )
      ).toThrow()
      expect(
        freezeCheckoutSparkEventMarketBinding(
          { ...input, organizerFee, organizerFeeSats: 0 },
          context
        ).organizerFee.state
      ).toBe(state)
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(
          { ...input, organizerFee: { ...organizerFee, minimumSats: 0 } },
          context
        )
      ).toThrow()
    })
  }

  it("checks the exclusive expiry and original signed timestamp at acceptance", () => {
    const { input, context } = fixture()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        acceptedAtMs: 999_999,
      })
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        acceptedAtMs: 1_100_000,
      })
    ).toThrow()
    expect(
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        acceptedAtMs: 1_099_999,
      }).organizerFeeSats
    ).toBe(25)
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...input,
          organizerFee: { ...input.organizerFee, expiresAt: 1_000 },
        },
        context
      )
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        acceptedAtMs: Number.NaN,
      })
    ).toThrow()
  })

  it("rejects fee terms from another author, market or signed market revision", () => {
    const { input, context } = fixture()
    for (const changed of [
      { organizerPubkey: merchantPubkey },
      { marketCoordinate: `30409:${organizerPubkey}:another` },
      { eventId: hash() },
    ]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(
          { ...input, organizerFee: { ...input.organizerFee, ...changed } },
          context
        )
      ).toThrow()
    }
  })

  it("rejects a changed assignment tuple hash or coordinate author/kind", () => {
    const { input, context } = fixture()
    const original = input.lines[0]!
    for (const changed of [
      { assignmentCoordinate: `30410:${merchantPubkey}:${hash()}` },
      {
        assignmentCoordinate: original.assignmentCoordinate.replace(
          merchantPubkey,
          organizerPubkey
        ),
      },
      {
        productCoordinate: original.productCoordinate.replace(
          "30402:",
          "30410:"
        ),
      },
      {
        productCoordinate: original.productCoordinate.replace(
          merchantPubkey,
          organizerPubkey
        ),
      },
      { productCoordinate: ` ${original.productCoordinate}` },
    ]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(
          { ...input, lines: [{ ...original, ...changed }] },
          context
        )
      ).toThrow()
    }
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        { ...input, occurrenceCoordinate: `31924:${organizerPubkey}:fair-day` },
        context
      )
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...input,
          schedule: {
            coordinate: `31924:${merchantPubkey}:schedule`,
            eventId: hash(),
          },
        },
        context
      )
    ).toThrow()
  })

  it("requires the same product revisions, quantities, merchant and total as the commerce quote", () => {
    const { input, context } = fixture()
    for (const changed of [{ productEventId: hash() }, { quantity: 2 }]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(
          { ...input, lines: [{ ...input.lines[0]!, ...changed }] },
          context
        )
      ).toThrow()
    }
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        commerceQuote: { ...context.commerceQuote, commerceTotalSats: 999 },
      })
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        commerceQuote: {
          ...context.commerceQuote,
          lines: context.commerceQuote.lines.map((entry) => ({
            ...entry,
            merchantPubkey: organizerPubkey,
          })),
        },
      })
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(input, {
        ...context,
        commerceQuote: { ...context.commerceQuote, lines: [] },
      })
    ).toThrow()
  })

  it("rejects duplicate products, assignment coordinates and stock pools", () => {
    const { input, context } = fixture()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        { ...input, lines: [input.lines[0]!, input.lines[0]!] },
        {
          ...context,
          commerceQuote: {
            ...context.commerceQuote,
            lines: [
              context.commerceQuote.lines[0]!,
              context.commerceQuote.lines[0]!,
            ],
          },
        }
      )
    ).toThrow()
    const second = line("pears")
    const stockPoolId = hash()
    const extraQuoteLine = {
      ...context.commerceQuote.lines[0]!,
      productCoordinate: second.productCoordinate,
      productEventId: second.productEventId,
    }
    const nextContext = {
      ...context,
      commerceQuote: {
        commerceTotalSats: 2_000,
        lines: [...context.commerceQuote.lines, extraQuoteLine],
      },
    }
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...input,
          mode: "organizer_handoff",
          organizerFeeSats: 50,
          lines: [...input.lines, second].map((entry) => ({
            ...entry,
            stockPoolId,
          })),
        },
        nextContext
      )
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkEventMarketBinding(
        {
          ...input,
          organizerFeeSats: 50,
          lines: [
            ...input.lines,
            {
              ...second,
              assignmentCoordinate: input.lines[0]!.assignmentCoordinate,
            },
          ],
        },
        nextContext
      )
    ).toThrow()
  })

  it("rejects unknown fields at every persisted binding boundary", () => {
    const { input, context } = fixture()
    for (const changed of [
      { ...input, enabled: true },
      {
        ...input,
        organizerFee: {
          ...input.organizerFee,
          fallbackAddress: "another@example.com",
        },
      },
      { ...input, lines: [{ ...input.lines[0]!, price: 1 }] },
      {
        ...input,
        schedule: {
          coordinate: `31924:${organizerPubkey}:schedule`,
          eventId: hash(),
          latest: true,
        },
      },
    ]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(changed, context)
      ).toThrow()
    }
  })

  it("rejects malformed IDs, labels, amounts, unsafe quantities and overflow", () => {
    const { input, context } = fixture()
    for (const changed of [
      { ...input, schemaVersion: 2 },
      { ...input, grantEventId: "missing" },
      { ...input, marketEventId: input.marketEventId.toUpperCase() },
      { ...input, assignment: " Booth 1 " },
      { ...input, assignment: "x\ny" },
      { ...input, assignment: "é".repeat(61) },
      { ...input, lines: [{ ...input.lines[0]!, quantity: 2_147_483_648 }] },
      { ...input, lines: [{ ...input.lines[0]!, quantity: 0 }] },
      { ...input, organizerFeeSats: 25.1 },
      { ...input, organizerFee: { ...input.organizerFee, basisPoints: -1 } },
      {
        ...input,
        organizerFee: {
          ...input.organizerFee,
          minimumSats: Number.MAX_SAFE_INTEGER,
        },
      },
      {
        ...input,
        organizerFee: {
          ...input.organizerFee,
          lightningAddress: " Organizer@Example.com ",
        },
      },
      {
        ...input,
        organizerFee: {
          ...input.organizerFee,
          basisPoints: Number.MAX_SAFE_INTEGER,
        },
      },
    ]) {
      expect(() =>
        freezeCheckoutSparkEventMarketBinding(changed, context)
      ).toThrow()
    }
  })

  it("canonicalizes line order and hashes every fee and authority field without caller mutation", () => {
    const { input, context } = fixture()
    const second = line("pears")
    input.lines.push(second)
    input.organizerFeeSats = 50
    context.commerceQuote.lines = [
      ...context.commerceQuote.lines,
      {
        ...context.commerceQuote.lines[0]!,
        productCoordinate: second.productCoordinate,
        productEventId: second.productEventId,
      },
    ]
    context.commerceQuote.commerceTotalSats = 2_000
    const a = freezeCheckoutSparkEventMarketBinding(input, context)
    const reversedInput = { ...input, lines: [...input.lines].reverse() }
    const b = freezeCheckoutSparkEventMarketBinding(reversedInput, context)
    const digest = checkoutSparkEventMarketBindingDigestValue(a)
    expect(checkoutSparkEventMarketBindingDigestValue(b)).toEqual(digest)
    expect(reversedInput.lines[0]?.productCoordinate).toBe(
      second.productCoordinate
    )
    for (const changed of [
      { ...a, marketEventId: hash() },
      { ...a, occurrenceEventId: hash() },
      { ...a, grantEventId: hash() },
      { ...a, assignment: "Booth 2" },
      { ...a, organizerFeeSats: 51 },
      { ...a, organizerFee: { ...a.organizerFee, createdAt: 999 } },
    ]) {
      expect(checkoutSparkEventMarketBindingDigestValue(changed)).not.toEqual(
        digest
      )
    }
  })

  it("compares complete public order references without requiring a schema or authenticating signatures", () => {
    const { input, context } = fixture()
    const binding = freezeCheckoutSparkEventMarketBinding(input, context)
    const line = binding.lines[0]!
    const snapshot = {
      type: "event_market_pickup",
      organizerPubkey,
      merchantPubkey,
      payeePubkey: merchantPubkey,
      market: {
        coordinate: binding.marketCoordinate,
        eventId: binding.marketEventId,
        signedEvent: { untrusted: true },
      },
      calendar: {
        coordinate: binding.occurrenceCoordinate,
        eventId: binding.occurrenceEventId,
      },
      grant: {
        kind: 3841,
        pubkey: organizerPubkey,
        eventId: binding.grantEventId,
        ancestryEventIds: binding.grantAncestryEventIds,
        observedDeletionEventIds: binding.observedDeletionEventIds,
      },
      product: {
        coordinate: line.productCoordinate,
        eventId: line.productEventId,
      },
      occurrenceAssignment: {
        coordinate: line.assignmentCoordinate,
        eventId: line.assignmentEventId,
      },
      mode: binding.mode,
      assignment: binding.assignment,
    }
    expect(
      matchesCheckoutSparkOrderEventMarketSnapshot(
        snapshot,
        binding,
        line.productCoordinate
      )
    ).toBe(true)
    for (const changed of [
      null,
      {},
      { ...snapshot, type: "pickup" },
      { ...snapshot, organizerPubkey: merchantPubkey },
      { ...snapshot, merchantPubkey: organizerPubkey },
      { ...snapshot, payeePubkey: organizerPubkey },
      { ...snapshot, mode: "organizer_handoff" },
      { ...snapshot, assignment: "Booth 2" },
      { ...snapshot, market: { ...snapshot.market, eventId: hash() } },
      {
        ...snapshot,
        calendar: {
          ...snapshot.calendar,
          coordinate: `31923:${organizerPubkey}:other-day`,
        },
      },
      { ...snapshot, grant: { ...snapshot.grant, kind: 16 } },
      { ...snapshot, grant: { ...snapshot.grant, pubkey: merchantPubkey } },
      { ...snapshot, grant: { ...snapshot.grant, eventId: hash() } },
      {
        ...snapshot,
        grant: {
          ...snapshot.grant,
          ancestryEventIds: [binding.grantEventId, binding.grantEventId],
        },
      },
      {
        ...snapshot,
        grant: { ...snapshot.grant, observedDeletionEventIds: [hash()] },
      },
      { ...snapshot, product: { ...snapshot.product, eventId: hash() } },
      {
        ...snapshot,
        occurrenceAssignment: {
          ...snapshot.occurrenceAssignment,
          eventId: hash(),
        },
      },
      { ...snapshot, occurrenceAssignment: undefined },
      { ...snapshot, parentProduct: snapshot.product },
      {
        ...snapshot,
        schedule: {
          coordinate: `31924:${organizerPubkey}:schedule`,
          eventId: hash(),
        },
      },
    ]) {
      expect(
        matchesCheckoutSparkOrderEventMarketSnapshot(
          changed,
          binding,
          line.productCoordinate
        )
      ).toBe(false)
    }
    expect(
      matchesCheckoutSparkOrderEventMarketSnapshot(
        snapshot,
        binding,
        `30402:${merchantPubkey}:unknown`
      )
    ).toBe(false)
    expect(
      matchesCheckoutSparkOrderEventMarketSnapshot(
        {
          get type() {
            throw new Error("Malformed snapshot")
          },
        },
        binding,
        line.productCoordinate
      )
    ).toBe(false)
  })

  it("compares optional schedule/parent references and complete source-ID sets independent of ordering", () => {
    const { input, context } = fixture()
    const parentProduct = {
      coordinate: `30402:${merchantPubkey}:family`,
      eventId: hash(),
    }
    context.commerceQuote.lines = context.commerceQuote.lines.map((line) => ({
      ...line,
      variation: {
        familyCoordinate: parentProduct.coordinate,
        specifications: [],
      },
    }))
    const binding = freezeCheckoutSparkEventMarketBinding(
      {
        ...input,
        schedule: {
          coordinate: `31924:${organizerPubkey}:schedule`,
          eventId: hash(),
        },
        grantAncestryEventIds: [input.grantEventId, hash()],
        observedDeletionEventIds: [hash(), hash()],
        lines: input.lines.map((line) => ({ ...line, parentProduct })),
      },
      context
    )
    const line = binding.lines[0]!
    const snapshot = {
      type: "event_market_pickup",
      organizerPubkey,
      merchantPubkey,
      payeePubkey: merchantPubkey,
      market: {
        coordinate: binding.marketCoordinate,
        eventId: binding.marketEventId,
      },
      calendar: {
        coordinate: binding.occurrenceCoordinate,
        eventId: binding.occurrenceEventId,
      },
      schedule: binding.schedule,
      parentProduct: line.parentProduct,
      grant: {
        kind: 3841,
        pubkey: organizerPubkey,
        eventId: binding.grantEventId,
        ancestryEventIds: [...binding.grantAncestryEventIds].reverse(),
        observedDeletionEventIds: [
          ...binding.observedDeletionEventIds,
        ].reverse(),
      },
      product: {
        coordinate: line.productCoordinate,
        eventId: line.productEventId,
      },
      occurrenceAssignment: {
        coordinate: line.assignmentCoordinate,
        eventId: line.assignmentEventId,
      },
      mode: binding.mode,
      assignment: binding.assignment,
    }
    expect(
      matchesCheckoutSparkOrderEventMarketSnapshot(
        snapshot,
        binding,
        line.productCoordinate
      )
    ).toBe(true)
    for (const changed of [
      { ...snapshot, schedule: undefined },
      { ...snapshot, schedule: { ...binding.schedule!, eventId: hash() } },
      { ...snapshot, parentProduct: undefined },
      { ...snapshot, parentProduct: { ...parentProduct, eventId: hash() } },
      {
        ...snapshot,
        grant: { ...snapshot.grant, ancestryEventIds: [binding.grantEventId] },
      },
      {
        ...snapshot,
        grant: {
          ...snapshot.grant,
          observedDeletionEventIds: [binding.observedDeletionEventIds[0]!],
        },
      },
    ]) {
      expect(
        matchesCheckoutSparkOrderEventMarketSnapshot(
          changed,
          binding,
          line.productCoordinate
        )
      ).toBe(false)
    }
  })
})
