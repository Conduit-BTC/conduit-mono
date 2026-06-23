import { describe, expect, it } from "bun:test"

import {
  applyPlausibleInitOptions,
  buildTelemetryEventPageContext,
  buildTelemetryPageUrl,
  getConduitPostHogConfig,
  getTelemetryAmountBucket,
  getTelemetryCountBucket,
  pubkeyToNpub,
  recordBrowserTelemetryPageView,
  resolveBrowserTelemetryConfig,
  sanitizeTelemetryEventProperties,
  sanitizePostHogCaptureEvent,
  sanitizeTelemetryPath,
  sensitiveTelemetryPropertyNames,
  type PlausibleFunction,
} from "@conduit/core"

describe("browser telemetry", () => {
  const storePubkey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const storeNpub = pubkeyToNpub(storePubkey)

  it("is disabled by default", () => {
    const config = resolveBrowserTelemetryConfig("market", {})

    expect(config).toEqual({
      app: "market",
      enabled: false,
      allowedHosts: [],
      plausible: null,
      posthog: null,
    })
  })

  it("enables only providers with explicit configuration", () => {
    const config = resolveBrowserTelemetryConfig("merchant", {
      VITE_ENABLE_TELEMETRY: "true",
      VITE_PLAUSIBLE_DOMAIN: "sell.conduit.market",
    })

    expect(config.enabled).toBe(true)
    expect(config.allowedHosts).toEqual([])
    expect(config.plausible).toEqual({
      domain: "sell.conduit.market",
      scriptSrc: "https://plausible.io/js/script.js",
    })
    expect(config.posthog).toBeNull()
  })

  it("supports site-specific Plausible scripts without a legacy domain", () => {
    const config = resolveBrowserTelemetryConfig("market", {
      VITE_ENABLE_TELEMETRY: "true",
      VITE_TELEMETRY_ALLOWED_HOSTS: "shop.conduit.market, sell.conduit.market",
      VITE_PLAUSIBLE_SRC: "https://plausible.io/js/pa-example-market.js",
    })

    expect(config.allowedHosts).toEqual([
      "shop.conduit.market",
      "sell.conduit.market",
    ])
    expect(config.plausible).toEqual({
      domain: null,
      scriptSrc: "https://plausible.io/js/pa-example-market.js",
    })
    expect(config.posthog).toBeNull()
  })

  it("resolves PostHog host defaults without requiring Plausible", () => {
    const config = resolveBrowserTelemetryConfig("market", {
      VITE_ENABLE_TELEMETRY: "true",
      VITE_POSTHOG_KEY: "ph_project_key",
    })

    expect(config.plausible).toBeNull()
    expect(config.posthog).toEqual({
      key: "ph_project_key",
      host: "https://us.i.posthog.com",
    })
  })

  it("redacts dynamic route identifiers from pageview paths", () => {
    expect(
      sanitizeTelemetryPath(
        "/products/30402%3Amerchant%3Atesting-digital-jxwwl7?order=abc"
      )
    ).toBe("/products/:productId")
    expect(sanitizeTelemetryPath(`/store/${storePubkey}`)).toBe(
      `/store/${storeNpub}`
    )
    expect(sanitizeTelemetryPath(`/store/${storeNpub}?q=raw`)).toBe(
      `/store/${storeNpub}`
    )
    expect(sanitizeTelemetryPath("/store/not-a-pubkey")).toBe("/store/:pubkey")
    expect(sanitizeTelemetryPath("/u/npub1example")).toBe("/u/:profileRef")
    expect(sanitizeTelemetryPath("/orders?order=local-secret")).toBe("/orders")
    expect(sanitizeTelemetryPath("/npub1example")).toBe("/:param")
    expect(sanitizeTelemetryPath("/lnbc123")).toBe("/:param")
  })

  it("builds sanitized pageview urls for providers", () => {
    expect(
      buildTelemetryPageUrl({
        origin: "https://shop.conduit.market/",
        pathname: "/products/30402:merchant:item",
      })
    ).toBe("https://shop.conduit.market/products/:productId")
  })

  it("builds sanitized route context for custom events", () => {
    expect(
      buildTelemetryEventPageContext({
        origin: "https://shop.conduit.market/",
        pathname: `/store/${storePubkey}?q=buyer-search`,
      })
    ).toEqual({
      page_path: `/store/${storeNpub}`,
      page_url: `https://shop.conduit.market/store/${storeNpub}`,
    })
  })

  it("uses privacy-restrictive PostHog configuration", () => {
    const config = getConduitPostHogConfig({
      key: "ph_project_key",
      host: "https://us.i.posthog.com",
    })

    expect(config).toMatchObject({
      api_host: "https://us.i.posthog.com",
      autocapture: false,
      capture_dead_clicks: false,
      capture_pageview: false,
      capture_pageleave: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      disable_persistence: true,
      persistence: "memory",
      person_profiles: "never",
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      enable_recording_console_log: false,
      enable_heatmaps: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
    })
    expect(config.property_denylist).toEqual([
      ...sensitiveTelemetryPropertyNames,
    ])
    expect(typeof config.before_send).toBe("function")
  })

  it("stores Plausible init options on the official stub field", () => {
    const plausible = (() => undefined) as PlausibleFunction

    applyPlausibleInitOptions(plausible, {
      autoCapturePageviews: false,
      logging: false,
    })

    expect(plausible.o).toEqual({
      autoCapturePageviews: false,
      logging: false,
    })
    expect(plausible.q).toBeUndefined()
  })

  it("honors Global Privacy Control before loading analytics providers", () => {
    const previousDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document"
    )
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator"
    )
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const previousEnableTelemetry = process.env.VITE_ENABLE_TELEMETRY
    const previousAllowedHosts = process.env.VITE_TELEMETRY_ALLOWED_HOSTS
    const previousPlausibleSrc = process.env.VITE_PLAUSIBLE_SRC

    const appendedScripts: unknown[] = []
    const fakeDocument = {
      createElement: () => ({
        addEventListener: () => undefined,
        async: false,
        dataset: {} as Record<string, string>,
        src: "",
      }),
      head: {
        appendChild: (script: unknown) => {
          appendedScripts.push(script)
        },
      },
      querySelector: () => null,
    } as unknown as Document
    const fakeWindow = {
      location: {
        hostname: "shop.conduit.market",
        origin: "https://shop.conduit.market",
        pathname: "/products/demo",
      },
    } as unknown as Window

    try {
      process.env.VITE_ENABLE_TELEMETRY = "true"
      process.env.VITE_TELEMETRY_ALLOWED_HOSTS = "shop.conduit.market"
      process.env.VITE_PLAUSIBLE_SRC =
        "https://plausible.io/js/pa-example-market.js"
      replaceGlobalProperty("document", fakeDocument)
      replaceGlobalProperty("navigator", {
        globalPrivacyControl: true,
      } as Navigator & { globalPrivacyControl: boolean })
      replaceGlobalProperty("window", fakeWindow)

      recordBrowserTelemetryPageView({
        app: "market",
        pathname: "/products/demo",
      })

      expect(appendedScripts).toEqual([])
      expect(
        (fakeWindow as Window & { plausible?: PlausibleFunction }).plausible
      ).toBeUndefined()
    } finally {
      restoreProcessEnvValue("VITE_ENABLE_TELEMETRY", previousEnableTelemetry)
      restoreProcessEnvValue(
        "VITE_TELEMETRY_ALLOWED_HOSTS",
        previousAllowedHosts
      )
      restoreProcessEnvValue("VITE_PLAUSIBLE_SRC", previousPlausibleSrc)
      restoreGlobalProperty("document", previousDocument)
      restoreGlobalProperty("navigator", previousNavigator)
      restoreGlobalProperty("window", previousWindow)
    }
  })

  it("strips PostHog SDK defaults from outgoing events", () => {
    expect(
      sanitizePostHogCaptureEvent({
        event: "cart_add",
        properties: {
          $browser: "Chrome",
          app: "market",
          $current_url:
            "https://shop.conduit.market/products/30402:merchant:item?q=raw",
          $host: "shop.conduit.market",
          $pathname: "/products/30402:merchant:item",
          action: "add",
          distinct_id: "sdk-generated-id",
          page_path: "/products/:productId",
          page_url: "https://shop.conduit.market/products/:productId",
          status: "success",
        },
      })
    ).toEqual({
      event: "cart_add",
      properties: {
        $current_url: "https://shop.conduit.market/products/:productId",
        $pathname: "/products/:productId",
        action: "add",
        app: "market",
        page_path: "/products/:productId",
        page_url: "https://shop.conduit.market/products/:productId",
        status: "success",
      },
    })
  })

  it("keeps PostHog pageviews split by client app", () => {
    expect(
      sanitizePostHogCaptureEvent({
        event: "$pageview",
        properties: {
          app: "merchant",
          page_path: "/products",
          page_url: "https://sell.conduit.market/products",
        },
      })
    ).toEqual({
      event: "$pageview",
      properties: {
        $current_url: "https://sell.conduit.market/products",
        $pathname: "/products",
        app: "merchant",
        page_path: "/products",
        page_url: "https://sell.conduit.market/products",
      },
    })
  })

  it("buckets counts and amounts before telemetry emission", () => {
    expect(getTelemetryCountBucket(0)).toBe("0")
    expect(getTelemetryCountBucket(1)).toBe("1")
    expect(getTelemetryCountBucket(3)).toBe("2_3")
    expect(getTelemetryCountBucket(10)).toBe("4_10")
    expect(getTelemetryCountBucket(11)).toBe("11_plus")

    expect(getTelemetryAmountBucket(undefined)).toBe("unknown")
    expect(getTelemetryAmountBucket(999)).toBe("lt_1k_sats")
    expect(getTelemetryAmountBucket(10_000)).toBe("10k_100k_sats")
    expect(getTelemetryAmountBucket(1_000_000)).toBe("1m_plus_sats")
  })

  it("drops telemetry properties that are sensitive, high-cardinality, or free text", () => {
    expect(
      sanitizeTelemetryEventProperties({
        app: "market",
        eventName: "cart_add",
        properties: {
          action: "ADD",
          count_bucket: "2_3",
          product_type: "digital",
          pubkey:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          status: "success",
          surface: "cart",
          title: "Handmade product title",
        } as Record<string, string>,
      })
    ).toEqual({
      action: "add",
      app: "market",
      count_bucket: "2_3",
      event_name: "cart_add",
      product_type: "digital",
      status: "success",
      surface: "cart",
    })

    expect(
      sanitizeTelemetryEventProperties({
        app: "market",
        eventName: "checkout_initiated",
        properties: {
          surface: "https://example.com/cart",
          status: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        },
      })
    ).toEqual({
      app: "market",
      event_name: "checkout_initiated",
    })
  })
})

function restoreProcessEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function replaceGlobalProperty(
  key: "document" | "navigator" | "window",
  value: Document | Navigator | Window
): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  })
}

function restoreGlobalProperty(
  key: "document" | "navigator" | "window",
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor)
    return
  }
  delete (globalThis as Record<string, unknown>)[key]
}
