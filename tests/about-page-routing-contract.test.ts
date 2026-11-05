import { describe, expect, it } from "bun:test"
import { isMerchantPublicAboutPath } from "../apps/merchant/src/lib/publicRoutes"

describe("About page routing and contributor contracts", () => {
  it("matches only the Merchant About route as a public workspace bypass", () => {
    expect(isMerchantPublicAboutPath("/about")).toBe(true)
    expect(isMerchantPublicAboutPath("/about/")).toBe(true)
    expect(isMerchantPublicAboutPath("/")).toBe(false)
    expect(isMerchantPublicAboutPath("/about/team")).toBe(false)
    expect(isMerchantPublicAboutPath("/about-us")).toBe(false)
  })

  it("derives contributor data at build time instead of shipping identities in UI source", async () => {
    for (const configPath of [
      "apps/market/vite.config.ts",
      "apps/merchant/vite.config.ts",
    ]) {
      const config = await Bun.file(configPath).text()
      expect(config).toContain("createRepositoryContributorsPlugin()")
    }

    for (const routePath of [
      "apps/market/src/routes/about.tsx",
      "apps/merchant/src/routes/about.tsx",
    ]) {
      const route = await Bun.file(routePath).text()
      expect(route).toContain('from "virtual:conduit-repository-contributors"')
      expect(route).toContain("contributors={repositoryContributorSnapshot}")
    }
  })
})
