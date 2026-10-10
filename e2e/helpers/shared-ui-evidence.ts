import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, type TestInfo } from "@playwright/test"

/** Content-free geometry checks on the real, populated commerce compositions. */
export async function inspectCommerceUi(
  page: Page,
  info: TestInfo,
  stage: string
) {
  await page.evaluate(() => document.fonts.ready)
  const metrics = await page.evaluate(() => {
    const visible = Array.from(
      document.querySelectorAll("main *,[role=dialog] *")
    ).filter((el) => {
      const rect = el.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        getComputedStyle(el).visibility !== "hidden"
      )
    })
    return {
      width: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      fragmentedStepTitles: visible.filter(
        (el) =>
          el.getAttribute("data-slot") === "step-title" &&
          el.getBoundingClientRect().height > 48
      ).length,
      gradients: visible.filter((el) =>
        getComputedStyle(el).backgroundImage.includes("gradient")
      ).length,
      oversizedPanels: visible.filter((el) => {
        const rect = el.getBoundingClientRect(),
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius)
        return (
          ["DIV", "SECTION", "ARTICLE", "ASIDE"].includes(el.tagName) &&
          rect.width > 100 &&
          rect.height > 50 &&
          radius > (el.closest("[role=dialog]") ? 12 : 8) &&
          radius < Math.min(rect.width, rect.height) / 2
        )
      }).length,
    }
  })
  expect(metrics.content, stage).toBeLessThanOrEqual(metrics.width + 1)
  expect(metrics.fragmentedStepTitles, stage).toBe(0)
  expect(metrics.gradients, stage).toBe(0)
  expect(metrics.oversizedPanels, stage).toBe(0)
  await info.attach(`ui-${stage}`, {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  })
  const directory = process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR
  const progress = page.getByRole("list", {
    name: "Order progress",
    exact: true,
  })
  if (directory && stage === "merchant-settled" && (await progress.count())) {
    await mkdir(directory, { recursive: true })
    // Capture only generic fulfillment labels. Never capture order contents,
    // identities, invoices, balances, messages or signer/wallet material.
    await progress.screenshot({
      path: join(directory, `${info.project.name}-${stage}-progress.png`),
      animations: "disabled",
    })
    await page
      .getByRole("button", { name: "Cancel order", exact: true })
      .screenshot({
        path: join(directory, `${info.project.name}-${stage}-cancel.png`),
        animations: "disabled",
      })
  }
}
