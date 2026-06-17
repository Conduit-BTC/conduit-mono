import { describe, expect, it } from "bun:test"

import {
  buildTelemetryPageUrl,
  getConduitPostHogConfig,
  resolveBrowserTelemetryConfig,
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
})
