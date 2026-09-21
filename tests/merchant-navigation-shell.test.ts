import { describe, expect, it } from "bun:test"

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function expectInOrder(source: string, values: string[]): void {
  let previousIndex = -1

  for (const value of values) {
    const index = source.indexOf(value)
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

describe("Merchant navigation shell", () => {
  it("keeps commerce, information, and account actions in their intended groups", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const commerce = sliceBetween(
      header,
      "const commerceNavItems",
      "const navItemClassName"
    )
    const information = sliceBetween(
      header,
      "function InformationNavLinks",
      "function MerchantNavLinks"
    )
    const account = sliceBetween(
      header,
      "export function MerchantAccountMenu",
      "function ReportBugLink"
    )

    expectInOrder(commerce, [
      'label: "Home"',
      'label: "Products"',
      'label: "Events"',
      'label: "Orders"',
      'label: "Payments"',
      'label: "Shipping"',
      'label: "Messages"',
    ])
    expectInOrder(information, [
      "<span>About</span>",
      "<span>Terms</span>",
      "<span>Privacy</span>",
      "<span>conduit.market</span>",
    ])
    expectInOrder(account, [
      'to="/profile"',
      'to="/network"',
      "<span>Disconnect</span>",
    ])

    expect(commerce).not.toContain('label: "Profile"')
    expect(commerce).not.toContain('label: "Network"')
    expect(information).not.toContain("GitHub")
    expect(information).not.toContain("Support")
    expect(information).not.toContain("Nostr")
    expect(account).not.toContain("Copy npub")
    expect(account).not.toContain("Needs completion")
    expect(account).not.toContain("Report a Bug")
  })

  it("uses the mobile panel as the shared overflow-free navigation surface", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const mobile = sliceBetween(
      header,
      "export function MerchantMobileNav",
      "function MerchantNavigationPanel"
    )
    const panel = sliceBetween(
      header,
      "function MerchantNavigationPanel",
      "export function MerchantWorkspaceHeader"
    )
    const sidebar = header.slice(
      header.indexOf("export function MerchantSidebar")
    )

    expect(panel).toContain("data-merchant-navigation-panel")
    expect(panel).toContain("headerAction")
    expect(panel).toContain("h-[calc(5rem+env(safe-area-inset-top))]")
    expect(panel).toContain("pt-[env(safe-area-inset-top)]")
    expect(panel).toContain("overflow-x-hidden overflow-y-auto")
    expect(panel).toContain("<MerchantNavLinks")
    expect(panel).toContain("<ReportBugLink")
    expect(panel.indexOf("<ReportBugLink")).toBeGreaterThan(
      panel.indexOf("<MerchantNavLinks")
    )
    expect(mobile).toContain("<MerchantNavigationPanel")
    expect(mobile).toContain("showCloseButton={false}")
    expect(mobile).toContain("<SheetClose asChild>")
    expect(sidebar).toContain("<MerchantNavigationPanel")
  })

  it("preserves the Merchant brand and removes redundant setup and About actions", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const dashboard = await Bun.file(
      "apps/merchant/src/routes/index.tsx"
    ).text()
    const publicAbout = await Bun.file(
      "apps/merchant/src/components/MerchantPublicAboutShell.tsx"
    ).text()
    const brand = sliceBetween(
      header,
      "export function MerchantBrandLockup",
      "function MerchantLogoLink"
    )
    const readiness = sliceBetween(
      dashboard,
      "function MerchantReadinessPanel",
      "function DashboardPage"
    )

    expect(brand).toContain('data-merchant-brand-logo=""')
    expect(brand).toContain("w-6")
    expect(brand).toContain("min-[420px]:w-[6.75rem]")
    expect(brand.match(/logo-full\.svg/g)).toHaveLength(1)
    expect(brand).toContain(">\n        merchant\n      </span>")
    expect(header).toContain("<MerchantAccountMenu />")
    expect(publicAbout).toContain("<MerchantBrandLockup />")
    expect(publicAbout).not.toContain("Open merchant workspace")
    expectInOrder(readiness, [
      'label="Profile"',
      'label="Payments"',
      'label="Shipping"',
      'label="Network"',
    ])
    expect(readiness).not.toContain("Private inbox")
  })

  it("keeps one aligned responsive header and account recovery in route errors", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const root = await Bun.file("apps/merchant/src/routes/__root.tsx").text()
    const messages = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()
    const workspaceHeader = sliceBetween(
      header,
      "export function MerchantWorkspaceHeader",
      "export function MerchantSidebar"
    )
    const shell = sliceBetween(
      root,
      "function RootShell",
      "function RootLayout"
    )
    const productError = sliceBetween(
      root,
      "function MerchantProductRootError",
      "function RootNotFound"
    )

    expectInOrder(workspaceHeader, [
      "<MerchantLogoLink />",
      "<MerchantMobileNav />",
      "<ThemeToggleButton />",
      "<MerchantAccountMenu />",
    ])
    expect(workspaceHeader).toContain("h-[calc(5rem+env(safe-area-inset-top))]")
    expect(shell).toContain("<MerchantWorkspaceHeader />")
    expect(shell).toContain("pt-[calc(6.5rem+env(safe-area-inset-top))]")
    expect(shell).toContain("lg:grid-cols-[320px_minmax(0,1fr)]")
    expect(shell).toContain("overflow-x-hidden")
    expect(messages).toContain("Buyer support inbox")
    expect(messages).not.toContain(
      ">\n          Messages\n        </div>\n        <h1"
    )
    expect(productError).toContain("if (!signerConnected) return errorPage")
    expect(productError).toContain("<RootShell>{errorPage}</RootShell>")
  })
})
