import path from "node:path"
import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("payment session survives route unmount but stays invalid from disconnect until reconnect @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  const result = await page.evaluate(
    async (authUrl) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { AuthProvider, useAuth } = await import(authUrl)
      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          async getPublicKey() {
            return "a".repeat(64)
          },
          async getRelays() {
            return {}
          },
          async signEvent(event: Record<string, unknown>) {
            return {
              ...event,
              pubkey: "a".repeat(64),
              id: "0".repeat(64),
              sig: "1".repeat(128),
            }
          },
        },
      })
      const host = document.createElement("div")
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      let shouldContinue = () => false
      let connect: () => Promise<void> = async () => undefined
      let disconnect: () => Promise<void> = async () => undefined
      let authStatus = "disconnected"
      let routeMounted = false
      let routeRenderCount = 0
      function Route() {
        const { authGeneration, isAuthGenerationCurrent } = useAuth()
        routeRenderCount += 1
        shouldContinue = () => isAuthGenerationCurrent(authGeneration)
        return null
      }
      class RouteLifetime extends React.Component<{ revision: number }> {
        componentDidMount() {
          routeMounted = true
        }
        componentWillUnmount() {
          routeMounted = false
        }
        render() {
          return React.createElement(Route)
        }
      }
      function Controls() {
        const auth = useAuth()
        connect = () => auth.connect({ method: "nip07" })
        disconnect = auth.disconnect
        authStatus = auth.status
        return null
      }
      const render = (showRoute: boolean, revision = 0) =>
        root.render(
          React.createElement(
            AuthProvider,
            null,
            React.createElement(Controls),
            showRoute ? React.createElement(RouteLifetime, { revision }) : null
          )
        )
      const waitForRoute = async (mounted: boolean) => {
        for (let frame = 0; routeMounted !== mounted; frame += 1) {
          if (frame > 100) throw new Error("Route fixture did not settle")
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      }
      const waitForAuthStatus = async (expected: string) => {
        for (let frame = 0; authStatus !== expected; frame += 1) {
          if (frame > 100) throw new Error("Auth fixture did not settle")
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      }
      const waitForRouteRenderAfter = async (previousCount: number) => {
        for (let frame = 0; routeRenderCount === previousCount; frame += 1) {
          if (frame > 100) {
            throw new Error("Route re-render did not settle")
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      }
      render(true)
      await waitForRoute(true)
      await connect()
      await waitForAuthStatus("connected")
      const beforeNavigation = shouldContinue()
      render(false)
      await waitForRoute(false)
      const afterNavigation = shouldContinue()
      const consumerUnmounted = !routeMounted
      render(true)
      await waitForRoute(true)
      const preDisconnectPredicate = shouldContinue
      let release!: () => void
      let locked!: () => void
      const acquired = new Promise<void>((resolve) => {
        locked = resolve
      })
      const lock = navigator.locks.request(
        "conduit-auth-operation",
        async () => {
          locked()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      )
      await acquired
      let cleanupSettled = false
      const pending = disconnect().finally(() => {
        cleanupSettled = true
      })
      const preexistingWhileCleanupBlocked = preDisconnectPredicate()
      const renderCountBeforeDisconnectRerender = routeRenderCount
      render(true, 1)
      await waitForRouteRenderAfter(renderCountBeforeDisconnectRerender)
      const newlyRenderedWhileCleanupBlocked = shouldContinue()
      const cleanupStillPending = !cleanupSettled
      release()
      await lock
      await pending
      const renderCountBeforeDisconnectedRerender = routeRenderCount
      render(true, 2)
      await waitForRouteRenderAfter(renderCountBeforeDisconnectedRerender)
      const afterDisconnect = shouldContinue()
      await connect()
      await waitForAuthStatus("connected")
      const afterReconnect = shouldContinue()
      root.unmount()
      host.remove()
      return {
        beforeNavigation,
        afterNavigation,
        consumerUnmounted,
        preexistingWhileCleanupBlocked,
        newlyRenderedWhileCleanupBlocked,
        cleanupStillPending,
        afterDisconnect,
        afterReconnect,
      }
    },
    `/@fs${path.resolve(process.cwd(), "packages/core/src/context/AuthContext.tsx")}`
  )
  expect(result).toEqual({
    beforeNavigation: true,
    afterNavigation: true,
    consumerUnmounted: true,
    preexistingWhileCleanupBlocked: false,
    newlyRenderedWhileCleanupBlocked: false,
    cleanupStillPending: true,
    afterDisconnect: false,
    afterReconnect: true,
  })
})
