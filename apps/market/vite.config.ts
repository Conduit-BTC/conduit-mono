import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { resolve } from "path"

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(__dirname, "./src"),
      react: resolve(__dirname, "../../node_modules/react"),
      "react-dom": resolve(__dirname, "../../node_modules/react-dom"),
      "react/jsx-runtime": resolve(
        __dirname,
        "../../node_modules/react/jsx-runtime.js"
      ),
      "react/jsx-dev-runtime": resolve(
        __dirname,
        "../../node_modules/react/jsx-dev-runtime.js"
      ),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
})
