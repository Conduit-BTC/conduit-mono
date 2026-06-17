import { describe, expect, it } from "bun:test"

import {
  buildTelemetryPageUrl,
  getConduitPostHogConfig,
  getTelemetryAmountBucket,
  getTelemetryCountBucket,
  resolveBrowserTelemetryConfig,
  sanitizeTelemetryEventProperties,
  sanitizeTelemetryPath,
  sensitiveTelemetryPropertyNames,
} from "@conduit/core"

describe("browser telemetry", () => {
  it("is disabled by default", () => {
    const config = resolveBrowserTelemetryConfig("market", {})

    expect(config).toEqual({
      app: "market",
      enabled: false,
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
    expect(config.plausible).toEqual({
      domain: "sell.conduit.market",
      scriptSrc: "https://plausible.io/js/script.js",
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
    expect(sanitizeTelemetryPath("/store/abcdef123456")).toBe("/store/:pubkey")
    expect(sanitizeTelemetryPath("/u/npub1example")).toBe("/u/:profileRef")
    expect(sanitizeTelemetryPath("/orders?order=local-secret")).toBe("/orders")
  })

  it("builds sanitized pageview urls for providers", () => {
    expect(
      buildTelemetryPageUrl({
        origin: "https://shop.conduit.market/",
        pathname: "/products/30402:merchant:item",
      })
    ).toBe("https://shop.conduit.market/products/:productId")
  })

  it("uses privacy-restrictive PostHog configuration", () => {
    const config = getConduitPostHogConfig({
      key: "ph_project_key",
      host: "https://us.i.posthog.com",
    })

    expect(config).toMatchObject({
      api_host: "https://us.i.posthog.com",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      disable_persistence: true,
      persistence: "memory",
      person_profiles: "never",
      advanced_disable_feature_flags: true,
      enable_recording_console_log: false,
      enable_heatmaps: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
    })
    expect(config.property_denylist).toEqual([
      ...sensitiveTelemetryPropertyNames,
    ])
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
