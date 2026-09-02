import type { Plugin } from "vite"
import { createThemeBootstrapScript } from "../../packages/ui/src/theme/definitions.ts"

export function createThemeBootstrapPlugin(): Plugin {
  return {
    name: "conduit-theme-bootstrap",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "script",
            attrs: { "data-conduit-theme-bootstrap": "true" },
            children: createThemeBootstrapScript(),
            injectTo: "head-prepend",
          },
        ]
      },
    },
  }
}
