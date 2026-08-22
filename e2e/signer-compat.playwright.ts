import { expect, test, type Page } from "@playwright/test"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installLateTestSigner,
  installLockedTestSigner,
  installRejectingTestSigner,
  installTestSigner,
  seedStoredAuth,
  unlockTestSigner,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const merchantTrustHarnessUrl = "/src/test-fixtures/merchant-trust-harness.tsx"
const ndkModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/ndk.ts`

async function hasActiveNdkSigner(page: Page): Promise<boolean> {
  return page.evaluate(async (url) => {
    const module = (await import(/* @vite-ignore */ url)) as {
      getNdk: () => { signer?: unknown }
    }
    return !!module.getNdk().signer
  }, ndkModuleUrl)
}

async function openMarketSignerDialog(page: Page): Promise<void> {
  await page.goto(`${marketUrl}/products`)
  await page
    .getByRole("button", { name: /^Connect$/ })
    .first()
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
}

async function connectFromMarketDialog(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
    .click()
}

async function storedAuthMatches(
  page: Page,
  expectedPubkey: string
): Promise<boolean> {
  return page.evaluate((expected) => {
    const raw = localStorage.getItem("conduit:auth")
    if (!raw) return false
    if (/^[0-9a-f]{64}$/i.test(raw)) return raw === expected
    try {
      const parsed = JSON.parse(raw) as { userPubkey?: unknown }
      return parsed.userPubkey === expected
    } catch {
      return false
    }
  }, expectedPubkey)
}

test("market connect tolerates late NIP-07 signer injection @market", async ({
  page,
}) => {
  await installLateTestSigner(page, TEST_BUYER_PUBKEY)
  await openMarketSignerDialog(page)

  const connectButton = page.getByRole("button", {
    name: /Connect Extension \(NIP-07\)/i,
  })
  await expect(connectButton).toBeEnabled({ timeout: 8_000 })
  await connectButton.click()

  await expect
    .poll(() => storedAuthMatches(page, TEST_BUYER_PUBKEY), {
      timeout: 10_000,
    })
    .toBe(true)
})

test("market rejected signer keeps retry path visible @market", async ({
  page,
}) => {
  await installRejectingTestSigner(page)
  await openMarketSignerDialog(page)

  await connectFromMarketDialog(page)

  await expect(page.getByText(/rejected/i).first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
  ).toBeEnabled()
})

test("market getRelays failure does not block signer connect @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, {
    rememberAuth: false,
    getRelaysThrows: true,
  })
  await openMarketSignerDialog(page)

  await connectFromMarketDialog(page)

  await expect
    .poll(() => storedAuthMatches(page, TEST_BUYER_PUBKEY), {
      timeout: 10_000,
    })
    .toBe(true)
})

test("market trust ignores a remembered viewer until auth is connected @market", async ({
  page,
}) => {
  await seedStoredAuth(page, TEST_BUYER_PUBKEY)
  await installLockedTestSigner(page)
  await page.goto(`${marketUrl}/products`)

  await page.evaluate(
    async ({ harnessUrl, viewerPubkey, merchantPubkey }) => {
      const container = document.createElement("div")
      container.id = "merchant-trust-harness"
      document.body.append(container)
      const { mountMerchantTrustHarness } = (await import(harnessUrl)) as {
        mountMerchantTrustHarness: (
          element: HTMLElement,
          staleViewerPubkey: string,
          merchantPubkey: string
        ) => void
      }
      mountMerchantTrustHarness(container, viewerPubkey, merchantPubkey)
    },
    {
      harnessUrl: merchantTrustHarnessUrl,
      viewerPubkey: TEST_BUYER_PUBKEY,
      merchantPubkey: TEST_MERCHANT_PUBKEY,
    }
  )

  const probe = page.getByTestId("merchant-trust-probe")
  await expect(probe).toHaveAttribute("data-social-state", "disconnected")
  await expect(probe).toHaveAttribute("data-mutual-count", "none")
  await expect(probe).toHaveAttribute("data-viewer-follows", "null")
})

test("market owner profile drops the public placeholder after connect @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await page.goto(`${marketUrl}/products`)

  await page.evaluate(
    async ({ harnessUrl, ownerPubkey }) => {
      const container = document.createElement("div")
      container.id = "merchant-trust-owner-harness"
      document.body.append(container)
      const { mountMerchantTrustHarness } = (await import(harnessUrl)) as {
        mountMerchantTrustHarness: (
          element: HTMLElement,
          staleViewerPubkey: string,
          merchantPubkey: string,
          options?: { publicProfileName?: string }
        ) => void
      }
      mountMerchantTrustHarness(container, ownerPubkey, ownerPubkey, {
        publicProfileName: "Public cached profile",
      })
    },
    {
      harnessUrl: merchantTrustHarnessUrl,
      ownerPubkey: TEST_BUYER_PUBKEY,
    }
  )

  const probe = page.getByTestId("merchant-trust-probe")
  await expect(probe).toHaveAttribute(
    "data-profile-name",
    "Public cached profile"
  )

  await page.getByTestId("merchant-trust-connect").evaluate((button) => {
    ;(button as HTMLButtonElement).click()
  })
  await expect(probe).toHaveAttribute("data-auth-status", "connected", {
    timeout: 10_000,
  })
  await expect(probe).not.toHaveAttribute(
    "data-profile-name",
    "Public cached profile"
  )
})

test("market signer authority storage failure remains retryable @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === "conduit:auth:revision") return
      setItem.call(this, key, value)
    }
  })
  await openMarketSignerDialog(page)

  const connectButton = page.getByRole("button", {
    name: /Connect Extension \(NIP-07\)/i,
  })
  await connectButton.click()

  await expect(
    page.getByText(/could not establish exclusive signer authority/i)
  ).toBeVisible({ timeout: 10_000 })
  await expect(connectButton).toBeEnabled()
})

test("market signer authority read failure remains retryable @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    let claimed = false
    let claimedRevisionReads = 0
    let failOnce = true
    let blocked = false

    Storage.prototype.setItem = function (key: string, value: string): void {
      setItem.call(this, key, value)
      if (key === "conduit:auth:revision" && failOnce) {
        claimed = true
        claimedRevisionReads = 0
      }
    }
    Storage.prototype.getItem = function (key: string): string | null {
      if (blocked) throw new Error("Storage access denied")
      if (claimed && key === "conduit:auth:revision") {
        claimedRevisionReads += 1
        if (claimedRevisionReads > 1) {
          blocked = true
          throw new Error("Storage access denied")
        }
      }
      return getItem.call(this, key)
    }
    ;(
      window as Window &
        typeof globalThis & {
          restoreSignerSetupStorage: () => void
        }
    ).restoreSignerSetupStorage = () => {
      blocked = false
      claimed = false
      failOnce = false
    }
  })
  await openMarketSignerDialog(page)

  const connectButton = page.getByRole("button", {
    name: /Connect Extension \(NIP-07\)/i,
  })
  await connectButton.click()

  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 })
  await expect(
    page.getByText(/lost signer authority or could not read site storage/i)
  ).toBeVisible()
  await expect(connectButton).toBeEnabled()
  await page.evaluate(() => {
    ;(
      window as Window &
        typeof globalThis & {
          restoreSignerSetupStorage: () => void
        }
    ).restoreSignerSetupStorage()
  })
  await connectButton.click()
  await expect
    .poll(() => storedAuthMatches(page, TEST_BUYER_PUBKEY), {
      timeout: 10_000,
    })
    .toBe(true)
})

test("market does not publish a NIP-07 signer after a late authority read failure @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    let blocked = false
    let failOnce = true

    Storage.prototype.setItem = function (key: string, value: string): void {
      setItem.call(this, key, value)
      if (key === "conduit:auth" && failOnce) {
        blocked = true
      }
    }
    Storage.prototype.getItem = function (key: string): string | null {
      if (blocked) throw new Error("Storage access denied")
      return getItem.call(this, key)
    }
    ;(
      window as Window &
        typeof globalThis & {
          restoreSignerSetupStorage: () => void
        }
    ).restoreSignerSetupStorage = () => {
      blocked = false
      failOnce = false
    }
  })
  await openMarketSignerDialog(page)

  await connectFromMarketDialog(page)
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 })
  await expect(
    page.getByText(/lost signer authority or could not read site storage/i)
  ).toBeVisible()
  await page.evaluate(() => {
    ;(
      window as Window &
        typeof globalThis & {
          restoreSignerSetupStorage: () => void
        }
    ).restoreSignerSetupStorage()
  })

  const reconnectButton = page.getByRole("button", {
    name: /Connect Extension \(NIP-07\)/i,
  })
  await expect(reconnectButton).toBeEnabled()
  await connectFromMarketDialog(page)
  await expect
    .poll(() => storedAuthMatches(page, TEST_BUYER_PUBKEY), {
      timeout: 10_000,
    })
    .toBe(true)
})

test("merchant locked signer shows waiting state then connects after unlock @merchant", async ({
  page,
}) => {
  await installLockedTestSigner(page)
  await page.goto(merchantUrl)

  await page
    .getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
    .click()
  await expect(
    page.getByRole("button", { name: "Connecting...", exact: true })
  ).toBeDisabled({
    timeout: 5_000,
  })

  await unlockTestSigner(page, TEST_MERCHANT_PUBKEY)

  await expect
    .poll(() => storedAuthMatches(page, TEST_MERCHANT_PUBKEY), {
      timeout: 10_000,
    })
    .toBe(true)
})

test("merchant remembered auth falls back to explicit retry when signer needs activation @merchant", async ({
  page,
}) => {
  await seedStoredAuth(page, TEST_MERCHANT_PUBKEY)
  await installLockedTestSigner(page)
  await page.goto(merchantUrl)

  await expect(page.getByText(/fresh button click/i)).toBeVisible({
    timeout: 15_000,
  })

  const connectButton = page.getByRole("button", {
    name: /Connect Extension \(NIP-07\)/i,
  })
  await expect(connectButton).toBeEnabled()
  await connectButton.click()
  await expect(
    page.getByRole("button", { name: "Connecting...", exact: true })
  ).toBeDisabled({
    timeout: 5_000,
  })

  await unlockTestSigner(page, TEST_MERCHANT_PUBKEY)

  await expect(
    page.getByRole("heading", { name: "Merchant Portal" })
  ).toBeVisible({ timeout: 10_000 })
})

test("market restored session keeps a usable signer attached @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/products`)

  await expect(page.getByLabel("Open account menu")).toBeVisible({
    timeout: 15_000,
  })

  await expect
    .poll(() => hasActiveNdkSigner(page), { timeout: 10_000 })
    .toBe(true)
})
