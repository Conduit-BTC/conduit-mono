import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools/pure"

const marketLocalOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantLocalOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
// Keep the production hostnames visible to the app while matching the local
// Vite servers' HTTP protocol for Playwright's same-protocol URL override.
const marketTestOrigin = "http://shop.conduit.market"
const merchantTestOrigin = "http://sell.conduit.market"
// Auth restoration now validates signed events, so the signed-in navigation
// fixture must use a real ephemeral key instead of racing an invalid stub.
const signerSecretKey = generateSecretKey()
const savedPubkey = getPublicKey(signerSecretKey)
const signEventBinding = "__conduitSignLegalTestEvent"

type AuthFixture = "signed_out" | "restoring" | "signed_in"

type LegalProbe = {
  beaconCalls: number
  fetches: string[]
  indexedDbOpenCalls: number
  localStorageReadKeys: string[]
  nostrGetPublicKeyCalls: number
  sessionStorageWrites: number
  xhrRequests: string[]
}

async function mapTestOriginToLocal(
  context: BrowserContext,
  testOrigin: string,
  localOrigin: string,
  onDocumentRequest?: (request: Request) => void
): Promise<void> {
  await context.route(`${testOrigin}/**`, async (route) => {
    const request = route.request()
    if (request.resourceType() === "document") onDocumentRequest?.(request)

    const testUrl = new URL(request.url())
    await route.continue({
      url: `${localOrigin}${testUrl.pathname}${testUrl.search}`,
    })
  })
}

async function installLegalIsolationProbe(
  page: Page,
  authFixture: AuthFixture
): Promise<void> {
  await page.exposeFunction(signEventBinding, (event: EventTemplate) =>
    finalizeEvent(event, signerSecretKey)
  )
  await page.addInitScript(
    ([fixture, pubkey, signerBinding]) => {
      if (fixture !== "signed_out") {
        localStorage.setItem("conduit:auth", pubkey)
      }

      const probe: LegalProbe = {
        beaconCalls: 0,
        fetches: [],
        indexedDbOpenCalls: 0,
        localStorageReadKeys: [],
        nostrGetPublicKeyCalls: 0,
        sessionStorageWrites: 0,
        xhrRequests: [],
      }
      Object.defineProperty(window, "__conduitLegalProbe", {
        configurable: false,
        value: probe,
      })

      const originalStorageGetItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key: string): string | null {
        if (this === localStorage) probe.localStorageReadKeys.push(key)
        return originalStorageGetItem.call(this, key)
      }

      const originalStorageSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (this === sessionStorage) probe.sessionStorageWrites += 1
        originalStorageSetItem.call(this, key, value)
      }

      const originalIndexedDbOpen = indexedDB.open.bind(indexedDB)
      indexedDB.open = ((...args: Parameters<IDBFactory["open"]>) => {
        probe.indexedDbOpenCalls += 1
        return originalIndexedDbOpen(...args)
      }) as IDBFactory["open"]

      const originalFetch = window.fetch.bind(window)
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        probe.fetches.push(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        )
        return originalFetch(input, init)
      }) as typeof window.fetch

      const originalXhrOpen = XMLHttpRequest.prototype.open
      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null
      ): void {
        probe.xhrRequests.push(String(url))
        originalXhrOpen.call(
          this,
          method,
          url,
          async ?? true,
          username ?? null,
          password ?? null
        )
      }

      const originalSendBeacon = navigator.sendBeacon?.bind(navigator)
      navigator.sendBeacon = ((
        dataUrl: string | URL,
        data?: BodyInit | null
      ) => {
        probe.beaconCalls += 1
        return originalSendBeacon?.(dataUrl, data) ?? false
      }) as typeof navigator.sendBeacon

      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          async getPublicKey() {
            probe.nostrGetPublicKeyCalls += 1
            if (fixture === "restoring") return new Promise<string>(() => {})
            return pubkey
          },
          async getRelays() {
            return { "wss://relay.conduit.market": { read: true, write: true } }
          },
          async signEvent(event: Record<string, unknown>) {
            return (
              window as unknown as Record<
                string,
                (event: Record<string, unknown>) => Promise<unknown>
              >
            )[signerBinding]!(event)
          },
        },
      })
    },
    [authFixture, savedPubkey, signEventBinding] as const
  )
}

async function readProbe(page: Page): Promise<LegalProbe> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __conduitLegalProbe: LegalProbe
        }
      ).__conduitLegalProbe
  )
}

async function dispatchRuntimeErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("legal route telemetry isolation probe"),
        message: "legal route telemetry isolation probe",
      })
    )

    const rejection = new Event("unhandledrejection") as Event & {
      reason: unknown
    }
    rejection.reason = new ReferenceError(
      "legal route telemetry isolation probe"
    )
    window.dispatchEvent(rejection)
  })
}

