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
  onConnectNostrConnect: () => undefined,
  onConnectRemote: () => undefined,
  onCancelConnect: () => undefined,
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
    expect(markup).toContain("QR code")
    expect(markup).toContain("Connection URL")
    expect(markup).toContain("Bunker URL")
    expect(markup).toContain("Create connection")
    expect(markup).toContain("Conduit never stores or recovers your keys.")
  })

  it("offers only the remote signer connection on mobile", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} mobile />
    )

    expect(markup).not.toContain("Connect Extension (NIP-07)")
    expect(markup).toContain("QR code")
    expect(markup).toContain("Connection URL")
    expect(markup).toContain("Bunker URL")
    expect(markup).toContain("Need a remote signer?")
    expect(markup).toContain("Amber")
    expect(markup).toContain("Clave")
  })

  it("renders the supplied ephemeral connection as an accessible QR code", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        nostrConnectUri="nostrconnect://client-pubkey?relay=wss%3A%2F%2Frelay.example&secret=temporary"
      />
    )

    expect(markup).toContain('aria-label="Remote signer connection method"')
    expect(markup).toContain('aria-label="Nostr Connect connection QR code"')
    expect(markup).toContain("<svg")
    expect(markup).not.toContain("Create connection")
  })

  it("provides readonly URL copy semantics without persisting pairing data", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )

    expect(source).toContain('aria-label="Nostr Connect connection URL"')
    expect(source).toContain("readOnly")
    expect(source).toContain("navigator.clipboard.writeText(nostrConnectUri)")
    expect(source).toContain('document.execCommand("copy")')
    expect(source).toContain('"Copy connection URL"')
    expect(source).toContain("Open in signer")
    expect(source).toContain('aria-live="polite"')
    expect(source).not.toContain("localStorage")
    expect(source).not.toContain("sessionStorage")
    expect(source).not.toContain("indexedDB")
  })

  it("wires the same Nostr Connect flow through both apps", async () => {
    const [market, merchant, merchantRoot] = await Promise.all([
      readFile("apps/market/src/components/SignerSwitch.tsx", "utf8"),
      readFile("apps/merchant/src/components/SignerSwitch.tsx", "utf8"),
      readFile("apps/merchant/src/routes/__root.tsx", "utf8"),
    ])

    for (const source of [market, merchant, merchantRoot]) {
      expect(source).toContain("nostrConnectUri")
      expect(source).toContain('nip46Flow: "nostrconnect"')
      expect(source).toContain("onConnectNostrConnect")
      expect(source).toContain("onCancelConnect")
    }
  })

  it("offers an explicit pairing cancellation action", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )

    expect(source).toContain("Cancel pairing")
    expect(source).toContain("onCancelConnect")
  })

  it("uses a clear selected state with a contained button glow", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )

    expect(source).toContain("data-[state=active]:bg-primary-500")
    expect(source).toContain("data-[state=active]:text-white")
    expect(source).toContain("data-[state=active]:border-primary-600")
    expect(source).toContain(
      "shadow-[0_8px_20px_color-mix(in_srgb,var(--primary-500)_24%,transparent)]"
    )
    expect(source).toContain(
      "data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--primary-500)_1%,var(--surface))]"
    )
    expect(source).not.toContain("shadow-[0_18px_38px")
  })

  it("closes the signer dialog after Nostr Connect pairing succeeds", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )
    const start = source.indexOf(
      "async function handleConnectNostrConnect(): Promise<void>"
    )
    const handler = source.slice(
      start,
      source.indexOf("async function handleSwitchSigner", start)
    )

    expect(handler.indexOf("await onConnectNostrConnect()")).toBeLessThan(
      handler.indexOf("setPendingSwitch(false)")
    )
    expect(handler.indexOf("setPendingSwitch(false)")).toBeLessThan(
      handler.indexOf("setOpen(false)")
    )
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

  it("retains the bunker URI until remote pairing succeeds", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )
    const start = source.indexOf("async function submitBunker(): Promise<void>")
    const submit = source.slice(start, source.indexOf("return (", start))

    expect(submit.indexOf("await onConnectBunker(uri)")).toBeLessThan(
      submit.indexOf('setBunkerUri("")')
    )
    expect(source).toContain("Waiting for approval from your remote signer")
  })

  it("keeps connection errors beside the remote signer controls", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )
    const disconnected = source.slice(
      source.indexOf("function SignerDisconnectedContent"),
      source.indexOf("export function SignerConnectPanel")
    )

    expect(disconnected.indexOf("{error && (")).toBeGreaterThan(
      disconnected.indexOf("<RemoteSignerConnect")
    )
    expect(disconnected.indexOf("{error && (")).toBeLessThan(
      disconnected.indexOf("<SignerUnlockCard")
    )
    expect(disconnected).toContain('role="alert"')
  })

  it("shows signer progress before waiting for the browser-wide lock", async () => {
    const source = await readFile(
      "packages/core/src/context/AuthContext.tsx",
      "utf8"
    )
    const connectStart = source.indexOf("const connect = useCallback")
    const connect = source.slice(
      connectStart,
      source.indexOf("const disconnectWithoutLock", connectStart)
    )

    expect(connect.indexOf("setStatus(")).toBeLessThan(
      connect.indexOf("withBrowserAuthOperationLock")
    )
  })

  it("checks encrypted storage before contacting the remote signer", async () => {
    const source = await readFile(
      "packages/core/src/protocol/remote-signer.ts",
      "utf8"
    )
    const start = source.indexOf("export async function pairRemoteSigner")
    const remoteConnect = source.slice(
      start,
      source.indexOf("export async function restoreRemoteSigner", start)
    )

    expect(
      remoteConnect.indexOf(
        "prepareRemoteSignerSessionStorage(options.keyVault)"
      )
    ).toBeLessThan(remoteConnect.indexOf('bunkerSigner.sendRequest("connect"'))
  })

  it("waits beyond an abandoned browser auth lease", async () => {
    const source = await readFile(
      "packages/core/src/protocol/remote-signer-vault.ts",
      "utf8"
    )

    expect(source).toContain(
      "const AUTH_OPERATION_WAIT_MS = AUTH_OPERATION_LEASE_MS + 5_000"
    )
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
