import path from "node:path"
import { randomBytes } from "node:crypto"
import { expect, test } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { installTestSigner } from "./helpers/auth"
import { makeSignedBolt11Fixture } from "../tests/support/signed-bolt11-fixture"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const moduleUrl = (file: string) => `/@fs${path.resolve(process.cwd(), file)}`

test("confirmed tip shows mission thank-you once, without a real payment @market", async ({
  page,
}) => {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc1110n",
    createdAt: Math.floor(Date.now() / 1_000),
  })
  await page.goto(`${marketUrl}/about`)
  await page.evaluate(
    async ({ componentUrl, invoice }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { ProjectTip } = await import(componentUrl)
      const host = document.createElement("div")
      host.id = "project-tip-fixture"
      host.style.position = "fixed"
      host.style.top = "20px"
      host.style.left = "20px"
      host.style.zIndex = "40"
      document.body.append(host)
      const state = window as typeof window & {
        __projectTipTest?: { prepared: number; paid: number }
      }
      state.__projectTipTest = { prepared: 0, paid: 0 }
      ReactDOM.createRoot(host).render(
        React.createElement(ProjectTip, {
          prepare: async (amountSats: number) => {
            state.__projectTipTest!.prepared += 1
            return {
              invoice,
              zapRequestId: "a".repeat(64),
              requestCreatedAt: Math.floor(Date.now() / 1_000),
              amountMsats: amountSats * 1_000,
              lnurl: "lnurl1test",
              lnurlNostrPubkey: "b".repeat(64),
              relayUrls: ["wss://relay.conduit.market"],
            }
          },
          payInvoice: async () => {
            state.__projectTipTest!.paid += 1
            return { status: "paid" as const }
          },
          rateQuote: {
            rate: 84_000,
            fetchedAt: Date.now(),
            source: "env" as const,
          },
        })
      )
    },
    {
      componentUrl: moduleUrl("packages/ui/src/components/ProjectTip.tsx"),
      invoice,
    }
  )
  await page
    .locator("#project-tip-fixture")
    .getByRole("button", { name: "Leave a Tip" })
    .click()
  const dialog = page.getByRole("dialog", { name: "Leave a tip" })
  await expect(
    dialog.getByRole("button", { name: /111 sats.*\$0\.09/ })
  ).toBeVisible()
  await expect(
    dialog.getByRole("spinbutton", { name: "Custom amount (sats)" })
  ).toBeHidden()
  await dialog.getByRole("button", { name: "Choose another amount" }).click()
  await dialog
    .getByRole("spinbutton", { name: "Custom amount (sats)" })
    .fill("99")
  await expect(dialog.getByRole("button", { name: "Send tip" })).toBeDisabled()
  await dialog.getByRole("button", { name: "Use a preset amount" }).click()
  await dialog.getByRole("button", { name: "Send 111 sats" }).click()
  await expect(dialog).toContainText(
    "Thank you for supporting our mission to build a more open market."
  )
  await expect(dialog).toContainText("independent merchants and shoppers")
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __projectTipTest?: { prepared: number; paid: number }
          }
        ).__projectTipTest
    )
  ).toEqual({ prepared: 1, paid: 1 })
})

test("narrow tip presets stay readable and stale USD estimates can recover @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(`${marketUrl}/about`)
  await page.evaluate(async (componentUrl) => {
    const React = (await import("/@id/react")).default
    const ReactDOM = (await import("/@id/react-dom/client")).default
    const { ProjectTip } = await import(componentUrl)
    const host = document.createElement("div")
    host.id = "project-tip-rate-fixture"
    host.style.position = "fixed"
    host.style.top = "20px"
    host.style.left = "20px"
    host.style.zIndex = "40"
    document.body.append(host)
    const root = ReactDOM.createRoot(host)
    const state = window as typeof window & {
      __projectTipRate?: { refreshes: number }
    }
    state.__projectTipRate = { refreshes: 0 }
    let rateQuote = {
      rate: 84_000,
      fetchedAt: Date.now() - 6 * 60_000,
      source: "mempool" as const,
    }
    function render() {
      root.render(
        React.createElement(ProjectTip, {
          prepare: async () => {
            throw new Error("No payment is made in this test.")
          },
          rateQuote,
          onRefreshRate: () => {
            state.__projectTipRate!.refreshes += 1
            rateQuote = { ...rateQuote, fetchedAt: Date.now() }
            render()
          },
        })
      )
    }
    render()
  }, moduleUrl("packages/ui/src/components/ProjectTip.tsx"))
  await page
    .locator("#project-tip-rate-fixture")
    .getByRole("button", { name: "Leave a Tip" })
    .click()
  const dialog = page.getByRole("dialog", { name: "Leave a tip" })
  await expect(dialog).toContainText("USD estimate unavailable")
  const amounts = ["111 sats", "1,111 sats", "11,111 sats"]
  const mobileBoxes = await Promise.all(
    amounts.map((amount) =>
      dialog.getByRole("button", { name: amount, exact: true }).boundingBox()
    )
  )
  expect(mobileBoxes.every((box) => box && box.height <= 52)).toBe(true)
  expect(mobileBoxes[0]!.y).toBeLessThan(mobileBoxes[1]!.y)
  expect(mobileBoxes[1]!.y).toBeLessThan(mobileBoxes[2]!.y)
  await dialog.getByRole("button", { name: "Retry" }).click()
  await expect(
    dialog.getByRole("button", { name: /111 sats.*\$0\.09/ })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __projectTipRate?: { refreshes: number } })
          .__projectTipRate?.refreshes
    )
  ).toBe(1)

  await page.setViewportSize({ width: 720, height: 700 })
  const desktopBoxes = await Promise.all(
    amounts.map((amount) =>
      dialog
        .getByRole("button", { name: new RegExp(`^${amount}`) })
        .boundingBox()
    )
  )
  expect(desktopBoxes[0]!.x).toBeLessThan(desktopBoxes[1]!.x)
  expect(desktopBoxes[1]!.x).toBeLessThan(desktopBoxes[2]!.x)
  expect(Math.abs(desktopBoxes[0]!.y - desktopBoxes[1]!.y)).toBeLessThan(2)
})

