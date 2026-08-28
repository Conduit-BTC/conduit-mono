import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { resolve } from "path"
import { fileURLToPath } from "node:url"
import { createConduitBuildContract } from "../../scripts/vite/build_info.ts"
import { createRepositoryContributorsPlugin } from "../../scripts/vite/repository_contributors.ts"

const appDir = fileURLToPath(new URL(".", import.meta.url))
const buildContract = createConduitBuildContract(appDir)

export default defineConfig({
  define: buildContract.define,
  plugins: [
    TanStackRouterVite(),
    react(),
    createRepositoryContributorsPlugin(),
    buildContract.deploymentManifestPlugin,
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
    port: 3000,
    host: true,
  },
})
