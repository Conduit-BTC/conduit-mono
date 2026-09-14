import { expect, test } from "@playwright/test"

const marketPort = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
const marketUrl = `http://127.0.0.1:${marketPort}`
const harnessUrl =
  "/src/test-fixtures/guest-checkout-payment-journey-harness.tsx"

test("guest payment prototype renders review, recovery, settlement, and retirement states @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/privacy-policy`)

  await page.evaluate(async (fixtureUrl) => {
    const container = document.createElement("div")
    container.id = "guest-checkout-payment-journey-fixture"
    document.body.replaceChildren(container)
    const { mountGuestCheckoutPaymentJourneyHarness } = (await import(
      fixtureUrl
    )) as {
      mountGuestCheckoutPaymentJourneyHarness: (
        element: HTMLElement
      ) => () => void
    }
    mountGuestCheckoutPaymentJourneyHarness(container)
  }, harnessUrl)

  const harness = page.getByTestId("guest-checkout-payment-journey-harness")
  const journey = page.getByTestId("guest-checkout-payment-journey")
  const state = page.getByTestId("guest-checkout-payment-journey-harness-state")

  await expect(harness).toBeVisible()
  await expect(state).toHaveText("authorization")
  await expect(journey).toHaveAttribute("data-journey-state", "authorization")
  await expect(
    journey.getByRole("heading", { name: "Purchase plan for approval" })
  ).toBeVisible()
  await expect(journey.getByText("Maximum debit")).toBeVisible()
  await expect(journey.getByText("1,150 sats").first()).toBeVisible()
  await expect(
    journey
      .getByLabel("Synthetic purchase recipient authorities")
      .getByText("fixture-recipient:olive-grove-v1")
  ).toBeVisible()
  await expect(journey.getByText("Synthetic final settlement")).toHaveCount(0)

  const recoveryAction = journey.getByRole("button", {
    name: "Save recovery receipt (proposed)",
  })
  await expect(recoveryAction).toBeDisabled()
  await expect(journey.locator("form")).toHaveCount(0)
  await expect(journey.locator("a[download]")).toHaveCount(0)

  await harness.getByRole("button", { name: "Approved, not funded" }).click()
  await expect(state).toHaveText("approved")
  await expect(journey).toHaveAttribute("data-journey-state", "approved")
  await expect(
    journey.getByRole("heading", { name: "Frozen purchase authorization" })
  ).toBeVisible()
  await expect(journey.getByText("Not funded").first()).toBeVisible()

  await harness.getByRole("button", { name: "Funding received" }).click()
  await expect(state).toHaveText("funded")
  await expect(journey.getByTestId("merchant-completion-summary")).toHaveText(
    "0 of 2 merchant payments complete"
  )
  await expect(recoveryAction).toHaveCount(0)

  await harness.getByRole("button", { name: "One payment left" }).click()
  await expect(state).toHaveText("remaining_leg")
  await expect(journey.getByTestId("merchant-completion-summary")).toHaveText(
    "1 of 2 merchant payments complete"
  )
  await expect(journey.getByText("One payment remains")).toBeVisible()
  await expect(journey.getByText("510 sats")).toBeVisible()

  await harness.getByRole("button", { name: "Recovery needed" }).click()
  await expect(state).toHaveText("recovery_needed")
  await expect(journey.getByRole("alert")).toContainText(
    "Automatic retry stays unavailable"
  )
  await expect(
    journey.getByText("Prepared before funding (fixture)")
  ).toBeVisible()
  await expect(recoveryAction).toHaveCount(0)

  await harness.getByRole("button", { name: "Final settlement" }).click()
  await expect(state).toHaveText("settlement")
  await expect(journey).toHaveAttribute("data-journey-state", "settlement")
  await expect(journey.getByTestId("merchant-completion-summary")).toHaveText(
    "2 of 2 merchant payments complete"
  )
  await expect(journey.getByText("150 sats", { exact: true })).toBeVisible()
  await expect(journey.getByText("30 sats (example)")).toBeVisible()
  await expect(journey.getByText("20 sats (example)")).toBeVisible()
  await expect(journey.getByText("Synthetic final settlement")).toBeVisible()

  await harness.getByRole("button", { name: "Retired" }).click()
  await expect(state).toHaveText("retired")
  await expect(
    journey.getByRole("heading", { name: "Purchase wallet retired" })
  ).toBeVisible()
  await expect(recoveryAction).toHaveCount(0)
  await expect(
    journey.getByText("2 of 2 merchant payments complete")
  ).toBeVisible()
  await expect(journey.getByText("Fresh incoming balance")).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(harness).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true)
})
