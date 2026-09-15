import path from "node:path"
import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("payment session survives route unmount but stops before queued disconnect cleanup @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  const result = await page.evaluate(
    async (authUrl) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { AuthProvider, useAuth } = await import(authUrl)
      const host = document.createElement("div")
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      let shouldContinue = () => false
      let disconnect: () => Promise<void> = async () => undefined
      let routeMounted = false
      function Route() {
        const { authGeneration, isAuthGenerationCurrent } = useAuth()
        shouldContinue = () => isAuthGenerationCurrent(authGeneration)
        return null
      }
      class RouteLifetime extends React.Component {
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
        disconnect = useAuth().disconnect
        return null
      }
      const render = (showRoute: boolean) =>
        root.render(
          React.createElement(
            AuthProvider,
            null,
            React.createElement(Controls),
            showRoute ? React.createElement(RouteLifetime) : null
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
      render(true)
      await waitForRoute(true)
      const beforeNavigation = shouldContinue()
      render(false)
      await waitForRoute(false)
      const afterNavigation = shouldContinue()
      const consumerUnmounted = !routeMounted
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
      const whileCleanupBlocked = shouldContinue()
      const cleanupStillPending = !cleanupSettled
      release()
      await lock
      await pending
      const afterDisconnect = shouldContinue()
      root.unmount()
      host.remove()
      return {
        beforeNavigation,
        afterNavigation,
        consumerUnmounted,
        whileCleanupBlocked,
        cleanupStillPending,
        afterDisconnect,
      }
    },
    `/@fs${path.resolve(process.cwd(), "packages/core/src/context/AuthContext.tsx")}`
  )
  expect(result).toEqual({
    beforeNavigation: true,
    afterNavigation: true,
    consumerUnmounted: true,
    whileCleanupBlocked: false,
    cleanupStillPending: true,
    afterDisconnect: false,
  })
})
