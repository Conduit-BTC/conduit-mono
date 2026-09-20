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

  it("keeps Report a Bug outside each scrolling navigation region", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const mobile = sliceBetween(
      header,
      "export function MerchantMobileNav",
      "export function MerchantSidebar"
    )
    const sidebar = header.slice(
      header.indexOf("export function MerchantSidebar")
    )

    for (const shell of [mobile, sidebar]) {
      expect(shell).toContain("min-h-0 flex-1 overflow-y-auto")
      expect(shell).toContain("<MerchantNavLinks")
      expect(shell).toContain("<ReportBugLink")
      expect(shell.indexOf("<ReportBugLink")).toBeGreaterThan(
        shell.indexOf("<MerchantNavLinks")
      )
    }
  })

  it("preserves the Merchant brand and removes redundant setup and About actions", async () => {
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const root = await Bun.file("apps/merchant/src/routes/__root.tsx").text()
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

    expect(brand).toContain("min-[400px]:block")
    expect(brand).toContain("min-[400px]:hidden")
    expect(brand).toContain(">\n        merchant\n      </span>")
    expect(root).toContain("<MerchantAccountMenu />")
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
})
