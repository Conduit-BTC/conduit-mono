import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { resolve } from "path"
import { defineConduitBuildEnv } from "../../scripts/vite/build_info"

export default defineConfig({
  define: defineConduitBuildEnv(__dirname),
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3002,
  },
})
