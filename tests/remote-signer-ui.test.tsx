import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { renderToStaticMarkup } from "react-dom/server"

import {
  SignerConnectPanel,
  isMobileSignerEnvironment,
} from "../packages/ui/src/components/SignerSwitch"
import {
  ClaveConnectButton,
  claveConnectUrl,
} from "../packages/ui/src/components/ClaveConnectButton"
import { SignerAuthUrlNotice } from "../packages/ui/src/components/SignerAuthUrlNotice"
import { ProductSignerRecoveryNotice } from "../apps/merchant/src/components/ProductSignerRecoveryNotice"

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
const nostrConnectUrl = new URL("nostrconnect://client-pubkey")
nostrConnectUrl.searchParams.set("relay", "wss://relay.example")
nostrConnectUrl.searchParams.set("secret", crypto.randomUUID())
const nostrConnectUri = nostrConnectUrl.toString()
const claveConnectPrefix = "https://clave.casa/connect/?uri="

function linkAttributes(markup: string, label: string): string {
  return (
    Array.from(markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)).find((match) =>
      match[2]?.includes(label)
    )?.[1] ?? ""
  )
}

function hasDisabledButton(markup: string, label: string): boolean {
  return Array.from(
    markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)
  ).some(
    (match) => match[1]?.includes('disabled=""') && match[2]?.includes(label)
  )
}

