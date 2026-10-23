import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { fileURLToPath } from "node:url"
import { createThemeBootstrapPlugin } from "../../scripts/vite/theme_bootstrap.ts"

// Separate authoring entry point. Never included in Market's product build.
export default defineConfig({
  root: fileURLToPath(new URL("../../packages/ui/workbench", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [createThemeBootstrapPlugin(), react()],
  css: { postcss: fileURLToPath(new URL(".", import.meta.url)) },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 7003, strictPort: true },
  preview: { host: "127.0.0.1", port: 7003, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
})
