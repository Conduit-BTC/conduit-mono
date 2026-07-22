import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { renderToStaticMarkup } from "react-dom/server"

import {
  SignerConnectPanel,
  isMobileSignerEnvironment,
} from "../packages/ui/src/components/SignerSwitch"
import { SignerAuthUrlNotice } from "../packages/ui/src/components/SignerAuthUrlNotice"

const commonProps = {
  description: "Connect to continue.",
  helperText: "Choose a signer.",
  unlockItems: ["Sign events without sharing keys."],
  extensionAvailable: true,
  onConnectExtension: () => undefined,
  onConnectRemote: () => undefined,
}

describe("remote signer UI", () => {
  it("detects phone and touch-first iPad environments", () => {
    expect(
      isMobileSignerEnvironment({ userAgent: "Mozilla/5.0 (iPhone) Mobile" })
    ).toBe(true)
    expect(
      isMobileSignerEnvironment({
        userAgent: "Mozilla/5.0 (Macintosh)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      })
    ).toBe(true)
    expect(
      isMobileSignerEnvironment({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
      })
    ).toBe(false)
  })

  it("offers extension and remote signer connections on desktop", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} mobile={false} />
    )

    expect(markup).toContain("Connect Extension (NIP-07)")
    expect(markup).toContain("Connect Signer (NIP-46)")
    expect(markup).toContain("bunker://...")
    expect(markup).toContain("Conduit never stores or recovers your keys.")
  })

  it("offers only the remote signer connection on mobile", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} mobile />
    )

    expect(markup).not.toContain("Connect Extension (NIP-07)")
    expect(markup).toContain("Connect Signer (NIP-46)")
    expect(markup).toContain("Need a remote signer?")
    expect(markup).toContain("Amber")
    expect(markup).toContain("Clave")
  })

  it("allows an unavailable remembered remote session to be forgotten", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        rememberedMethod="nip46"
        onReconnect={() => undefined}
        onForget={() => undefined}
      />
    )

    expect(markup).toContain("Reconnect NIP-46 signer")
    expect(markup).toContain("Forget remote signer")
  })

  it("renders signer approval as a globally actionable notice", async () => {
    const markup = renderToStaticMarkup(
      <SignerAuthUrlNotice
        authUrl="https://signer.example/approve"
        onDismiss={() => undefined}
      />
    )
    const [marketRoot, merchantRoot] = await Promise.all([
      readFile("apps/market/src/routes/__root.tsx", "utf8"),
      readFile("apps/merchant/src/routes/__root.tsx", "utf8"),
    ])

    expect(markup).toContain("Signer approval required")
    expect(markup).toContain("https://signer.example/approve")
    expect(markup).toContain("Dismiss signer approval notice")
    for (const source of [marketRoot, merchantRoot]) {
      expect(source).toContain("SignerAuthUrlNotice")
      expect(source).toContain("onDismiss={dismissAuthUrl}")
    }
  })

  it("keeps signer telemetry method-aware and pairing data out of telemetry", async () => {
    const [marketRoot, merchantRoot] = await Promise.all([
      readFile("apps/market/src/routes/__root.tsx", "utf8"),
      readFile("apps/merchant/src/routes/__root.tsx", "utf8"),
    ])

    for (const source of [marketRoot, merchantRoot]) {
      expect(source).toContain('method: method ?? "nip07"')
      const telemetryBlocks = source.match(
        /recordBrowserTelemetryEvent\(\{[\s\S]*?\n\s*\}\)/g
      )
      expect(telemetryBlocks?.join("\n") ?? "").not.toContain("bunkerUri")
      expect(telemetryBlocks?.join("\n") ?? "").not.toContain(
        "clientPrivateKey"
      )
    }
  })
})
