import { describe, expect, it } from "bun:test"

import {
  buildMarketEventCatalogUrl,
  inferConduitAppOrigin,
} from "../packages/core/src/app-links"
import { encodeEventMarketNaddr } from "../packages/core/src/protocol/event-market"
import { getWalletNetworkFromLightningConfig } from "../packages/core/src/wallets"
import {
  resolvePlaywrightRouterPorts,
  resolvePlaywrightRouterWebServerTarget,
} from "../scripts/dev/run_playwright_router_web_server"
import { createPlaywrightRouterConfig } from "../scripts/dev/playwright_router_config"
import { parseCheckoutSparkReceiverContracts } from "../packages/core/src/protocol/checkout-spark-receiver-capability"

describe("isolated router Playwright launcher", () => {
  it("selects receiver setup and pre-funding admission separately from all routing lanes", () => {
    const setup = createPlaywrightRouterConfig({
      PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE: "true",
    })
    const setupTitle = "receiver setup supported payment profile @commerce"
    expect((setup.grep as RegExp).test(setupTitle)).toBe(true)
    expect((setup.grep as RegExp).test("native router funding @commerce")).toBe(
      false
    )
    expect(
      (setup.grep as RegExp).test("routed public Zapout shopper @commerce")
    ).toBe(false)
    expect(
      (setup.grep as RegExp).test("routed anonymous Zapout guest @commerce")
    ).toBe(false)
    expect(
      (createPlaywrightRouterConfig({}).grep as RegExp).test(setupTitle)
    ).toBe(false)
    if (!Array.isArray(setup.webServer))
      throw new Error("Router servers unavailable.")
    expect(
      setup.webServer.every(
        (server) => server.env?.PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE === "true"
      )
    ).toBe(true)
  })
  it("qualifies only the fixture provider's private receiver contract in both isolated apps", () => {
    for (const target of ["market", "merchant"] as const) {
      const launch = resolvePlaywrightRouterWebServerTarget(target, {
        PLAYWRIGHT_RELAY_PORT: "54321",
      })
      const contracts = parseCheckoutSparkReceiverContracts(
        launch.env.VITE_CHECKOUT_SPARK_RECEIVER_CONTRACTS
      )
      expect(contracts.length).toBe(1)
      expect(
        contracts.map(({ modes, binding }) => ({ modes, binding }))
      ).toEqual([{ modes: ["private"], binding: "metadata_hash" }])
      expect(
        contracts.every(
          (contract) =>
            contract.qualification === "accepted" &&
            contract.payRequestOrigins.length === 1 &&
            contract.payRequestOrigins[0] === "https://wallet.conduit.market" &&
            JSON.stringify(contract.payRequestOrigins) ===
              JSON.stringify(contract.callbackOrigins) &&
            JSON.stringify(contract.payRequestOrigins) ===
              JSON.stringify(contract.verifyOrigins) &&
            contract.verifyPathPrefix === "/__hermetic_lnurl/verify/"
        )
      ).toBe(true)
      expect(() =>
        resolvePlaywrightRouterWebServerTarget(target, {
          PLAYWRIGHT_RELAY_PORT: "54321",
          VITE_CHECKOUT_SPARK_RECEIVER_CONTRACTS: "[]",
        })
      ).toThrow("isolated mock receiver configuration")
    }
  })
  it("selects ordinary signed-in and guest routing with no public signing service", () => {
    const config = createPlaywrightRouterConfig({})
    for (const title of [
      "native router funding automatically @commerce",
      "native router cold Merchant restores @commerce",
      "native router ordinary guest checkout @commerce",
    ])
      expect((config.grep as RegExp).test(title)).toBe(true)
    expect(config.grepInvert).toBeUndefined()
    for (const target of ["market", "merchant"] as const) {
      const launch = resolvePlaywrightRouterWebServerTarget(target, {
        PLAYWRIGHT_RELAY_PORT: "54321",
      })
      expect(launch.env.VITE_E2E_PUBLIC_ZAP_RECEIPT_HINTS).toBe("false")
      expect(launch.env.VITE_ANON_ZAP_SIGNER_PUBKEY).toBe("")
      expect(launch.env.VITE_ANON_ZAP_SIGNER_URL).toBe("")
    }
  })
  it("keeps real event-catalog links inside its configured local app pair", () => {
    const ports = resolvePlaywrightRouterPorts({})
    const marketOrigin = `http://127.0.0.1:${ports.marketPort}`
    const merchantOrigin = `http://127.0.0.1:${ports.merchantPort}`
    const reference = encodeEventMarketNaddr(
      `30409:${"a".repeat(64)}:isolated-market`
    )
    const share = buildMarketEventCatalogUrl(marketOrigin, reference)
    expect(new URL(share).origin).toBe(marketOrigin)
    expect(new URL(share).pathname === `/events/${reference}`).toBe(true)
    expect(inferConduitAppOrigin("merchant", new URL(marketOrigin))).toBe(
      merchantOrigin
    )
    expect(inferConduitAppOrigin("market", new URL(merchantOrigin))).toBe(
      marketOrigin
    )
  })

  it("starts separate strict-port mock apps on regtest without changing commerce defaults", () => {
    for (const target of ["market", "merchant"] as const) {
      const launch = resolvePlaywrightRouterWebServerTarget(target, {
        PLAYWRIGHT_RELAY_PORT: "54321",
      })
      expect(launch.command).toEqual([
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
        target === "market" ? "5173" : "5174",
        "--strictPort",
      ])
      expect(launch.env.VITE_LIGHTNING_NETWORK).toBe("mock")
      expect(getWalletNetworkFromLightningConfig("mock")).toBe("regtest")
      expect(launch.env.VITE_E2E_RELAY_URL).toBe("ws://127.0.0.1:54321")
      expect(launch.env.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY).toBe("true")
      expect(launch.env.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL).toBe("true")
    }
  })

  it("refuses live, ordinary-smoke, malformed, missing, and overlapping ports", () => {
    for (const port of [
      "3000",
      "3001",
      "3002",
      "7000",
      "7001",
      "0",
      "",
      "-1",
      "65536",
      "7100/path",
      "07000",
    ]) {
      expect(() =>
        resolvePlaywrightRouterWebServerTarget("market", {
          PLAYWRIGHT_MARKET_PORT: port,
          PLAYWRIGHT_RELAY_PORT: "54321",
        })
      ).toThrow()
    }
    for (const relayPort of [
      undefined,
      "0",
      "3000",
      "7001",
      "5173",
      "5174",
      "ws://public.example.invalid",
    ]) {
      expect(() =>
        resolvePlaywrightRouterWebServerTarget("market", {
          PLAYWRIGHT_RELAY_PORT: relayPort,
        })
      ).toThrow()
    }
    expect(() =>
      resolvePlaywrightRouterWebServerTarget("merchant", {
        PLAYWRIGHT_MARKET_PORT: "5174",
        PLAYWRIGHT_RELAY_PORT: "54321",
      })
    ).toThrow()
    const launch = resolvePlaywrightRouterWebServerTarget("market", {
      PLAYWRIGHT_MARKET_PORT: "7200",
      PLAYWRIGHT_MERCHANT_PORT: "7201",
      PLAYWRIGHT_RELAY_PORT: "54321",
    })
    expect(launch.command).toContain("7200")
  })

  it("starts an ephemeral loopback relay and refuses conflicting inherited deployment settings", () => {
    expect(resolvePlaywrightRouterWebServerTarget("relay", {})).toEqual({
      command: ["bun", "scripts/dev/run_playwright_router_relay.ts"],
      env: {
        RELAY_EPHEMERAL: "true",
        RELAY_FAULT_MODE: "none",
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: "0",
      },
    })
    for (const overrides of [
      { VITE_E2E_RELAY_URL: "wss://public.example.invalid" },
      { VITE_E2E_RELAY_URL: "ws://127.0.0.1:12345" },
      { VITE_LIGHTNING_NETWORK: "mainnet" },
      { VITE_LIGHTNING_NETWORK: "testnet" },
      { VITE_LIGHTNING_NETWORK: "regtest" },
      { CONDUIT_DEPLOYMENT_PROFILE: "production" },
      { CF_PAGES: "1" },
      { NODE_ENV: "production" },
    ]) {
      expect(() =>
        resolvePlaywrightRouterWebServerTarget("market", {
          PLAYWRIGHT_RELAY_PORT: "54321",
          ...overrides,
        })
      ).toThrow()
    }
  })

  it("removes inherited contributor credentials and disables remote telemetry and devtools", () => {
    const launch = resolvePlaywrightRouterWebServerTarget("merchant", {
      PLAYWRIGHT_RELAY_PORT: "54321",
      GH_TOKEN: "synthetic-not-a-credential",
      GITHUB_TOKEN: "synthetic-not-a-credential",
    })
    expect(launch.env.GH_TOKEN).toBe("")
    expect(launch.env.GITHUB_TOKEN).toBe("")
    expect(launch.env.VITE_ENABLE_TELEMETRY).toBe("false")
    expect(launch.env.VITE_DISABLE_DEVTOOLS).toBe("true")
    expect(launch.env.VITE_PLAUSIBLE_SRC).toBe("data:text/javascript,")
  })
})

