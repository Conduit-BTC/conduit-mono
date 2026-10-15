import { expect, it } from "bun:test"
import { closeSync, existsSync, openSync } from "node:fs"
import path from "node:path"

import {
  createPlaywrightRouterClock,
  openPlaywrightRouterClock,
} from "../scripts/dev/playwright_router_clock"
import { resolvePlaywrightRouterRelayOptions } from "../scripts/dev/run_playwright_router_relay"

it("keeps fresh AUTH timestamps aligned across the router clock after the real takeover duration", () => {
  const owner = createPlaywrightRouterClock()
  try {
    const reader = openPlaywrightRouterClock({
      PLAYWRIGHT_ROUTER_CLOCK_FILE: owner.filePath,
    })
    const oldAuthSeconds = Math.floor(reader.nowMs() / 1_000)
    const browserTime = owner.advanceBy(46 * 60 * 1_000)
    const newAuthSeconds = Math.floor(browserTime / 1_000)
    const relaySeconds = Math.floor(reader.nowMs() / 1_000)
    expect(Math.abs(relaySeconds - newAuthSeconds)).toBeLessThanOrEqual(1)
    expect(relaySeconds - oldAuthSeconds).toBeGreaterThan(10 * 60)
    expect(Math.abs(reader.reset() - Date.now())).toBeLessThan(1_000)
    expect(Math.abs(owner.nowMs() - Date.now())).toBeLessThan(1_000)
  } finally {
    owner.cleanup()
  }
})

it("shares the ticking offset with an independent process and removes only its owned clock", () => {
  const owner = createPlaywrightRouterClock()
  try {
    owner.advanceBy(46 * 60 * 1_000)
    const helperUrl = new URL(
      "../scripts/dev/playwright_router_clock.ts",
      import.meta.url
    ).href
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `const { openPlaywrightRouterClock } = await import(${JSON.stringify(helperUrl)});
         const clock = openPlaywrightRouterClock({PLAYWRIGHT_ROUTER_CLOCK_FILE:${JSON.stringify(owner.filePath)}});
         console.log(Math.abs(clock.nowMs() - Date.now() - 46 * 60 * 1000) < 1000);`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe("true")
  } finally {
    owner.cleanup()
  }
  expect(existsSync(owner.filePath)).toBe(false)
  expect(existsSync(path.dirname(owner.filePath))).toBe(false)
  expect(() => owner.nowMs()).toThrow("Isolated router clock unavailable.")
  expect(() => owner.cleanup()).not.toThrow()
})

