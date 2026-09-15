const target = process.argv[2]
const marketPort = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
const merchantPort = process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
const relayPort = process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"
const relayUrl = `ws://127.0.0.1:${relayPort}`
const smokeArea = process.env.PLAYWRIGHT_SMOKE_AREA ?? "all"
const commerceIncluded = smokeArea === "all" || smokeArea === "commerce"

const sharedAppEnv = {
  VITE_DISABLE_DEVTOOLS: "true",
  VITE_E2E_RELAY_URL: relayUrl,
  VITE_ENABLE_TELEMETRY: "true",
  VITE_ENABLE_TELEMETRY_TEST_HOOKS: "true",
  VITE_PLAUSIBLE_SRC: "data:text/javascript,",
  VITE_TELEMETRY_ALLOWED_HOSTS: "127.0.0.1",
  ...(commerceIncluded ? { VITE_LIGHTNING_NETWORK: "testnet" } : {}),
}

const targets: Record<
  string,
  { command: string[]; env: Record<string, string> }
> = {
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

const selected = target ? targets[target] : undefined
if (!selected) {
  throw new Error(
    "Expected Playwright web server target: relay, market, or merchant"
  )
}

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

process.exitCode = await child.exited
