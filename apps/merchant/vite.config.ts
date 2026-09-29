import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { resolve } from "path"
import { fileURLToPath } from "node:url"
import { createConduitBuildContract } from "../../scripts/vite/build_info.ts"
import { createRepositoryContributorsPlugin } from "../../scripts/vite/repository_contributors.ts"
import { createThemeBootstrapPlugin } from "../../scripts/vite/theme_bootstrap.ts"
import { createAboutMetadataPlugin } from "../../scripts/vite/about_metadata.ts"

const appDir = fileURLToPath(new URL(".", import.meta.url))
const buildContract = createConduitBuildContract(appDir)

export default defineConfig({
  define: buildContract.define,
  plugins: [
    createThemeBootstrapPlugin(),
    TanStackRouterVite(),
    react(),
    createRepositoryContributorsPlugin(),
    buildContract.deploymentManifestPlugin,
    createAboutMetadataPlugin({
      homeTitle: "Conduit Merchant",
      homeDescription:
        "Manage listings, invoices, fulfillment, and buyer conversations from the Conduit Merchant Portal.",
      origin: "https://sell.conduit.market",
      aboutTitle: "About Conduit Sell | Open Nostr Commerce",
      aboutDescription:
        "Explore the open Nostr standards behind Conduit Sell, its source code, contributors, and current build information.",
    }),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(appDir, "./src"),
      react: resolve(appDir, "../../node_modules/react"),
      "react-dom": resolve(appDir, "../../node_modules/react-dom"),
      "react/jsx-runtime": resolve(
        appDir,
        "../../node_modules/react/jsx-runtime.js"
      ),
      "react/jsx-dev-runtime": resolve(
        appDir,
        "../../node_modules/react/jsx-dev-runtime.js"
      ),
    },
  },
  server: {
    port: 3001,
  },
})
