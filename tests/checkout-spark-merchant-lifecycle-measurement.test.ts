import { expect, it } from "bun:test"
import { fileURLToPath } from "node:url"

const CHILD_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 16_384

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  retain: boolean
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_OUTPUT_BYTES)
        throw new Error("Merchant lifecycle subprocess output limit exceeded.")
      if (retain) output += decoder.decode(chunk.value, { stream: true })
    }
    return retain ? output + decoder.decode() : ""
  } finally {
    reader.releaseLock()
  }
}

it("measures composed offline Merchant wallet-open sessions without contaminating the test process", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL(
          "../scripts/dev/measure_checkout_spark_merchant_lifecycle.ts",
          import.meta.url
        )
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const timeout = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS)
  let output: string
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      readBounded(child.stdout, true),
      readBounded(child.stderr, false),
    ])
    if (exitCode !== 0) throw new Error("Merchant lifecycle subprocess failed.")
    output = stdout
  } catch {
    // No child assertions, raw stderr, provider payloads, or key material escape.
    throw new Error("Merchant lifecycle subprocess failed.")
  } finally {
    clearTimeout(timeout)
    child.kill()
  }

  const expected = {
    schemaVersion: 1,
    measurement: "merchant_wallet_open_lifecycle",
    finalCollection: "lightning_fee_leg",
    environment: "offline_fixture",
    timing: "controlled_virtual_wallet_open_cost",
    initCostMs: 100,
    networkAttempts: 0,
    cases: [
      {
        commerceLegs: 1,
        conduitLegs: 1,
        walletOpens: 9,
        walletCleanups: 9,
        sends: 2,
        virtualInitMs: 900,
        maxActiveWallets: 1,
        advancementInvocations: 5,
        phaseWalletOpens: {
          credit: 1,
          prepare: 2,
          history: 3,
          continue: 2,
          retire: 1,
        },
        terminalReplayOpens: 0,
        terminalReplaySends: 0,
      },
      {
        commerceLegs: 3,
        conduitLegs: 1,
        walletOpens: 17,
        walletCleanups: 17,
        sends: 4,
        virtualInitMs: 1_700,
        maxActiveWallets: 1,
        advancementInvocations: 9,
        phaseWalletOpens: {
          credit: 1,
          prepare: 4,
          history: 7,
          continue: 4,
          retire: 1,
        },
        terminalReplayOpens: 0,
        terminalReplaySends: 0,
      },
      {
        commerceLegs: 8,
        conduitLegs: 1,
        walletOpens: 37,
        walletCleanups: 37,
        sends: 9,
        virtualInitMs: 3_700,
        maxActiveWallets: 1,
        advancementInvocations: 19,
        phaseWalletOpens: {
          credit: 1,
          prepare: 9,
          history: 17,
          continue: 9,
          retire: 1,
        },
        terminalReplayOpens: 0,
        terminalReplaySends: 0,
      },
    ],
  }
  // Compare only a boolean so unexpected child output cannot enter diagnostics.
  expect(output.trim() === JSON.stringify(expected)).toBe(true)
}, 90_000)
