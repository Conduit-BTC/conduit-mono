import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { createSelectedProfileContext } from "../packages/core/src/protocol/profile-cache"
import { EventMarketOrganizerFeeForm } from "../apps/merchant/src/components/EventMarketOrganizerFeeEditor"
import {
  createEventMarketOrganizerFeeFormValues,
  formatOrganizerFeePercent,
  getOrganizerFeeProfileAddress,
  parseEventMarketOrganizerFeeForm,
} from "../apps/merchant/src/lib/event-market-organizer-fee-form"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

describe("organizer fee form", () => {
  it("authors percentage-only terms with exact basis points without floating-point rounding", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const values = createEventMarketOrganizerFeeFormValues(fee)
    expect(values).toMatchObject({
      state: "active",
      percent: "2.5",
      lightningAddress: "organizer@example.test",
    })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "2.15" })
    ).toMatchObject({ basisPoints: 215, minimumSats: 0 })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "0.01" })
    ).toMatchObject({ basisPoints: 1 })
    expect(formatOrganizerFeePercent(200)).toBe("2")
    expect(formatOrganizerFeePercent(1)).toBe("0.01")
    expect(
      parseEventMarketOrganizerFeeForm({
        ...values,
        percent: "0",
        lightningAddress: "",
      })
    ).toEqual({ state: "disabled" })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "revoked" })
    ).toEqual({ state: "revoked" })
    for (const change of [
      { percent: "-1" },
      { percent: "2.151" },
      { percent: "NaN" },
      { percent: "1e2" },
      { percent: String(Number.MAX_SAFE_INTEGER) },
      { lightningAddress: "not-an-address" },
    ])
      expect(() =>
        parseEventMarketOrganizerFeeForm({ ...values, ...change })
      ).toThrow()
  })

  it("keeps unknown or malformed current terms unselected until the organizer explicitly decides", () => {
    const values = createEventMarketOrganizerFeeFormValues({ state: "invalid" })
    expect(values.state).toBe("")
    expect(() => parseEventMarketOrganizerFeeForm(values)).toThrow("Choose")
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "disabled" })
    ).toEqual({ state: "disabled" })
  })

  it("leaves existing signed terms untouched while an explicit edit authors no minimum or expiry", () => {
    const original = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    if (original.state !== "active") throw new Error("Expected active")
    const expiresAt = AT / 1_000 + 3_601
    const current = {
      ...original,
      expiresAt,
    }
    const snapshot = structuredClone(current)
    const values = createEventMarketOrganizerFeeFormValues(current)
    expect(values).not.toHaveProperty("minimumSats")
    expect(values).not.toHaveProperty("expiresAtUtc")
    expect(current).toEqual(snapshot)
    expect(parseEventMarketOrganizerFeeForm(values)).toEqual({
      state: "active",
      basisPoints: current.basisPoints,
      minimumSats: 0,
      lightningAddress: current.lightningAddress,
    })
    expect(current).toEqual(snapshot)
  })

  it("uses the selected organizer profile address, not display data or another account", () => {
    const event = finalizeEvent(
      {
        kind: 0,
        created_at: AT / 1_000,
        tags: [],
        content: JSON.stringify({ lud16: "organizer@example.test" }),
      },
      generateSecretKey()
    )
    const context = createSelectedProfileContext({
      pubkey: event.pubkey,
      row: {
        pubkey: event.pubkey,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        rawContent: event.content,
        cachedAt: AT,
      },
    })
    context.profile.lud16 = "display-only@example.test"
    expect(getOrganizerFeeProfileAddress(context, event.pubkey)).toBe(
      "organizer@example.test"
    )
    expect(
      getOrganizerFeeProfileAddress(context, "another-account")
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(undefined, event.pubkey)
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        createSelectedProfileContext({
          pubkey: event.pubkey,
          profile: { pubkey: event.pubkey, lud16: "display-only@example.test" },
        }),
        event.pubkey
      )
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        { ...context, frontier: { ...context.frontier!, rawContent: "{}" } },
        event.pubkey
      )
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        {
          ...context,
          frontier: {
            ...context.frontier!,
            rawContent: JSON.stringify({ lud16: "not-an-address" }),
          },
        },
        event.pubkey
      )
    ).toBeUndefined()
  })
})

describe("organizer fee shared-control presentation", () => {
  const noChange = () => undefined
  it("shows percentage-only fields, an explicit saved-address choice and editable custom address", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    let actions = 0
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry
        editing
        busy={false}
        profileAddress="saved@example.test"
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={() => {
          actions++
        }}
        onRetry={() => {
          actions++
        }}
      />
    )
    expect(html).toContain("Organizer fee")
    expect(html).toContain("2.5%, minimum 5 sats")
    for (const label of [
      "Fee setting",
      "Percentage",
      "Organizer Lightning address",
    ])
      expect(html).toContain(label)
    expect(html).toContain("Save fee settings")
    expect(html).toContain("Retry current signed settings")
    expect(html).not.toContain("Minimum (sats)")
    expect(html).not.toContain("Expiry (UTC, optional)")
    expect(html).toContain("Use my Lightning address")
    expect(html).toContain("saved@example.test")
    expect(html).toContain('value="organizer@example.test"')
    expect(html).toContain(
      "This does not change your profile or wallet settings"
    )
    expect(html).toContain("Saving replaces the current minimum and expiry")
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('<select aria-hidden="true"')
    expect(actions).toBe(0)
  })

  it("shows invalid terms as a blocker rather than claiming the fee is zero", () => {
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={{ state: "invalid" }}
        values={createEventMarketOrganizerFeeFormValues({ state: "invalid" })}
        canEdit
        canRetry
        editing
        busy={false}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("could not be verified")
    expect(html).toContain("explicitly replace")
    expect(html).not.toContain("No organizer fee has been set")
    expect(html).toContain('disabled=""')
  })

  it("does not expose editing or publication controls to a non-organizer", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit={false}
        canRetry={false}
        editing={false}
        busy={false}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("organizer@example.test")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("<button")
    expect(html).toContain("Only the authenticated organizer")
  })

  it("shows a compact saved summary with explicit editing and retains legacy expiry", () => {
    const original = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    if (original.state !== "active") throw new Error("Expected active")
    const fee = { ...original, expiresAt: AT / 1_000 + 3_601 }
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry={false}
        editing={false}
        busy={false}
        notice="Fee settings saved and published."
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).not.toContain("<form")
    expect(html).toContain("Edit fee settings")
    expect(html).toContain("2.5%, minimum 5 sats")
    expect(html).toContain("Expires")
    expect(html).toContain("Fee settings saved and published.")
    expect(html).not.toContain("Only the authenticated organizer")
    expect(html).not.toContain("Retry current signed settings")
  })

  it("keeps custom entry available without saved profile evidence and exposes failed-delivery retry", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry
        editing
        editLocked
        busy={false}
        error="Publication could not be confirmed. Retry the saved update."
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("No saved profile address is available here")
    expect(html).not.toContain("Use my Lightning address")
    expect(html).toContain("Organizer Lightning address")
    expect(html).toContain('role="alert"')
    expect(html).toContain("Retry current signed settings")
    expect(html).not.toContain("saved and published")
    expect(html).toContain('disabled=""')
  })
})
