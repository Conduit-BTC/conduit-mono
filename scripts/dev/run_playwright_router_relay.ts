import { createPlaywrightRouterClock } from "./playwright_router_clock"
import { startRelayServer, type RelayServerOptions } from "./relay_bun"
import { resolvePlaywrightRouterPorts } from "./run_playwright_router_web_server"

export function resolvePlaywrightRouterRelayOptions(
  environment: Record<string, string | undefined>,
  now: () => number
): RelayServerOptions {
  const { relayPort } = resolvePlaywrightRouterPorts(environment)
  if (
    environment.RELAY_HOST !== "127.0.0.1" ||
    environment.RELAY_PORT !== relayPort ||
    environment.RELAY_EPHEMERAL !== "true" ||
    environment.RELAY_FAULT_MODE !== "none"
  ) {
    throw new Error("Router clock requires its isolated ephemeral relay.")
  }
  return {
    hostname: "127.0.0.1",
    port: Number(relayPort),
    persistence: false,
    faultMode: "none",
    now,
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    throw new Error("Router relay accepts no arguments.")
  }
  // Validate deployment before creating a temporary file or binding a port.
  resolvePlaywrightRouterRelayOptions(process.env, Date.now)
  const clock = createPlaywrightRouterClock()
  try {
    const relay = startRelayServer(
      resolvePlaywrightRouterRelayOptions(process.env, clock.nowMs)
    )
    const shutdown = () => {
      relay.server.stop(true)
      clock.cleanup()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    process.on("exit", clock.cleanup)
    // Playwright captures only runner configuration; this is not an HTTP API.
    console.log(
      `Conduit router relay ready on ws://127.0.0.1:${relay.server.port}; clock=${clock.filePath}`
    )
  } catch {
    clock.cleanup()
    throw new Error("Isolated router relay failed to start.")
  }
}
