import { expect, test } from "bun:test"
import { resolvePlaywrightWebServerTarget } from "../scripts/dev/run_playwright_web_server"

test("the isolated relay never inherits a public listening host", () => {
  const target = resolvePlaywrightWebServerTarget("relay", {
    RELAY_HOST: "0.0.0.0",
  })
  expect(target.env.RELAY_HOST).toBe("127.0.0.1")
})

test("commerce configuration disables automatic DOM failure snapshots", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'await import("./playwright.config.ts"); console.log(process.env.PLAYWRIGHT_NO_COPY_PROMPT === "1")',
    ],
    {
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_AREA: "commerce",
        PLAYWRIGHT_SMOKE_DISCOVERY: "true",
        PLAYWRIGHT_NO_COPY_PROMPT: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const output = await new Response(child.stdout).text()
  await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(output.trim()).toBe("true")
})
