import { createPlaywrightRouterConfig } from "./scripts/dev/playwright_router_config"
import { resolvePlaywrightRouterPorts } from "./scripts/dev/run_playwright_router_web_server"
import { encodeSparkAddress } from "./apps/market/node_modules/@buildonspark/spark-sdk/dist/index.node.js"

// This suppresses DOM failure snapshots, not error-context generation. Router
// tests must still rethrow fixed stage errors and observe only booleans/counts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
// Public deterministic fixture destination only. No treasury signing material
// is present in this process or exposed to either browser application.
process.env.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS = encodeSparkAddress({
  identityPublicKey:
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  network: "REGTEST",
})

const ports = resolvePlaywrightRouterPorts(process.env)
// Test helpers and Vite processes must agree on these dedicated origins.
process.env.PLAYWRIGHT_MARKET_PORT = ports.marketPort
process.env.PLAYWRIGHT_MERCHANT_PORT = ports.merchantPort
export default createPlaywrightRouterConfig(process.env)
