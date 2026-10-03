import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { BrowserContext, Route, WebSocketRoute } from "@playwright/test"
import { createHermeticLnurlFixture } from "../e2e/helpers/hermetic-lnurl"
import { CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"

import {
  createHermeticCommerceNetworkPolicy,
  installHermeticCommerceNetwork,
} from "../e2e/helpers/hermetic-network"

function withRuntimeUserInfo(value: string): string {
  const url = new URL(value)
  url.username = randomUUID()
  url.password = randomUUID()
  return url.toString()
}

const options = {
  appUrls: ["http://127.0.0.1:7000", "http://127.0.0.1:7001"],
  relayUrl: "ws://127.0.0.1:17777",
  imageUrl: "https://media.example.invalid/product.svg",
}

describe("hermetic commerce network policy", () => {
  test("permits only the named local apps and relay; the image is fulfilled offline", () => {
    const policy = createHermeticCommerceNetworkPolicy(options)
    expect(policy.http("http://127.0.0.1:7000/checkout")).toBe("local")
    expect(policy.http("http://127.0.0.1:7001/products")).toBe("local")
    expect(policy.http("http://127.0.0.1:17777/")).toBe("local")
    expect(policy.http(options.imageUrl)).toBe("image")
    expect(policy.webSocket("ws://127.0.0.1:17777/")).toBe(true)
    expect(policy.webSocket("ws://127.0.0.1:7000/?token=synthetic")).toBe(true)
    expect(policy.webSocket("ws://127.0.0.1:7001/")).toBe(true)
    expect(policy.http("https://provider.example.invalid/payment")).toBe(
      "blocked"
    )
    expect(policy.webSocket("wss://provider.example.invalid/")).toBe(false)
    expect(policy.http("http://127.0.0.1:3000/wallet")).toBe("blocked")
    expect(policy.webSocket("ws://127.0.0.1:3000/")).toBe(false)
  })

  test("rejects non-isolated configuration before any network handler is installed", () => {
    for (const appUrl of [
      "https://shop.conduit.market",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3002",
      "http://localhost:7000",
      "http://127.0.0.1:0",
      "http://127.0.0.1:7000/path",
      "http://127.0.0.1:7000?mode=live",
      withRuntimeUserInfo("http://127.0.0.1:7000/"),
    ]) {
      expect(() =>
        createHermeticCommerceNetworkPolicy({ ...options, appUrls: [appUrl] })
      ).toThrow("Commerce smoke requires explicit loopback origins.")
    }
    expect(() =>
      createHermeticCommerceNetworkPolicy({
        ...options,
        relayUrl: "wss://relay.conduit.market",
      })
    ).toThrow("Commerce smoke requires explicit loopback origins.")
    expect(() =>
      createHermeticCommerceNetworkPolicy({ ...options, appUrls: [] })
    ).toThrow("Commerce smoke requires at least one local app.")
  })

  test("rejects credentials, wrong ports and non-HTTP request schemes", () => {
    const policy = createHermeticCommerceNetworkPolicy(options)
    for (const target of [
      "not a URL",
      withRuntimeUserInfo("http://127.0.0.1:7000/"),
      "http://127.0.0.1:7002/",
      "https://127.0.0.1:7000/",
      "blob:http://127.0.0.1:7000/synthetic",
      "https://media.example.invalid/product.svg?redirect=1",
    ]) {
      expect(policy.http(target)).toBe("blocked")
    }
    expect(policy.webSocket(withRuntimeUserInfo("ws://127.0.0.1:17777/"))).toBe(
      false
    )
    expect(policy.webSocket("wss://127.0.0.1:17777")).toBe(false)
  })
})

test("the installed handler refuses redirects without following them", async () => {
  let httpHandler: ((route: Route) => Promise<void>) | undefined
  const context = {
    addInitScript: async () => {},
    route: async (_match: string, handler: (route: Route) => Promise<void>) => {
      httpHandler = handler
    },
    routeWebSocket: async () => {},
  } as unknown as BrowserContext
  await installHermeticCommerceNetwork(context, options)
  let maxRedirects: number | undefined
  let aborted = false
  let fulfilled = false
  let disposed = false
  await httpHandler!({
    request: () => ({ url: () => `${options.appUrls[0]}/redirect` }),
    fetch: async (input: { maxRedirects: number }) => {
      maxRedirects = input.maxRedirects
      return {
        status: () => 302,
        dispose: async () => {
          disposed = true
        },
      }
    },
    abort: async () => {
      aborted = true
    },
    fulfill: async () => {
      fulfilled = true
    },
  } as unknown as Route)
  expect(maxRedirects).toBe(0)
  expect(aborted).toBe(true)
  expect(fulfilled).toBe(false)
  expect(disposed).toBe(true)
})

test("public HTTP and WebSocket requests never reach a server", async () => {
  let httpHandler: ((route: Route) => Promise<void>) | undefined
  let socketHandler: ((socket: WebSocketRoute) => Promise<void>) | undefined
  const context = {
    addInitScript: async () => {},
    route: async (_match: string, handler: (route: Route) => Promise<void>) => {
      httpHandler = handler
    },
    routeWebSocket: async (
      _match: RegExp,
      handler: (socket: WebSocketRoute) => Promise<void>
    ) => {
      socketHandler = handler
    },
  } as unknown as BrowserContext
  await installHermeticCommerceNetwork(context, options)
  let attemptedNetwork = false
  let aborted = false
  let closed = false
  await httpHandler!({
    request: () => ({ url: () => "https://provider.example.invalid/payment" }),
    fetch: async () => {
      attemptedNetwork = true
    },
    continue: async () => {
      attemptedNetwork = true
    },
    abort: async () => {
      aborted = true
    },
  } as unknown as Route)
  await socketHandler!({
    url: () => "wss://relay.example.invalid/",
    connectToServer: () => {
      attemptedNetwork = true
    },
    close: async () => {
      closed = true
    },
  } as unknown as WebSocketRoute)
  expect(attemptedNetwork).toBe(false)
  expect(aborted).toBe(true)
  expect(closed).toBe(true)
})

test.each([false, true])(
  "local request failure without source evidence stays fatal with context closed=%s",
  async (closed) => {
    let handler: ((route: Route) => Promise<void>) | undefined
    await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async () => {},
        pages: () => (closed ? [] : [{ isClosed: () => false }]),
      } as unknown as BrowserContext,
      options
    )
    let redirected = false
    let abortAttempts = 0
    const request = handler!({
      request: () => ({ url: () => `${options.appUrls[0]}/orders` }),
      fetch: async () => {
        throw new Error("Private request details must not escape")
      },
      abort: async () => {
        abortAttempts += 1
      },
      continue: async () => {
        redirected = true
      },
    } as unknown as Route)
    await expect(request).rejects.toThrow(
      "Isolated local application request failed."
    )
    expect(abortAttempts).toBe(0)
    expect(redirected).toBe(false)
  }
)

