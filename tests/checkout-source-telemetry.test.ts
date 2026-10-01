import { afterEach, describe, expect, it } from "bun:test"
import {
  checkoutAttributionTelemetryProperties,
  checkoutPartnerRegistry,
  resolveCheckoutAttribution,
  parseCheckoutIntentFragment,
  encodeProductNaddr,
  sanitizeTelemetryEventProperties,
  sanitizePostHogCaptureEvent,
  recordBrowserTelemetryEvent,
  type CheckoutPartnerRegistration,
} from "@conduit/core"
import {
  handlePostHogProxyRequest,
  rebuildPostHogIngestPayload,
} from "../apps/posthog-proxy/src"
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
  source_domain: "other",
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
      source_domain: "other",
      source_method: "claimed",
      source_partner_status: "unregistered",
      ...extra,
    } as Record<string, string>,
  })

describe("checkout domain telemetry pipeline", () => {
  it("keeps unknown claimed and referrer domains local across every checkout counter", () => {
    const outcome = {
      mode: "buy",
      rail: "none",
      status: "success",
      count_bucket: "1",
      amount_bucket: "unknown",
      product_type: "unknown",
    }
    const counters = [
      ["checkout_handoff_result", { mode: "buy", handoff_stage: "arrival" }],
      ["checkout_step_result", { ...outcome, step: "order_submit" }],
      ["checkout_success", outcome],
      ["checkout_result", { ...outcome, network: "browser" }],
    ] as const
    for (const method of ["claimed", "referrer"] as const) {
      const attribution = resolveCheckoutAttribution({
        source: { domain: "private-business.com", method },
      })
      expect(attribution?.sourceDomain).toBe("private-business.com")
      const source = checkoutAttributionTelemetryProperties(attribution)
      expect(source.source_domain).toBe("other")
      for (const [eventName, extra] of counters) {
        const sanitized = sanitizeTelemetryEventProperties({
          app: "market",
          eventName,
          properties: { surface: "checkout", ...extra, ...source },
        })
        expect(sanitized).not.toBeNull()
        const rebuilt = rebuild({
          event: eventName,
          properties: {
            token,
            app: "market",
            event_name: eventName,
            page_path: "/checkout",
            page_url: `${origin.origin}/checkout`,
            ...sanitized,
          },
        })
        expect(rebuilt.ok).toBe(true)
        if (rebuilt.ok) {
          expect(rebuilt.events).toHaveLength(1)
          expect(JSON.stringify(rebuilt.events)).not.toContain(
            "private-business.com"
          )
        }
        const bypass = rebuild({
          event: eventName,
          properties: {
            token,
            app: "market",
            event_name: eventName,
            page_path: "/checkout",
            page_url: `${origin.origin}/checkout`,
            surface: "checkout",
            ...extra,
            ...source,
            source_domain: "private-business.com",
          },
        })
        expect(bypass.ok).toBe(true)
        if (bypass.ok) expect(bypass.events).toHaveLength(0)
      }
    }
  })

  it("buckets unknown domains and preserves finite methods without identifiers through client and ingest", () => {
    for (const method of ["claimed", "referrer"]) {
      expect(client({ source_method: method })).toMatchObject({
        source_domain: "other",
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
      expect(sanitized?.properties?.source_domain).toBe("other")
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
      event({
        source_domain: "example.com",
        source_partner_status: "active",
        partner_code: "project_a",
      })
    )
    if (active.ok) expect(active.events).toHaveLength(1)
    expect(
      client({
        source_domain: "example.com",
        source_partner_status: "active",
        partner_code: "project_a",
      })
    ).not.toBeNull()
    const legacy = resolveCheckoutAttribution({ partner: "project_a" })
    expect(checkoutAttributionTelemetryProperties(legacy)).toEqual({
      source_method: "partner",
      source_partner_status: "active",
      partner_code: "project_a",
    })
    registry[0]!.active = false
    expect(checkoutAttributionTelemetryProperties(attribution)).toEqual({
      source_domain: "other",
      source_method: "claimed",
      source_partner_status: "unregistered",
    })
    expect(resolveCheckoutAttribution({ partner: "project_a" })).toBeUndefined()
    expect(
      resolveCheckoutAttribution({
        source: { domain: "example.com", method: "claimed" },
      })?.partnerCode
    ).toBeUndefined()
    const inactive = rebuild(
      event({
        source_domain: "example.com",
        source_partner_status: "active",
        partner_code: "project_a",
      })
    )
    if (inactive.ok) expect(inactive.events).toHaveLength(0)
  })

  it("preserves a legacy claimed code alongside an observed domain through parser, client and ingest", () => {
    registry.push(
      { code: "legacy_a", account: "public-legacy", active: true },
      {
        code: "mapped_b",
        account: "public-mapped",
        active: true,
        domains: ["approved.com"],
      }
    )
    const product = encodeProductNaddr(
      `30402:${"a".repeat(64)}:legacy-referrer`
    )
    const fragment = new URLSearchParams({
      buy: product,
      partner: "legacy_a",
    }).toString()
    for (const [referrer, expectedDomain, status] of [
      ["https://unknown.co.uk/", "other", "unregistered"],
      ["https://approved.com/", "approved.com", "active"],
      ["https://deadbeefdeadbeef.com/", "other", "unregistered"],
    ]) {
      const parsed = parseCheckoutIntentFragment(fragment, referrer)
      expect(parsed.status).toBe("valid")
      if (parsed.status !== "valid")
        throw new Error("Fixture failed purchase parsing")
      const source = checkoutAttributionTelemetryProperties(
        resolveCheckoutAttribution(parsed.intent)
      )
      expect(source).toEqual({
        source_method: "referrer",
        source_domain: expectedDomain,
        source_partner_status: status,
        partner_code: "legacy_a",
      })
      expect(client(source)).not.toBeNull()
      const rebuilt = rebuild(event(source))
      expect(rebuilt.ok).toBe(true)
      if (rebuilt.ok) {
        expect(rebuilt.events).toHaveLength(1)
        expect(rebuilt.events[0]?.properties?.partner_code).toBe("legacy_a")
        expect(rebuilt.events[0]?.properties?.source_partner_status).toBe(
          status
        )
      }
      expect(
        client({
          ...source,
          source_partner_status:
            status === "active" ? "unregistered" : "active",
        })
      ).toBeNull()
      expect(
        client({ ...source, partner_code: "unregistered_code" })
      ).toBeNull()
    }
    const explicit = parseCheckoutIntentFragment(
      `${fragment}&source=unknown.co.uk`,
      "https://approved.com/"
    )
    if (explicit.status !== "valid")
      throw new Error("Fixture failed purchase parsing")
    const explicitSource = checkoutAttributionTelemetryProperties(
      resolveCheckoutAttribution(explicit.intent)
    )
    expect(explicitSource.partner_code).toBeUndefined()
    expect(explicitSource.source_partner_status).toBe("unregistered")
    expect(client({ ...explicitSource, partner_code: "legacy_a" })).toBeNull()
    registry[0]!.active = false
    const observed = parseCheckoutIntentFragment(
      fragment,
      "https://approved.com/"
    )
    if (observed.status !== "valid")
      throw new Error("Fixture failed purchase parsing")
    expect(resolveCheckoutAttribution(observed.intent)?.partnerCode).toBe(
      "mapped_b"
    )
  })

  it("rejects URLs, subdomains, free text and forged status through both validators", () => {
    for (const extra of [
      { source_domain: "example.com" },
      { source_domain: "project.github.io" },
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

  it("rejects every unreviewed hosted-domain label across repeated ingest requests", () => {
    for (let index = 0; index < 70; index++) {
      const domain = `project-${index}.github.io`
      expect(client({ source_domain: domain })).toBeNull()
      const result = rebuild(event({ source_domain: domain }))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.events).toHaveLength(0)
    }
  })

  it("drops GPC and nonofficial-origin ingest without forwarding referrer or identifiers", async () => {
    let forwarded = ""
    const fetcher = async (request: Request) => {
      forwarded = await request.text()
      return new Response("ok")
    }
    const request = (
      headers: Record<string, string>,
      extra: Record<string, unknown> = {}
    ) =>
      new Request("https://e.conduit.market/e", {
        method: "POST",
        headers: {
          origin: origin.origin,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(event(extra)),
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
    // Only the fixed bucket reaches the provider; the original domain stays local.
    expect(forwarded.includes('"source_method":"claimed"')).toBe(true)
    expect(forwarded.includes('"source_domain":"other"')).toBe(true)
    expect(forwarded.includes(uuid)).toBe(false)
    expect(forwarded.includes("referrer")).toBe(false)
    forwarded = ""
    await handlePostHogProxyRequest(
      request({}, { source_domain: "private-business.com" }),
      fetcher
    )
    expect(forwarded).toBe("")
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