async function assertIsolatedLegalLoad(
  page: Page,
  expectedTitle: string,
  expectedCanonical: string,
  externalWebSockets: string[]
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canonical = document.head.querySelector<HTMLLinkElement>(
          'link[rel="canonical"]'
        )
        return {
          canonicalHref: canonical?.href ?? null,
          canonicalLink: canonical?.getAttribute("href") ?? null,
          title: document.title,
        }
      })
    )
    .toEqual({
      canonicalHref: expectedCanonical,
      canonicalLink: expectedCanonical,
      title: `${expectedTitle} | Conduit`,
    })
  await expect(page.getByRole("heading", { name: expectedTitle })).toBeVisible()
  await expect(page.getByLabel("Policy scope")).toContainText(
    "shop.conduit.market"
  )
  await expect(page.getByLabel("Policy scope")).toContainText(
    "sell.conduit.market"
  )

  await dispatchRuntimeErrors(page)

  const probe = await readProbe(page)
  expect(probe).toMatchObject({
    beaconCalls: 0,
    fetches: [],
    indexedDbOpenCalls: 0,
    nostrGetPublicKeyCalls: 0,
    sessionStorageWrites: 0,
    xhrRequests: [],
  })
  expect(probe.localStorageReadKeys).not.toContain("conduit:auth")
  expect(externalWebSockets).toEqual([])
  expect(await page.evaluate(() => "plausible" in window)).toBe(false)
}

const legalCases = [
  {
    app: "market",
    testOrigin: marketTestOrigin,
    localOrigin: marketLocalOrigin,
    path: "/privacy-policy",
    title: "Product Privacy Policy",
    canonical: "https://shop.conduit.market/privacy-policy",
  },
  {
    app: "market",
    testOrigin: marketTestOrigin,
    localOrigin: marketLocalOrigin,
    path: "/terms-of-service",
    title: "Product Terms of Service",
    canonical: "https://shop.conduit.market/terms-of-service",
  },
  {
    app: "merchant",
    testOrigin: merchantTestOrigin,
    localOrigin: merchantLocalOrigin,
    path: "/privacy-policy",
    title: "Product Privacy Policy",
    canonical: "https://shop.conduit.market/privacy-policy",
  },
  {
    app: "merchant",
    testOrigin: merchantTestOrigin,
    localOrigin: merchantLocalOrigin,
    path: "/terms-of-service",
    title: "Product Terms of Service",
    canonical: "https://shop.conduit.market/terms-of-service",
  },
] as const

for (const legalCase of legalCases) {
  test(`${legalCase.app} ${legalCase.path} is public and isolated @${legalCase.app}`, async ({
    context,
    page,
  }) => {
    const externalWebSockets: string[] = []
    page.on("websocket", (socket) => {
      const socketUrl = new URL(socket.url())
      const allowedHmrHosts = new Set([
        new URL(legalCase.testOrigin).hostname,
        new URL(legalCase.localOrigin).hostname,
      ])
      if (!allowedHmrHosts.has(socketUrl.hostname)) {
        externalWebSockets.push(socket.url())
      }
    })
    await installLegalIsolationProbe(page, "signed_out")
    await mapTestOriginToLocal(
      context,
      legalCase.testOrigin,
      legalCase.localOrigin
    )

    await page.goto(`${legalCase.testOrigin}${legalCase.path}`)
    await assertIsolatedLegalLoad(
      page,
      legalCase.title,
      legalCase.canonical,
      externalWebSockets
    )
  })
}

for (const legalCase of legalCases) {
  test(`${legalCase.app} ${legalCase.path}/ keeps the legal startup boundary @${legalCase.app}`, async ({
    context,
    page,
  }) => {
    const externalWebSockets: string[] = []
    page.on("websocket", (socket) => {
      const socketUrl = new URL(socket.url())
      const allowedHmrHosts = new Set([
        new URL(legalCase.testOrigin).hostname,
        new URL(legalCase.localOrigin).hostname,
      ])
      if (!allowedHmrHosts.has(socketUrl.hostname)) {
        externalWebSockets.push(socket.url())
      }
    })
    await installLegalIsolationProbe(page, "signed_out")
    await mapTestOriginToLocal(
      context,
      legalCase.testOrigin,
      legalCase.localOrigin
    )

    await page.goto(`${legalCase.testOrigin}${legalCase.path}/`)
    await assertIsolatedLegalLoad(
      page,
      legalCase.title,
      legalCase.canonical,
      externalWebSockets
    )
  })
}

for (const authFixture of ["restoring", "signed_in"] as const) {
  for (const path of ["/privacy-policy", "/terms-of-service"] as const) {
    test(`merchant ${path} bypasses ${authFixture} signer state @merchant`, async ({
      context,
      page,
    }) => {
      const externalWebSockets: string[] = []
      page.on("websocket", (socket) => {
        const socketUrl = new URL(socket.url())
        if (
          socketUrl.hostname !== "sell.conduit.market" &&
          socketUrl.hostname !== new URL(merchantLocalOrigin).hostname
        ) {
          externalWebSockets.push(socket.url())
        }
      })
      await installLegalIsolationProbe(page, authFixture)
      await mapTestOriginToLocal(
        context,
        merchantTestOrigin,
        merchantLocalOrigin
      )

      await page.goto(`${merchantTestOrigin}${path}`)
      await assertIsolatedLegalLoad(
        page,
        path === "/privacy-policy"
          ? "Product Privacy Policy"
          : "Product Terms of Service",
        `https://shop.conduit.market${path}`,
        externalWebSockets
      )
    })
  }
}