describe("local resource failure remains scoped to its source document", () => {
  test.each([
    { scenario: "current document", harmless: false },
    { scenario: "same-document history change", harmless: false },
    { scenario: "new document in source frame", harmless: true },
    { scenario: "new document only in another frame", harmless: false },
    { scenario: "navigation request with changed document", harmless: false },
    {
      scenario: "navigation request after all pages close",
      harmless: false,
      allPagesClosed: true,
    },
    { scenario: "missing original marker", harmless: false },
    { scenario: "missing current marker", harmless: false },
    { scenario: "source frame detached", harmless: true },
    {
      scenario: "source page closed with another page open",
      harmless: true,
      abortThrows: true,
    },
    { scenario: "source frame unavailable", harmless: false },
    {
      scenario: "source frame unavailable after all pages close",
      harmless: false,
      allPagesClosed: true,
    },
    { scenario: "document marker read unavailable", harmless: false },
  ])("$scenario", async (testCase) => {
    const { scenario, harmless } = testCase
    const allPagesClosed =
      "allPagesClosed" in testCase && testCase.allPagesClosed
    let handler: ((route: Route) => Promise<void>) | undefined
    let documentMarker: string | null =
      scenario === "missing original marker" ? null : randomUUID()
    let otherDocumentMarker = randomUUID()
    let detached = false
    let sourceClosed = false
    let sourceUrl = `${options.appUrls[0]}/orders`
    let abortAttempts = 0
    let fallbackAttempts = 0
    let fetchAttempts = 0
    const otherFrame = { evaluate: async () => otherDocumentMarker }
    const sourcePage = {
      isClosed: () => sourceClosed,
      mainFrame: () => otherFrame,
    }
    const sourceFrame = {
      page: () => sourcePage,
      isDetached: () => detached,
      url: () => sourceUrl,
      evaluate: async () => {
        if (scenario === "document marker read unavailable") {
          throw new Error("Document marker unavailable.")
        }
        return documentMarker
      },
    }
    await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async () => {},
        // The context remains alive even when this resource's own page closes.
        pages: () =>
          allPagesClosed ? [] : [sourcePage, { isClosed: () => false }],
      } as unknown as BrowserContext,
      options
    )
    const result = handler!({
      request: () => ({
        url: () => `${options.appUrls[0]}/old-document-module.js`,
        isNavigationRequest: () =>
          scenario === "navigation request with changed document" ||
          scenario === "navigation request after all pages close",
        frame: () => {
          if (
            scenario === "source frame unavailable" ||
            scenario === "source frame unavailable after all pages close"
          ) {
            throw new Error("Source frame unavailable.")
          }
          return sourceFrame
        },
        failure: () => null,
      }),
      fetch: async () => {
        fetchAttempts += 1
        if (
          scenario === "new document in source frame" ||
          scenario === "navigation request with changed document" ||
          scenario === "missing original marker"
        )
          documentMarker = randomUUID()
        if (scenario === "missing current marker") documentMarker = null
        if (scenario === "new document only in another frame") {
          otherDocumentMarker = randomUUID()
        }
        if (scenario === "same-document history change") {
          sourceUrl = `${options.appUrls[0]}/orders?sort=newest#details`
        }
        if (scenario === "source frame detached") detached = true
        if (scenario === "source page closed with another page open") {
          sourceClosed = true
        }
        throw new Error("Local fixture socket closed.")
      },
      abort: async () => {
        abortAttempts += 1
        if ("abortThrows" in testCase && testCase.abortThrows) {
          throw new Error("The torn-down route was already cancelled.")
        }
      },
      continue: async () => {
        fallbackAttempts += 1
      },
    } as unknown as Route)
    if (harmless) await expect(result).resolves.toBeUndefined()
    else {
      await expect(result).rejects.toThrow(
        "Isolated local application request failed."
      )
    }
    expect(fetchAttempts).toBe(1)
    expect(abortAttempts).toBe(harmless ? 1 : 0)
    expect(fallbackAttempts).toBe(0)
  })
})

