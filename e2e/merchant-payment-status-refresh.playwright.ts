import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import type { CheckoutSparkMerchantPaymentCard as MerchantPaymentCard } from "../apps/merchant/src/components/CheckoutSparkMerchantPaymentCard"
import { installHermeticCommerceNetwork } from "./helpers/hermetic-network"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

test("saved Merchant payment status stays stable across background refreshes @merchant", async ({
  browser,
}) => {
  const relayPort = process.env.PLAYWRIGHT_RELAY_PORT
  if (!relayPort || relayPort === "0") {
    throw new Error("Isolated payment presentation requires its local relay.")
  }
  const context = await browser.newContext({ serviceWorkers: "block" })
  let beginTeardown: () => void = () => undefined
  let stage = "isolated presentation setup"
  try {
    beginTeardown = await installHermeticCommerceNetwork(context, {
      appUrls: [marketUrl, merchantUrl],
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      imageUrl: "https://payment-presentation.invalid/fixture.svg",
    })
    const page = await context.newPage()
    // Legal startup bypasses account restoration and payment automation. This
    // isolated fixture mounts only the real presentation component, no wallet.
    await page.goto(`${merchantUrl}/privacy-policy`)
    stage = "mounted refresh sequence"
    const states = await page.evaluate(async () => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const cardModuleUrl =
        "/src/components/CheckoutSparkMerchantPaymentCard.tsx"
      const { CheckoutSparkMerchantPaymentCard } = await import(cardModuleUrl)
      const host = document.createElement("div")
      host.id = "merchant-payment-status-refresh-fixture"
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      const base = {
        projection: null,
        checking: false,
        paused: false,
        canContinue: false,
        transitioning: false,
        handoffAt: 1_800_000_180_000,
        nowMs: 1_800_000_200_000,
        onRetry() {},
        onPause() {},
        onContinue() {},
      }
      const verified = {
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: true,
        feePending: false,
        recipientUnverified: false,
      }
      type CardProps = Parameters<typeof MerchantPaymentCard>[0]
      let revision = 0
      const read = () => {
        const text = host.textContent ?? ""
        const heading = host.querySelector("h2")?.textContent
        const details = host.querySelector("details")
        const buttons = Array.from(host.querySelectorAll("button"))
        const reviewButton = buttons.find(
          (button) => button.textContent === "Review saved payout"
        )
        return {
          verified: heading === "Payment verified",
          attention: heading === "Payment needs attention",
          checking: heading === "Checking payment",
          feeAttention: text.includes("The coordination fee needs attention"),
          refreshing: text.includes("Refreshing saved payment status…"),
          checkingParagraph: text.includes("Checking this order's payment…"),
          unavailable: text.includes(
            "Saved payment status is temporarily unavailable"
          ),
          fulfillment: text.includes("Continue with fulfillment"),
          paused: text.includes("Automatic payments are paused"),
          transitioning: text.includes(
            "Waiting for the current operation to finish safely"
          ),
          detailsPresent: details !== null,
          detailsOpen: details?.open === true,
          reviewPresent: reviewButton !== undefined,
          reviewVisible: reviewButton?.checkVisibility() ?? false,
          retryPresent: buttons.some(
            (button) =>
              button.textContent === "Check coordination fee again" ||
              button.textContent === "Check payment again"
          ),
        }
      }
      type Snapshot = ReturnType<typeof read>
      const render = (props: CardProps) =>
        new Promise<Snapshot>((resolve, reject) => {
          const committedRevision = String(revision++)
          const observer = new MutationObserver(() => {
            if (
              host.firstElementChild?.getAttribute("data-fixture-commit") !==
              committedRevision
            ) {
              return
            }
            observer.disconnect()
            clearTimeout(timer)
            resolve(read())
          })
          observer.observe(host, {
            attributes: true,
            childList: true,
            subtree: true,
          })
          const timer = setTimeout(() => {
            observer.disconnect()
            reject(new Error("Isolated card commit did not finish."))
          }, 3_000)
          root.render(
            React.createElement(
              "div",
              { "data-fixture-commit": committedRevision },
              React.createElement(CheckoutSparkMerchantPaymentCard, props)
            )
          )
        })
      try {
        const initial = await render({ ...base, checking: true })
        const unavailable = await render({
          ...base,
          projection: verified,
          settlementReadUnavailable: true,
        })
        const cycles: Array<{
          kind: "verified" | "fee_attention" | "outcome_attention"
          snapshots: Snapshot[]
        }> = []
        for (const kind of [
          "verified",
          "fee_attention",
          "outcome_attention",
        ] as const) {
          const props: CardProps = {
            ...base,
            projection:
              kind === "outcome_attention"
                ? null
                : {
                    ...verified,
                    recipientUnverified: kind === "fee_attention",
                  },
            ...(kind !== "verified"
              ? { outcome: "recipient_unverified" as const }
              : {}),
          }
          const snapshots: Snapshot[] = []
          for (let cycle = 0; cycle < 3; cycle += 1) {
            for (const refreshing of [false, true, false]) {
              snapshots.push(
                await render({
                  ...props,
                  checking: refreshing,
                  settlementRefreshing: refreshing,
                })
              )
            }
          }
          cycles.push({ kind, snapshots })
        }
        const changed = await render({
          ...base,
          projection: verified,
          checking: true,
          settlementRefreshing: true,
        })
        const paused = await render({
          ...base,
          outcome: "recipient_unverified",
          checking: true,
          settlementRefreshing: true,
          paused: true,
        })
        const transitioning = await render({
          ...base,
          outcome: "recipient_unverified",
          checking: true,
          settlementRefreshing: true,
          transitioning: true,
        })
        const reviewChild = React.createElement(
          "button",
          { type: "button" },
          "Review saved payout"
        )
        const activePendingFee = await render({
          ...base,
          projection: { ...verified, feePending: true },
          children: reviewChild,
        })
        const settledPaused = await render({
          ...base,
          projection: verified,
          paused: true,
          children: reviewChild,
        })
        const pausedPendingFee = await render({
          ...base,
          projection: { ...verified, feePending: true },
          paused: true,
          children: reviewChild,
        })
        host.querySelector<HTMLElement>("details summary")?.click()
        const expandedPausedFee = read()
        const empty = await render({
          ...base,
          checking: true,
          settlementRefreshing: true,
        })
        return {
          initial,
          unavailable,
          cycles,
          changed,
          paused,
          transitioning,
          activePendingFee,
          settledPaused,
          pausedPendingFee,
          expandedPausedFee,
          empty,
        }
      } finally {
        root.unmount()
        host.remove()
      }
    })
    const observationsPath = test
      .info()
      .outputPath("payment-presentation-observations.json")
    await mkdir(path.dirname(observationsPath), { recursive: true })
    await writeFile(observationsPath, JSON.stringify(states), { mode: 0o600 })
    await test.info().attach("payment-presentation-observations", {
      path: observationsPath,
      contentType: "application/json",
    })
    stage = "first-load feedback retained"
    expect(states.initial.checking).toBe(true)
    expect(states.initial.checkingParagraph).toBe(true)
    stage = "real availability warning retained"
    expect(states.unavailable.verified).toBe(true)
    expect(states.unavailable.unavailable).toBe(true)
    for (const cycle of states.cycles) {
      stage = `stable ${cycle.kind} background refresh`
      expect(cycle.snapshots).toHaveLength(9)
      for (const snapshot of cycle.snapshots) {
        expect(snapshot.verified).toBe(cycle.kind !== "outcome_attention")
        expect(snapshot.attention).toBe(cycle.kind === "outcome_attention")
        expect(snapshot.feeAttention).toBe(cycle.kind === "fee_attention")
        expect(snapshot.fulfillment).toBe(cycle.kind !== "outcome_attention")
        expect(snapshot.refreshing).toBe(false)
        expect(snapshot.checkingParagraph).toBe(false)
      }
    }
    stage = "new result replaces attention"
    expect(states.changed.verified).toBe(true)
    expect(states.changed.attention).toBe(false)
    expect(states.changed.feeAttention).toBe(false)
    expect(states.changed.refreshing).toBe(false)
    stage = "explicit pause feedback retained"
    expect(states.paused.attention).toBe(true)
    expect(states.paused.paused).toBe(true)
    expect(states.paused.checkingParagraph).toBe(false)
    stage = "explicit transition feedback retained"
    expect(states.transitioning.attention).toBe(true)
    expect(states.transitioning.transitioning).toBe(true)
    expect(states.transitioning.checkingParagraph).toBe(false)
    stage = "ordinary pending fee details remain hidden"
    expect(states.activePendingFee.verified).toBe(true)
    expect(states.activePendingFee.detailsPresent).toBe(false)
    expect(states.activePendingFee.reviewPresent).toBe(false)
    expect(states.activePendingFee.retryPresent).toBe(false)
    stage = "settled paused payment details remain hidden"
    expect(states.settledPaused.verified).toBe(true)
    expect(states.settledPaused.detailsPresent).toBe(false)
    expect(states.settledPaused.reviewPresent).toBe(false)
    expect(states.settledPaused.retryPresent).toBe(false)
    stage = "paused fee saved review is available collapsed"
    expect(states.pausedPendingFee.verified).toBe(true)
    expect(states.pausedPendingFee.fulfillment).toBe(true)
    expect(states.pausedPendingFee.detailsPresent).toBe(true)
    expect(states.pausedPendingFee.detailsOpen).toBe(false)
    expect(states.pausedPendingFee.reviewPresent).toBe(true)
    expect(states.pausedPendingFee.reviewVisible).toBe(false)
    expect(states.pausedPendingFee.retryPresent).toBe(false)
    stage = "paused fee saved review expands without retry"
    expect(states.expandedPausedFee.detailsOpen).toBe(true)
    expect(states.expandedPausedFee.reviewVisible).toBe(true)
    expect(states.expandedPausedFee.retryPresent).toBe(false)
    stage = "empty order feedback restored"
    expect(states.empty.checking).toBe(true)
    expect(states.empty.checkingParagraph).toBe(true)
    expect(states.empty.refreshing).toBe(true)
    expect(states.empty.verified).toBe(false)
    expect(states.empty.attention).toBe(false)
  } catch {
    // No DOM, console, provider errors, or application payloads in evidence.
    const stagePath = test.info().outputPath("payment-presentation-stage.txt")
    await mkdir(path.dirname(stagePath), { recursive: true })
    await writeFile(stagePath, JSON.stringify({ stage }), { mode: 0o600 })
    await test.info().attach("payment-presentation-stage", {
      path: stagePath,
      contentType: "text/plain",
    })
    throw new Error(`Merchant payment presentation failed: ${stage}.`)
  } finally {
    beginTeardown()
    await context.unrouteAll({ behavior: "wait" })
    await context.close()
  }
})