it("resets sequential tests without changing another lane or permitting invalid offsets", () => {
  const first = createPlaywrightRouterClock()
  const second = createPlaywrightRouterClock()
  try {
    first.advanceBy(46 * 60 * 1_000)
    expect(Math.abs(second.nowMs() - Date.now())).toBeLessThan(1_000)
    first.reset()
    expect(Math.abs(first.nowMs() - second.nowMs())).toBeLessThan(1_000)
    for (const invalid of [-1, 0.1, NaN, Infinity, 24 * 60 * 60 * 1_000 + 1]) {
      expect(() => first.advanceBy(invalid)).toThrow()
    }
    expect(Math.abs(first.nowMs() - Date.now())).toBeLessThan(1_000)
    for (const filePath of [undefined, "clock.json", process.cwd()]) {
      expect(() =>
        openPlaywrightRouterClock({ PLAYWRIGHT_ROUTER_CLOCK_FILE: filePath })
      ).toThrow("Isolated router clock unavailable.")
    }
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

it("injects the shared clock only into an isolated ephemeral loopback relay", () => {
  const clock = createPlaywrightRouterClock()
  const environment = {
    PLAYWRIGHT_RELAY_PORT: "54321",
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "54321",
    RELAY_EPHEMERAL: "true",
    RELAY_FAULT_MODE: "none",
  }
  try {
    const options = resolvePlaywrightRouterRelayOptions(
      environment,
      clock.nowMs
    )
    expect(options).toMatchObject({
      hostname: "127.0.0.1",
      port: 54321,
      persistence: false,
      faultMode: "none",
    })
    const browserTime = clock.advanceBy(46 * 60 * 1_000)
    expect(Math.abs(options.now!() - browserTime)).toBeLessThan(1_000)
    for (const unsafe of [
      { RELAY_HOST: "0.0.0.0" },
      { RELAY_PORT: "3000" },
      { RELAY_PORT: "3001" },
      { RELAY_EPHEMERAL: "false" },
      { RELAY_FAULT_MODE: "drop-acks" },
      { VITE_LIGHTNING_NETWORK: "mainnet" },
      { VITE_E2E_RELAY_URL: "wss://public.example.invalid" },
      { NODE_ENV: "production" },
    ]) {
      expect(() =>
        resolvePlaywrightRouterRelayOptions(
          { ...environment, ...unsafe },
          clock.nowMs
        )
      ).toThrow()
    }
  } finally {
    clock.cleanup()
  }
})

it("keeps a concurrent process readable across bounded resets and advances", async () => {
  const clock = createPlaywrightRouterClock()
  const helperUrl = new URL(
    "../scripts/dev/playwright_router_clock.ts",
    import.meta.url
  ).href
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `const { openPlaywrightRouterClock } = await import(${JSON.stringify(helperUrl)});
       const clock = openPlaywrightRouterClock({PLAYWRIGHT_ROUTER_CLOCK_FILE:${JSON.stringify(clock.filePath)}});
       console.log("ready");
       await Bun.stdin.text();
       let failed = 0;
       for (let index = 0; index < 500; index++) {
         try { clock.nowMs(); } catch { failed++; }
         if (index % 50 === 0) await new Promise(resolve => setTimeout(resolve, 1));
       }
       console.log(JSON.stringify({failed}));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const output = child.stdout.getReader()
    const ready = await output.read()
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready")
    child.stdin.end()
    let failedWrites = 0
    for (let index = 0; index < 50; index++) {
      try {
        clock.reset()
        clock.advanceBy(46 * 60 * 1_000)
      } catch {
        failedWrites++
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    let remaining = ""
    for (;;) {
      const chunk = await output.read()
      if (chunk.done) break
      remaining += new TextDecoder().decode(chunk.value)
    }
    expect(await child.exited).toBe(0)
    expect(JSON.parse(remaining)).toEqual({ failed: 0 })
    expect(failedWrites).toBe(0)
  } finally {
    child.kill()
    await child.exited
    clock.cleanup()
  }
})

it.skipIf(process.platform !== "win32")(
  "fails closed when a Windows sharing lock outlasts bounded replacement retries",
  () => {
    const clock = createPlaywrightRouterClock()
    try {
      const held = openSync(clock.filePath, "r")
      try {
        expect(() => clock.advanceBy(46 * 60 * 1_000)).toThrow(
          "Isolated router clock unavailable."
        )
        expect(Math.abs(clock.nowMs() - Date.now())).toBeLessThan(1_000)
      } finally {
        closeSync(held)
      }
      expect(() => clock.advanceBy(46 * 60 * 1_000)).not.toThrow()
    } finally {
      clock.cleanup()
    }
  }
)

it("cleans up after a brief final cross-process read without masking the test result", async () => {
  const clock = createPlaywrightRouterClock()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `const { openSync, closeSync } = await import("node:fs");
       const held = openSync(${JSON.stringify(clock.filePath)}, "r");
       console.log("ready");
       await Bun.stdin.text();
       await new Promise(resolve => setTimeout(resolve, 30));
       closeSync(held);`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const output = child.stdout.getReader()
    const ready = await output.read()
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready")
    child.stdin.end()
    expect(() => clock.cleanup()).not.toThrow()
    expect(await child.exited).toBe(0)
    expect(existsSync(clock.filePath)).toBe(false)
    expect(existsSync(path.dirname(clock.filePath))).toBe(false)
  } finally {
    child.kill()
    await child.exited
    clock.cleanup()
  }
})
