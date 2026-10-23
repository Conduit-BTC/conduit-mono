import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  assertCheckoutSparkSignedEventMarketSources,
  getCheckoutSparkEventMarketSourceReferences,
} from "@conduit/core/protocol/checkout-spark-event-market-sources"
import {
  canonicalizeCheckoutSparkPlanSourceEvents,
  getCheckoutSparkPlanSourceReferences,
  validateCheckoutSparkPlanSources,
} from "@conduit/core/protocol/checkout-spark-plan-sources"
import { freezeCheckoutSparkSettledEventPlan } from "@conduit/core/protocol/checkout-spark-settled-router"
import { buildEventMarketAuthorizationDraft } from "@conduit/core/protocol/event-market-authorization"
import { parseEventMarketOrganizerFeeTerms } from "@conduit/core/protocol/event-market-organizer-fee"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT,
} from "./support/checkout-spark-event-market-fixture"

type Fixture = ReturnType<typeof checkoutSparkEventMarketFixture>
type AuthorityInput = Parameters<
  typeof assertCheckoutSparkSignedEventMarketSources
>[0]

function authority(fixture: Fixture, changes: Partial<AuthorityInput> = {}) {
  return assertCheckoutSparkSignedEventMarketSources({
    eventMarket: fixture.input.eventMarket,
    commerceQuote: fixture.input.commerceQuote,
    merchantPubkey: fixture.input.merchantPubkey,
    sourceEvents: fixture.sourceEvents,
    acceptedAtMs: fixture.input.createdAt,
    ...changes,
  })
}

function replaceSource(
  fixture: Fixture,
  previous: SignedPublicNostrEvent,
  next: SignedPublicNostrEvent
) {
  return fixture.sourceEvents.map((event) =>
    event.id === previous.id ? next : event
  )
}

function rebindMarket(fixture: Fixture, market: SignedPublicNostrEvent) {
  const organizerFee = parseEventMarketOrganizerFeeTerms({
    marketCoordinate: fixture.eventMarket.marketCoordinate,
    event: market,
  })
  if (organizerFee.state === "invalid")
    throw new Error("Invalid market test fixture")
  return {
    ...fixture.input.eventMarket,
    marketEventId: market.id,
    organizerFee,
  }
}

