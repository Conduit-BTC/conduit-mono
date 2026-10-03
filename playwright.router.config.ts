import { createPlaywrightRouterConfig } from "./scripts/dev/playwright_router_config"
import { resolvePlaywrightRouterPorts } from "./scripts/dev/run_playwright_router_web_server"

// This suppresses DOM failure snapshots, not error-context generation. Router
// tests must still rethrow fixed stage errors and observe only booleans/counts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

const ports = resolvePlaywrightRouterPorts(process.env)
// Test helpers and Vite processes must agree on these dedicated origins.
process.env.PLAYWRIGHT_MARKET_PORT = ports.marketPort
process.env.PLAYWRIGHT_MERCHANT_PORT = ports.merchantPort
export default createPlaywrightRouterConfig(process.env)
