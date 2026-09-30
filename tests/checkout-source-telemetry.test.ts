import { afterEach, describe, expect, it } from "bun:test"
import {
  checkoutAttributionTelemetryProperties,
  checkoutPartnerRegistry,
  resolveCheckoutAttribution,
  sanitizeTelemetryEventProperties,
  sanitizePostHogCaptureEvent,
  recordBrowserTelemetryEvent,
  type CheckoutPartnerRegistration,
} from "@conduit/core"
import {
  handlePostHogProxyRequest,
  rebuildPostHogIngestPayload,
} from "../apps/posthog-proxy/src"
import { createCheckoutSourceBudget } from "../apps/posthog-proxy/src/checkout-source-budget"
import {
  validateTelemetryEvents,
  validateTelemetrySourceUsage,
} from "../scripts/ci/check_telemetry_policy"

const registry = checkoutPartnerRegistry as CheckoutPartnerRegistration[]
const initialRegistry = [...registry]
afterEach(() => {
  registry.splice(0, registry.length, ...initialRegistry)
})
const origin = { app: "market" as const, origin: "https://shop.conduit.market" }
const token = "phc_workerTestProjectToken0001"
const uuid = "0198f4a0-2222-7abc-8def-0123456789ab"
const properties = (extra: Record<string, unknown> = {}) => ({
  token,
  app: "market",
  event_name: "checkout_handoff_result",
  page_path: "/checkout",
  page_url: `${origin.origin}/checkout`,
  surface: "checkout",
  mode: "buy",
  handoff_stage: "arrival",
  source_domain: "example.com",
  source_method: "claimed",
  source_partner_status: "unregistered",
  ...extra,
})
const event = (extra: Record<string, unknown> = {}) => ({
  event: "checkout_handoff_result",
  uuid,
  timestamp: "2026-09-30T20:21:31.123Z",
  properties: properties(extra),
})
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer
const rebuild = (value: unknown) =>
  rebuildPostHogIngestPayload(encode(value), origin, token)
const client = (extra: Record<string, unknown> = {}) =>
  sanitizeTelemetryEventProperties({
    app: "market",
    eventName: "checkout_handoff_result",
    properties: {
      surface: "checkout",
      mode: "buy",
      handoff_stage: "arrival",
      source_domain: "example.com",
      source_method: "claimed",
      source_partner_status: "unregistered",
      ...extra,
    } as Record<string, string>,
  })

