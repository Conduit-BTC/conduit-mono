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

  it("keeps Merchant About ahead of authenticated workspace initialization", async () => {
    const main = await Bun.file("apps/merchant/src/main.tsx").text()
    const root = await Bun.file("apps/merchant/src/routes/__root.tsx").text()
    const publicShell = await Bun.file(
      "apps/merchant/src/components/MerchantPublicAboutShell.tsx"
    ).text()
    const publicBranch = main.slice(
      main.indexOf("if (isPublicEntry)"),
      main.indexOf("} else {")
    )
    const authenticatedBranch = main.slice(main.indexOf("} else {"))
    const rootDispatch = root.slice(
      root.indexOf("function RootLayout()"),
      root.indexOf("function MerchantProductRoot")
    )

    expect(publicBranch).toContain("<RouterProvider router={router} />")
    expect(publicBranch).not.toContain("<AuthProvider")
    expect(publicBranch).not.toContain("startProductDeletionDeliveryWorker()")
    expect(authenticatedBranch).toContain("<AuthProvider")
    expect(authenticatedBranch).toContain(
      "startProductDeletionDeliveryWorker()"
    )
    expect(rootDispatch).toContain("isMerchantPublicAboutPath(pathname)")
    expect(rootDispatch).toContain("<MerchantPublicAboutShell>")
    expect(rootDispatch).not.toContain("useAuth")
    expect(publicShell).not.toContain("AuthProvider")
    expect(publicShell).toContain(
      'installBrowserClientErrorTelemetry("merchant")'
    )
    expect(publicShell).toContain("Open merchant workspace")
  })

  it("derives contributor data at build time instead of shipping identities in UI source", async () => {
    const panel = await Bun.file(
      "packages/ui/src/components/AboutPagePanel.tsx"
    ).text()
    const generator = await Bun.file(
      "scripts/vite/repository_contributors.ts"
    ).text()

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

    expect(generator).toContain("api.github.com/graphql")
    expect(generator).toContain("states: MERGED")
    expect(generator).toContain("commit.parents.totalCount < 2")
    expect(generator).toContain("contributor.commitIds.add(commit.oid)")
    expect(generator).toContain('actor.__typename === "Bot"')
    expect(generator).toContain("GENERATED_SNAPSHOT_MAX_AGE_MS")
    expect(generator).toContain('status: "unavailable"')
    expect(panel).toContain("<AvatarImage")
    expect(panel).toContain("src={contributor.avatarUrl}")
    expect(panel).not.toContain("dependabot[bot]")
    expect(panel).not.toContain("DEFAULT_CONTRIBUTORS")
  })
})