describe("explicit hermetic network teardown", () => {
  test("held fixture responses are not delivered after teardown begins", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    let releaseResponse!: () => void
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const beginTeardown = await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async () => {},
      } as unknown as BrowserContext,
      {
        ...options,
        lnurl: async () => {
          announceStarted()
          await held
          return { status: 200, body: "{}" }
        },
      }
    )
    let fulfilled = 0
    let fetches = 0
    let aborted = 0
    const request = handler!({
      request: () => ({ url: () => options.imageUrl, method: () => "GET" }),
      fulfill: async () => {
        fulfilled += 1
      },
      fetch: async () => {
        fetches += 1
      },
      abort: async () => {
        aborted += 1
      },
    } as unknown as Route)
    await started
    beginTeardown()
    releaseResponse()
    await request
    expect(fulfilled).toBe(0)
    expect(fetches).toBe(0)
    expect(aborted).toBe(1)
  })

  test("teardown stops new fixture and WebSocket work without network fallback", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    let socketHandler: ((socket: WebSocketRoute) => Promise<void>) | undefined
    let fixtureCalls = 0
    const beginTeardown = await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async (_match: RegExp, value: typeof socketHandler) => {
          socketHandler = value
        },
      } as unknown as BrowserContext,
      {
        ...options,
        lnurl: async () => {
          fixtureCalls += 1
          return null
        },
      }
    )
    let fetches = 0
    let fulfilled = 0
    let aborted = 0
    let connected = 0
    let closed = 0
    beginTeardown()
    for (const url of [
      options.appUrls[0],
      options.imageUrl,
      "https://provider.example.invalid/payment",
    ]) {
      await handler!({
        request: () => ({ url: () => url, method: () => "GET" }),
        fulfill: async () => {
          fulfilled += 1
        },
        fetch: async () => {
          fetches += 1
        },
        abort: async () => {
          aborted += 1
        },
      } as unknown as Route)
    }
    for (const url of [options.relayUrl, "wss://provider.example.invalid/"]) {
      await socketHandler!({
        url: () => url,
        connectToServer: () => {
          connected += 1
        },
        close: async () => {
          closed += 1
        },
      } as unknown as WebSocketRoute)
    }
    expect(fixtureCalls).toBe(0)
    expect(fetches).toBe(0)
    expect(fulfilled).toBe(0)
    expect(aborted).toBe(3)
    expect(connected).toBe(0)
    expect(closed).toBe(2)
  })

  test.each([false, true])(
    "settles an in-flight current-document failure after teardown begins with abort throwing=%s",
    async (abortThrows) => {
      let handler: ((route: Route) => Promise<void>) | undefined
      const marker = randomUUID()
      const sourceFrame = {
        page: () => ({ isClosed: () => false }),
        isDetached: () => false,
        evaluate: async () => marker,
      }
      const beginTeardown = await installHermeticCommerceNetwork(
        {
          addInitScript: async () => {},
          route: async (_match: string, value: typeof handler) => {
            handler = value
          },
          routeWebSocket: async () => {},
        } as unknown as BrowserContext,
        options
      )
      let announceFetchStarted!: () => void
      const fetchStarted = new Promise<void>((resolve) => {
        announceFetchStarted = resolve
      })
      let rejectFetch!: (error: Error) => void
      const fetchResult = new Promise<never>((_resolve, reject) => {
        rejectFetch = reject
      })
      let abortAttempts = 0
      const request = handler!({
        request: () => ({
          url: () => `${options.appUrls[0]}/orders`,
          isNavigationRequest: () => false,
          frame: () => sourceFrame,
        }),
        fetch: async () => {
          announceFetchStarted()
          return fetchResult
        },
        abort: async () => {
          abortAttempts += 1
          if (abortThrows) throw new Error("The closing route was cancelled.")
        },
      } as unknown as Route)

      await fetchStarted
      beginTeardown()
      rejectFetch(new Error("Local fixture socket closed."))

      await expect(request).resolves.toBeUndefined()
      expect(abortAttempts).toBe(1)
    }
  )

  test("a one-way teardown boundary aborts new local requests before delivery", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    const beginTeardown = await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async () => {},
      } as unknown as BrowserContext,
      options
    )
    let fetchAttempts = 0
    let fallbackAttempts = 0
    let abortAttempts = 0

    beginTeardown()
    beginTeardown()
    await expect(
      handler!({
        request: () => ({ url: () => `${options.appUrls[0]}/orders` }),
        fetch: async () => {
          fetchAttempts += 1
          throw new Error("A closing context must not start new delivery.")
        },
        continue: async () => {
          fallbackAttempts += 1
        },
        abort: async () => {
          abortAttempts += 1
        },
      } as unknown as Route)
    ).resolves.toBeUndefined()
    expect(fetchAttempts).toBe(0)
    expect(fallbackAttempts).toBe(0)
    expect(abortAttempts).toBe(1)
  })

  test("public requests remain denied after teardown begins", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    const beginTeardown = await installHermeticCommerceNetwork(
      {
        addInitScript: async () => {},
        route: async (_match: string, value: typeof handler) => {
          handler = value
        },
        routeWebSocket: async () => {},
      } as unknown as BrowserContext,
      options
    )
    let attemptedNetwork = false
    let abortAttempts = 0

    beginTeardown()
    await handler!({
      request: () => ({
        url: () => "https://provider.example.invalid/payment",
      }),
      fetch: async () => {
        attemptedNetwork = true
      },
      continue: async () => {
        attemptedNetwork = true
      },
      abort: async () => {
        abortAttempts += 1
      },
    } as unknown as Route)

    expect(attemptedNetwork).toBe(false)
    expect(abortAttempts).toBe(1)
  })
})

