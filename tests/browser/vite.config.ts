import { defineConfig } from "vite"
import { resolve } from "node:path"
import { createRequire } from "node:module"
const appRequire = createRequire(
  resolve(import.meta.dirname, "../../apps/market/package.json")
)
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
    alias: [
      {
        find: "@conduit/core",
        replacement: resolve(import.meta.dirname, "../../packages/core/src"),
      },
      ...["react", "react-dom/client", "@tanstack/react-query"].map((name) => ({
        find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement: appRequire.resolve(name),
      })),
    ],
  },
})
