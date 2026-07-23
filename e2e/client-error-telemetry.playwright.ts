import { expect, test, type Page } from "@playwright/test"

type TelemetryProperties = Record<string, string | boolean>

type CapturedTelemetryEvent = {
  eventName: string
  properties: TelemetryProperties
  url?: string
}

const appCases = [
  {
    app: "market",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`,
  },
  {
    app: "merchant",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`,
  },
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

for (const { app, url } of appCases) {
  test(`${app} client-error telemetry covers runtime, boundary, and host gates`, async ({
    page,
  }) => {
    await page.goto(`${url}/about`)
    await waitForClientEffects(page)
    await dispatchRuntimeErrors(page)

    await expect
      .poll(async () => (await readClientErrorEvents(page)).length)
      .toBe(2)

    const runtimeEvents = await readClientErrorEvents(page)
    expect(runtimeEvents).toEqual([
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
    expect(JSON.stringify(runtimeEvents)).not.toContain("private")

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
    expect(boundaryEvents).toEqual([
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
    expect(JSON.stringify(boundaryEvents)).not.toContain(
      "private-checkout-token"
    )

    const disallowedUrl = url.replace("127.0.0.1", "localhost")
    await page.goto(`${disallowedUrl}/about`)
    await waitForClientEffects(page)
    await dispatchRuntimeErrors(page)
    await waitForClientEffects(page)

    expect(await readClientErrorEvents(page)).toEqual([])
    expect(
      await page.locator('script[data-conduit-telemetry="plausible"]').count()
    ).toBe(0)
  })
}
