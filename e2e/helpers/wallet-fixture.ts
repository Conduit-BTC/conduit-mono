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
        if (!fixtureWindow.__walletProbe)
          await new Promise<void>((resolve) => {
            fixtureWindow.__walletFixtureReady = resolve
          })
        const probe = fixtureWindow.__walletProbe
        probe.opens++
        probe.openedAccounts.push(input.accountNumber)
        probe.lastAccount = input.accountNumber
        probe.savedMnemonic = input.mnemonic
        const imported = input.mnemonic === probe.importMnemonic
        const recovered = !!probe.restoredAddress
        if (fixtureWindow.__walletSetupBarrier)
          await fixtureWindow.__walletSetupBarrier()
        let registered = imported || recovered
        let registrationPending = false
        let selectedName: string | undefined
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
                      : `${selectedName ?? `wallet${probe.registrations}`}@conduit.cash`,
                  lnurl: "https://conduit.cash/lnurlp/test",
                  publicLookup: "verified",
                  zap: { status: "unsupported" },
                }
              : registrationPending
                ? { status: "unavailable", reason: "registration_pending" }
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
          async ensureBreezAddress(username?: string) {
            if (registered) return lookup()
            if (probe.delayRegistration)
              await new Promise<void>((resolve) => {
                probe.releaseRegistration = resolve
              })
            if (probe.failRegistration) {
              registrationPending = true
              return { status: "unavailable", reason: "registration_pending" }
            }
            selectedName = username
            probe.registrations++
            registered = true
            registrationPending = false
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
  failRegistration = false,
  restoredAddress?: string
) {
  await page.evaluate(
    async ({ failRegistration, modulePath, restoredAddress }) => {
      const recovery = await import("/@fs" + modulePath)
      Object.assign(window, {
        __walletProbe: {
          restoredAddress,
          registrations: 0,
          opens: 0,
          openedAccounts: [],
          disconnects: 0,
          failRegistration,
          importMnemonic: recovery.generateSparkMnemonic(),
          savedMnemonic: "",
          lastAccount: -1,
        },
      })
      ;(window as any).__walletFixtureReady?.()
    },
    {
      restoredAddress,
      failRegistration,
      modulePath: path.resolve("packages/core/src/wallets/spark-recovery.ts"),
    }
  )
}