describe("exact signed Event Market checkout source authority", () => {
  it("accepts a complete signed roster, admission, occurrence, product, assignment and fee revision", () => {
    const fixture = checkoutSparkEventMarketFixture()
    expect(authority(fixture)).toEqual(fixture.plan.eventMarket)
    expect(
      validateCheckoutSparkPlanSources(fixture.plan, fixture.sourceEvents)
    ).toMatchObject({
      checkoutId: fixture.plan.checkoutId,
      planDigest: fixture.plan.planDigest,
    })
    const canonical = canonicalizeCheckoutSparkPlanSourceEvents(
      fixture.plan,
      fixture.sourceEvents
    )
    expect(canonical).toHaveLength(fixture.sourceEvents.length)
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical[0]!.tags)).toBe(true)
    const refs = getCheckoutSparkPlanSourceReferences(fixture.plan)
    expect(new Set(refs.map((ref) => ref.eventId))).toEqual(
      new Set(fixture.sourceEvents.map((event) => event.id))
    )
  })

  it("accepts the exact signed variation parent and optional occurrence schedule", () => {
    const fixture = checkoutSparkEventMarketFixture({
      schedule: true,
      variation: true,
    })
    expect(authority(fixture).schedule?.eventId).toBe(
      fixture.events.schedule!.id
    )
    expect(
      validateCheckoutSparkPlanSources(fixture.plan, fixture.sourceEvents)
        .planDigest
    ).toBe(fixture.plan.planDigest)
    const refs = getCheckoutSparkEventMarketSourceReferences(
      fixture.plan.eventMarket!,
      fixture.merchantPubkey
    )
    expect(refs).toContainEqual({
      eventId: fixture.events.parentProduct!.id,
      kind: 30402,
      pubkey: fixture.merchantPubkey,
    })
    expect(refs).toContainEqual({
      eventId: fixture.events.schedule!.id,
      kind: 31924,
      pubkey: fixture.organizerPubkey,
    })
    expect(() =>
      authority(fixture, {
        sourceEvents: fixture.sourceEvents.filter(
          (event) => event.id !== fixture.events.parentProduct!.id
        ),
      })
    ).toThrow()
    expect(() =>
      authority(fixture, {
        sourceEvents: fixture.sourceEvents.filter(
          (event) => event.id !== fixture.events.schedule!.id
        ),
      })
    ).toThrow()
  })

  it("fails closed for wrong signatures, wrong source authors or missing exact IDs", () => {
    const fixture = checkoutSparkEventMarketFixture()
    const corrupted = {
      ...fixture.events.assignment,
      content: "Unsigned replacement",
    }
    expect(() =>
      authority(fixture, {
        sourceEvents: replaceSource(
          fixture,
          fixture.events.assignment,
          corrupted
        ),
      })
    ).toThrow()
    const wrongSigner = finalizeEvent(
      {
        kind: fixture.events.assignment.kind,
        tags: fixture.events.assignment.tags.map((tag) => [...tag]),
        created_at: fixture.events.assignment.created_at,
        content: fixture.events.assignment.content,
      },
      generateSecretKey()
    )
    expect(() =>
      authority(fixture, {
        eventMarket: {
          ...fixture.eventMarket,
          lines: fixture.eventMarket.lines.map((line) => ({
            ...line,
            assignmentEventId: wrongSigner.id,
          })),
        },
        sourceEvents: replaceSource(
          fixture,
          fixture.events.assignment,
          wrongSigner
        ),
      })
    ).toThrow()
    expect(() =>
      authority(fixture, {
        sourceEvents: fixture.sourceEvents.filter(
          (event) => event.id !== fixture.events.grant.id
        ),
      })
    ).toThrow()
    expect(() =>
      canonicalizeCheckoutSparkPlanSourceEvents(fixture.plan, [
        ...fixture.sourceEvents,
        fixture.events.market,
      ])
    ).toThrow()
  })

  it("requires the exact Merchant roster row, open state and assignment label", () => {
    const fixture = checkoutSparkEventMarketFixture()
    for (const tags of [
      fixture.events.market.tags.filter((tag) => tag[0] !== "merchant"),
      fixture.events.market.tags.map((tag) =>
        tag[0] === "event_market" ? ["event_market", "2", "closed"] : [...tag]
      ),
      fixture.events.market.tags.map((tag) =>
        tag[0] === "merchant"
          ? ["merchant", fixture.merchantPubkey, "merchant_present", "Booth 2"]
          : [...tag]
      ),
    ]) {
      const market = fixture.signOrganizer({ ...fixture.events.market, tags })
      expect(() =>
        authority(fixture, {
          eventMarket: rebindMarket(fixture, market),
          sourceEvents: replaceSource(fixture, fixture.events.market, market),
        })
      ).toThrow()
    }
  })

  it("does not let locally rewritten rates, minimums or receiving addresses override signed fee terms", () => {
    const fixture = checkoutSparkEventMarketFixture()
    const original = fixture.eventMarket.organizerFee
    if (original.state !== "active")
      throw new Error("Active fee fixture required")
    for (const changes of [
      {
        organizerFee: { ...original, basisPoints: 500 },
        organizerFeeSats: 5_000,
      },
      {
        organizerFee: { ...original, minimumSats: 3_000 },
        organizerFeeSats: 3_000,
      },
      {
        organizerFee: { ...original, lightningAddress: "other@example.test" },
        organizerFeeSats: fixture.eventMarket.organizerFeeSats,
      },
    ]) {
      expect(() =>
        authority(fixture, {
          eventMarket: { ...fixture.eventMarket, ...changes },
        })
      ).toThrow()
    }
  })

  it("requires the whole causally valid admission chain rather than trusting only its last transition", () => {
    const fixture = checkoutSparkEventMarketFixture()
    const root = fixture.events.grant
    const revoke = fixture.signOrganizer({
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate: fixture.eventMarket.marketCoordinate,
        merchantPubkey: fixture.merchantPubkey,
        state: "revoked",
        sequence: 1,
        parentIds: [root.id],
      }),
      created_at: root.created_at + 1,
    })
    const regrant = fixture.signOrganizer({
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate: fixture.eventMarket.marketCoordinate,
        merchantPubkey: fixture.merchantPubkey,
        state: "active",
        sequence: 2,
        parentIds: [revoke.id],
      }),
      created_at: root.created_at + 2,
    })
    const fullBinding = {
      ...fixture.eventMarket,
      grantEventId: regrant.id,
      grantAncestryEventIds: [root.id, revoke.id, regrant.id],
    }
    const all = [...fixture.sourceEvents, revoke, regrant]
    expect(
      authority(fixture, { eventMarket: fullBinding, sourceEvents: all })
        .grantEventId
    ).toBe(regrant.id)
    expect(() =>
      authority(fixture, {
        eventMarket: { ...fullBinding, grantAncestryEventIds: [regrant.id] },
        sourceEvents: all,
      })
    ).toThrow()
    expect(() =>
      authority(fixture, {
        eventMarket: {
          ...fullBinding,
          grantEventId: revoke.id,
          grantAncestryEventIds: [root.id, revoke.id],
        },
        sourceEvents: all,
      })
    ).toThrow()
    expect(() =>
      authority(fixture, {
        eventMarket: fullBinding,
        sourceEvents: all.filter((event) => event.id !== root.id),
      })
    ).toThrow()
  })

  it("retains an observed deletion as a blocker until an explicit descendant repair", () => {
    const fixture = checkoutSparkEventMarketFixture()
    const grant = fixture.events.grant
    const deletion = fixture.signOrganizer({
      kind: 5,
      created_at: grant.created_at + 1,
      content: "",
      tags: [
        ["e", grant.id],
        ["a", fixture.eventMarket.marketCoordinate],
        ["p", fixture.merchantPubkey],
      ],
    })
    const deletedBinding = {
      ...fixture.eventMarket,
      observedDeletionEventIds: [deletion.id],
    }
    expect(() =>
      authority(fixture, {
        eventMarket: deletedBinding,
        sourceEvents: [...fixture.sourceEvents, deletion],
      })
    ).toThrow()
    const repair = fixture.signOrganizer({
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate: fixture.eventMarket.marketCoordinate,
        merchantPubkey: fixture.merchantPubkey,
        state: "active",
        sequence: 1,
        parentIds: [grant.id],
        repairs: [{ deletionId: deletion.id, targetId: grant.id }],
      }),
      created_at: grant.created_at + 2,
    })
    const repairedBinding = {
      ...deletedBinding,
      grantEventId: repair.id,
      grantAncestryEventIds: [grant.id, repair.id],
    }
    expect(
      authority(fixture, {
        eventMarket: repairedBinding,
        sourceEvents: [...fixture.sourceEvents, deletion, repair],
      }).grantEventId
    ).toBe(repair.id)
    expect(() =>
      authority(fixture, {
        eventMarket: repairedBinding,
        sourceEvents: [...fixture.sourceEvents, repair],
      })
    ).toThrow()
  })

  it("rejects a wrong/expired occurrence or a schedule that omits the selected day", () => {
    const fixture = checkoutSparkEventMarketFixture({ schedule: true })
    const occurrence = fixture.events.occurrence
    for (const tags of [
      occurrence.tags.map((tag) =>
        tag[0] === "d" ? ["d", "other-day"] : [...tag]
      ),
      occurrence.tags.map((tag) =>
        tag[0] === "end"
          ? ["end", String(EVENT_MARKET_FIXTURE_AT / 1_000)]
          : [...tag]
      ),
    ]) {
      const changed = fixture.signOrganizer({ ...occurrence, tags })
      expect(() =>
        authority(fixture, {
          eventMarket: {
            ...fixture.eventMarket,
            occurrenceEventId: changed.id,
          },
          sourceEvents: replaceSource(fixture, occurrence, changed),
        })
      ).toThrow()
    }
    const schedule = fixture.events.schedule!
    const changedSchedule = fixture.signOrganizer({
      ...schedule,
      tags: schedule.tags.map((tag) =>
        tag[0] === "a"
          ? ["a", `31923:${fixture.organizerPubkey}:other-day`]
          : [...tag]
      ),
    })
    expect(() =>
      authority(fixture, {
        eventMarket: {
          ...fixture.eventMarket,
          schedule: {
            ...fixture.eventMarket.schedule!,
            eventId: changedSchedule.id,
          },
        },
        sourceEvents: replaceSource(fixture, schedule, changedSchedule),
      })
    ).toThrow()
  })

  it("requires a current matching organizer pool with enough unimported stock", () => {
    const fixture = checkoutSparkEventMarketFixture({
      mode: "organizer_handoff",
    })
    expect(authority(fixture).mode).toBe("organizer_handoff")
    expect(
      validateCheckoutSparkPlanSources(fixture.plan, fixture.sourceEvents)
        .planDigest
    ).toBe(fixture.plan.planDigest)
    const assignment = fixture.events.assignment
    for (const change of [
      "wrong_pool",
      "closed",
      "exhausted",
      "missing",
      "malformed",
    ]) {
      const tags =
        change === "missing"
          ? assignment.tags.filter((tag) => tag[0] !== "conduit_stock_pool")
          : assignment.tags.map((tag) => {
              if (tag[0] !== "conduit_stock_pool") return [...tag]
              const changed = [...tag]
              if (change === "wrong_pool")
                changed[3] = fixture.events.product.id
              if (change === "closed") changed[2] = "closed"
              if (change === "exhausted") changed[6] = changed[5]!
              if (change === "malformed") changed[1] = "2"
              return changed
            })
      const changed = fixture.signMerchant({ ...assignment, tags })
      expect(() =>
        authority(fixture, {
          eventMarket: {
            ...fixture.eventMarket,
            lines: fixture.eventMarket.lines.map((line) => ({
              ...line,
              assignmentEventId: changed.id,
            })),
          },
          sourceEvents: replaceSource(fixture, assignment, changed),
        })
      ).toThrow()
    }
  })

  it("cannot sell an active organizer-held allocation as ordinary Merchant pickup", () => {
    const fixture = checkoutSparkEventMarketFixture({
      mode: "organizer_handoff",
    })
    const market = fixture.signOrganizer({
      ...fixture.events.market,
      tags: fixture.events.market.tags.map((tag) =>
        tag[0] === "merchant"
          ? ["merchant", fixture.merchantPubkey, "merchant_present", "Booth 1"]
          : [...tag]
      ),
    })
    const binding = {
      ...rebindMarket(fixture, market),
      mode: "merchant_present" as const,
      lines: fixture.eventMarket.lines.map((line) => {
        const { stockPoolId, ...withoutPool } = line
        void stockPoolId
        return withoutPool
      }),
    }
    expect(() =>
      authority(fixture, {
        eventMarket: binding,
        sourceEvents: replaceSource(fixture, fixture.events.market, market),
      })
    ).toThrow()
  })

  it("anchors fee expiry to original acceptance and preserves retained exact sources across later edits", () => {
    const fixture = checkoutSparkEventMarketFixture({
      organizerFee: {
        state: "active",
        basisPoints: 250,
        minimumSats: 5,
        lightningAddress: "organizer@example.test",
        expiresAt: EVENT_MARKET_FIXTURE_AT / 1_000 + 60,
      },
    })
    expect(authority(fixture).organizerFeeSats).toBe(2_500)
    expect(() =>
      authority(fixture, { acceptedAtMs: EVENT_MARKET_FIXTURE_AT + 60_000 })
    ).toThrow()
    const laterMarket = fixture.signOrganizer({
      ...fixture.events.market,
      created_at: EVENT_MARKET_FIXTURE_AT / 1_000 + 120,
      tags: fixture.events.market.tags.map((tag) =>
        tag[0] === "conduit_event_fee"
          ? ["conduit_event_fee", "1", "revoked"]
          : [...tag]
      ),
    })
    expect(
      validateCheckoutSparkPlanSources(fixture.plan, [
        ...fixture.sourceEvents,
        laterMarket,
      ]).planDigest
    ).toBe(fixture.plan.planDigest)
    expect(() =>
      validateCheckoutSparkPlanSources(
        fixture.plan,
        replaceSource(fixture, fixture.events.market, laterMarket)
      )
    ).toThrow()
    expect(() =>
      canonicalizeCheckoutSparkPlanSourceEvents(fixture.plan, [
        ...fixture.sourceEvents,
        laterMarket,
      ])
    ).toThrow()
  })

  for (const state of ["absent", "disabled", "revoked"] as const) {
    it(`keeps ${state} signed fee terms free of an organizer payout`, () => {
      const fixture = checkoutSparkEventMarketFixture({
        organizerFee: state === "absent" ? "absent" : { state },
      })
      expect(fixture.plan.eventMarket?.organizerFeeSats).toBe(0)
      expect(
        fixture.plan.recipients.some(
          (recipient) => recipient.kind === "organizer"
        )
      ).toBe(false)
      expect(authority(fixture).organizerFee.state).toBe(state)
      expect(
        validateCheckoutSparkPlanSources(fixture.plan, fixture.sourceEvents)
          .planDigest
      ).toBe(fixture.plan.planDigest)
    })
  }

  it("admits zero-priced commerce with an exact positive signed minimum and no invented profile payout", () => {
    const fixture = checkoutSparkEventMarketFixture({ commerceTotalSats: 0 })
    expect(authority(fixture).organizerFeeSats).toBe(5)
    expect(fixture.plan.recipients.map((recipient) => recipient.kind)).toEqual([
      "organizer",
      "conduit",
    ])
    expect(
      validateCheckoutSparkPlanSources(fixture.plan, fixture.sourceEvents)
        .planDigest
    ).toBe(fixture.plan.planDigest)
    expect(
      canonicalizeCheckoutSparkPlanSourceEvents(
        fixture.plan,
        fixture.sourceEvents
      )
    ).toHaveLength(fixture.sourceEvents.length)
  })

  it("rejects a source-valid plan if its locally frozen organizer economics were changed", () => {
    const fixture = checkoutSparkEventMarketFixture()
    const fee = fixture.eventMarket.organizerFee
    if (fee.state !== "active") throw new Error("Active fee fixture required")
    const locallyAltered = {
      ...fixture.input,
      eventMarket: {
        ...fixture.eventMarket,
        organizerFee: { ...fee, basisPoints: 249 },
      },
    }
    expect(() => freezeCheckoutSparkSettledEventPlan(locallyAltered)).toThrow()
  })
})