describe("remote signer UI", () => {
  it("detects phone and touch-first iPad environments", () => {
    expect(
      isMobileSignerEnvironment({ userAgent: "Mozilla/5.0 (iPhone) Mobile" })
    ).toBe(true)
    expect(
      isMobileSignerEnvironment({
        userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
      })
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

  it("offers extension and manual remote connections on desktop", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} platform="desktop" />
    )

    expect(markup.includes("Connect Extension (NIP-07)")).toBe(true)
    expect(markup.includes("Scan QR")).toBe(true)
    expect(markup.includes("Copy link")).toBe(true)
    expect(markup.includes("Paste bunker")).toBe(true)
    expect(markup.includes("Start new connection")).toBe(true)
    expect(markup.includes("Other ways to connect")).toBe(false)
    expect(markup.includes("Your account keys stay in your signer app.")).toBe(
      true
    )
    expect(markup.includes("Conduit cannot recover them.")).toBe(true)
    expect(
      markup.includes("This device remembers an encrypted connection")
    ).toBe(true)
  })

  it("keeps the iOS Clave action disabled until its connection is ready", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="ios"
        connectPending
        connectingMethod="nip46"
      />
    )

    expect(hasDisabledButton(markup, "Connect with Clave")).toBe(true)
    expect(markup.includes("Preparing your connection…")).toBe(true)
    expect(markup.includes("clave.casa/connect")).toBe(false)
    expect(markup.includes("Connect Extension (NIP-07)")).toBe(false)
    expect(markup.includes("Amber")).toBe(false)
    expect(markup.includes("Primal")).toBe(false)
    expect(markup.includes('aria-expanded="false"')).toBe(true)
    expect(markup.includes("Other ways to connect")).toBe(true)
    expect(markup.includes('role="tablist"')).toBe(false)
    expect(markup.includes("Nostr Connect connection QR code")).toBe(false)
  })

  it("offers only Clave as the iOS app handoff once its connection is ready", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="ios"
        nostrConnectUri={nostrConnectUri}
        connectPending
        connectingMethod="nip46"
      />
    )
    const handoff = linkAttributes(markup, "Connect with Clave")
    const install = linkAttributes(markup, "Get Clave on the App Store")

    expect(handoff.includes(`href="${claveConnectUrl(nostrConnectUri)}"`)).toBe(
      true
    )
    expect(handoff.includes('target="_self"')).toBe(true)
    expect(hasDisabledButton(markup, "Connect with Clave")).toBe(false)
    expect(
      install.includes('href="https://apps.apple.com/app/id6762104155"')
    ).toBe(true)
    expect(markup.includes("Ready. Open your app to approve sign-in.")).toBe(
      true
    )
    expect(markup.includes("Amber")).toBe(false)
    expect(markup.includes("Primal")).toBe(false)
    expect(markup.includes("github.com")).toBe(false)
    expect(markup.includes('href="nostrconnect:')).toBe(false)
    expect(markup.includes('href="intent:')).toBe(false)
    expect(markup.includes('role="tablist"')).toBe(false)
    expect(markup.includes("Other ways to connect")).toBe(true)
  })

  it("keeps both Android app choices disabled until the connection is ready", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} platform="android" />
    )

    expect(hasDisabledButton(markup, "Use Amber")).toBe(true)
    expect(hasDisabledButton(markup, "Use Primal")).toBe(true)
    expect(markup.includes('href="intent:')).toBe(false)
    expect(markup.includes("Connect with Clave")).toBe(false)
    expect(markup.includes("Connect Extension (NIP-07)")).toBe(false)
    expect(markup.includes("Other ways to connect")).toBe(true)
    expect(markup.includes('role="tablist"')).toBe(false)
  })

  it("targets the chosen Android app with the exact same connection request", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="android"
        nostrConnectUri={nostrConnectUri}
      />
    )
    const choices = [
      ["Use Amber", "com.greenart7c3.nostrsigner"],
      ["Use Primal", "net.primal.android"],
    ] as const

    for (const [label, packageName] of choices) {
      const attributes = linkAttributes(markup, label)
      const href =
        attributes.match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&") ?? ""
      const intentSuffix = `#Intent;scheme=nostrconnect;package=${packageName};end`

      expect(href.startsWith("intent:")).toBe(true)
      expect(href.endsWith(intentSuffix)).toBe(true)
      expect(
        "nostrconnect:" + href.slice("intent:".length, -intentSuffix.length) ===
          nostrConnectUri
      ).toBe(true)
      expect(attributes.includes('target="_self"')).toBe(true)
      expect(href.includes("browser_fallback_url")).toBe(false)
    }
    expect(markup.match(/href="intent:/g)?.length).toBe(2)
    expect(markup.includes("Connect with Clave")).toBe(false)
    expect(markup.includes('href="nostrconnect:')).toBe(false)
    expect(markup.includes("github.com")).toBe(false)
    expect(markup.includes('role="tablist"')).toBe(false)
  })

  it("links Android installation to the official app listings", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} platform="android" />
    )
    const amber = linkAttributes(markup, "Get Amber on F-Droid")
    const primal = linkAttributes(markup, "Get Primal on Google Play")

    expect(
      amber.includes(
        'href="https://f-droid.org/en/packages/com.greenart7c3.nostrsigner/"'
      )
    ).toBe(true)
    expect(
      primal.includes(
        'href="https://play.google.com/store/apps/details?id=net.primal.android"'
      )
    ).toBe(true)
    for (const attributes of [amber, primal]) {
      expect(attributes.includes('target="_blank"')).toBe(true)
      expect(attributes.includes('rel="noopener noreferrer"')).toBe(true)
    }
  })

  it("keeps manual connections available on an unknown mobile platform", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} platform="unknown-mobile" />
    )

    expect(
      markup.includes('aria-label="Remote signer connection method"')
    ).toBe(true)
    expect(markup.includes("Scan QR")).toBe(true)
    expect(markup.includes("Copy link")).toBe(true)
    expect(markup.includes("Paste bunker")).toBe(true)
    expect(markup.includes("Connect Extension (NIP-07)")).toBe(false)
    expect(markup.includes("Connect with Clave")).toBe(false)
    expect(markup.includes("Use Amber")).toBe(false)
    expect(markup.includes("Use Primal")).toBe(false)
  })

  it("renders the supplied ephemeral connection as an accessible QR code", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="desktop"
        nostrConnectUri={nostrConnectUri}
      />
    )

    expect(
      markup.includes('aria-label="Remote signer connection method"')
    ).toBe(true)
    expect(
      markup.includes('aria-label="Nostr Connect connection QR code"')
    ).toBe(true)
    expect(markup.includes("<svg")).toBe(true)
    expect(
      markup.includes("Scan with the signer app on your other device.")
    ).toBe(true)
    expect(markup.includes("Start new connection")).toBe(false)
    expect(markup.includes('href="nostrconnect:')).toBe(false)
  })

  it("wraps the Nostr Connect URI in the Clave Universal Link exactly once", () => {
    const url = claveConnectUrl(nostrConnectUri)

    expect(url.startsWith(claveConnectPrefix)).toBe(true)
    expect(nostrConnectUri.includes("%3A%2F%2F")).toBe(true)
    expect(url.includes("%253A%252F%252F")).toBe(true)
    expect(
      decodeURIComponent(url.slice(claveConnectPrefix.length)) ===
        nostrConnectUri
    ).toBe(true)
    expect(new URL(url).searchParams.get("uri") === nostrConnectUri).toBe(true)
  })

  it("renders the Connect with Clave handoff as a same-tab link", () => {
    const markup = renderToStaticMarkup(
      <ClaveConnectButton nostrConnectUri={nostrConnectUri} />
    )
    const handoff = linkAttributes(markup, "Connect with Clave")

    expect(handoff.includes(`href="${claveConnectUrl(nostrConnectUri)}"`)).toBe(
      true
    )
    expect(handoff.includes('target="_self"')).toBe(true)
    expect(markup.includes('alt=""')).toBe(true)
    expect(markup.includes('src="data:image/png;base64,')).toBe(true)
    expect(markup.includes("clave.casa/brand")).toBe(false)
  })

  it("provides readonly URL copy semantics without persisting pairing data", async () => {
    const source = await readFile(
      "packages/ui/src/components/RemoteSignerConnect.tsx",
      "utf8"
    )

    const manual = await readFile(
      "packages/ui/src/components/ManualSignerConnection.tsx",
      "utf8"
    )
    expect(manual).toContain('aria-label="Nostr Connect connection URL"')
    expect(manual).toContain("readOnly")
    expect(source).toContain("navigator.clipboard.writeText(nostrConnectUri)")
    expect(source).toContain('document.execCommand("copy")')
    expect(source).toContain('"Copy connection link"')
    expect(source).not.toContain("Open in signer")
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

  it("offers an explicit pairing cancellation action", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="ios"
        nostrConnectUri={nostrConnectUri}
        connectPending
        connectingMethod="nip46"
      />
    )

    expect(markup.includes("Cancel pairing")).toBe(true)
    expect(hasDisabledButton(markup, "Cancel pairing")).toBe(false)
    expect(markup.includes('role="status"')).toBe(true)
  })

  it("uses visible remote pairing labels with decorative icons", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel {...commonProps} platform="desktop" />
    )

    expect(markup.includes("Scan QR")).toBe(true)
    expect(markup.includes("Copy link")).toBe(true)
    expect(markup.includes("Paste bunker")).toBe(true)
    expect(markup.includes('aria-hidden="true"')).toBe(true)
  })

  it("uses one explicit momentum scroll surface for the signer dialog", async () => {
    const source = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )

    expect(source).toContain("overflow-y-auto overscroll-contain")
    expect(source).toContain("[-webkit-overflow-scrolling:touch]")
    expect(source).toContain('<div className="relative rounded-[inherit]">')
    expect(source).not.toContain(
      '<div className="relative rounded-[inherit] border border-[var(--border)] bg-[var(--surface-dialog)]">'
    )
  })

  it("allows an unavailable remembered remote session to be forgotten", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="desktop"
        rememberedMethod="nip46"
        onReconnect={() => undefined}
        onForget={() => undefined}
      />
    )

    expect(markup.includes("Reconnect your account")).toBe(true)
    expect(markup.includes("Forget remote signer")).toBe(true)
  })

  it("retains the bunker draft when the pairing promise resolves or rejects", async () => {
    const source = await readFile(
      "packages/ui/src/components/RemoteSignerConnect.tsx",
      "utf8"
    )
    const start = source.indexOf("async function submitBunker(): Promise<void>")
    const end = source.indexOf("async function copyConnectionUrl", start)
    const submit = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(submit).toContain("await onConnectBunker(bunkerUri.trim())")
    expect(submit).not.toContain("setBunkerUri(")
  })

  it("keeps connection errors beside the remote signer controls", () => {
    const markup = renderToStaticMarkup(
      <SignerConnectPanel
        {...commonProps}
        platform="ios"
        error="The signer did not respond. Try again."
      />
    )

    expect(markup.includes('role="alert"')).toBe(true)
    expect(markup.includes("The signer did not respond. Try again.")).toBe(true)
    expect(
      markup.indexOf("The signer did not respond. Try again.")
    ).toBeGreaterThan(markup.indexOf("Other ways to connect"))
    expect(
      markup.indexOf("The signer did not respond. Try again.")
    ).toBeLessThan(markup.indexOf("Sign events without sharing keys."))
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

  it("renders truthful accessible recovery actions without an awaiting flash", () => {
    const savedMarkup = renderToStaticMarkup(
      <ProductSignerRecoveryNotice
        draftStorageAvailable
        reconnecting={false}
        restoreFailed={false}
        changingSigner={false}
        changeSignerError={null}
        onReconnect={async () => undefined}
        onUseDifferentSigner={async () => undefined}
      />
    )
    const savedFailedMarkup = renderToStaticMarkup(
      <ProductSignerRecoveryNotice
        draftStorageAvailable
        reconnecting={false}
        restoreFailed
        changingSigner={false}
        changeSignerError={null}
        onReconnect={async () => undefined}
        onUseDifferentSigner={async () => undefined}
      />
    )
    const unsavedFailedMarkup = renderToStaticMarkup(
      <ProductSignerRecoveryNotice
        draftStorageAvailable={false}
        reconnecting={false}
        restoreFailed
        changingSigner={false}
        changeSignerError={null}
        onReconnect={async () => undefined}
        onUseDifferentSigner={async () => undefined}
      />
    )

    expect(savedMarkup).toContain('role="alert"')
    expect(savedMarkup).toContain("Reconnect signer")
    expect(savedMarkup).toContain("draft is saved on this device")
    expect(savedMarkup).not.toContain("Waiting for signer")
    expect(unsavedFailedMarkup).toContain("Keep this page open")
    expect(savedFailedMarkup).toContain("Use a different signer")
    expect(savedFailedMarkup).toContain("remain saved for this account")
    expect(unsavedFailedMarkup).not.toContain("Use a different signer")
    expect(unsavedFailedMarkup).toContain(
      "another signer cannot be opened safely"
    )
  })
})
