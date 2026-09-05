import { describe, expect, it } from "bun:test"

import {
  androidSignerConnectUrl,
  getSignerPlatform,
  type AndroidSigner,
} from "../packages/ui/src/components/signer-platform"

function connectionFixture(): string {
  const uri = new URL("nostrconnect://client-marker")
  uri.searchParams.append("relay", "wss://relay.example/path?one=1&two=2")
  uri.searchParams.append("relay", "wss://second.example")
  uri.searchParams.set("secret", crypto.randomUUID())
  uri.searchParams.set("name", "Shop + % # ; & = café")
  uri.searchParams.set("url", "https://example.test/checkout?done=1&next=two")
  return uri.toString().replaceAll("%3A", "%3a")
}

describe("signer platform", () => {
  it("recognizes iPhone, iPod, and both iPad browser identities", () => {
    for (const userAgent of ["iPhone", "iPod", "iPad"]) {
      expect(getSignerPlatform({ userAgent })).toBe("ios")
    }
    expect(
      getSignerPlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      })
    ).toBe("ios")
  })

  it("recognizes Android phones and tablets without using touch alone", () => {
    expect(getSignerPlatform({ userAgent: "Android 16; Mobile" })).toBe(
      "android"
    )
    expect(getSignerPlatform({ userAgent: "Android 16; Tablet" })).toBe(
      "android"
    )
    expect(
      getSignerPlatform({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        platform: "Win32",
        maxTouchPoints: 10,
      })
    ).toBe("desktop")
  })

  it("keeps unidentified mobile devices separate from named signer platforms", () => {
    for (const userAgent of [
      "Example Mobile",
      "Example Mobi",
      "Example Tablet",
    ]) {
      expect(getSignerPlatform({ userAgent })).toBe("unknown-mobile")
    }
  })

  it("keeps desktop Macs and absent browser metadata on the desktop path", () => {
    for (const maxTouchPoints of [undefined, 0, 1]) {
      expect(
        getSignerPlatform({
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
          platform: "MacIntel",
          maxTouchPoints,
        })
      ).toBe("desktop")
    }
    expect(getSignerPlatform({})).toBe("desktop")
  })
})

describe("Android signer handoff", () => {
  it("targets each known package and preserves the complete encoded request", () => {
    const request = connectionFixture()
    const packages: Record<AndroidSigner, string> = {
      amber: "com.greenart7c3.nostrsigner",
      primal: "net.primal.android",
    }

    for (const signer of ["amber", "primal"] as const) {
      const handoff = androidSignerConnectUrl(signer, request)
      const marker = handoff.indexOf("#Intent;")
      const recoveredRequest = `nostrconnect:${handoff.slice("intent:".length, marker)}`

      // Boolean comparisons keep connection credentials out of failure output.
      expect(handoff.startsWith("intent://")).toBe(true)
      expect(recoveredRequest === request).toBe(true)
      expect(
        handoff.slice(marker) ===
          `#Intent;scheme=nostrconnect;package=${packages[signer]};end`
      ).toBe(true)
      expect(handoff.includes("browser_fallback_url")).toBe(false)
      expect(handoff.indexOf("#") === handoff.lastIndexOf("#")).toBe(true)
    }
  })

  it("rejects non-NIP-46 schemes and malformed scheme prefixes", () => {
    for (const request of [
      "https://example.test/connect",
      "nostrsigner:request",
      "bunker:request",
      "intent:request",
      "nostrconnect:request",
    ]) {
      expect(() => androidSignerConnectUrl("amber", request)).toThrow(TypeError)
    }
  })

  it("rejects fragments before they can inject Android intent options", () => {
    const request = connectionFixture()
    for (const fragment of [
      "#",
      "#section",
      "#Intent;package=example.untrusted;S.browser_fallback_url=https%3A%2F%2Fexample.test;end",
    ]) {
      expect(() =>
        androidSignerConnectUrl("primal", request + fragment)
      ).toThrow(TypeError)
    }
  })

  it("rejects raw whitespace and controls that browsers could normalize", () => {
    const request = connectionFixture()
    for (const control of [" ", "\n", "\r", "\t", "\u0000", "\u007f"]) {
      expect(() => androidSignerConnectUrl("amber", request + control)).toThrow(
        TypeError
      )
    }
  })

  it("rejects arbitrary packages and inherited object keys at runtime", () => {
    const request = connectionFixture()
    for (const signer of ["example.untrusted", "__proto__", "toString"]) {
      expect(() =>
        androidSignerConnectUrl(signer as AndroidSigner, request)
      ).toThrow(TypeError)
    }
  })
})
