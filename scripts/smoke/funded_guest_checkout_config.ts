import { nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import { isValidLud16Address } from "@conduit/core/protocol/lightning"
import { parseNwcUri, type NwcConnection } from "@conduit/core/protocol/nwc"
import { normalizePubkey } from "@conduit/core/utils"

const MAX_FUNDED_SMOKE_PAYMENT_SATS = 1_000
const MAX_RECEIPT_RELAYS = 8

type FundedGuestSmokeConfigStage = "configuration"

class FundedGuestSmokeConfigFailure extends Error {
  override name = "FundedGuestSmokeConfigFailure"

  constructor(
    readonly stage: FundedGuestSmokeConfigStage,
    cause: unknown
  ) {
    super(`Funded guest smoke fixture failed at ${stage}.`, { cause })
  }
}

type Environment = Record<string, string | undefined>

export type FundedGuestSmokeConfig = {
  baseUrl: URL
  merchantPrivateKey: Uint8Array
  merchantPubkey: string
  merchantLud16: string
  productAddress: string
  providerHost: string
  receiptRelayUrls: string[]
  anonShopperPubkey: string
  maxPaymentSats: number
  payerWallet: NwcConnection
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function parseBaseUrl(raw: string): URL {
  const url = new URL(raw)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Funded smoke base URL must be a safe HTTPS URL.")
  }
  return url
}

function parseMerchantPrivateKey(raw: string): Uint8Array {
  try {
    const decoded = nip19.decode(raw)
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Unexpected signer encoding.")
    }
    getPublicKey(decoded.data)
    return decoded.data
  } catch (error) {
    throw new Error("Funded smoke merchant signer is invalid.", {
      cause: error,
    })
  }
}

function parseProviderHost(raw: string): string {
  const host = raw.toLowerCase()
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    !host.includes(".") ||
    host.includes("..")
  ) {
    throw new Error("Funded smoke provider host is invalid.")
  }
  return host
}

function parseProductAddress(raw: string, merchantPubkey: string): string {
  const match = raw.match(/^30402:([0-9a-fA-F]{64}):(.+)$/)
  if (
    !match ||
    match[1]?.toLowerCase() !== merchantPubkey ||
    !match[2]?.trim()
  ) {
    throw new Error(
      "Funded smoke product must be a kind 30402 coordinate owned by the configured merchant."
    )
  }
  return `30402:${merchantPubkey}:${match[2]}`
}

function parseReceiptRelays(raw: string): string[] {
  const relays = Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
  if (
    relays.length === 0 ||
    relays.length > MAX_RECEIPT_RELAYS ||
    !relays.every((value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === "wss:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        )
      } catch {
        return false
      }
    })
  ) {
    throw new Error("Funded smoke receipt relays are invalid.")
  }
  return relays
}

function parseMaxPaymentSats(raw: string): number {
  const value = Number(raw)
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_FUNDED_SMOKE_PAYMENT_SATS
  ) {
    throw new Error(
      `Funded smoke payment cap must be between 1 and ${MAX_FUNDED_SMOKE_PAYMENT_SATS} sats.`
    )
  }
  return value
}

function parsePayerWallet(raw: string): NwcConnection {
  try {
    const connection = parseNwcUri(raw)
    if (
      !normalizePubkey(connection.walletPubkey) ||
      !connection.secret ||
      connection.relays.length === 0 ||
      !connection.relays.every((relay) => relay.startsWith("wss://"))
    ) {
      throw new Error("Incomplete NWC connection.")
    }
    return connection
  } catch (error) {
    throw new Error("Funded smoke payer wallet is invalid.", { cause: error })
  }
}

export function parseFundedGuestSmokeConfig(
  env: Environment = process.env
): FundedGuestSmokeConfig {
  try {
    const merchantPrivateKey = parseMerchantPrivateKey(
      required(env, "FUNDED_GUEST_SMOKE_MERCHANT_NSEC")
    )
    const derivedMerchantPubkey = getPublicKey(merchantPrivateKey)
    const merchantPubkey = normalizePubkey(
      required(env, "FUNDED_GUEST_SMOKE_MERCHANT_PUBKEY")
    )
    if (!merchantPubkey || merchantPubkey !== derivedMerchantPubkey) {
      throw new Error(
        "Funded smoke merchant signer does not match the configured pubkey."
      )
    }

    const merchantLud16 = required(
      env,
      "FUNDED_GUEST_SMOKE_MERCHANT_LUD16"
    ).toLowerCase()
    const providerHost = parseProviderHost(
      required(env, "FUNDED_GUEST_SMOKE_PROVIDER_HOST")
    )
    if (
      !isValidLud16Address(merchantLud16) ||
      merchantLud16.split("@")[1] !== providerHost
    ) {
      throw new Error(
        "Funded smoke Lightning address does not match the provider host."
      )
    }

    const anonShopperPubkey = normalizePubkey(
      required(env, "FUNDED_GUEST_SMOKE_ANON_SHOPPER_PUBKEY")
    )
    if (!anonShopperPubkey) {
      throw new Error("Funded smoke Anon Shopper pubkey is invalid.")
    }

    return {
      baseUrl: parseBaseUrl(required(env, "FUNDED_GUEST_SMOKE_BASE_URL")),
      merchantPrivateKey,
      merchantPubkey,
      merchantLud16,
      productAddress: parseProductAddress(
        required(env, "FUNDED_GUEST_SMOKE_PRODUCT_ADDRESS"),
        merchantPubkey
      ),
      providerHost,
      receiptRelayUrls: parseReceiptRelays(
        required(env, "FUNDED_GUEST_SMOKE_RECEIPT_RELAYS")
      ),
      anonShopperPubkey,
      maxPaymentSats: parseMaxPaymentSats(
        required(env, "FUNDED_GUEST_SMOKE_MAX_PAYMENT_SATS")
      ),
      payerWallet: parsePayerWallet(
        required(env, "FUNDED_GUEST_SMOKE_PAYER_NWC_URI")
      ),
    }
  } catch (error) {
    throw new FundedGuestSmokeConfigFailure("configuration", error)
  }
}

export function formatFundedGuestSmokeConfigFailure(error: unknown): string {
  const stage =
    error instanceof FundedGuestSmokeConfigFailure
      ? error.stage
      : "configuration"
  return `Funded guest smoke fixture failed at ${stage}.`
}

async function main(): Promise<void> {
  try {
    parseFundedGuestSmokeConfig()
    console.log(
      "Funded guest smoke fixture preflight passed. No order was created, no invoice was requested, and no payment was attempted."
    )
  } catch (error) {
    console.error(formatFundedGuestSmokeConfigFailure(error))
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
