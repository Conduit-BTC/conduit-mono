import { describe, expect, it } from "bun:test"
import {
  getProductImageCandidates,
  isPublicNetworkHostname,
  MAX_PRODUCT_IMAGE_CANDIDATES,
  normalizePublicHttpsUrl,
  normalizePublicMediaUrl,
  normalizePublicWebSocketUrl,
} from "@conduit/core"

describe("public network target safety", () => {
  it("preserves ordinary public media destinations", () => {
    expect(
      normalizePublicMediaUrl(
        "https://cdn.example.com:8443/products/item.png?token=a%2Fb#preview"
      )
    ).toBe("https://cdn.example.com:8443/products/item.png?token=a%2Fb#preview")
    expect(normalizePublicMediaUrl("http://images.example.com/item.jpg")).toBe(
      "http://images.example.com/item.jpg"
    )
    expect(normalizePublicMediaUrl("https://8.8.8.8/item.jpg")).toBe(
      "https://8.8.8.8/item.jpg"
    )
    expect(
      normalizePublicMediaUrl("https://[2001:4860:4860::8888]/item.jpg")
    ).toBe("https://[2001:4860:4860::8888]/item.jpg")
  })

  it("rejects credentials, unsupported schemes, relative URLs, and whitespace", () => {
    for (const value of [
      "/image.png",
      "//cdn.example.com/image.png",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "https://user:secret@cdn.example.com/image.png",
      " https://cdn.example.com/image.png",
    ]) {
      expect(normalizePublicMediaUrl(value)).toBeNull()
    }
  })

  it("rejects local and special-use names", () => {
    for (const hostname of [
      "localhost",
      "LOCALHOST.",
      "images.localhost",
      "images.localhost\u3002",
      "printer.local",
      "router.internal",
      "device.home",
      "gateway.lan",
      "service.home.arpa",
      "intranet",
    ]) {
      expect(isPublicNetworkHostname(hostname)).toBe(false)
      expect(
        normalizePublicMediaUrl(`https://${hostname}/image.png`)
      ).toBeNull()
    }
  })

  it("rejects private, loopback, link-local, and reserved IPv4 forms", () => {
    for (const hostname of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.1",
      "192.168.1.1",
      "192.31.196.1",
      "192.52.193.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "2130706433",
      "0x7f000001",
      "127.1",
      "999.999.999.999",
    ]) {
      expect(normalizePublicMediaUrl(`http://${hostname}/image.png`)).toBeNull()
    }
  })

  it("rejects non-global and transition IPv6 destinations", () => {
    for (const hostname of [
      "[::]",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[2001:db8::1]",
      "[2002:7f00:1::]",
    ]) {
      expect(
        normalizePublicMediaUrl(`https://${hostname}/image.png`)
      ).toBeNull()
    }
  })

  it("applies protocol-specific policy to fetch and relay destinations", () => {
    expect(
      normalizePublicHttpsUrl("https://identity.example/.well-known/x")
    ).toBe("https://identity.example/.well-known/x")
    expect(normalizePublicHttpsUrl("http://identity.example/x")).toBeNull()
    expect(
      normalizePublicHttpsUrl("https://identity.example/x#fragment")
    ).toBeNull()
    expect(normalizePublicWebSocketUrl("wss://relay.example.com/path")).toBe(
      "wss://relay.example.com/path"
    )
    expect(
      normalizePublicWebSocketUrl("ws://relay.example.com/path")
    ).toBeNull()
    expect(normalizePublicWebSocketUrl("wss://127.0.0.1:7777")).toBeNull()
  })

  it("deduplicates and caps product image request candidates", () => {
    const images = [
      { url: "http://127.0.0.1/private.png" },
      ...Array.from(
        { length: MAX_PRODUCT_IMAGE_CANDIDATES + 5 },
        (_, index) => ({
          url: `https://cdn.example.com/${index}.png`,
        })
      ),
      { url: "https://cdn.example.com/0.png" },
    ]

    const candidates = getProductImageCandidates({ images })

    expect(candidates).toHaveLength(MAX_PRODUCT_IMAGE_CANDIDATES)
    expect(candidates[0]?.url).toBe("https://cdn.example.com/0.png")
    expect(new Set(candidates.map((image) => image.url)).size).toBe(
      MAX_PRODUCT_IMAGE_CANDIDATES
    )
  })
})
