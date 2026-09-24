export type PlaywrightWebServerTarget = {
  command: string[]
  env: Record<string, string>
}

export function resolvePlaywrightWebServerTarget(
  target: string | undefined,
  environment: Record<string, string | undefined> = process.env
): PlaywrightWebServerTarget {
  if (!target || !new Set(["relay", "market", "merchant"]).has(target)) {
    throw new Error(
      "Expected Playwright web server target: relay, market, or merchant"
    )
  }

  const marketPort = environment.PLAYWRIGHT_MARKET_PORT ?? "7000"
  const merchantPort = environment.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
  const relayPort =
    environment.PLAYWRIGHT_RELAY_PORT || (target === "relay" ? "0" : undefined)
  if (relayPort === undefined) {
    throw new Error(
      "PLAYWRIGHT_RELAY_PORT must be captured before starting app servers"
    )
  }
  const relayUrl = `ws://127.0.0.1:${relayPort}`
  const smokeArea = environment.PLAYWRIGHT_SMOKE_AREA ?? "all"
  const commerceIncluded = smokeArea === "all" || smokeArea === "commerce"

  const sharedAppEnv = {
    VITE_DISABLE_DEVTOOLS: "true",
    VITE_E2E_RELAY_URL: relayUrl,
    VITE_ENABLE_TELEMETRY: "true",
    VITE_ENABLE_TELEMETRY_TEST_HOOKS: "true",
    VITE_PLAUSIBLE_SRC: "data:text/javascript,",
    VITE_TELEMETRY_ALLOWED_HOSTS: "127.0.0.1",
    ...(commerceIncluded
      ? { VITE_LIGHTNING_NETWORK: "testnet" }
      : smokeArea === "market"
        ? { VITE_LIGHTNING_NETWORK: "mainnet" }
        : {}),
  }

  const targets: Record<string, PlaywrightWebServerTarget> = {
    relay: {
      command: ["bun", "scripts/dev/relay_bun.ts"],
      env: {
        RELAY_EPHEMERAL: "true",
        RELAY_FAULT_MODE: "none",
        RELAY_PORT: relayPort,
      },
    },
    market: {
      command: [
        "bun",
        "run",
        "--filter",
        "@conduit/market",
        "dev",
        "--mode",
        "mock",
        "--host",
        "127.0.0.1",
        "--port",
        marketPort,
      ],
      env: sharedAppEnv,
    },
    merchant: {
      command: [
        "bun",
        "run",
        "--filter",
        "@conduit/merchant",
        "dev",
        "--mode",
        "mock",
        "--host",
        "127.0.0.1",
        "--port",
        merchantPort,
      ],
      env: sharedAppEnv,
    },
  }

  return targets[target]
}

async function run(): Promise<number> {
  const selected = resolvePlaywrightWebServerTarget(process.argv[2])
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