test("closing during preparation permits a new tip and ignores stale completion @market", async ({
  page,
}) => {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc1110n",
    createdAt: Math.floor(Date.now() / 1_000),
  })
  await page.goto(`${marketUrl}/about`)
  await page.evaluate(
    async ({ componentUrl, invoice }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { ProjectTip } = await import(componentUrl)
      const host = document.createElement("div")
      host.id = "project-tip-interrupted-fixture"
      host.style.position = "fixed"
      host.style.top = "20px"
      host.style.left = "20px"
      host.style.zIndex = "40"
      document.body.append(host)
      const state = window as typeof window & {
        __projectTipInterrupted?: {
          pending: Array<() => void>
          confirm: (id: string) => void
          confirmedId: string | null
          watchedId: string | null
        }
      }
      state.__projectTipInterrupted = {
        pending: [],
        confirm: () => {},
        confirmedId: null,
        watchedId: null,
      }
      const root = ReactDOM.createRoot(host)
      const prepare = (amountSats: number) =>
        new Promise((resolve) => {
          const attempt = state.__projectTipInterrupted!.pending.length + 1
          state.__projectTipInterrupted!.pending.push(() =>
            resolve({
              invoice,
              zapRequestId: "a".repeat(63) + attempt,
              requestCreatedAt: Math.floor(Date.now() / 1_000),
              amountMsats: amountSats * 1_000,
              lnurl: "lnurl1test",
              lnurlNostrPubkey: "b".repeat(64),
              relayUrls: ["wss://relay.conduit.market"],
            })
          )
        })
      const onReceiptWatchChange = (tip: { zapRequestId: string } | null) => {
        state.__projectTipInterrupted!.watchedId = tip?.zapRequestId ?? null
      }
      function render() {
        root.render(
          React.createElement(ProjectTip, {
            prepare,
            onReceiptWatchChange,
            confirmedZapRequestId: state.__projectTipInterrupted!.confirmedId,
          })
        )
      }
      state.__projectTipInterrupted.confirm = (id) => {
        state.__projectTipInterrupted!.confirmedId = id
        render()
      }
      render()
    },
    {
      componentUrl: moduleUrl("packages/ui/src/components/ProjectTip.tsx"),
      invoice,
    }
  )
  const trigger = page
    .locator("#project-tip-interrupted-fixture")
    .getByRole("button", { name: "Leave a Tip" })
  await trigger.click()
  let dialog = page.getByRole("dialog", { name: "Leave a tip" })
  await dialog.getByRole("button", { name: "Send 111 sats" }).click()
  await expect(dialog).toContainText("Preparing your zap invoice")
  await dialog.getByRole("button", { name: "Close" }).click()
  await trigger.click()
  dialog = page.getByRole("dialog", { name: "Leave a tip" })
  await expect(
    dialog.getByRole("button", { name: "Send 111 sats" })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Send 111 sats" }).click()
  await page.evaluate(() => {
    ;(
      window as typeof window & {
        __projectTipInterrupted: { pending: Array<() => void> }
      }
    ).__projectTipInterrupted.pending[0]()
  })
  await expect(dialog).toContainText("Preparing your zap invoice")
  await page.evaluate(() => {
    ;(
      window as typeof window & {
        __projectTipInterrupted: { pending: Array<() => void> }
      }
    ).__projectTipInterrupted.pending[1]()
  })
  await expect(
    dialog.getByRole("button", { name: "Copy invoice" })
  ).toBeVisible()
  await page.evaluate(() => {
    ;(
      window as typeof window & {
        __projectTipInterrupted: { confirm: (id: string) => void }
      }
    ).__projectTipInterrupted.confirm("a".repeat(63) + "1")
  })
  await expect(dialog).not.toContainText("Thank you for supporting")
  await page.evaluate(() => {
    ;(
      window as typeof window & {
        __projectTipInterrupted: { confirm: (id: string) => void }
      }
    ).__projectTipInterrupted.confirm("a".repeat(63) + "2")
  })
  await expect(dialog).toContainText("Thank you for supporting")
})