for (const legalCase of legalCases) {
  test(`${legalCase.app} ${legalCase.path} remains usable at a mobile viewport @${legalCase.app}`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installLegalIsolationProbe(page, "signed_out")
    await mapTestOriginToLocal(
      context,
      legalCase.testOrigin,
      legalCase.localOrigin
    )

    await page.goto(`${legalCase.testOrigin}${legalCase.path}`)
    await expect(
      page.getByRole("heading", { name: legalCase.title })
    ).toBeVisible()
    await expect(page.getByLabel("Policy scope")).toBeVisible()
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll")
  })
}

test("market Product legal links use full navigation and suppress cross-origin referrers @market", async ({
  context,
  page,
}) => {
  let termsDocumentRequests = 0
  let websiteReferer: string | undefined
  await installLegalIsolationProbe(page, "signed_out")
  await mapTestOriginToLocal(
    context,
    marketTestOrigin,
    marketLocalOrigin,
    (request) => {
      if (new URL(request.url()).pathname === "/terms-of-service") {
        termsDocumentRequests += 1
      }
    }
  )
  await context.route("https://conduit.market/**", async (route) => {
    websiteReferer = route.request().headers().referer
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Website policy</title><h1>Website policy</h1>",
    })
  })

  await page.goto(`${marketTestOrigin}/privacy-policy`)
  await page
    .getByRole("link", { name: "Read the Product Terms of Service" })
    .click()
  await expect(page).toHaveURL(`${marketTestOrigin}/terms-of-service`)
  expect(termsDocumentRequests).toBe(1)

  const websitePrivacy = page.getByRole("link", {
    name: "Website Privacy Policy",
  })
  await expect(websitePrivacy).toHaveAttribute(
    "href",
    "https://conduit.market/privacy-policy"
  )
  await expect(websitePrivacy).toHaveAttribute("referrerpolicy", "no-referrer")
  await expect(websitePrivacy).toHaveAttribute("rel", "noopener noreferrer")
  await websitePrivacy.click()
  await expect(page).toHaveURL("https://conduit.market/privacy-policy")
  expect(websiteReferer).toBeUndefined()
})

test("market footer opens the host-local Product Terms with full navigation @market", async ({
  context,
  page,
}) => {
  let termsDocumentRequests = 0
  await installLegalIsolationProbe(page, "signed_out")
  await mapTestOriginToLocal(
    context,
    marketTestOrigin,
    marketLocalOrigin,
    (request) => {
      if (new URL(request.url()).pathname === "/terms-of-service") {
        termsDocumentRequests += 1
      }
    }
  )

  await page.goto(`${marketTestOrigin}/about`)
  const termsLink = page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Terms" })
  await expect(termsLink).toHaveAttribute("href", "/terms-of-service")
  await expect(termsLink).not.toHaveAttribute("target", "_blank")
  await termsLink.click()

  await expect(page).toHaveURL(`${marketTestOrigin}/terms-of-service`)
  expect(termsDocumentRequests).toBe(1)
})

test("merchant ConnectGate opens the host-local Product Privacy Policy with full navigation @merchant", async ({
  context,
  page,
}) => {
  let privacyDocumentRequests = 0
  await installLegalIsolationProbe(page, "signed_out")
  await mapTestOriginToLocal(
    context,
    merchantTestOrigin,
    merchantLocalOrigin,
    (request) => {
      if (new URL(request.url()).pathname === "/privacy-policy") {
        privacyDocumentRequests += 1
      }
    }
  )

  await page.goto(`${merchantTestOrigin}/`)
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit" })
  ).toBeVisible()
  const privacyLink = page.getByRole("link", { name: "Privacy" })
  await expect(privacyLink).toHaveAttribute("href", "/privacy-policy")
  await expect(privacyLink).not.toHaveAttribute("target", "_blank")
  await privacyLink.click()

  await expect(page).toHaveURL(`${merchantTestOrigin}/privacy-policy`)
  expect(privacyDocumentRequests).toBe(1)
})

test("merchant signed menu opens the host-local Product Terms with full navigation @merchant", async ({
  context,
  page,
}) => {
  let termsDocumentRequests = 0
  await installLegalIsolationProbe(page, "signed_in")
  await mapTestOriginToLocal(
    context,
    merchantTestOrigin,
    merchantLocalOrigin,
    (request) => {
      if (new URL(request.url()).pathname === "/terms-of-service") {
        termsDocumentRequests += 1
      }
    }
  )

  await page.goto(`${merchantTestOrigin}/`)
  await page.getByRole("button", { name: "Open merchant account menu" }).click()
  const termsLink = page.getByRole("menu").getByRole("menuitem", {
    name: "Terms",
  })
  await expect(termsLink).toHaveAttribute("href", "/terms-of-service")
  await expect(termsLink).not.toHaveAttribute("target", "_blank")
  await termsLink.click()

  await expect(page).toHaveURL(`${merchantTestOrigin}/terms-of-service`)
  expect(termsDocumentRequests).toBe(1)
})
