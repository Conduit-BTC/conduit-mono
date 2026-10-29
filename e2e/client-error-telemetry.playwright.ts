import { isDeepStrictEqual } from "node:util"

import { expect, test, type Page } from "@playwright/test"

import { TEST_MERCHANT_PUBKEY, installTestSigner } from "./helpers/auth"

type TelemetryProperties = Record<string, string | boolean>

type CapturedTelemetryEvent = {
  eventName: string
  properties: TelemetryProperties
  url?: string
}

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

function hasSameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

const appCases = [
  {
    app: "market",
    appName: "Conduit Market",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`,
  },
  {
    app: "merchant",
    appName: "Conduit Merchant Portal",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`,
  },
] as const

const hostileBoundaryCases = [
  "react_error_boundary_proxy_prototype",
  "react_error_boundary_proxy_message",
] as const

async function readClientErrorEvents(
  page: Page
): Promise<CapturedTelemetryEvent[]> {
  return page.evaluate(() => {
    const plausible = (
      window as unknown as {
        plausible?: { q?: unknown[] }
      }
    ).plausible

    return (plausible?.q ?? []).flatMap((entry) => {
      const [eventName, options] = entry as [
        string,
        { props?: Record<string, string | boolean>; url?: string } | undefined,
      ]
      if (eventName !== "client_error_result" || !options?.props) return []
      return [
        {
          eventName,
          properties: options.props,
          url: options.url,
        },
      ]
    })
  })
}

async function waitForClientEffects(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

async function dispatchRuntimeErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("private product title must not escape"),
        message: "private product title must not escape",
      })
    )

    const rejection = new Event("unhandledrejection") as Event & {
      reason: unknown
    }
    rejection.reason = new ReferenceError(
      "private payment detail must not escape"
    )
    window.dispatchEvent(rejection)
  })
}

test("merchant authenticated route errors retain account recovery actions @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)

  const openErrorMenu = async () => {
    await page.goto(
      `${merchantUrl}/products?__conduit_telemetry_test=react_error_boundary`
    )
    await expect(
      page.getByRole("heading", { name: "Something went wrong" })
    ).toBeVisible()
    const menuTrigger = page.getByRole("button", {
      name: "Open merchant account menu",
    })
    await expect(menuTrigger).toBeVisible({ timeout: 15_000 })
    await menuTrigger.click()
    return page.getByRole("menu")
  }

  let menu = await openErrorMenu()
  await menu.getByRole("menuitem", { name: "Profile" }).click()
  await expect(page).toHaveURL(`${merchantUrl}/profile`)
  await expect(
    page.getByRole("heading", { name: "Store Profile", exact: true })
  ).toBeVisible()

  menu = await openErrorMenu()
  await menu.getByRole("menuitem", { name: "Network" }).click()
  await expect(page).toHaveURL(`${merchantUrl}/network`)
  await expect(
    page.getByRole("heading", { name: "Network", exact: true })
  ).toBeVisible()

  menu = await openErrorMenu()
  await menu.getByRole("menuitem", { name: "Disconnect" }).click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")))
    .toBeNull()
  await page.goto(merchantUrl)
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit" })
  ).toBeVisible()
})

for (const { app, appName, url } of appCases) {
  for (const hostileCase of hostileBoundaryCases) {
    test(`${app} route boundary safely handles ${hostileCase} @${app}`, async ({
      page,
    }) => {
      const pathname = app === "merchant" ? "/products" : "/about"
      if (app === "merchant") {
        await installTestSigner(page, TEST_MERCHANT_PUBKEY)
      }
      await page.goto(
        `${url}${pathname}?__conduit_telemetry_test=${hostileCase}&secret=private-proxy-token`
      )

      await expect(
        page.getByRole("heading", { name: "Something went wrong" })
      ).toBeVisible()
      await expect(
        page.getByText("An unexpected error occurred.")
      ).toBeVisible()
      await expect
        .poll(async () => (await readClientErrorEvents(page)).length)
        .toBe(1)

      const boundaryEvents = await readClientErrorEvents(page)
      expect(boundaryEvents[0]?.properties.event_family).toBe("non_error")
      expect(JSON.stringify(boundaryEvents).includes("private")).toBe(false)
    })
  }

  test(`${app} client-error telemetry covers runtime, boundary, and host gates @${app}`, async ({
    page,
  }) => {
    // Loading the document and two animation frames do not imply that a lazy
    // route has mounted its error listeners. Exercise that gap deliberately.
    let delayedAboutComponents = 0
    await page.route(
      (url) =>
        url.pathname.endsWith("/routes/about.tsx") &&
        Boolean(url.searchParams.get("tsr-split")?.includes("component")),
      async (route) => {
        delayedAboutComponents += 1
        await new Promise((resolve) => setTimeout(resolve, 500))
        await route.continue()
      },
      { times: 1 }
    )
    await page.goto(`${url}/about`)
    await expect(
      page.getByRole("heading", { name: `About ${appName}`, exact: true })
    ).toBeVisible()
    expect(delayedAboutComponents).toBe(1)
    await waitForClientEffects(page)
    await dispatchRuntimeErrors(page)

    await expect
      .poll(async () => (await readClientErrorEvents(page)).length)
      .toBe(2)

    const runtimeEvents = await readClientErrorEvents(page)
    expect(
      hasSameValue(runtimeEvents, [
        {
          eventName: "client_error_result",
          properties: {
            action: "window_error",
            app,
            event_family: "type_error",
            event_name: "client_error_result",
            mode: "unhandled",
            page_path: "/about",
            page_url: `${url}/about`,
            status: "failure",
            surface: "browser",
          },
          url: `${url}/about`,
        },
        {
          eventName: "client_error_result",
          properties: {
            action: "unhandled_rejection",
            app,
            event_family: "reference_error",
            event_name: "client_error_result",
            mode: "unhandled",
            page_path: "/about",
            page_url: `${url}/about`,
            status: "failure",
            surface: "browser",
          },
          url: `${url}/about`,
        },
      ])
    ).toBe(true)
    expect(JSON.stringify(runtimeEvents).includes("private")).toBe(false)

    await page.goto(
      `${url}/about?__conduit_telemetry_test=react_error_boundary&secret=private-checkout-token`
    )
    await expect(
      page.getByRole("heading", { name: "Something went wrong" })
    ).toBeVisible()
    await expect
      .poll(async () => (await readClientErrorEvents(page)).length)
      .toBe(1)

    const boundaryEvents = await readClientErrorEvents(page)
    expect(
      hasSameValue(boundaryEvents, [
        {
          eventName: "client_error_result",
          properties: {
            action: "react_error_boundary",
            app,
            event_family: "type_error",
            event_name: "client_error_result",
            mode: "handled",
            page_path: "/about",
            page_url: `${url}/about`,
            status: "failure",
            surface: "browser",
          },
          url: `${url}/about`,
        },
      ])
    ).toBe(true)
    expect(
      JSON.stringify(boundaryEvents).includes("private-checkout-token")
    ).toBe(false)

    const disallowedUrl = url.replace("127.0.0.1", "localhost")
    await page.goto(`${disallowedUrl}/about`)
    await expect(
      page.getByRole("heading", { name: `About ${appName}`, exact: true })
    ).toBeVisible()
    await waitForClientEffects(page)
    await dispatchRuntimeErrors(page)
    await waitForClientEffects(page)

    expect((await readClientErrorEvents(page)).length).toBe(0)
    expect(
      await page.locator('script[data-conduit-telemetry="plausible"]').count()
    ).toBe(0)
  })
}
