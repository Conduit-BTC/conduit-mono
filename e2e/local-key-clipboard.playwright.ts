import { expect, test, type Page } from "@playwright/test"

test.use({ trace: "off", screenshot: "off", video: "off" })

const protocol = `/@fs${process.cwd()}/packages/core/src/protocol`
const fixture = `/@fs${process.cwd()}/e2e/helpers/local-key-test-identity.ts`

async function hasOwner(page: Page): Promise<boolean> {
  return page.evaluate(async (root) => {
    const auth = await import(`${root}/auth-session.ts`)
    const owner = await import(`${root}/session-signer.ts`)
    return (
      auth.readAuthSession()?.type === "local" && !!owner.getAccountSigner()
    )
  }, protocol)
}

for (const app of ["market", "merchant"] as const) {
  const port =
    app === "market"
      ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
      : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
  const home = `http://127.0.0.1:${port}/${app === "market" ? "products" : ""}`

  test(`${app} one-click clipboard paste signs in with a real disposable identity @${app}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Sign In", exact: true })
        .first()
        .click()
    await page.evaluate(async (path) => {
      const helper = await import(path)
      await helper.writeTestIdentityToClipboard()
    }, fixture)
    await page
      .getByRole("button", { name: "Paste secret key from clipboard" })
      .click()
    await expect(
      page.getByRole("status").filter({ hasText: "Secret key pasted." })
    ).toBeVisible()
    expect(await hasOwner(page)).toBe(false)
    await page
      .locator("form")
      .filter({ has: page.getByLabel("Secret Key", { exact: true }) })
      .getByRole("button", { name: "Sign In", exact: true })
      .click()
    await expect.poll(() => hasOwner(page)).toBe(true)
    await page.evaluate(() => navigator.clipboard.writeText(""))
  })
}
