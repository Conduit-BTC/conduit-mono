import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

import { SYNTHETIC_POSTHOG_PROJECT_TOKEN } from "./test/fixtures.js"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          POSTHOG_PROJECT_TOKEN: SYNTHETIC_POSTHOG_PROJECT_TOKEN,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.worker.ts"],
  },
})
