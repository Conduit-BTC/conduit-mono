import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin, ResolvedConfig } from "vite"
import { createThemeBootstrapScript } from "../../packages/ui/src/theme/definitions.ts"

// These are executable dependencies, not general network destinations. Any new
// source requires review here; an environment variable cannot expand this list.
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com"
const CLOUDFLARE_ANALYTICS_ORIGIN = "https://static.cloudflareinsights.com"

export function browserSecurityHeaders(
  env: Record<string, string | undefined> = {}
): Record<string, string> {
  const scripts = [
    "'self'",
    // Spark's existing browser wallet compiles WebAssembly. This does not
    // permit JavaScript eval or Function constructors.
    "'wasm-unsafe-eval'",
    `'sha256-${createHash("sha256").update(createThemeBootstrapScript()).digest("base64")}'`,
    TURNSTILE_ORIGIN,
    // Hosting injects the approved Cloudflare Web Analytics beacon.
    CLOUDFLARE_ANALYTICS_ORIGIN,
  ]
  if (
    env.VITE_ENABLE_TELEMETRY?.trim().toLowerCase() === "true" &&
    (env.VITE_PLAUSIBLE_DOMAIN?.trim() || env.VITE_PLAUSIBLE_SRC?.trim())
  ) {
    const source =
      env.VITE_PLAUSIBLE_SRC?.trim() || "https://plausible.io/js/script.js"
    // Official product hosts already disable Plausible. Preserve the optional
    // legacy integration on other hosts without trusting arbitrary script URLs.
    if (!/^https:\/\/plausible\.io\/js\/[a-zA-Z0-9._-]+\.js$/.test(source)) {
      throw new Error(
        "Plausible script source requires a reviewed browser policy"
      )
    }
    scripts.push(source)
  }
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src ${scripts.join(" ")}`,
      "script-src-attr 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `frame-src ${TURNSTILE_ORIGIN}`,
      "worker-src 'self'",
      // User-selected relays, media, uploads and wallet endpoints are open
      // network capabilities. This is not an exfiltration-prevention claim.
      "connect-src 'self' https: http: wss: ws:",
      "img-src 'self' https: http: data: blob:",
      "media-src 'self' https: http: data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "manifest-src 'self'",
      "form-action 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  }
}

export function assertBuiltScriptBoundary(html: string): void {
  let themeScripts = 0
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  )) {
    const attributes = match[1] ?? ""
    const content = match[2] ?? ""
    const source = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
    if (source) {
      if (!/^\/assets\/[a-zA-Z0-9._-]+\.js$/.test(source) || content.trim()) {
        throw new Error("Unreviewed script in built application HTML")
      }
    } else if (content === createThemeBootstrapScript()) {
      themeScripts++
    } else {
      throw new Error("Unreviewed inline script in built application HTML")
    }
  }
  if (themeScripts !== 1)
    throw new Error("Expected one reviewed theme bootstrap")
}

export function createBrowserSecurityPlugin(): Plugin {
  let config: ResolvedConfig
  let headers: Record<string, string>
  return {
    name: "conduit-browser-security",
    apply: "build",
    config() {
      // NDK's locked emitter already ships this API-compatible no-eval entry.
      // Keep its event machinery working under CSP without weakening script-src.
      const require = createRequire(import.meta.url)
      const ndkRequire = createRequire(require.resolve("@nostr-dev-kit/ndk"))
      return {
        resolve: {
          alias: [
            {
              find: /^tseep$/,
              replacement: ndkRequire.resolve("tseep/lib/ee-safe.js"),
            },
          ],
        },
      }
    },
    configResolved(resolved) {
      config = resolved
      headers = browserSecurityHeaders({
        ...resolved.env,
        ...process.env,
      })
    },
    async closeBundle() {
      const output = resolve(config.root, config.build.outDir)
      assertBuiltScriptBoundary(
        await readFile(resolve(output, "index.html"), "utf8")
      )
      // Pages applies this wildcard to assets and SPA fallback paths. Existing
      // /api Functions return JSON, not documents; Functions do not inherit it.
      await writeFile(
        resolve(output, "_headers"),
        `/*\n${Object.entries(headers)
          .map(([name, value]) => `  ${name}: ${value}`)
          .join("\n")}\n`
      )
    },
  }
}
