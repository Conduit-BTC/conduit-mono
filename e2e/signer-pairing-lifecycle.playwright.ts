import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

interface PairingInput {
  autoPrepare?: boolean
  connectPending?: boolean
  connectDisabled?: boolean
  rememberedMethod?: "nip07" | "nip46" | null
  nostrConnectUri?: string | null
  error?: string | null
}

interface PairingHarness {
  starts: number
  bunkerStarts: number
  cancels: number
  start: () => void
  runBunker: () => void
  cancel: () => void
  settle: (attempt: number) => void
  update: (input: PairingInput) => void
  unmount: () => void
}

async function mountPairing(
  page: Page,
  initial: PairingInput = {},
  strict = false
): Promise<void> {
  const hookUrl = `/@fs${path.resolve(
    process.cwd(),
    "packages/ui/src/components/use-signer-pairing.ts"
  )}`
  await page.evaluate(
    async ({ url, initial, strict }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { useSignerPairing } = await import(url)
      const host = document.createElement("div")
      host.id = "signer-pairing-lifecycle-test"
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      let input = { autoPrepare: true, ...initial }
      const settlements: Array<() => void> = []
      const harness: PairingHarness = {
        starts: 0,
        bunkerStarts: 0,
        cancels: 0,
        start: () => undefined,
        runBunker: () => undefined,
        cancel: () => undefined,
        settle: (attempt) => settlements[attempt - 1]?.(),
        update: (next) => {
          input = { ...input, ...next }
          render()
        },
        unmount: () => {
          root.unmount()
          host.remove()
        },
      }
      window.__signerPairingHarness = harness

      function Harness() {
        const pairing = useSignerPairing({
          ...input,
          onConnect: () => {
            harness.starts += 1
            return new Promise<void>((resolve) => settlements.push(resolve))
          },
          onCancel: () => {
            harness.cancels += 1
          },
        })
        harness.start = () => void pairing.start()
        harness.runBunker = () =>
          void pairing.run(() => {
            harness.bunkerStarts += 1
            return new Promise<void>((resolve) => settlements.push(resolve))
          })
        harness.cancel = pairing.cancel
        return React.createElement("span", null, "Pairing harness ready")
      }

      function render() {
        const component = React.createElement(Harness)
        root.render(
          strict
            ? React.createElement(React.StrictMode, null, component)
            : component
        )
      }
      render()
    },
    { url: hookUrl, initial, strict }
  )
  await expect(
    page.getByText("Pairing harness ready", { exact: true })
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto(`${marketUrl}/products`)
})

test("mobile pairing prepares again after StrictMode cleanup and stays canceled after explicit cancel @market", async ({
  page,
}) => {
  await mountPairing(page, {}, true)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(2)
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )

  await page.evaluate(() => {
    window.__signerPairingHarness.update({
      connectPending: true,
      nostrConnectUri: "prepared-connection",
    })
  })
  await expect(
    page.getByText("Pairing harness ready", { exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__signerPairingHarness.starts)).toBe(
    2
  )
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )

  await page.evaluate(() => {
    window.__signerPairingHarness.cancel()
    window.__signerPairingHarness.update({
      connectPending: false,
      nostrConnectUri: null,
    })
  })
  await expect(
    page.getByText("Pairing harness ready", { exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__signerPairingHarness.starts)).toBe(
    2
  )
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    2
  )
  await page.evaluate(() => window.__signerPairingHarness.unmount())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    2
  )
})

test("an older pairing promise cannot release ownership of its replacement @market", async ({
  page,
}) => {
  await mountPairing(page)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(1)
  await page.evaluate(() => {
    window.__signerPairingHarness.start()
    window.__signerPairingHarness.cancel()
    window.__signerPairingHarness.start()
  })
  expect(await page.evaluate(() => window.__signerPairingHarness.starts)).toBe(
    2
  )
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )
  await page.evaluate(() => window.__signerPairingHarness.settle(1))
  await page.evaluate(() => window.__signerPairingHarness.start())
  expect(await page.evaluate(() => window.__signerPairingHarness.starts)).toBe(
    2
  )
  await page.evaluate(() => window.__signerPairingHarness.unmount())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    2
  )
})

test("remembered sessions and existing work do not start or cancel a new pairing automatically @market", async ({
  page,
}) => {
  const guardedInputs: PairingInput[] = [
    { autoPrepare: false },
    { rememberedMethod: "nip46" },
    { rememberedMethod: "nip07" },
    { connectPending: true },
    { connectDisabled: true },
    { nostrConnectUri: "existing-connection" },
    { error: "Connection failed" },
  ]
  for (const initial of guardedInputs) {
    await mountPairing(page, initial, true)
    await page.evaluate(() => {
      window.__signerPairingHarness.update({
        autoPrepare: true,
        rememberedMethod: null,
        connectPending: false,
        connectDisabled: false,
        nostrConnectUri: null,
        error: null,
      })
    })
    await expect(
      page.getByText("Pairing harness ready", { exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(() => window.__signerPairingHarness.starts)
    ).toBe(0)
    await page.evaluate(() => window.__signerPairingHarness.unmount())
    expect(
      await page.evaluate(() => window.__signerPairingHarness.cancels)
    ).toBe(0)
  }
})

test("a settled pairing does not cancel a later operation when the surface unmounts @market", async ({
  page,
}) => {
  await mountPairing(page)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(1)
  await page.evaluate(() => window.__signerPairingHarness.settle(1))
  await page.evaluate(() => window.__signerPairingHarness.unmount())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    0
  )
})

test("pasted signer connections share explicit cancellation and unmount ownership @market", async ({
  page,
}) => {
  await mountPairing(page, { autoPrepare: false })
  await page.evaluate(() => {
    window.__signerPairingHarness.runBunker()
    window.__signerPairingHarness.runBunker()
  })
  expect(
    await page.evaluate(() => window.__signerPairingHarness.bunkerStarts)
  ).toBe(1)
  await page.evaluate(() => window.__signerPairingHarness.cancel())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )
  await page.evaluate(() => window.__signerPairingHarness.unmount())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )
})

