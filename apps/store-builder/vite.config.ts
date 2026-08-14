import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { resolve } from "path"
import { fileURLToPath } from "node:url"
import { createConduitBuildContract } from "../../scripts/vite/build_info.ts"

const appDir = fileURLToPath(new URL(".", import.meta.url))
const buildContract = createConduitBuildContract(appDir)

export default defineConfig({
  define: buildContract.define,
  plugins: [
    TanStackRouterVite(),
    react(),
    buildContract.deploymentManifestPlugin,
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(appDir, "./src"),
    },
  },
  server: {
    port: 3002,
  },
})
