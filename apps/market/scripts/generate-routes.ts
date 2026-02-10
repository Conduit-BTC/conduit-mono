import path from "path"
import { fileURLToPath } from "url"
import { Generator, getConfig } from "@tanstack/router-generator"

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, "..")

  const config = getConfig(
    {
      target: "react",
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
      quoteStyle: "double",
      semicolons: false,
      disableLogging: true,
    },
    root
  )

  const gen = new Generator({ config, root })
  await gen.run({ type: "rerun" })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

