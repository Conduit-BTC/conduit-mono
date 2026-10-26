import { expect, test } from "@playwright/test"

for (const [app, port] of [
  ["market", 7100],
  ["merchant", 7101],
] as const) {
  const origin = `http://127.0.0.1:${port}`
  test(`${app}: built route policy blocks injected execution`, async ({
    page,
  }) => {
    await page.route("https://unapproved.invalid/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: "window.__remoteExecuted = true",
      })
    )
    const response = await page.goto(`${origin}/about`)
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src"
    )
    await expect(page.locator("#root")).not.toBeEmpty()
    await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/)
    await page.evaluate(() => {
      const probe = window as typeof window & {
        __scriptViolations: number
        __baseViolations: number
      }
      probe.__scriptViolations = 0
      probe.__baseViolations = 0
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.effectiveDirective.startsWith("script-src"))
          probe.__scriptViolations++
        if (event.effectiveDirective === "base-uri") probe.__baseViolations++
      })
      const script = document.createElement("script")
      script.textContent = "window.__inlineExecuted = true"
      document.head.append(script)
      const remote = document.createElement("script")
      remote.src = "https://unapproved.invalid/payload.js"
      document.head.append(remote)
      const link = document.createElement("a")
      link.href = "javascript:window.__linkExecuted=true"
      link.textContent = "Synthetic unsafe link"
      link.id = "unsafe-probe"
      link.style.cssText =
        "position:fixed;top:0;left:0;z-index:2147483647;background:white;color:black"
      document.body.append(link)
      const base = document.createElement("base")
      base.href = "https://unapproved.invalid/"
      document.head.append(base)
    })
    await page.locator("#unsafe-probe").click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __scriptViolations: number })
              .__scriptViolations
        )
      )
      .toBeGreaterThanOrEqual(3)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __baseViolations: number })
              .__baseViolations
        )
      )
      .toBe(1)
    const outcomes = await page.evaluate(() => {
      const probe = window as typeof window & {
        __inlineExecuted?: boolean
        __remoteExecuted?: boolean
        __linkExecuted?: boolean
      }
      return {
        inline: !!probe.__inlineExecuted,
        remote: !!probe.__remoteExecuted,
        link: !!probe.__linkExecuted,
        base: document.baseURI.startsWith(location.origin),
      }
    })
    expect(outcomes).toEqual({
      inline: false,
      remote: false,
      link: false,
      base: true,
    })
  })
  test(`${app}: theme, lazy code, worker and wallet WASM remain usable`, async ({
    page,
  }) => {
    await page.goto(`${origin}/about`)
    await expect(page.locator("#root")).not.toBeEmpty()
    await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/)
    await page.addScriptTag({ url: `${origin}/__security__/capabilities.js` })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __capabilities?: Record<string, boolean>
              }
            ).__capabilities
        )
      )
      .toEqual({
        script: true,
        evalBlocked: true,
        wasm: true,
        worker: true,
        module: true,
      })
    // Both generated HTML and the SPA fallback must carry the same policy.
    const about = await page.request.get(`${origin}/about`)
    for (const path of [
      "/",
      "/products",
      "/network",
      "/privacy-policy",
      "/unknown-security-probe",
    ]) {
      const response = await page.request.get(`${origin}${path}`)
      expect(response.headers()["content-security-policy"]).toBe(
        about.headers()["content-security-policy"]
      )
      expect(response.headers()["x-content-type-options"]).toBe("nosniff")
    }
    await page.goto(`${origin}/`)
    await expect(page.locator("#root")).not.toBeEmpty()
    await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/)
  })
}