for (const mode of ["refusal", "prepublish", "timeout"] as const) {
  test(`Merchant ${mode} tip payment exposes only safe actions @merchant`, async ({
    page,
  }) => {
    const secretKey = generateSecretKey()
    await installTestSigner(page, getPublicKey(secretKey), { secretKey })
    const connectionSecret = randomBytes(32).toString("hex")
    const invoice = makeSignedBolt11Fixture({
      hrp: "lnbc1110n",
      createdAt: Math.floor(Date.now() / 1_000),
    })
    await page.goto(merchantUrl)
    await page.evaluate(
      async ({ componentUrl, paymentUrl, invoice, mode, connectionSecret }) => {
        const React = (await import("/@id/react")).default
        const ReactDOM = (await import("/@id/react-dom/client")).default
        const { ProjectTip } = await import(componentUrl)
        const { classifyMerchantTipPaymentError } = await import(paymentUrl)
        const host = document.createElement("div")
        host.id = "merchant-tip-payment-fixture"
        host.style.position = "fixed"
        host.style.top = "20px"
        host.style.left = "20px"
        host.style.zIndex = "40"
        document.body.append(host)
        ReactDOM.createRoot(host).render(
          React.createElement(ProjectTip, {
            prepare: async (amountSats: number) => ({
              invoice,
              zapRequestId: "a".repeat(64),
              requestCreatedAt: Math.floor(Date.now() / 1_000),
              amountMsats: amountSats * 1_000,
              lnurl: "lnurl1test",
              lnurlNostrPubkey: "b".repeat(64),
              relayUrls: ["wss://relay.conduit.market"],
            }),
            payInvoice: async () => {
              const error =
                mode === "refusal"
                  ? Object.assign(new Error("Insufficient balance"), {
                      code: "INSUFFICIENT_BALANCE",
                    })
                  : mode === "prepublish"
                    ? new Error("Failed to connect to NWC relay(s)")
                    : new Error("NWC request timed out")
              return classifyMerchantTipPaymentError(error, {
                walletPubkey: "a".repeat(64),
                secret: connectionSecret,
                relays: ["wss://relay.example"],
              })
            },
          })
        )
      },
      {
        componentUrl: moduleUrl("packages/ui/src/components/ProjectTip.tsx"),
        paymentUrl: moduleUrl("apps/merchant/src/lib/project-tip-payment.ts"),
        invoice,
        mode,
        connectionSecret,
      }
    )
    await page
      .locator("#merchant-tip-payment-fixture")
      .getByRole("button", { name: "Leave a Tip" })
      .click()
    const dialog = page.getByRole("dialog", { name: "Leave a tip" })
    await dialog.getByRole("button", { name: "Send 111 sats" }).click()
    if (mode === "timeout") {
      await expect(
        dialog.getByRole("button", { name: "Copy invoice" })
      ).toHaveCount(0)
      await expect(dialog).toContainText("Check your wallet before trying")
    } else {
      await expect(
        dialog.getByRole("button", { name: "Copy invoice" })
      ).toBeVisible()
      await expect(
        dialog.getByRole("link", { name: "Open Lightning wallet" })
      ).toBeVisible()
    }
  })
}

for (const viewport of [
  { width: 1280, height: 800, label: "sidebar" },
  { width: 390, height: 844, label: "mobile menu" },
] as const) {
  test(`merchant ${viewport.label} opens the shared tip dialog @merchant`, async ({
    page,
  }) => {
    const secretKey = generateSecretKey()
    await installTestSigner(page, getPublicKey(secretKey), { secretKey })
    await page.setViewportSize(viewport)
    await page.goto(merchantUrl)
    if (viewport.label === "mobile menu") {
      await page.getByRole("button", { name: "Open menu" }).click()
    }
    const navigation = page.locator("[data-merchant-navigation-panel]:visible")
    const tip = navigation.getByRole("button", { name: "Leave a Tip" })
    await expect(tip).toBeVisible()
    await tip.click()
    const dialog = page.getByRole("dialog", { name: "Leave a tip" })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: /^111 sats/ })
    ).toBeVisible()
    await expect(dialog).not.toContainText("Anon Conduit Shopper")
    await dialog.getByRole("button", { name: "Close" }).click()
    await expect(dialog).toHaveCount(0)
  })
}
