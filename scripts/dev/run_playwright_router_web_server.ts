import type { PlaywrightWebServerTarget } from "./run_playwright_web_server"

type Environment = Record<string, string | undefined>

function isolatedPort(value: string, allowDynamic = false): string {
  if (allowDynamic && value === "0") return value
  if (
    !/^[1-9]\d{0,4}$/.test(value) ||
    Number(value) > 65_535 ||
    ["3000", "3001", "3002", "7000", "7001"].includes(value)
  ) {
    throw new Error("Router smoke requires isolated numeric loopback ports.")
  }
  return value
}

/** Shared by discovery/configuration and the explicitly selected launcher. */
export function resolvePlaywrightRouterPorts(environment: Environment) {
  const marketPort = isolatedPort(environment.PLAYWRIGHT_MARKET_PORT ?? "5173")
  const merchantPort = isolatedPort(
    environment.PLAYWRIGHT_MERCHANT_PORT ?? "5174"
  )
  const relayPort = isolatedPort(environment.PLAYWRIGHT_RELAY_PORT ?? "0", true)
  if (
    marketPort === merchantPort ||
    relayPort === marketPort ||
    relayPort === merchantPort
  ) {
    throw new Error("Router smoke app and relay ports must be distinct.")
  }
  if (
    (environment.VITE_LIGHTNING_NETWORK !== undefined &&
      environment.VITE_LIGHTNING_NETWORK !== "mock") ||
    (environment.VITE_E2E_RELAY_URL !== undefined &&
      environment.VITE_E2E_RELAY_URL !== `ws://127.0.0.1:${relayPort}`) ||
    environment.CONDUIT_DEPLOYMENT_PROFILE ||
    environment.CF_PAGES === "1" ||
    environment.NODE_ENV === "production"
  ) {
    throw new Error("Router smoke requires its isolated mock deployment.")
  }
  return { marketPort, merchantPort, relayPort }
}

/** The router lane never inherits the ordinary Commerce testnet deployment. */
export function resolvePlaywrightRouterWebServerTarget(
  target: string | undefined,
  environment: Environment = process.env
): PlaywrightWebServerTarget {
  if (target !== "relay" && target !== "market" && target !== "merchant") {
    throw new Error(
      "Expected isolated router target: relay, market, or merchant."
    )
  }
  const { marketPort, merchantPort, relayPort } =
    resolvePlaywrightRouterPorts(environment)
  if (target === "relay") {
    return {
      command: ["bun", "scripts/dev/run_playwright_router_relay.ts"],
      env: {
        RELAY_EPHEMERAL: "true",
        RELAY_FAULT_MODE: "none",
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: relayPort,
      },
    }
  }
  if (relayPort === "0") {
    throw new Error(
      "Router relay port must be captured before starting app servers."
    )
  }
  const port = target === "market" ? marketPort : merchantPort
  return {
    command: [
      "bun",
      "run",
      "--filter",
      `@conduit/${target}`,
      "dev",
      "--config",
      `../../e2e/vite.router-${target}.config.ts`,
      "--mode",
      "mock",
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--strictPort",
    ],
    env: {
      // Contributor metadata may otherwise fetch GitHub from the Vite process.
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      VITE_DISABLE_DEVTOOLS: "true",
      VITE_ENABLE_TELEMETRY: "false",
      VITE_ENABLE_TELEMETRY_TEST_HOOKS: "false",
      VITE_PLAUSIBLE_SRC: "data:text/javascript,",
      // The existing application mock network maps to Spark/BOLT11 regtest.
      VITE_LIGHTNING_NETWORK: "mock",
      VITE_E2E_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
      VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY: "true",
      VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL: "true",
    },
  }
}

async function run(): Promise<number> {
  // This command has no passthrough arguments that could change Vite's mode,
  // config, host, or port after the isolated target has been validated.
  if (process.argv.length !== 3) {
    throw new Error("Expected one isolated router server target.")
  }
  const selected = resolvePlaywrightRouterWebServerTarget(process.argv[2])
  const child = Bun.spawn(selected.command, {
    cwd: process.cwd(),
    env: { ...process.env, ...selected.env },
    stderr: "inherit",
    stdin: "ignore",
    stdout: "inherit",
  })
  let stopping = false
  function stopChild(): void {
    if (stopping) return
    stopping = true
    child.kill()
  }
  process.on("SIGINT", stopChild)
  process.on("SIGTERM", stopChild)
  process.on("exit", stopChild)
  return child.exited
}

if (import.meta.main) {
  process.exitCode = await run()
}