describe("checkout domain telemetry pipeline", () => {
  it("includes unknown domains and finite methods without identifiers through client and ingest", () => {
    for (const method of ["claimed", "referrer"]) {
      expect(client({ source_method: method })).toMatchObject({
        source_domain: "example.com",
        source_method: method,
        source_partner_status: "unregistered",
      })
      const sanitized = sanitizePostHogCaptureEvent({
        ...event({
          source_method: method,
          $session_id: uuid,
          $pageview_id: uuid,
          $prev_pageview_id: uuid,
        }),
        timestamp: new Date("2026-09-30T20:21:31.123Z"),
      })
      expect(sanitized?.properties?.source_domain).toBe("example.com")
      expect(sanitized?.uuid).toBeUndefined()
      expect(sanitized?.properties?.$session_id).toBeUndefined()
      expect(sanitized?.properties?.$pageview_id).toBeUndefined()
      const proxy = rebuild(sanitized)
      expect(proxy.ok).toBe(true)
      if (proxy.ok) {
        expect(proxy.events).toHaveLength(1)
        expect(proxy.events[0]?.uuid).toBeUndefined()
        expect(proxy.events[0]?.timestamp).toBe("2026-09-30T20:00:00.000Z")
        expect(JSON.stringify(proxy.events[0]).includes(uuid)).toBe(false)
      }
      // SDK-added identifiers are stripped independently if client sanitization is bypassed.
      const bypass = rebuild(
        event({
          $session_id: uuid,
          $pageview_id: uuid,
          $prev_pageview_id: uuid,
        })
      )
      if (bypass.ok)
        expect(JSON.stringify(bypass.events).includes(uuid)).toBe(false)
    }
  })

  it("admits only a reviewed active mapping and compatible partner-only claims", () => {
    registry.push({
      code: "project_a",
      account: "public-project-a",
      active: true,
      domains: ["example.com"],
    })
    const attribution = resolveCheckoutAttribution({
      source: { domain: "example.com", method: "claimed" },
      partner: "unrelated",
    })
    expect(checkoutAttributionTelemetryProperties(attribution)).toEqual({
      source_domain: "example.com",
      source_method: "claimed",
      source_partner_status: "active",
      partner_code: "project_a",
    })
    const active = rebuild(
      event({ source_partner_status: "active", partner_code: "project_a" })
    )
    if (active.ok) expect(active.events).toHaveLength(1)
    expect(
      client({ source_partner_status: "active", partner_code: "project_a" })
    ).not.toBeNull()
    const legacy = resolveCheckoutAttribution({ partner: "project_a" })
    expect(checkoutAttributionTelemetryProperties(legacy)).toEqual({
      source_method: "partner",
      source_partner_status: "active",
      partner_code: "project_a",
    })
    registry[0]!.active = false
    expect(resolveCheckoutAttribution({ partner: "project_a" })).toBeUndefined()
    expect(
      resolveCheckoutAttribution({
        source: { domain: "example.com", method: "claimed" },
      })?.partnerCode
    ).toBeUndefined()
    const inactive = rebuild(
      event({ source_partner_status: "active", partner_code: "project_a" })
    )
    if (inactive.ok) expect(inactive.events).toHaveLength(0)
  })

  it("rejects URLs, subdomains, free text and forged status through both validators", () => {
    for (const extra of [
      { source_domain: "https://example.com/private?token=secret" },
      { source_domain: "user123.example.com" },
      { source_domain: "BÜCHER.DE" },
      { source_domain: "127.0.0.1" },
      { source_domain: "project.test" },
      { source_domain: "a".repeat(64) },
      { source_domain: "deadbeefdeadbeef.com" },
      { source_domain: "12345678.com" },
      { source_method: "browser_url" },
      { source_partner_status: "active" },
      { source_method: "partner" },
      { source_method: "none" },
      { partner_code: "unknown_code" },
      { source_domain: "other", source_partner_status: "active" },
      { source_url: "https://example.com/private" },
      { product: "sensitive-product" },
      { invoice: "sensitive-invoice" },
    ]) {
      expect(client(extra)).toBeNull()
      const result = rebuild(event(extra))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.events).toHaveLength(0)
    }
    const missing = client({
      source_domain: undefined,
      source_method: "none",
      source_partner_status: "none",
    })
    // Explicit undefined is rejected rather than becoming a property; builders omit it.
    expect(missing).toBeNull()
    expect(checkoutAttributionTelemetryProperties()).toEqual({
      source_method: "none",
      source_partner_status: "none",
    })
  })

  it("bounds generated registrable hosted domains and buckets identifier-like names", () => {
    const budget = createCheckoutSourceBudget(2)
    const first = properties({ source_domain: "one.github.io" })
    const second = properties({ source_domain: "two.github.io" })
    const third = properties({ source_domain: "three.github.io" })
    budget(first, 100)
    budget(second, 100)
    budget(third, 100)
    expect(first.source_domain).toBe("one.github.io")
    expect(second.source_domain).toBe("two.github.io")
    expect(third.source_domain).toBe("other")
    const repeat = properties({ source_domain: "one.github.io" })
    budget(repeat, 100)
    expect(repeat.source_domain).toBe("one.github.io")
    const nextHour = properties({ source_domain: "three.github.io" })
    budget(nextHour, 3_600_000)
    expect(nextHour.source_domain).toBe("three.github.io")
    expect(
      checkoutAttributionTelemetryProperties({
        sourceDomain: "deadbeefdeadbeef.com",
        sourceMethod: "claimed",
      }).source_domain
    ).toBe("other")
    expect(
      checkoutAttributionTelemetryProperties({
        sourceDomain: `${"a".repeat(48)}.${"b".repeat(48)}.com`,
        sourceMethod: "claimed",
      }).source_domain
    ).toBe("other")
  })

  it("enforces a finite new-domain budget across actual ingest requests", () => {
    let other = 0
    const retained = new Set<string>()
    for (let index = 0; index < 70; index++) {
      const result = rebuild(
        event({ source_domain: `project-${index}.github.io` })
      )
      if (result.ok) {
        const domain = (result.events[0]?.properties as Record<string, unknown>)
          ?.source_domain
        if (domain === "other") other++
        else if (typeof domain === "string") retained.add(domain)
      }
    }
    expect(retained.size).toBeLessThanOrEqual(64)
    expect(other).toBeGreaterThan(0)
  })

  it("drops GPC and nonofficial-origin ingest without forwarding referrer or identifiers", async () => {
    let forwarded = ""
    const fetcher = async (request: Request) => {
      forwarded = await request.text()
      return new Response("ok")
    }
    const request = (headers: Record<string, string>) =>
      new Request("https://e.conduit.market/e", {
        method: "POST",
        headers: {
          origin: origin.origin,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(event()),
      })
    expect(
      (await handlePostHogProxyRequest(request({ "sec-gpc": "1" }), fetcher))
        .status
    ).toBe(200)
    expect(forwarded).toBe("")
    expect(
      (
        await handlePostHogProxyRequest(
          request({ origin: "https://preview.pages.dev" }),
          fetcher
        )
      ).status
    ).toBe(403)
    expect(forwarded).toBe("")
    await handlePostHogProxyRequest(request({}), fetcher)
    // Domain budget may bucket this label after previous test; the counter remains.
    expect(forwarded.includes('"source_method":"claimed"')).toBe(true)
    expect(forwarded.includes(uuid)).toBe(false)
    expect(forwarded.includes("referrer")).toBe(false)
  })

  it("keeps attribution restricted to the four checkout counter contracts", () => {
    expect(
      validateTelemetryEvents([
        { eventName: "cart_add", properties: ["source_domain"] },
      ])
    ).toContain(
      "Telemetry event cart_add cannot use checkout attribution property: source_domain"
    )
    expect(
      validateTelemetrySourceUsage({
        source:
          'recordBrowserTelemetryEvent({ eventName: "checkout_handoff_result", properties: { referrer_url } })',
        relativePath: "apps/market/src/referral.ts",
        allowedEventNames: new Set(["checkout_handoff_result"]),
      }).length
    ).toBeGreaterThan(0)
  })

  it("preserves optional telemetry, GPC and official-host restrictions at the browser emitter", () => {
    const oldWindow = globalThis.window
    const oldDocument = globalThis.document
    const oldNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator"
    )
    const names = [
      "VITE_ENABLE_TELEMETRY",
      "VITE_TELEMETRY_ALLOWED_HOSTS",
      "VITE_PLAUSIBLE_SRC",
      "VITE_POSTHOG_KEY",
    ]
    const env = names.map((name) => process.env[name])
    let calls = 0
    try {
      globalThis.document = { querySelector: () => ({}) } as unknown as Document
      globalThis.window = {
        location: {
          hostname: "preview.example",
          origin: "https://preview.example",
          pathname: "/checkout",
        },
        plausible: () => {
          calls++
        },
      } as unknown as Window & typeof globalThis
      process.env.VITE_ENABLE_TELEMETRY = "true"
      process.env.VITE_TELEMETRY_ALLOWED_HOSTS = "preview.example"
      process.env.VITE_PLAUSIBLE_SRC = "https://plausible.io/js/test.js"
      delete process.env.VITE_POSTHOG_KEY
      Object.defineProperty(globalThis, "navigator", {
        value: {},
        configurable: true,
      })
      const emit = () =>
        recordBrowserTelemetryEvent({
          app: "market",
          eventName: "checkout_handoff_result",
          properties: {
            surface: "checkout",
            mode: "buy",
            handoff_stage: "arrival",
            ...checkoutAttributionTelemetryProperties({
              sourceDomain: "example.com",
              sourceMethod: "claimed",
            }),
          },
        })
      emit()
      expect(calls).toBe(0)
      window.location.hostname = "shop.conduit.market"
      window.location.origin = origin.origin
      process.env.VITE_ENABLE_TELEMETRY = "false"
      emit()
      expect(calls).toBe(0)
      process.env.VITE_ENABLE_TELEMETRY = "true"
      Object.defineProperty(globalThis, "navigator", {
        value: { globalPrivacyControl: true },
        configurable: true,
      })
      emit()
      expect(calls).toBe(0)
    } finally {
      globalThis.window = oldWindow
      globalThis.document = oldDocument
      if (oldNavigator)
        Object.defineProperty(globalThis, "navigator", oldNavigator)
      else Reflect.deleteProperty(globalThis, "navigator")
      names.forEach((name, index) => {
        if (env[index] === undefined) delete process.env[name]
        else process.env[name] = env[index]
      })
    }
  })
})