test("configured LNURL endpoints are fulfilled offline without allowing their public origins", async () => {
  const addresses = [
    "merchant@wallet.conduit.market",
    "supplier@wallet.conduit.market",
    CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT,
  ]
  const fixture = createHermeticLnurlFixture({
    recipients: addresses.map((lud16) => ({ lud16 })),
    nowSeconds: () => 1_800_000_000,
  })
  let handler: ((route: Route) => Promise<void>) | undefined
  const context = {
    addInitScript: async () => {},
    route: async (_match: string, value: typeof handler) => {
      handler = value
    },
    routeWebSocket: async () => {},
  } as unknown as BrowserContext
  await installHermeticCommerceNetwork(context, {
    ...options,
    lnurl: fixture.respond,
  })
  let publicFetches = 0
  let fulfilled = 0
  let blocked = 0
  const callbacks: string[] = []
  const request = async (url: string) => {
    await handler!({
      request: () => ({ url: () => url, method: () => "GET" }),
      fetch: async () => {
        publicFetches += 1
        throw new Error("Offline only")
      },
      continue: async () => {
        publicFetches += 1
      },
      abort: async () => {
        blocked += 1
      },
      fulfill: async (response: {
        body?: string
        headers?: Record<string, string>
      }) => {
        const body = JSON.parse(response.body!)
        if (body.tag === "payRequest") callbacks.push(body.callback)
        else
          expect(
            typeof body.pr === "string" && body.pr.startsWith("lnbcrt")
          ).toBe(true)
        expect(response.headers?.["access-control-allow-origin"]).toBe("*")
        fulfilled += 1
      },
    } as unknown as Route)
  }
  for (const address of addresses) {
    const [username, domain] = address.split("@")
    await request(`https://${domain}/.well-known/lnurlp/${username}`)
    await request(`https://${domain}/unconfigured`)
  }
  expect(fulfilled).toBe(3)
  expect(blocked).toBe(3)
  expect(publicFetches).toBe(0)
  expect(fixture.snapshot()).toEqual({ metadataRequests: 3, invoicesIssued: 0 })
  for (const callback of callbacks) await request(`${callback}?amount=2000`)
  expect(fulfilled).toBe(6)
  expect(publicFetches).toBe(0)
  expect(fixture.snapshot()).toEqual({ metadataRequests: 3, invoicesIssued: 3 })
})

test("an unavailable offline LNURL responder aborts without falling through to public transport", async () => {
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: "merchant@wallet.conduit.market" }],
    nowSeconds: () => 1_800_000_000,
    onInvoiceIssued: () => {
      throw new Error("Runner registration unavailable")
    },
  })
  let handler: ((route: Route) => Promise<void>) | undefined
  await installHermeticCommerceNetwork(
    {
      addInitScript: async () => {},
      route: async (_match: string, value: typeof handler) => {
        handler = value
      },
      routeWebSocket: async () => {},
    } as unknown as BrowserContext,
    { ...options, lnurl: fixture.respond }
  )
  let aborted = false
  let sent = false
  await handler!({
    request: () => ({
      url: () =>
        "https://wallet.conduit.market/__hermetic_lnurl/callback/merchant?amount=2000",
      method: () => "GET",
    }),
    abort: async () => {
      aborted = true
    },
    fetch: async () => {
      sent = true
    },
    continue: async () => {
      sent = true
    },
    fulfill: async () => {
      sent = true
    },
  } as unknown as Route)
  expect(aborted).toBe(true)
  expect(sent).toBe(false)
})
