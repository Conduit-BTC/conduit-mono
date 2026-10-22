import { expect, test } from "@playwright/test"

// This workbench suite uses only fictional presentation data. It has no app
// session, signer, relay, payment provider, or account-storage boundary.
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`page timeline preserves earlier and back anchors at ${viewport.width}px in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (url.hostname === "127.0.0.1") await route.continue()
        else await route.abort()
      })
      await page.goto("/")
      if (viewport.width < 640) {
        await page.getByRole("combobox", { name: "Reference section" }).click()
        await page.getByRole("option", { name: "Event / inventory" }).click()
      } else {
        await page.getByRole("tab", { name: "Event / inventory" }).click()
      }
      const timeline = page.getByRole("region", {
        name: "Chronological events",
      })
      const now = timeline.getByRole("separator", { name: "Now" })
      await expect(timeline).toBeVisible()
      await expect(timeline).not.toHaveAttribute("tabindex")
      expect(
        await timeline.evaluate((node) => getComputedStyle(node).overflowY)
      ).toBe("visible")
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(0)
      await expect
        .poll(() =>
          now.evaluate((node) => {
            const root = document.scrollingElement!
            const inset = Number.parseFloat(
              getComputedStyle(node).scrollMarginTop
            )
            // A short phone-width list can reach the end of the document
            // before Now reaches its inset. Check the browser's real clamp.
            const expected = Math.min(
              root.scrollHeight - root.clientHeight,
              window.scrollY + node.getBoundingClientRect().top - inset
            )
            return Math.abs(window.scrollY - expected)
          })
        )
        .toBeLessThan(2)
      expect(
        await now.evaluate((node) => node.getBoundingClientRect().top)
      ).toBeGreaterThanOrEqual(0)

      // Real page scroll, not an inner list. A local detail remounts the same
      // shared hook used by the apps without copying route or discovery logic.
      const future = timeline.getByRole("button", {
        name: /^Open Sunday community market\./,
      })
      await future.scrollIntoViewIfNeeded()
      const returnPosition = await page.evaluate(() => window.scrollY)
      expect(returnPosition).toBeGreaterThan(0)
      expect(await timeline.evaluate((node) => node.scrollTop)).toBe(0)
      await future.click()
      await expect(timeline).toHaveCount(0)
      await page
        .getByRole("button", { name: "Back to sample timeline" })
        .click()
      await expect
        .poll(async () =>
          Math.abs((await page.evaluate(() => window.scrollY)) - returnPosition)
        )
        .toBeLessThan(2)

      const earlier = timeline.getByRole("button", {
        name: "Load 2 earlier events",
      })
      await earlier.scrollIntoViewIfNeeded()
      const anchorBefore = await now.evaluate(
        (node) => node.getBoundingClientRect().top
      )
      await earlier.click()
      await expect(
        timeline
          .getByRole("list", { name: "Past events", exact: true })
          .getByRole("listitem")
      ).toHaveCount(3)
      await expect
        .poll(async () =>
          Math.abs(
            (await now.evaluate((node) => node.getBoundingClientRect().top)) -
              anchorBefore
          )
        )
        .toBeLessThan(2)
      await timeline
        .getByRole("button", { name: "Load 2 later events" })
        .click()
      await expect(
        timeline
          .getByRole("list", { name: "Current and upcoming events" })
          .getByRole("listitem")
      ).toHaveCount(4)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true)
    })
  }
}
