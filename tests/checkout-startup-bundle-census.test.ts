import { describe, expect, it } from "bun:test"
import { measureEmittedCheckoutStartupBundle } from "../scripts/dev/measure_checkout_startup_bundle"

const encode = (value: string) => new TextEncoder().encode(value)

describe("checkout startup emitted-byte census", () => {
  it("separates the static entry closure from literal dynamic imports without executing source", () => {
    const javascript = new Map([
      [
        "assets/entry.js",
        encode(
          'import "./shared.js"; import("./sdk.js"); throw new Error("Must not execute")'
        ),
      ],
      [
        "assets/shared.js",
        encode('import "./entry.js"; export const shared = 1'),
      ],
      [
        "assets/sdk.js",
        encode('import "./sdk-vendor.js"; export const sdk = 1'),
      ],
      ["assets/sdk-vendor.js", encode("export const dependency = 1")],
      [".well-known/probe.js", encode("export const probe = 1")],
    ])
    const result = measureEmittedCheckoutStartupBundle({
      indexHtml:
        '<script type="module" src="/assets/entry.js"></script><link rel="modulepreload" href="/assets/shared.js">',
      javascript,
    })
    expect(result.moduleEntriesAndPreloads).toBe(2)
    expect(result.initialStaticJavaScript.chunks).toBe(2)
    expect(result.initialStaticJavaScript.bytes).toBe(
      javascript.get("assets/entry.js")!.byteLength +
        javascript.get("assets/shared.js")!.byteLength
    )
    expect(result.deferredLiteralImportJavaScript.chunks).toBe(2)
    expect(result.otherEmittedJavaScript.chunks).toBe(1)
    expect(result.allEmittedJavaScript.chunks).toBe(5)
    expect(result.allEmittedJavaScript.gzip9Bytes).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain("Must not execute")
    expect(JSON.stringify(result)).not.toContain("assets/")
  })

  it.each(["https://example.test/entry.js", "../outside.js"])(
    "rejects nonlocal or escaping roots without fetching: %s",
    (path) => {
      expect(() =>
        measureEmittedCheckoutStartupBundle({
          indexHtml: `<script type="module" src="${path}"></script>`,
          javascript: new Map(),
        })
      ).toThrow()
    }
  )

  it("fails rather than undercounting a missing static module", () => {
    expect(() =>
      measureEmittedCheckoutStartupBundle({
        indexHtml: '<script type="module" src="/assets/entry.js"></script>',
        javascript: new Map([
          ["assets/entry.js", encode('import "./missing.js"')],
        ]),
      })
    ).toThrow("missing emitted module")
  })

  it("bounds the number of emitted chunks", () => {
    expect(() =>
      measureEmittedCheckoutStartupBundle({
        indexHtml: '<script type="module" src="/assets/entry.js"></script>',
        javascript: new Map(
          Array.from({ length: 513 }, (_, index) => [
            `${index}.js`,
            new Uint8Array(),
          ])
        ),
      })
    ).toThrow("artifact budget")
  })
})
