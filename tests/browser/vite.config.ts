import { defineConfig } from "vite"
import { resolve } from "node:path"
export default defineConfig({
  root: resolve(import.meta.dirname),
  envDir: false,
  cacheDir: resolve(
    import.meta.dirname,
    "../../node_modules/.vite-browser-tests-isolated"
  ),
  envPrefix: "BROWSER_TEST_PUBLIC_",
  server: { host: "127.0.0.1", port: 4318, strictPort: true, hmr: false },
  resolve: {
    alias: {
      "@conduit/core": resolve(import.meta.dirname, "../../packages/core/src"),
    },
  },
})
