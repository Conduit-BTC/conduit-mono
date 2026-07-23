import path from "node:path"
import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("hold-to-release supports cancellation, keyboard, and optional haptics", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  const componentUrl = `/@fs${path.resolve(
    process.cwd(),
    "packages/ui/src/components/HoldToReleaseButton.tsx"
  )}`
  await page.evaluate(async (url) => {
    const React = (await import("/@id/react")).default
    const ReactDOM = (await import("/@id/react-dom/client")).default
    const { HoldToReleaseButton } = await import(url)
    const host = document.createElement("div")
    host.id = "hold-to-release-e2e"
    Object.assign(host.style, {
      position: "fixed",
      top: "100px",
      left: "100px",
      zIndex: "9999",
    })
    document.body.append(host)
    const state = window as typeof window & {
      __holdCount: number
      __vibrations: Array<number | number[]>
      __mountCompletingHold: () => void
    }
    state.__holdCount = 0
    state.__vibrations = []
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: number | number[]) => {
        state.__vibrations.push(pattern)
        return true
      },
    })
    ReactDOM.createRoot(host).render(
      React.createElement(
        HoldToReleaseButton,
        {
          holdDurationMs: 80,
          onHoldComplete: () => {
            state.__holdCount += 1
          },
          style: { width: "220px", height: "52px" },
        },
        "Zap out"
      )
    )

    state.__mountCompletingHold = () => {
      const completionHost = document.createElement("div")
      completionHost.id = "hold-to-release-unmount-e2e"
      Object.assign(completionHost.style, {
        position: "fixed",
        top: "180px",
        left: "100px",
        zIndex: "9999",
      })
      document.body.append(completionHost)
      const root = ReactDOM.createRoot(completionHost)
      root.render(
        React.createElement(
          HoldToReleaseButton,
          {
            holdDurationMs: 80,
            onHoldComplete: () => root.unmount(),
            style: { width: "220px", height: "52px" },
          },
          "Complete and unmount"
        )
      )
    }
  }, componentUrl)

  const button = page.getByRole("button", { name: /Zap out/ })
  await expect(button).toBeVisible()
  const box = await button.boundingBox()
  expect(box).not.toBeNull()
  const center = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  }

  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.waitForTimeout(25)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__holdCount)).toBe(0)

  await page.mouse.down()
  await page.waitForTimeout(110)
  await expect(button).toHaveAttribute("data-hold-state", "charged")
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__holdCount)).toBe(1)

  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.waitForTimeout(110)
  await page.mouse.move(box!.x + box!.width + 80, center.y)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__holdCount)).toBe(1)

  await button.focus()
  await page.keyboard.down("Space")
  await page.waitForTimeout(110)
  await page.keyboard.up("Space")
  await expect.poll(() => page.evaluate(() => window.__holdCount)).toBe(2)
  await expect
    .poll(() => page.evaluate(() => window.__vibrations))
    .toContainEqual([12, 28, 30])

  await page.evaluate(() => {
    window.__vibrations = []
    window.__mountCompletingHold()
  })
  const unmountingButton = page.getByRole("button", {
    name: /Complete and unmount/,
  })
  await expect(unmountingButton).toBeVisible()
  const unmountingBox = await unmountingButton.boundingBox()
  expect(unmountingBox).not.toBeNull()
  await page.mouse.move(
    unmountingBox!.x + unmountingBox!.width / 2,
    unmountingBox!.y + unmountingBox!.height / 2
  )
  await page.mouse.down()
  await page.waitForTimeout(110)
  await expect(unmountingButton).toHaveAttribute("data-hold-state", "charged")
  await page.mouse.up()
  await expect(unmountingButton).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => window.__vibrations.at(-1)))
    .toEqual([12, 28, 30])
})

declare global {
  interface Window {
    __holdCount: number
    __vibrations: Array<number | number[]>
    __mountCompletingHold: () => void
  }
}
