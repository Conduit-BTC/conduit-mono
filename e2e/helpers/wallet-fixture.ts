import path from "node:path"
import type { Page } from "@playwright/test"
export async function prepareControlledWallet(page: Page) {
  // Replace network initialization at the existing single manager's factory.
  // Production modules and UI/hooks/storage/signers otherwise run unchanged.
  await page.addInitScript(() => {
    const fixtureWindow = window as any
    fixtureWindow.__walletFixtureFactory = {
      network: "mainnet",
      async open(input: {
        mnemonic: string
        accountNumber: number
        walletId: string
      }) {
        const probe = fixtureWindow.__walletProbe
        probe.opens++
        probe.lastAccount = input.accountNumber
        probe.savedMnemonic = input.mnemonic
        const imported = input.mnemonic === probe.importMnemonic
        const recovered = !!probe.restoredAddress
        if (fixtureWindow.__walletSetupBarrier)
          await fixtureWindow.__walletSetupBarrier()
        let registered = imported || recovered
        const lookup = async () =>
          probe.addressUnavailableReason
            ? { status: "unavailable", reason: probe.addressUnavailableReason }
            : registered
              ? {
                  status: "registered",
                  address: recovered
                    ? probe.restoredAddress
                    : imported
                      ? "support@conduit.cash"
                      : `wallet${probe.registrations}@conduit.cash`,
                  lnurl: "https://conduit.cash/lnurlp/test",
                  publicLookup: "verified",
                  zap: { status: "unsupported" },
                }
              : { status: "absent" }
        return {
          async disconnect() {
            probe.disconnects++
          },
          async getInfo() {
            return { balanceSats: 0 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async lookupBreezAddress() {
            return lookup()
          },
          async ensureBreezAddress() {
            if (registered) return lookup()
            if (probe.delayRegistration)
              await new Promise<void>((resolve) => {
                probe.releaseRegistration = resolve
              })
            if (probe.failRegistration)
              return { status: "unavailable", reason: "registration_pending" }
            probe.registrations++
            registered = true
            return lookup()
          },
          async receivePayment() {
            return { paymentRequest: "controlled-invoice", fee: 0n }
          },
          async prepareSendPayment() {
            throw new Error("Controlled unfunded wallet")
          },
          async sendPayment() {
            throw new Error("No payment is authorized in this test")
          },
        }
      },
    }
  })
  await page.route(
    "**/packages/core/src/wallets/spark-sdk.ts*",
    async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      const marker = "new FirstPartySparkSdkFactory("
      if (body.split(marker).length !== 2)
        throw new Error("Wallet factory fixture seam changed")
      await route.fulfill({
        response,
        body: body.replace(
          marker,
          "window.__walletFixtureFactory ?? new FirstPartySparkSdkFactory("
        ),
      })
    }
  )
}
export async function installControlledWallet(
  page: Page,
  failRegistration = false
) {
  await page.evaluate(
    async ({ failRegistration, modulePath }) => {
      const recovery = await import("/@fs" + modulePath)
      Object.assign(window, {
        __walletProbe: {
          registrations: 0,
          opens: 0,
          disconnects: 0,
          failRegistration,
          importMnemonic: recovery.generateSparkMnemonic(),
          savedMnemonic: "",
          lastAccount: -1,
        },
      })
    },
    {
      failRegistration,
      modulePath: path.resolve("packages/core/src/wallets/spark-recovery.ts"),
    }
  )
}
