import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  browserSecurityHeaders,
  assertBuiltScriptBoundary,
} from "../scripts/vite/browser_security"
import { createThemeBootstrapScript } from "../packages/ui/src/theme/definitions"

describe("built browser execution boundary", () => {
  it("rejects arbitrary executable telemetry configuration", () => {
    for (const source of [
      "https://attacker.invalid/a.js",
      "https://plausible.io.attacker.invalid/js/a.js",
      "data:text/javascript,",
      "https://plausible.io/js/a.js?redirect=x",
      "/uploads/code.js",
    ]) {
      expect(() =>
        browserSecurityHeaders({
          VITE_ENABLE_TELEMETRY: "true",
          VITE_PLAUSIBLE_SRC: source,
        })
      ).toThrow()
    }
    expect(
      browserSecurityHeaders({
        VITE_ENABLE_TELEMETRY: "true",
        VITE_PLAUSIBLE_SRC: "https://plausible.io/js/pa-site.js",
      })["Content-Security-Policy"]
    ).toContain("https://plausible.io/js/pa-site.js")
    expect(browserSecurityHeaders()["Content-Security-Policy"]).not.toContain(
      "plausible.io"
    )
  })
  it("never authorizes an additional inline or remote entry script automatically", () => {
    const theme = `<script>${createThemeBootstrapScript()}</script>`
    expect(() =>
      assertBuiltScriptBoundary(
        `${theme}<script type="module" src="/assets/index-abc.js"></script>`
      )
    ).not.toThrow()
    for (const extra of [
      "<script>alert(1)</script>",
      '<script src="https://example.invalid/a.js"></script>',
      '<script src="//example.invalid/a.js"></script>',
      '<script src="/uploads/a.js"></script>',
    ]) {
      expect(() => assertBuiltScriptBoundary(theme + extra)).toThrow()
    }
    expect(() => assertBuiltScriptBoundary(theme + theme)).toThrow()
  })
  it("keeps both application builds under the shared policy", () => {
    for (const app of ["market", "merchant"]) {
      expect(readFileSync(`apps/${app}/vite.config.ts`, "utf8")).toContain(
        "createBrowserSecurityPlugin()"
      )
    }
  })
})

describe("explicit browser execution sinks", () => {
  it("requires review for new script loaders and HTML/code execution sinks", async () => {
    const approvedLoaders = new Set([
      "packages/core/src/telemetry.ts",
      "packages/ui/src/components/AddressNameRequestForm.tsx",
    ])
    const observedLoaders = new Set<string>()
    for (const root of [
      "apps/market/src",
      "apps/merchant/src",
      "packages/core/src",
      "packages/ui/src",
    ]) {
      for await (const path of new Bun.Glob("**/*.{ts,tsx,js,jsx}").scan(
        root
      )) {
        const name = `${root}/${path}`
        const source = readFileSync(name, "utf8")
        // A regression alarm for explicit sinks, not a complete XSS detector.
        expect(source, name).not.toMatch(
          /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(/
        )
        if (/createElement\s*\(\s*["']script["']/.test(source)) {
          expect(approvedLoaders.has(name), name).toBe(true)
          observedLoaders.add(name)
        }
      }
    }
    expect(observedLoaders).toEqual(approvedLoaders)
  })
})
