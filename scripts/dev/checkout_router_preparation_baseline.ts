import { plugin } from "bun"
import { execFileSync } from "node:child_process"
import { relative } from "node:path"

const PREPARATION_MODULES = new Set([
  "apps/market/src/lib/checkout-spark-settled-entry.ts",
  "apps/market/src/lib/checkout-spark-settled-preparation.ts",
])

/**
 * Read-only, process-scoped replay of the preparation baseline. Run only with
 * the documented offline preparation tests; no working-tree reset is needed.
 * Current fixtures/assertions stay unchanged so the old path must go red.
 */
plugin({
  name: "Checkout router preparation baseline replay",
  setup(build) {
    build.onLoad(
      { filter: /checkout-spark-settled-(entry|preparation)\.ts$/ },
      ({ path }) => {
        const modulePath = relative(process.cwd(), path).replaceAll("\\", "/")
        if (!PREPARATION_MODULES.has(modulePath)) return
        return {
          loader: "ts",
          contents: execFileSync("git", ["show", `2029d606:${modulePath}`], {
            cwd: process.cwd(),
            encoding: "utf8",
          }),
        }
      }
    )
  },
})
