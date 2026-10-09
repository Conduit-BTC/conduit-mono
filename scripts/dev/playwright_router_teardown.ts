import { cleanupPlaywrightRouterClock } from "./playwright_router_clock"

export default function teardown(): void {
  // Windows can terminate child processes without delivering SIGTERM. The
  // runner therefore also removes its captured exact clock file after tests.
  if (process.env.PLAYWRIGHT_ROUTER_CLOCK_FILE) {
    cleanupPlaywrightRouterClock(process.env)
  }
}
