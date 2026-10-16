import { fileURLToPath } from "node:url"
import appConfig from "../apps/merchant/vite.config"
import { createHermeticSparkVitePlugin } from "./helpers/hermetic-spark-vite"

const appDir = fileURLToPath(new URL("../apps/merchant/", import.meta.url))

export default {
  ...appConfig,
  root: appDir,
  plugins: [
    ...(appConfig.plugins ?? []),
    createHermeticSparkVitePlugin(appDir),
  ],
  server: {
    ...appConfig.server,
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
}
