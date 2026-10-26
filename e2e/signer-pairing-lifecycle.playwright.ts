import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

test.use({ trace: "off", screenshot: "off", video: "off" })

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
  browserStarts: number
  cancels: number
  start: () => void
  runBunker: () => void
  switchToBrowser: () => void
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
      const root = ReactDOM.createRoot(host, {
        identifierPrefix: "sign-in-fixture-",
      })
      let input = { autoPrepare: true, ...initial }
      const settlements: Array<() => void> = []
      const harness: PairingHarness = {
        starts: 0,
        bunkerStarts: 0,
        browserStarts: 0,
        cancels: 0,
        start: () => undefined,
        runBunker: () => undefined,
        switchToBrowser: () => undefined,
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
        harness.switchToBrowser = () =>
          void pairing.cancelAndRun(() => {
            harness.browserStarts += 1
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

test("browser switch waits for the canceled pairing to settle @market", async ({
  page,
}) => {
  await mountPairing(page)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(1)
  await page.evaluate(() => window.__signerPairingHarness.switchToBrowser())
  expect(await page.evaluate(() => window.__signerPairingHarness.cancels)).toBe(
    1
  )
  expect(
    await page.evaluate(() => window.__signerPairingHarness.browserStarts)
  ).toBe(0)

  await page.evaluate(() => window.__signerPairingHarness.settle(1))
  await expect
    .poll(() =>
      page.evaluate(() => window.__signerPairingHarness.browserStarts)
    )
    .toBe(1)
  await page.evaluate(() => window.__signerPairingHarness.unmount())
})

test("closing or replacing the pairing prevents a delayed browser switch @market", async ({
  page,
}) => {
  await mountPairing(page)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(1)
  await page.evaluate(() => {
    window.__signerPairingHarness.switchToBrowser()
    window.__signerPairingHarness.unmount()
    window.__signerPairingHarness.settle(1)
  })
  expect(
    await page.evaluate(() => window.__signerPairingHarness.browserStarts)
  ).toBe(0)

  await mountPairing(page)
  await expect
    .poll(() => page.evaluate(() => window.__signerPairingHarness.starts))
    .toBe(1)
  await page.evaluate(() => {
    window.__signerPairingHarness.switchToBrowser()
    window.__signerPairingHarness.start()
    window.__signerPairingHarness.settle(1)
  })
  expect(await page.evaluate(() => window.__signerPairingHarness.starts)).toBe(
    2
  )
  expect(
    await page.evaluate(() => window.__signerPairingHarness.browserStarts)
  ).toBe(0)
  await page.evaluate(() => window.__signerPairingHarness.unmount())
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
    "packages/ui/src/components/SignInDialog.tsx"
  )}`
  await page.evaluate(
    async ({ url, initialConnected }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { SignInDialog } = await import(url)
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "iPhone",
      })
      const host = document.createElement("div")
      document.body.append(host)
      const root = ReactDOM.createRoot(host, {
        identifierPrefix: "sign-in-fixture-",
      })
      const settlements: Array<() => void> = []
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
      }
      window.__signerModalHarness = harness

      function render() {
        root.render(
          React.createElement(SignInDialog, {
            open,
            onOpenChange: (nextOpen: boolean) => {
              open = nextOpen
              render()
            },
            status,
            signerMethod: status === "disconnected" ? null : "nip46",
            extensionAvailable: false,
            connectDescription: "Approve in the test signer.",
            unlockItems: [],
            nostrConnectUri: uri,
            onConnectExtension: () => undefined,
            onConnectRemote: () => undefined,
            onDisconnect: () => {
              harness.disconnects += 1
              status = "disconnected"
              uri = null
              render()
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
    .toEqual({ dialogs: initialConnected ? 0 : 1, errors: [] })
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

test("an already connected account never opens a sign-in or account-switch dialog @market", async ({
  page,
}) => {
  await mountSignerModal(page, true)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(await page.evaluate(() => window.__signerModalHarness.starts)).toBe(0)
  expect(
    await page.evaluate(() => window.__signerModalHarness.disconnects)
  ).toBe(0)
  await page.evaluate(() => window.__signerModalHarness.reopen())
  await expect(page.getByRole("dialog")).toHaveCount(0)
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
    }
  }
}

async function mountAppSignIn(
  page: Page,
  options: { mobile?: boolean; gate?: boolean } = {}
) {
  const url = `/@fs${path.resolve(process.cwd(), "packages/ui/src/components/SignInProvider.tsx")}`
  const panelUrl = `/@fs${path.resolve(process.cwd(), "packages/ui/src/components/SignInDialog.tsx")}`
  await page.evaluate(
    async ({ url, panelUrl, options }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { SignInProvider, useSignIn } = await import(url)
      const { SignerConnectPanel } = await import(panelUrl)
      if (options.mobile)
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          value: "iPhone",
        })
      const host = document.createElement("div")
      host.style.cssText = "position:fixed;top:100px;left:20px;z-index:50"
      document.body.append(host)
      const root = ReactDOM.createRoot(host, {
        identifierPrefix: "sign-in-fixture-",
      })
      let status = "disconnected"
      let gate = options.gate ?? false
      let route = "checkout"
      let showRoute = true
      let authUrl: string | null = null
      let rejectDisconnect = false
      const settlements: Array<() => void> = []
      const harness = {
        starts: 0,
        cancels: 0,
        navigations: 0,
        hideRoute: () => {
          showRoute = false
          render()
        },
        changeRoute: () => {
          route = "other"
          render()
        },
        toggleGate: () => {
          gate = !gate
          render()
        },
        showApproval: () => {
          authUrl = "https://signer.example/approve"
          render()
        },
        complete: () => {
          settlements.at(-1)?.()
          status = "connected"
          render()
        },
        failDisconnect: () => {
          rejectDisconnect = true
        },
        disconnect: () => undefined as void | Promise<void>,
        request: () => undefined,
        unmount: () => {
          root.unmount()
          host.remove()
        },
      }
      window.__appSignInHarness = harness
      function Route() {
        const { requestSignIn, disconnectAccount } = useSignIn()
        harness.request = () =>
          requestSignIn(() => {
            harness.navigations++
          })
        harness.disconnect = () => disconnectAccount().catch(() => undefined)
        return showRoute
          ? React.createElement(
              "button",
              { onClick: harness.request },
              "Start fixture sign-in"
            )
          : React.createElement("p", null, "Route is loading")
      }
      function render() {
        root.render(
          React.createElement(
            SignInProvider,
            {
              status,
              accountPresent: status === "connected",
              navigationKey: route,
              gate,
              renderGate: (props: unknown) =>
                React.createElement(SignerConnectPanel, props),
              authUrl,
              onDismissAuthUrl: () => {
                authUrl = null
                render()
              },
              signerMethod: "nip46",
              extensionAvailable: true,
              connectDescription: "Synthetic connection lifecycle",
              unlockItems: [],
              onConnectExtension: () => undefined,
              onConnectRemote: () => undefined,
              onConnectNostrConnect: () => {
                harness.starts++
                status = "connecting"
                render()
                return new Promise<void>((resolve) => settlements.push(resolve))
              },
              onCancelConnect: () => {
                harness.cancels++
                status = "disconnected"
                render()
              },
              onDisconnect: async () => {
                status = "disconnected"
                showRoute = false
                render()
                if (rejectDisconnect)
                  throw new Error("Synthetic cleanup failure")
              },
            },
            React.createElement(Route)
          )
        )
      }
      render()
    },
    { url, panelUrl, options }
  )
  await expect(
    page.getByRole("button", { name: "Start fixture sign-in", exact: true })
  ).toBeVisible()
}

test("route loading and gate presentation changes retain one owned pairing and one approval notice @market", async ({
  page,
}) => {
  await mountAppSignIn(page, { mobile: true })
  await page
    .getByRole("button", { name: "Start fixture sign-in", exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__appSignInHarness.starts))
    .toBe(1)
  await page.evaluate(() => {
    window.__appSignInHarness.hideRoute()
    window.__appSignInHarness.showApproval()
  })
  await expect(page.getByRole("dialog")).toHaveCount(1)
  await expect(
    page.getByRole("link", { name: "Open signer approval" })
  ).toHaveCount(1)
  await page.evaluate(() => window.__appSignInHarness.toggleGate())
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit", exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__appSignInHarness.starts)).toBe(1)
  expect(await page.evaluate(() => window.__appSignInHarness.cancels)).toBe(0)
  await page.evaluate(() => window.__appSignInHarness.complete())
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit", exact: true })
  ).toHaveCount(0)
  expect(await page.evaluate(() => window.__appSignInHarness.navigations)).toBe(
    1
  )
  await page.evaluate(() => window.__appSignInHarness.unmount())
})

test("dismissed or abandoned navigation does not replay after sign-in @market", async ({
  page,
}) => {
  await mountAppSignIn(page)
  await page
    .getByRole("button", { name: "Start fixture sign-in", exact: true })
    .click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await page.evaluate(() => {
    window.__appSignInHarness.request()
    window.__appSignInHarness.changeRoute()
  })
  await expect(page.getByRole("dialog")).toHaveCount(1)
  await page.evaluate(() => window.__appSignInHarness.complete())
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(await page.evaluate(() => window.__appSignInHarness.navigations)).toBe(
    0
  )
  await page.evaluate(() => window.__appSignInHarness.unmount())
})

test("disconnect failure stays actionable after account controls disappear @market", async ({
  page,
}) => {
  await mountAppSignIn(page)
  await page.evaluate(() => window.__appSignInHarness.complete())
  await page.evaluate(async () => {
    window.__appSignInHarness.failDisconnect()
    await window.__appSignInHarness.disconnect()
  })
  await expect(
    page.getByRole("button", { name: "Retry disconnect", exact: true })
  ).toBeVisible()
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Could not finish disconnecting" })
  ).toBeVisible()
  await page.evaluate(() => window.__appSignInHarness.unmount())
})

declare global {
  interface Window {
    __appSignInHarness: {
      starts: number
      cancels: number
      navigations: number
      hideRoute: () => void
      changeRoute: () => void
      toggleGate: () => void
      showApproval: () => void
      complete: () => void
      failDisconnect: () => void
      disconnect: () => void | Promise<void>
      request: () => void
      unmount: () => void
    }
  }
}

test("a connection started at the Merchant gate survives switching to modal presentation @market", async ({
  page,
}) => {
  await mountAppSignIn(page, { mobile: true, gate: true })
  await expect
    .poll(() => page.evaluate(() => window.__appSignInHarness.starts))
    .toBe(1)
  await page.evaluate(() => window.__appSignInHarness.toggleGate())
  await expect(
    page.getByRole("dialog", { name: "Sign in to Conduit" })
  ).toHaveCount(1)
  expect(await page.evaluate(() => window.__appSignInHarness.cancels)).toBe(0)
  await page.evaluate(() => window.__appSignInHarness.complete())
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(await page.evaluate(() => window.__appSignInHarness.starts)).toBe(1)
  await page.evaluate(() => window.__appSignInHarness.unmount())
})
