import path from "node:path"
import { expect, test } from "@playwright/test"
import { makeSignedBolt11Fixture } from "../tests/support/signed-bolt11-fixture"
import type { CheckoutSparkExternalFundingInvoice } from "../apps/market/src/lib/checkout-spark-settled-funding"
import type { ExternalInvoicePaymentActionResult } from "../apps/market/src/components/invoice-payment-action"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const observationPrefix = "external-preparation-fixture-state:"
const sinkPath = "/external-payment-test-sink"
const moduleUrl = (file: string) =>
  `/@fs/${path.resolve(process.cwd(), file).replaceAll("\\", "/")}`

// Payment fixtures must not enter DOM failure snapshots or browser artifacts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] },
})

for (const action of ["cash_app", "lightning"] as const) {
  for (const revoke of [false, true]) {
    test(`prepared ${action} ${revoke ? "blocks revoked approval" : "uses a fresh wallet gesture"} @market`, async ({
      page,
      context,
    }) => {
      test.setTimeout(45_000)
      let stage = "mount"
      let popups = 0
      let observation: Record<string, unknown> = {}
      page.on("console", (message) => {
        const scalarSignal = message.text()
        if (!scalarSignal.startsWith(observationPrefix)) return
        try {
          const signal = JSON.parse(
            scalarSignal.slice(observationPrefix.length)
          )
          const snapshot: Record<string, unknown> = {}
          for (const key of [
            "prepareCalls",
            "automaticOpens",
            "nativeAttempts",
          ]) {
            if (!Number.isSafeInteger(signal[key]) || signal[key] < 0) return
            snapshot[key] = signal[key]
          }
          for (const key of [
            "prepared",
            "initiatingGesture",
            "gestureExpired",
            "nativeGesture",
            "exactDestination",
            "approvalCurrent",
            "rejectedGuard",
          ]) {
            if (typeof signal[key] !== "boolean") return
            snapshot[key] = signal[key]
          }
          if (
            !["", "wallet_ready", "wallet_requested", "unavailable"].includes(
              signal.result
            )
          )
            return
          observation = { ...snapshot, result: signal.result }
        } catch {
          // Unknown console data is not retained in payment test evidence.
        }
      })
      context.on("page", (opened) => {
        if (opened !== page) popups += 1
      })
      try {
        const invoice = makeSignedBolt11Fixture({
          createdAt: Math.floor(Date.now() / 1_000),
        })
        await context.route(`${marketUrl}${sinkPath}`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Local wallet handoff</title>",
          })
        )
        await page.goto(`${marketUrl}/products`)
        await page.evaluate(
          async ({
            componentUrl,
            actionUrl,
            invoice,
            action,
            observationPrefix,
            sinkPath,
          }) => {
            const React = (await import("/@id/react")).default
            const ReactDOM = (await import("/@id/react-dom/client")).default
            const { CheckoutSparkExternalFunding } = await import(componentUrl)
            const { performExternalInvoicePaymentAction } = await import(
              actionUrl
            )
            const host = document.createElement("div")
            host.id = "external-preparation-fixture"
            Object.assign(host.style, {
              position: "fixed",
              inset: "0",
              zIndex: "9999",
              overflow: "auto",
              background: "var(--surface)",
              padding: "16px",
            })
            document.body.append(host)
            const observation = {
              prepared: false,
              prepareCalls: 0,
              automaticOpens: 0,
              initiatingGesture: false,
              gestureExpired: false,
              nativeGesture: false,
              nativeAttempts: 0,
              exactDestination: false,
              approvalCurrent: true,
              rejectedGuard: false,
              result: "",
            }
            // Renderer-origin scalar observation avoids Runtime evaluation
            // while preparation is pending (Playwright can grant a gesture).
            const save = () =>
              console.debug(observationPrefix + JSON.stringify(observation))
            const nativeOpen = window.open.bind(window)
            // Observe attempted asynchronous launch without sending a fixture
            // to a real wallet. Fresh links below use the native browser instead.
            window.open = () => {
              observation.automaticOpens += 1
              save()
              return null
            }
            const fixtureWindow = window as typeof window & {
              revokeExternalFundingApproval: () => void
            }
            fixtureWindow.revokeExternalFundingApproval = () => {
              observation.approvalCurrent = false
              save()
            }
            const canUseInvoice = () => {
              if (!observation.approvalCurrent) observation.rejectedGuard = true
              save()
              return observation.approvalCurrent
            }
            document.addEventListener("click", (event) => {
              const anchor =
                event.target instanceof Element
                  ? event.target.closest("#external-preparation-fixture a")
                  : null
              if (!(anchor instanceof HTMLAnchorElement)) return
              // Run after the real React click/capture guards. Substitute only
              // the external destination, preserving native target/popup policy.
              const allowed = !event.defaultPrevented
              event.preventDefault()
              if (!allowed) return
              observation.nativeGesture = navigator.userActivation.isActive
              observation.nativeAttempts += 1
              observation.exactDestination =
                anchor.href ===
                (action === "cash_app"
                  ? `https://cash.app/launch/lightning/${invoice}`
                  : `lightning:${invoice}`)
              save()
              nativeOpen(
                `${location.origin}${sinkPath}`,
                anchor.target === "_blank" ? "_blank" : "_self",
                anchor.target === "_blank" ? "noopener,noreferrer" : undefined
              )
            })
            // Fixture props stay outside an inline page-evaluation hook wrapper;
            // the imported production component owns its real state and guards.
            const root = ReactDOM.createRoot(host)
            let reserved: CheckoutSparkExternalFundingInvoice | null = null
            let result: ExternalInvoicePaymentActionResult | undefined
            let busy = false
            async function prepare(requested: string) {
              if (requested !== action) return
              observation.prepareCalls += 1
              observation.initiatingGesture = navigator.userActivation.isActive
              busy = true
              renderFunding()
              save()
              // Controlled provider latency: wait for actual gesture expiry,
              // rather than assuming every await loses browser activation.
              const started = performance.now()
              while (
                navigator.userActivation.isActive &&
                performance.now() - started < 10_000
              )
                await new Promise((resolve) => setTimeout(resolve, 25))
              observation.gestureExpired = !navigator.userActivation.isActive
              if (!observation.gestureExpired)
                throw new Error("Gesture expiry was not observed")
              const now = Date.now()
              reserved = {
                checkoutId: "fixture",
                planDigest: "fixture",
                orderId: "fixture",
                buyerPubkey: "",
                invoice,
                amountSats: 40_000,
                exposedAt: now,
                expiresAt: now + 15 * 60_000,
                takeoverAt: now + 2 * 60_000,
              }
              renderFunding()
              const actionResult = await performExternalInvoicePaymentAction({
                action,
                invoice,
                expectedAmountSats: 40_000,
                onBeforeInvoiceUse: canUseInvoice,
              })
              result = actionResult
              busy = false
              renderFunding()
              observation.result = actionResult
              observation.prepared = true
              save()
            }
            function renderFunding() {
              root.render(
                React.createElement(CheckoutSparkExternalFunding, {
                  externalInvoice: reserved,
                  enabled: true,
                  onBeforeInvoiceUse: canUseInvoice,
                  actionResult: result,
                  preparation: {
                    amountSats: 40_000,
                    cashAppAvailable: true,
                    disabled: busy,
                    onApprove: (requested: string) => void prepare(requested),
                  },
                  preference: { currency: "BITCOIN", bitcoinUnit: "sats" },
                  quote: null,
                })
              )
            }
            renderFunding()
            save()
          },
          {
            componentUrl: moduleUrl(
              "apps/market/src/components/CheckoutSparkExternalFunding.tsx"
            ),
            actionUrl: moduleUrl(
              "apps/market/src/components/invoice-payment-action.ts"
            ),
            invoice,
            action,
            observationPrefix,
            sinkPath,
          }
        )
        const readObservation = () => observation
        const fixture = page.locator("#external-preparation-fixture")
        const label =
          action === "cash_app" ? "Pay with Cash App" : "Open Lightning wallet"
        stage = "prepare"
        await fixture.getByRole("button", { name: label, exact: true }).click()
        await expect.poll(readObservation, { timeout: 15_000 }).toMatchObject({
          prepared: true,
          prepareCalls: 1,
          automaticOpens: 0,
          initiatingGesture: true,
          gestureExpired: true,
          nativeAttempts: 0,
          result: "wallet_ready",
        })
        await expect(fixture.getByRole("status")).toHaveText(
          "Invoice ready. Choose a wallet link above to pay."
        )
        if (revoke) {
          await page.evaluate(() => {
            ;(
              window as typeof window & {
                revokeExternalFundingApproval: () => void
              }
            ).revokeExternalFundingApproval()
          })
        }
        stage = "fresh_handoff"
        await fixture.getByRole("link", { name: label, exact: true }).click()
        if (!revoke && action === "lightning")
          await page.waitForURL(`${marketUrl}${sinkPath}`)
        await expect.poll(readObservation).toMatchObject({
          prepareCalls: 1,
          automaticOpens: 0,
          nativeAttempts: revoke ? 0 : 1,
          nativeGesture: !revoke,
          exactDestination: !revoke,
          rejectedGuard: revoke,
        })
        if (!revoke && action === "cash_app")
          await expect.poll(() => popups).toBe(1)
        else expect(popups).toBe(0)
      } catch {
        // Never include invoice values, raw errors, DOM or provider data.
        throw new Error(`External preparation failed at ${stage}`)
      }
    })
  }
}
