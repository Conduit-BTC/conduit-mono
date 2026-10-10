import type { WalletDescriptor } from "./index"
import {
  nwcMakeInvoice,
  nwcLookupInvoice,
  nwcGetInfo,
  parseNwcUri,
  type NwcLookupInvoiceResult,
  type NwcConnection,
} from "../protocol/nwc"
import { getAccountSigner } from "../protocol/session-signer"
import { getMarketWalletStore } from "./wallet-storage"
import { getSparkWalletManager } from "./spark-sdk"
import { type ReceivingWalletBinding } from "./receiving"

async function ownedReceivingWallet(
  owner: string,
  walletId: string,
  capability: "receive" | "verify_invoice" = "receive"
) {
  const signer = getAccountSigner()
  if (!signer || signer.pubkey !== owner)
    throw new Error("Reconnect the receiving wallet's Nostr identity.")
  const wallet = (await getMarketWalletStore().listVisible(owner)).find(
    (wallet) =>
      wallet.id === walletId &&
      (wallet.capabilities.includes(capability) ||
        (capability === "verify_invoice" &&
          wallet.providerId === "spark" &&
          wallet.capabilities.includes("receive")))
  )
  if (!wallet || getAccountSigner() !== signer)
    throw new Error("The original receiving wallet is unavailable.")
  return {
    wallet,
    assertCurrent() {
      if (getAccountSigner() !== signer)
        throw new Error("Your Nostr sign-in changed.")
    },
  }
}
export async function createWalletReceivingInvoice(
  owner: string,
  walletId: string,
  amountSats: number,
  description?: string
) {
  const { wallet, assertCurrent } = await ownedReceivingWallet(owner, walletId)
  let result: { invoice: string; receivingWallet: ReceivingWalletBinding }
  if (wallet.providerId === "spark") {
    const manager = getSparkWalletManager()
    if (!manager?.canVerifyReceiving(walletId))
      throw new Error("Open this wallet in Wallets before creating an invoice.")
    result = await manager.createReceivingInvoice(walletId, {
      amountSats,
      description,
    })
  } else if (wallet.providerId === "nwc") {
    const uri = await getMarketWalletStore().getNwcCredential(walletId)
    assertCurrent()
    if (!uri) throw new Error("Reconnect this external wallet.")
    const connection = parseNwcUri(uri)
    const info = await nwcGetInfo(connection, 10000, "merchant")
    assertCurrent()
    if (!info.methods.includes("make_invoice"))
      throw new Error("Authorize invoice creation for this external wallet.")
    const invoice = await nwcMakeInvoice(
      connection,
      { amountMsats: amountSats * 1000, description },
      null,
      "merchant"
    )
    result = {
      invoice: invoice.invoice,
      receivingWallet: { walletId, providerId: "nwc", network: wallet.network },
    }
  } else throw new Error("Unsupported receiving wallet.")
  assertCurrent()
  return result
}
export async function lookupWalletReceivingInvoice(
  owner: string,
  binding: ReceivingWalletBinding,
  invoice: string
): Promise<NwcLookupInvoiceResult> {
  const { wallet, assertCurrent } = await ownedReceivingWallet(
    owner,
    binding.walletId,
    "verify_invoice"
  )
  if (
    wallet.providerId !== binding.providerId ||
    wallet.network !== binding.network
  )
    throw new Error("The original receiving destination changed.")
  let result: NwcLookupInvoiceResult
  if (wallet.providerId === "spark") {
    const manager = getSparkWalletManager()
    if (!manager?.canVerifyReceiving(wallet.id))
      throw new Error(
        "Open the original wallet in Wallets to check its invoice."
      )
    result = await manager.lookupReceivingInvoice(
      wallet.id,
      invoice,
      binding.requestId
    )
  } else {
    const uri = await getMarketWalletStore().getNwcCredential(wallet.id)
    assertCurrent()
    if (!uri) throw new Error("Reconnect the original external wallet.")
    result = await nwcLookupInvoice(
      parseNwcUri(uri),
      { invoice },
      10000,
      "merchant"
    )
  }
  assertCurrent()
  return result
}

/** Legacy invoices have no wallet binding; exact incoming evidence is required. */
export async function lookupAccountReceivingInvoice(input: {
  owner: string
  invoice: string
  receivingWallet?: ReceivingWalletBinding
  wallets: readonly WalletDescriptor[]
  legacyConnection?: NwcConnection | null
}): Promise<NwcLookupInvoiceResult> {
  const signer = getAccountSigner()
  const assertCurrent = () => {
    if (
      !signer ||
      signer.pubkey !== input.owner ||
      getAccountSigner() !== signer
    )
      throw new Error("Your Nostr sign-in changed.")
  }
  assertCurrent()
  if (input.receivingWallet)
    return lookupWalletReceivingInvoice(
      input.owner,
      input.receivingWallet,
      input.invoice
    )
  for (const wallet of input.wallets) {
    if (wallet.providerId !== "spark" && wallet.providerId !== "nwc") continue
    if (
      !wallet.capabilities.includes("receive") &&
      !wallet.capabilities.includes("verify_invoice")
    )
      continue
    try {
      const result = await lookupWalletReceivingInvoice(
        input.owner,
        {
          walletId: wallet.id,
          providerId: wallet.providerId === "spark" ? "spark" : "nwc",
          network: wallet.network,
        },
        input.invoice
      )
      assertCurrent()
      if (result.type === "incoming" && result.state === "settled")
        return result
    } catch {
      assertCurrent()
    }
  }
  if (!input.legacyConnection)
    throw new Error(
      "Open or reconnect the original receiving wallet to check this invoice."
    )
  const result = await nwcLookupInvoice(
    input.legacyConnection,
    { invoice: input.invoice },
    10000,
    "merchant"
  )
  assertCurrent()
  return result
}
