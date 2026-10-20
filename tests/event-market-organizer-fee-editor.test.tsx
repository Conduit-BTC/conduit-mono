import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { EventMarketOrganizerFeeForm } from "../apps/merchant/src/components/EventMarketOrganizerFeeEditor"
import {
  createEventMarketOrganizerFeeFormValues,
  formatOrganizerFeePercent,
  parseEventMarketOrganizerFeeForm,
} from "../apps/merchant/src/lib/event-market-organizer-fee-form"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

describe("organizer fee form", () => {
  it("round-trips signed terms and exact basis points without floating-point rounding", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const values = createEventMarketOrganizerFeeFormValues(fee)
    expect(values).toMatchObject({
      state: "active",
      percent: "2.5",
      minimumSats: "5",
      lightningAddress: "organizer@example.test",
    })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "2.15" }, AT)
    ).toMatchObject({ basisPoints: 215 })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "0.01" }, AT)
    ).toMatchObject({ basisPoints: 1 })
    expect(formatOrganizerFeePercent(200)).toBe("2")
    expect(formatOrganizerFeePercent(1)).toBe("0.01")
    expect(
      parseEventMarketOrganizerFeeForm(
        { ...values, percent: "0", minimumSats: "0", lightningAddress: "" },
        AT
      )
    ).toEqual({ state: "disabled" })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "revoked" }, AT)
    ).toEqual({ state: "revoked" })
    for (const change of [
      { percent: "-1" },
      { percent: "2.151" },
      { percent: "NaN" },
      { percent: "1e2" },
      { minimumSats: "0.1" },
      { minimumSats: "-1" },
      { minimumSats: String(Number.MAX_SAFE_INTEGER) },
      { lightningAddress: "not-an-address" },
      { expiresAtUtc: "2000-01-01T00:00" },
    ])
      expect(() =>
        parseEventMarketOrganizerFeeForm({ ...values, ...change }, AT)
      ).toThrow()
  })

  it("keeps unknown or malformed current terms unselected until the organizer explicitly decides", () => {
    const values = createEventMarketOrganizerFeeFormValues({ state: "invalid" })
    expect(values.state).toBe("")
    expect(() => parseEventMarketOrganizerFeeForm(values, AT)).toThrow("Choose")
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "disabled" }, AT)
    ).toEqual({ state: "disabled" })
  })

  it("preserves optional expiry and rejects an expired replacement", () => {
    const original = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    if (original.state !== "active") throw new Error("Expected active")
    const expiresAt = AT / 1_000 + 3_601
    const values = createEventMarketOrganizerFeeFormValues({
      ...original,
      expiresAt,
    })
    expect(parseEventMarketOrganizerFeeForm(values, AT)).toMatchObject({
      expiresAt,
    })
    expect(() =>
      parseEventMarketOrganizerFeeForm(values, expiresAt * 1_000)
    ).toThrow("expiry")
  })
})

describe("organizer fee shared-control presentation", () => {
  const noChange = () => undefined
  it("shows the separate fee, all accessible fields and an explicit save with phone-stacking layout", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    let actions = 0
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry
        busy={false}
        onChange={noChange}
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
      "Minimum (sats)",
      "Organizer Lightning address",
      "Expiry (UTC, optional)",
    ])
      expect(html).toContain(label)
    expect(html).toContain("Save fee settings")
    expect(html).toContain("Retry current signed settings")
    expect(html).toContain("sm:grid-cols-2")
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
        busy={false}
        onChange={noChange}
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
        busy={false}
        onChange={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("organizer@example.test")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("<button")
    expect(html).toContain("Only the authenticated organizer")
  })
})
