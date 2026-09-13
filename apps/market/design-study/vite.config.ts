import { fileURLToPath } from "node:url"
import process from "node:process"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import tailwind from "@tailwindcss/postcss"
import { createThemeBootstrapPlugin } from "../../../scripts/vite/theme_bootstrap.ts"

const root = fileURLToPath(new URL(".", import.meta.url))
const codespaceHost =
  process.env.CODESPACE_NAME &&
  process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `${process.env.CODESPACE_NAME}-7000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : undefined

export default defineConfig({
  root,
  // Do not load Market's .env files, routes, build contract, or service plugins.
  envDir: false,
  envPrefix: "STUDY_PUBLIC_",
  publicDir: false,
  plugins: [createThemeBootstrapPlugin(), react()],
  resolve: { dedupe: ["react", "react-dom"] },
  css: { postcss: { plugins: [tailwind()] } },
  server: {
    host: "0.0.0.0",
    port: 7000,
    strictPort: true,
    allowedHosts: codespaceHost ? [codespaceHost] : [],
  },
  build: { outDir: "dist" },
})
