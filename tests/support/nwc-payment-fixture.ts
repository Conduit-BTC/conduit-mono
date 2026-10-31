import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { type WalletNetwork, type WalletPayInvoiceInput } from "@conduit/core"
import {
  __buyerNwcSessionTestInternals,
  closeBuyerNwcSession,
  getBuyerNwcSession,
} from "../../apps/market/src/lib/buyer-nwc-session"
import { payCheckoutInvoice } from "../../apps/market/src/lib/payment-rails"
import {
  marketWalletProviderRegistry,
  WalletPaymentCoordinator,
} from "../../apps/market/src/lib/wallet-payment-coordinator"

/** Real session/adapter/coordinator/rail; only the SDK client is local dummy I/O. */
export async function createNwcPaymentFixture(
  pay: (invoice: string) => Promise<{ preimage: string }>,
  options: { prepare?: () => void; network?: WalletNetwork } = {}
) {
  const walletId = crypto.randomUUID()
  const connection = {
    walletPubkey: getPublicKey(generateSecretKey()),
    secret: Buffer.from(generateSecretKey()).toString("hex"),
    relays: ["wss://wallet.example.invalid"],
  }
  const submitted: string[] = []
  const attempts: WalletPayInvoiceInput[] = []
  __buyerNwcSessionTestInternals.__setClientFactory(() => ({
    getInfo: async () => ({
      methods: ["pay_invoice"],
      network: options.network ?? "mainnet",
    }),
    getBalance: async () => ({ balance: 0 }),
    pool: { ensureRelay: async () => options.prepare?.() },
    payInvoice: async ({ invoice }) => {
      submitted.push(invoice)
      return pay(invoice)
    },
    close() {},
  }))
  const reconnect = async () => {
    closeBuyerNwcSession(walletId)
    const session = getBuyerNwcSession(walletId)
    session.setConnection(connection)
    await session.warm()
  }
  await reconnect()
  // Registry eligibility is local fixture setup; payment admission stays real.
  const coordinator = new WalletPaymentCoordinator(marketWalletProviderRegistry)
  return {
    target: { type: "wallet" as const, providerId: "nwc" as const, walletId },
    submitted,
    attempts,
    reconnect,
    payInvoice: (input: Parameters<typeof payCheckoutInvoice>[0]) =>
      payCheckoutInvoice(input, {
        walletPaymentCoordinator: {
          payInvoice: (target, request) => {
            attempts.push(request)
            return coordinator.payInvoice(target, request)
          },
        },
        hasWebLN: () => false,
        weblnSendPayment: async () => {
          throw new Error("Unexpected payment fallback")
        },
        recordPaymentAttemptResult: () => {},
      }),
    dispose() {
      closeBuyerNwcSession(walletId)
      __buyerNwcSessionTestInternals.__setClientFactory(null)
    },
  }
}