describe("isolated router Playwright config", () => {
  const evidence = {
    baseSha: "b".repeat(40),
    sourceHeadSha: "a".repeat(40),
    testedSha: "c".repeat(40),
  }
  const evidenceEnvironment = {
    PLAYWRIGHT_SMOKE_BASE_SHA: evidence.baseSha,
    PLAYWRIGHT_SMOKE_SOURCE_HEAD_SHA: evidence.sourceHeadSha,
    PLAYWRIGHT_SMOKE_TESTED_SHA: evidence.testedSha,
  }

  it("binds CI router reports to complete validated source, base and tested SHAs", () => {
    const config = createPlaywrightRouterConfig({
      CI: "true",
      ...evidenceEnvironment,
      PLAYWRIGHT_SMOKE_RESULT_FILE: "owned-router-results.json",
    })
    expect(config.metadata).toEqual({ smokeEvidence: evidence })
    expect(createPlaywrightRouterConfig({}).metadata).toBeUndefined()
  })

  it("rejects incomplete or malformed router SHA evidence instead of silently dropping it", () => {
    for (const [field] of Object.entries(evidenceEnvironment)) {
      for (const invalid of [
        undefined,
        "",
        "a".repeat(39),
        "A".repeat(40),
        "g".repeat(40),
      ]) {
        expect(() =>
          createPlaywrightRouterConfig({
            ...evidenceEnvironment,
            [field]: invalid,
          })
        ).toThrow("source, base, and tested SHAs")
      }
    }
  })

  it("requires CI SHA evidence and an owned result file but keeps discovery server-free", () => {
    expect(() => createPlaywrightRouterConfig({ CI: "true" })).toThrow()
    expect(() =>
      createPlaywrightRouterConfig({ CI: "true", ...evidenceEnvironment })
    ).toThrow("PLAYWRIGHT_SMOKE_RESULT_FILE")
    const discovery = createPlaywrightRouterConfig({
      CI: "true",
      ...evidenceEnvironment,
      PLAYWRIGHT_SMOKE_DISCOVERY: "true",
    })
    expect(discovery.metadata).toEqual({ smokeEvidence: evidence })
    expect(discovery.webServer).toBeUndefined()
  })

  it("keeps configuration discovery imports and builders free of shared environment mutations", () => {
    const helperUrl = new URL(
      "../scripts/dev/playwright_router_config.ts",
      import.meta.url
    ).href
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `const before = JSON.stringify(process.env);
         const { createPlaywrightRouterConfig } = await import(${JSON.stringify(helperUrl)});
         createPlaywrightRouterConfig({ PLAYWRIGHT_SMOKE_DISCOVERY: "true" });
         console.log(JSON.stringify(process.env) === before);`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe("true")
  })

  it("does not bypass disabled router artifacts with direct screenshot calls", async () => {
    const source = await Bun.file(
      new URL("../e2e/commerce-router-recovery.playwright.ts", import.meta.url)
    ).text()
    // A failure must not dump the synthetic payment/identity fixture source.
    expect(/\.\s*screenshot\s*\(/.test(source)).toBe(false)
  })

  it("selects only the router recovery smoke with one serial Chromium worker and no captured artifacts", () => {
    const config = createPlaywrightRouterConfig({})
    expect(config.testDir).toBe("./e2e")
    expect(config.testMatch).toBe("**/commerce-router-recovery.playwright.ts")
    expect(config.grep?.toString()).toBe("/native router.*@commerce/")
    expect(config.workers).toBe(1)
    expect(config.fullyParallel).toBe(false)
    expect(config.retries).toBe(0)
    expect(config.use).toMatchObject({
      trace: "off",
      screenshot: "off",
      video: "off",
      serviceWorkers: "block",
    })
    expect(config.projects?.map(({ name }) => name)).toEqual(["chromium"])
    expect(config.preserveOutput).toBe("never")
    expect(config.reporter).toEqual([
      [
        "./scripts/ci/playwright_smoke_reporter.ts",
        {
          outputFile: "test-results/router-smoke-results.json",
          progressFile: undefined,
        },
      ],
    ])
    const servers = config.webServer
    expect(Array.isArray(servers)).toBe(true)
    if (!Array.isArray(servers)) throw new Error("Router servers unavailable.")
    expect(servers).toHaveLength(3)
    expect(
      servers.every((server) => server.reuseExistingServer === false)
    ).toBe(true)
    expect(
      servers.every((server) =>
        server.command.includes("run_playwright_router_web_server.ts")
      )
    ).toBe(true)
  })

  it("uses a captured or explicit isolated relay port without server reuse", () => {
    const config = createPlaywrightRouterConfig({
      PLAYWRIGHT_RELAY_PORT: "54321",
    })
    if (!Array.isArray(config.webServer))
      throw new Error("Router servers unavailable.")
    expect(config.webServer[0]?.url).toBeUndefined()
    const ready = config.webServer[0]?.wait?.stdout
    expect(ready).toBeInstanceOf(RegExp)
    expect(
      ready?.exec(
        "Conduit router relay ready on ws://127.0.0.1:54321; clock=owned-clock-file"
      )?.groups
    ).toEqual({
      PLAYWRIGHT_RELAY_PORT: "54321",
      PLAYWRIGHT_ROUTER_CLOCK_FILE: "owned-clock-file",
    })
    expect(config.globalTeardown).toBe(
      "./scripts/dev/playwright_router_teardown.ts"
    )
    for (const target of [undefined, "unknown", "market --mode production"]) {
      expect(() => resolvePlaywrightRouterWebServerTarget(target, {})).toThrow()
    }
  })

  it("discovers without starting servers and rejects an unrelated area selection", () => {
    expect(
      createPlaywrightRouterConfig({ PLAYWRIGHT_SMOKE_DISCOVERY: "true" })
        .webServer
    ).toBeUndefined()
    for (const area of ["market", "merchant", "typo"]) {
      expect(() =>
        createPlaywrightRouterConfig({ PLAYWRIGHT_SMOKE_AREA: area })
      ).toThrow()
    }
    expect(() =>
      createPlaywrightRouterConfig({ PLAYWRIGHT_SMOKE_AREA: "commerce" })
    ).not.toThrow()
    expect(() =>
      createPlaywrightRouterConfig({ PLAYWRIGHT_SMOKE_AREA: "all" })
    ).not.toThrow()
  })

  it("excludes the router-only file from ordinary network-lane discovery", async () => {
    const previous = process.env.PLAYWRIGHT_SMOKE_DISCOVERY
    const previousCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT
    process.env.PLAYWRIGHT_SMOKE_DISCOVERY = "true"
    try {
      const { default: ordinary } = await import("../playwright.config")
      const desktop = ordinary.projects?.find(({ name }) => name === "chromium")
      expect(desktop?.testIgnore).toContain(
        "**/commerce-router-recovery.playwright.ts"
      )
      for (const mobile of ordinary.projects?.filter(
        ({ name }) => name !== "chromium"
      ) ?? []) {
        expect(mobile.testMatch).not.toContain(
          "**/commerce-router-recovery.playwright.ts"
        )
      }
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_SMOKE_DISCOVERY
      else process.env.PLAYWRIGHT_SMOKE_DISCOVERY = previous
      if (previousCopyPrompt === undefined)
        delete process.env.PLAYWRIGHT_NO_COPY_PROMPT
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousCopyPrompt
    }
  })
})