async function mountSignerModal(
  page: Page,
  initialConnected = false
): Promise<void> {
  const runtimeErrors: string[] = []
  page.on("pageerror", (error) => runtimeErrors.push(error.message))
  const componentUrl = `/@fs${path.resolve(
    process.cwd(),
    "packages/ui/src/components/SignerSwitch.tsx"
  )}`
  await page.evaluate(
    async ({ url, initialConnected }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { SignerSwitch } = await import(url)
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "iPhone",
      })
      const host = document.createElement("div")
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      const settlements: Array<() => void> = []
      let settleDisconnect: (() => void) | undefined
      let open = true
      let status = initialConnected ? "connected" : "disconnected"
      let uri: string | null = null
      const harness = {
        starts: 0,
        cancels: 0,
        disconnects: 0,
        reopen: () => {
          open = true
          render()
        },
        complete: () => {
          status = "connected"
          render()
        },
        settle: (attempt: number) => settlements[attempt - 1]?.(),
        settleDisconnect: () => settleDisconnect?.(),
      }
      window.__signerModalHarness = harness

      function render() {
        root.render(
          React.createElement(SignerSwitch, {
            open,
            onOpenChange: (nextOpen: boolean) => {
              open = nextOpen
              render()
            },
            hideTrigger: true,
            status,
            pubkeyLabel: status === "connected" ? "Test account" : null,
            signerMethod: status === "disconnected" ? null : "nip46",
            extensionAvailable: false,
            connectedDescription: "Connected for the lifecycle test.",
            connectDescription: "Approve in the test signer.",
            connectedUseDescription: "No real signer is connected.",
            unlockItems: [],
            nostrConnectUri: uri,
            onConnectExtension: () => undefined,
            onConnectRemote: () => undefined,
            onDisconnect: () => {
              harness.disconnects += 1
              status = "disconnected"
              uri = null
              render()
              return new Promise<void>((resolve) => {
                settleDisconnect = resolve
              })
            },
            onConnectNostrConnect: () => {
              harness.starts += 1
              status = "connecting"
              // No key, relay, or credential appears in this inert UI-only value.
              uri = "nostrconnect://inert-client"
              render()
              return new Promise<void>((resolve) => settlements.push(resolve))
            },
            onCancelConnect: () => {
              harness.cancels += 1
              status = "disconnected"
              uri = null
              render()
            },
          })
        )
      }
      render()
    },
    { url: componentUrl, initialConnected }
  )

  await expect
    .poll(async () => ({
      dialogs: await page.getByRole("dialog").count(),
      errors: runtimeErrors,
    }))
    .toEqual({ dialogs: 1, errors: [] })
}

test("a canceled connection resolving late cannot close a reopened signer dialog @market", async ({
  page,
}) => {
  await mountSignerModal(page)
  const dialog = page.getByRole("dialog", { name: "Sign in to Conduit" })
  await expect(dialog).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__signerModalHarness.starts))
    .toBe(1)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(await page.evaluate(() => window.__signerModalHarness.cancels)).toBe(1)
  await page.evaluate(() => window.__signerModalHarness.reopen())
  await expect(dialog).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__signerModalHarness.starts))
    .toBe(2)

  await page.evaluate(() => window.__signerModalHarness.settle(1))
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.__signerModalHarness.cancels)).toBe(1)

  await page.evaluate(() => window.__signerModalHarness.settle(2))
  await page.evaluate(() => window.__signerModalHarness.complete())
  await expect(dialog).not.toBeVisible()
})

test("switching accounts prepares the next mobile connection only after logout settles @market", async ({
  page,
}) => {
  await mountSignerModal(page, true)
  const connectedDialog = page.getByRole("dialog", { name: "Signer connected" })
  await connectedDialog
    .getByRole("button", { name: "Switch account", exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__signerModalHarness.disconnects))
    .toBe(1)
  expect(await page.evaluate(() => window.__signerModalHarness.starts)).toBe(0)
  await expect(
    page.getByRole("link", { name: "Connect with Clave", exact: true })
  ).toHaveCount(0)

  await page.evaluate(() => window.__signerModalHarness.settleDisconnect())
  await expect
    .poll(() => page.evaluate(() => window.__signerModalHarness.starts))
    .toBe(1)
  await expect(
    page.getByRole("dialog", { name: "Sign in to Conduit" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Connect with Clave", exact: true })
  ).toBeVisible()
})

declare global {
  interface Window {
    __signerPairingHarness: PairingHarness
    __signerModalHarness: {
      starts: number
      cancels: number
      disconnects: number
      reopen: () => void
      complete: () => void
      settle: (attempt: number) => void
      settleDisconnect: () => void
    }
  }
}
