import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import { resolveCheckoutSparkSignedPickup } from "@conduit/core/protocol/checkout-spark-pickup-evidence"
import {
  CHECKOUT_SPARK_PICKUP_FIXTURE_CREATED_AT as CREATED_AT,
  createCheckoutSparkPickupFixture,
} from "./support/checkout-spark-pickup-fixture"

describe("Checkout Spark historical pickup evidence", () => {
  it("reconstructs exact signed merchant-handoff terms for the commerce line", () => {
    const fixture = createCheckoutSparkPickupFixture()

    expect(resolveCheckoutSparkSignedPickup(fixture)).toEqual({
      type: "pickup",
      organizerPubkey: fixture.organizerPubkey,
      product: {
        coordinate: fixture.line.productCoordinate,
        eventId: fixture.productEvent.id,
        createdAt: CREATED_AT * 1_000,
        merchantPubkey: fixture.merchantPubkey,
      },
      calendar: {
        ...fixture.line.pickup!.calendar,
        createdAt: CREATED_AT * 1_000,
      },
      collection: {
        ...fixture.line.pickup!.collection,
        createdAt: CREATED_AT * 1_000,
      },
      option: {
        ...fixture.line.shippingOption!,
        createdAt: CREATED_AT * 1_000,
        title: "Merchant booth",
        location: "Public square, booth 2",
        geohash: "dr5ru",
      },
      handoffMode: "merchant_handoff",
      handlerPubkey: fixture.merchantPubkey,
      costSats: 10,
      sourceCost: { amount: 10, currency: "SAT", normalizedCurrency: "SAT" },
    })
  })

  it("resolves organizer handoff through the exact collection alias and signed extra cost", () => {
    const fixture = createCheckoutSparkPickupFixture({
      handoffMode: "organizer_handoff",
      collectionAlias: true,
      extraCostSats: 3,
      quantity: 4,
    })

    const pickup = resolveCheckoutSparkSignedPickup(fixture)

    expect(pickup).toMatchObject({
      handoffMode: "organizer_handoff",
      handlerPubkey: fixture.organizerPubkey,
      costSats: 13,
      sourceCost: { amount: 13, currency: "SAT", normalizedCurrency: "SAT" },
      option: {
        coordinate: fixture.line.shippingOption!.coordinate,
        eventId: fixture.pickup.id,
        title: "Organizer desk",
      },
    })
    // Historical handoff terms are not payment or release authorization.
    expect(Object.keys(pickup!).sort()).toEqual(
      [
        "type",
        "organizerPubkey",
        "product",
        "calendar",
        "collection",
        "option",
        "handoffMode",
        "handlerPubkey",
        "costSats",
        "sourceCost",
      ].sort()
    )
  })

  it("preserves date-based calendar evidence and an included zero-cost pickup", () => {
    const fixture = createCheckoutSparkPickupFixture({
      calendarKind: 31922,
      pickupPriceSats: 0,
    })

    expect(resolveCheckoutSparkSignedPickup(fixture)).toMatchObject({
      calendar: {
        coordinate: fixture.line.pickup!.calendar.coordinate,
        eventId: fixture.calendar.id,
      },
      option: { eventId: fixture.pickup.id },
      handoffMode: "merchant_handoff",
      costSats: 0,
      sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
    })
  })

  it("retains original historical terms when later signed revisions close the event", () => {
    const accepted = createCheckoutSparkPickupFixture({
      handoffMode: "organizer_handoff",
    })
    const later = createCheckoutSparkPickupFixture({
      handoffMode: "organizer_handoff",
      createdAt: CREATED_AT + 7_200,
      orderAcceptance: "closed",
      pickupPriceSats: 15,
    })
    const expected = resolveCheckoutSparkSignedPickup(accepted)

    expect(
      resolveCheckoutSparkSignedPickup({
        ...accepted,
        sourceEvents: [...later.sourceEvents, ...accepted.sourceEvents],
      })
    ).toEqual(expected)
    expect(expected?.option.eventId).toBe(accepted.pickup.id)
    expect(expected?.costSats).toBe(10)
    expect(expected?.collection.eventId).toBe(accepted.collection.id)
  })

  it.each(["calendar", "collection", "pickup"] as const)(
    "keeps a missing exact %s revision unavailable instead of substituting a later source",
    (missing) => {
      const accepted = createCheckoutSparkPickupFixture()
      const later = createCheckoutSparkPickupFixture({
        createdAt: CREATED_AT + 60,
      })

      expect(() =>
        resolveCheckoutSparkSignedPickup({
          ...accepted,
          sourceEvents: [
            ...accepted.sourceEvents.filter(
              (source) => source.id !== accepted[missing].id
            ),
            later[missing],
          ],
        })
      ).toThrow("Checkout Spark signed pickup evidence is unavailable.")
    }
  )

  it("accepts signed trailing d-tag fields already supported by the legacy parsers", () => {
    const fixture = createCheckoutSparkPickupFixture({
      dTagExtraFields: ["public compatibility annotation"],
    })

    expect(resolveCheckoutSparkSignedPickup(fixture)).toMatchObject({
      product: { eventId: fixture.productEvent.id },
      calendar: { eventId: fixture.calendar.id },
      collection: { eventId: fixture.collection.id },
      option: { eventId: fixture.pickup.id },
    })
  })

  it("uses the historical acceptance time and honors an explicit open declaration after schedule end", () => {
    const afterSchedule = (CREATED_AT + 7_200) * 1_000
    const open = createCheckoutSparkPickupFixture({
      orderAcceptance: "open",
      acceptedAtMs: afterSchedule,
    })
    const ended = createCheckoutSparkPickupFixture({
      acceptedAtMs: afterSchedule,
    })

    expect(resolveCheckoutSparkSignedPickup(open)?.collection.eventId).toBe(
      open.collection.id
    )
    expect(() => resolveCheckoutSparkSignedPickup(ended)).toThrow(
      "Checkout Spark signed pickup evidence is unavailable."
    )
  })

  it("does not reconstruct acceptance from a closed graph or before the signed sources existed", () => {
    const closed = createCheckoutSparkPickupFixture({
      orderAcceptance: "closed",
    })
    const notYetPublished = createCheckoutSparkPickupFixture({
      acceptedAtMs: (CREATED_AT - 1) * 1_000,
    })

    expect(() => resolveCheckoutSparkSignedPickup(closed)).toThrow(
      "Checkout Spark signed pickup evidence is unavailable."
    )
    expect(() => resolveCheckoutSparkSignedPickup(notYetPublished)).toThrow(
      "Checkout Spark signed pickup evidence is unavailable."
    )
  })

  it("keeps an organizer selling their own product in merchant handoff", () => {
    const secret = generateSecretKey()
    const fixture = createCheckoutSparkPickupFixture({
      merchantSecret: secret,
      organizerSecret: secret,
      handoffMode: "organizer_handoff",
      collectionAlias: true,
    })

    expect(resolveCheckoutSparkSignedPickup(fixture)).toMatchObject({
      organizerPubkey: fixture.organizerPubkey,
      handoffMode: "merchant_handoff",
      handlerPubkey: fixture.merchantPubkey,
    })
  })

  it("deduplicates exact signed sources without retaining unsigned transport annotations", () => {
    const fixture = createCheckoutSparkPickupFixture()
    const expected = resolveCheckoutSparkSignedPickup(fixture)
    const annotated = {
      ...fixture,
      productEvent: {
        ...fixture.productEvent,
        transportAnnotation: "not signed evidence",
      },
      sourceEvents: fixture.sourceEvents.flatMap((source) => [
        { ...source, transportAnnotation: "not signed evidence" },
        structuredClone(source),
      ]),
    }

    expect(resolveCheckoutSparkSignedPickup(annotated)).toEqual(expected)
    expect(JSON.stringify(expected)).not.toContain("transportAnnotation")
  })
})
