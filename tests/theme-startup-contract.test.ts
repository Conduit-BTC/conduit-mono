import { describe, expect, it } from "bun:test"

const appEntries = ["market", "merchant", "store-builder"] as const

describe("theme startup contract", () => {
  for (const app of appEntries) {
    it(`${app} injects the shared synchronous bootstrap ahead of app modules`, async () => {
      const viteConfig = await Bun.file(`apps/${app}/vite.config.ts`).text()
      const bootstrapIndex = viteConfig.indexOf("createThemeBootstrapPlugin()")
      const appPluginIndex = viteConfig.indexOf("TanStackRouterVite()")

      expect(bootstrapIndex).toBeGreaterThan(-1)
      expect(bootstrapIndex).toBeLessThan(appPluginIndex)
    })

    it(`${app} initializes the runtime before creating the React root`, async () => {
      const source = await Bun.file(`apps/${app}/src/main.tsx`).text()
      const initializeIndex = source.indexOf("\ninitializeTheme()\n")
      const createRootIndex = source.indexOf("createRoot(")

      expect(initializeIndex).toBeGreaterThan(-1)
      expect(initializeIndex).toBeLessThan(createRootIndex)
    })
  }

  it("keeps bootstrap behavior and theme values in the shared UI package", async () => {
    const bootstrap = await Bun.file(
      "packages/ui/src/theme/definitions.ts"
    ).text()
    const bootstrapPlugin = await Bun.file(
      "scripts/vite/theme_bootstrap.ts"
    ).text()
    const themeCss = await Bun.file("packages/ui/src/styles/theme.css").text()

    expect(bootstrap).toContain("createThemeBootstrapScript")
    expect(bootstrap).toContain("document.documentElement")
    expect(bootstrapPlugin).toContain('injectTo: "head-prepend"')
    expect(bootstrapPlugin).toContain("children: createThemeBootstrapScript()")
    expect(themeCss).toContain(':root[data-theme="night-market"]')
    expect(themeCss).toContain(':root[data-theme="day-market"]')
    expect(themeCss).not.toContain("prefers-color-scheme")
  })
})
