import { expect, it } from "bun:test"

it("enforces opaque public parser inputs and deeply immutable signed fields", async () => {
  const child = Bun.spawn(
    ["bun", "scripts/ci/check_public_event_boundary.ts"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stdout + stderr)
  expect(exitCode).toBe(0)
}, 60_000)
