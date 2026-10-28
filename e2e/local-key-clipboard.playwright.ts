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

  for (const path of ["button", "keyboard"] as const) {
    test(`${app} ${path} paste clears clipboard and signs in with a real disposable identity @${app}`, async ({
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
      if (path === "button")
        await page
          .getByRole("button", { name: "Paste secret key from clipboard" })
          .click()
      else {
        await page.getByLabel("Secret Key", { exact: true }).focus()
        await page.keyboard.press("Control+V")
      }
      await expect(
        page.getByRole("status").filter({ hasText: "Clipboard cleared." })
      ).toBeVisible()
      await expect(page.getByLabel("Secret Key", { exact: true })).toBeFocused()
      expect(
        await page.evaluate(
          async () => (await navigator.clipboard.readText()).length === 0
        )
      ).toBe(true)
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

  for (const path of ["button", "keyboard"] as const) {
    test(`${app} ${path} denied clearing preserves pasted text and warning through typing @${app}`, async ({
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
      await page.evaluate(async () => {
        await navigator.clipboard.writeText("clipboard test text")
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: async () => {
            throw new Error("Denied")
          },
        })
      })
      const input = page.getByLabel("Secret Key", { exact: true })
      if (path === "button")
        await page
          .getByRole("button", { name: "Paste secret key from clipboard" })
          .click()
      else {
        await input.focus()
        await page.keyboard.press("Control+V")
      }
      const warning = page.getByRole("status").filter({
        hasText: "Couldn’t clear your clipboard. Clear it manually.",
      })
      await expect(warning).toBeVisible()
      expect(
        await input.evaluate(
          (element: HTMLInputElement) => element.value === "clipboard test text"
        )
      ).toBe(true)
      await input.press("End")
      await input.press("x")
      await expect(warning).toBeVisible()
      await expect(
        input
          .locator("xpath=ancestor::form")
          .getByRole("button", { name: "Sign In", exact: true })
      ).toBeEnabled()
      await input
        .locator("xpath=ancestor::form")
        .getByRole("button", { name: "Sign In", exact: true })
        .click()
      // Failed import must not hide a clipboard warning that still applies.
      await expect
        .poll(() =>
          input.evaluate(
            (element: HTMLInputElement) => element.value.length === 0
          )
        )
        .toBe(true)
      await expect(warning).toBeVisible()
    })

    test(`${app} ${path} pending clear cannot block sign-in, queue writes or overwrite newer feedback @${app}`, async ({
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
      await page.evaluate(async () => {
        await navigator.clipboard.writeText("clipboard test text")
        const probe = { calls: 0, release: () => {} }
        Object.assign(window, { clipboardClearProbe: probe })
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => {
            probe.calls += 1
            return new Promise<void>((resolve) => {
              probe.release = resolve
            })
          },
        })
      })
      const input = page.getByLabel("Secret Key", { exact: true })
      if (path === "button")
        await page
          .getByRole("button", { name: "Paste secret key from clipboard" })
          .click()
      else {
        await input.focus()
        await page.keyboard.press("Control+V")
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { clipboardClearProbe: { calls: number } })
                .clipboardClearProbe.calls
          )
        )
        .toBe(1)
      await expect(
        page.getByRole("status").filter({ hasText: "Clipboard cleared." })
      ).toHaveCount(0)
      await expect(
        input
          .locator("xpath=ancestor::form")
          .getByRole("button", { name: "Sign In", exact: true })
      ).toBeEnabled()
      // A second native paste works, but does not queue a deferred cleanup.
      await input.focus()
      await page.keyboard.press("Control+V")
      const warning = page
        .getByRole("status")
        .filter({ hasText: "Couldn’t clear your clipboard." })
      await expect(warning).toBeVisible()
      await page.evaluate(async () => {
        const probe = (
          window as unknown as {
            clipboardClearProbe: { calls: number; release(): void }
          }
        ).clipboardClearProbe
        probe.release()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await expect(warning).toBeVisible()
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { clipboardClearProbe: { calls: number } })
              .clipboardClearProbe.calls
        )
      ).toBe(1)
    })
  }

  test(`${app} typing, cancelled paste and undo do not clear; accepted native paste preserves selection and undo @${app}`, async ({
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
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("clipboard test text")
    })
    const input = page.getByLabel("Secret Key", { exact: true })
    await input.fill("prefix suffix")
    expect(
      await page.evaluate(
        async () =>
          (await navigator.clipboard.readText()) === "clipboard test text"
      )
    ).toBe(true)
    await input.evaluate((element) =>
      element.addEventListener("paste", (event) => event.preventDefault(), {
        once: true,
      })
    )
    await input.focus()
    await page.keyboard.press("Control+V")
    expect(
      await page.evaluate(
        async () =>
          (await navigator.clipboard.readText()) === "clipboard test text"
      )
    ).toBe(true)
    expect(
      await input.evaluate(
        (element: HTMLInputElement) => element.value === "prefix suffix"
      )
    ).toBe(true)
    await input.evaluate((element: HTMLInputElement) =>
      element.setSelectionRange(7, 13)
    )
    await page.keyboard.press("Control+V")
    await expect(
      page.getByRole("status").filter({ hasText: "Clipboard cleared." })
    ).toBeVisible()
    expect(
      await input.evaluate(
        (element: HTMLInputElement) =>
          element.value === "prefix clipboard test text"
      )
    ).toBe(true)
    expect(
      await page.evaluate(
        async () => (await navigator.clipboard.readText()).length === 0
      )
    ).toBe(true)
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("later copy")
    })
    await page.keyboard.press("Control+Z")
    expect(
      await input.evaluate(
        (element: HTMLInputElement) => element.value === "prefix suffix"
      )
    ).toBe(true)
    expect(
      await page.evaluate(
        async () => (await navigator.clipboard.readText()) === "later copy"
      )
    ).toBe(true)
    await expect(
      page.getByRole("status").filter({ hasText: "Clipboard cleared." })
    ).toHaveCount(0, { timeout: 5_000 })
  })

  test(`${app} repeated successful pastes restart the confirmation lifetime @${app}`, async ({
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
    await page.clock.install()
    const pasted = page
      .getByRole("status")
      .filter({ hasText: "Clipboard cleared." })
    const button = page.getByRole("button", {
      name: "Paste secret key from clipboard",
    })
    await page.evaluate(() =>
      navigator.clipboard.writeText("clipboard test text")
    )
    await button.click()
    await expect(pasted).toBeVisible()
    await page.clock.fastForward(2_500)
    await page.evaluate(() =>
      navigator.clipboard.writeText("second clipboard text")
    )
    await button.click()
    await expect(pasted).toBeVisible()
    await page.clock.fastForward(600)
    await expect(pasted).toBeVisible()
    await page.clock.fastForward(2_400)
    await expect(pasted).toHaveCount(0)
  })

  test(`${app} sign-in completes while clipboard clearing remains pending @${app}`, async ({
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
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () =>
          new Promise<void>((resolve) => {
            Object.assign(window, { releaseClipboardClear: resolve })
          }),
      })
    }, fixture)
    await page
      .getByRole("button", { name: "Paste secret key from clipboard" })
      .click()
    await page
      .locator("form")
      .filter({ has: page.getByLabel("Secret Key", { exact: true }) })
      .getByRole("button", { name: "Sign In", exact: true })
      .click()
    await expect.poll(() => hasOwner(page)).toBe(true)
    await page.evaluate(async () => {
      ;(
        window as unknown as { releaseClipboardClear(): void }
      ).releaseClipboardClear()
      // Restore the native method before removing the disposable clipboard value.
      Reflect.deleteProperty(navigator.clipboard, "writeText")
      await navigator.clipboard.writeText("")
    })
    await expect(
      page.getByRole("status").filter({ hasText: "Clipboard cleared." })
    ).toHaveCount(0)
  })
}
