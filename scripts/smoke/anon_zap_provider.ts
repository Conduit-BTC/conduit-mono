import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  isValidLud16Address,
  validateLightningInvoiceForPayment,
  validateZapInvoiceDescriptionBinding,
  type LnurlPayMetadata,
} from "@conduit/core/protocol/lightning"
import { normalizePubkey } from "@conduit/core/utils"

import {
  getAnonZapCanaryConfigFromEnv,
  prepareAnonZapAuthorizationCanary,
  type AnonZapCanaryConfig,
  type AnonZapCanaryDependencies,
} from "./anon_zap_authorization"

const METADATA_TIMEOUT_MS = 10_000

type ProviderCanaryStage =
  | "configuration"
  | "boundary"
  | "metadata"
  | "metadata_validation"
  | "invoice"
  | "invoice_validation"

class AnonZapProviderCanaryFailure extends Error {
  override name = "AnonZapProviderCanaryFailure"

  constructor(
    readonly stage: ProviderCanaryStage,
    cause: unknown
  ) {
    super(`Anon zap provider canary failed at ${stage}.`, { cause })
  }
}

export type AnonZapProviderCanaryConfig = {
  boundary: AnonZapCanaryConfig
  lud16: string
  expectedProviderHost: string
  requestInvoice: boolean
}

type PreparedBoundary = Awaited<
  ReturnType<typeof prepareAnonZapAuthorizationCanary>
>

export type AnonZapProviderCanaryDependencies = {
  prepareBoundary?: (
    config: AnonZapCanaryConfig,
    dependencies?: AnonZapCanaryDependencies
  ) => Promise<PreparedBoundary>
  boundaryDependencies?: AnonZapCanaryDependencies
  fetchMetadata?: typeof fetchLnurlPayMetadata
  fetchInvoice?: typeof fetchZapInvoice
  nowSeconds?: () => number
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function parseExpectedHost(raw: string): string {
  const host = raw.toLowerCase()
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    !host.includes(".") ||
    host.includes("..")
  ) {
    throw new Error(
      "ANON_ZAP_PROVIDER_CANARY_EXPECTED_HOST must be an exact public hostname."
    )
  }
  return host
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase() ?? "false"
  if (normalized === "true") return true
  if (normalized === "false") return false
  throw new Error(`${name} must be true or false.`)
}

export function getAnonZapProviderCanaryConfigFromEnv(): AnonZapProviderCanaryConfig {
  const boundary = getAnonZapCanaryConfigFromEnv()
  const lud16 = getRequiredEnv("ANON_ZAP_PROVIDER_CANARY_LUD16").toLowerCase()
  if (!isValidLud16Address(lud16)) {
    throw new Error("ANON_ZAP_PROVIDER_CANARY_LUD16 is invalid.")
  }
  const expectedProviderHost = parseExpectedHost(
    getRequiredEnv("ANON_ZAP_PROVIDER_CANARY_EXPECTED_HOST")
  )
  if (lud16.split("@")[1] !== expectedProviderHost) {
    throw new Error(
      "Provider canary host does not match the Lightning address."
    )
  }
  return {
    boundary,
    lud16,
    expectedProviderHost,
    requestInvoice: parseBoolean(
      "ANON_ZAP_PROVIDER_CANARY_REQUEST_INVOICE",
      process.env.ANON_ZAP_PROVIDER_CANARY_REQUEST_INVOICE
    ),
  }
}

function assertProviderMetadata(
  metadata: LnurlPayMetadata,
  config: AnonZapProviderCanaryConfig,
  prepared: PreparedBoundary
): void {
  if (
    new URL(metadata.payRequestUrl).hostname.toLowerCase() !==
      config.expectedProviderHost ||
    new URL(metadata.callback).hostname.toLowerCase() !==
      config.expectedProviderHost
  ) {
    throw new Error("Provider metadata escaped the expected host.")
  }
  if (!metadata.allowsNostr) {
    throw new Error("Provider metadata does not support NIP-57.")
  }
  if (!normalizePubkey(metadata.nostrPubkey)) {
    throw new Error("Provider metadata has no valid receipt pubkey.")
  }
  if (
    prepared.signed.lnurl !== metadata.lnurl ||
    prepared.signed.lnurl !== config.boundary.expectedLnurl
  ) {
    throw new Error("Provider metadata does not match the authorized LNURL.")
  }
  const amountMsats = prepared.signed.pricing.totalMsats
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error("Authorized amount is outside the provider range.")
  }
}

export function formatAnonZapProviderCanaryFailure(error: unknown): string {
  const stage =
    error instanceof AnonZapProviderCanaryFailure
      ? error.stage
      : "configuration"
  return `Anon zap provider canary failed at ${stage}.`
}

export async function runAnonZapProviderCanary(
  config: AnonZapProviderCanaryConfig,
  dependencies: AnonZapProviderCanaryDependencies = {}
): Promise<{ status: "passed"; invoiceRequested: boolean }> {
  const prepareBoundary =
    dependencies.prepareBoundary ?? prepareAnonZapAuthorizationCanary
  const fetchMetadata = dependencies.fetchMetadata ?? fetchLnurlPayMetadata
  const fetchInvoice = dependencies.fetchInvoice ?? fetchZapInvoice
  const nowSeconds =
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))

  let prepared: PreparedBoundary
  try {
    prepared = await prepareBoundary(
      config.boundary,
      dependencies.boundaryDependencies
    )
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("boundary", error)
  }

  let metadata: LnurlPayMetadata
  try {
    metadata = await fetchMetadata(config.lud16, {
      timeoutMs: METADATA_TIMEOUT_MS,
    })
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("metadata", error)
  }

  try {
    assertProviderMetadata(metadata, config, prepared)
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("metadata_validation", error)
  }

  if (!config.requestInvoice) {
    return { status: "passed", invoiceRequested: false }
  }

  const amountMsats = prepared.signed.pricing.totalMsats
  const zapRequestJson = JSON.stringify(prepared.signed.rawEvent)
  let invoice: string
  try {
    invoice = (
      await fetchInvoice(
        metadata.callback,
        amountMsats,
        zapRequestJson,
        prepared.signed.lnurl
      )
    ).invoice
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("invoice", error)
  }

  try {
    const binding = validateZapInvoiceDescriptionBinding({
      invoice,
      zapRequestJson,
    })
    const payment = validateLightningInvoiceForPayment({
      invoice,
      expectedAmountMsats: amountMsats,
      nowSeconds: nowSeconds(),
    })
    if (!binding.ok || !payment.ok) {
      throw new Error("Provider invoice is not bound to the canary request.")
    }
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("invoice_validation", error)
  }

  return { status: "passed", invoiceRequested: true }
}

async function main(): Promise<void> {
  let config: AnonZapProviderCanaryConfig
  try {
    config = getAnonZapProviderCanaryConfigFromEnv()
  } catch (error) {
    throw new AnonZapProviderCanaryFailure("configuration", error)
  }
  const result = await runAnonZapProviderCanary(config)
  console.log(
    result.invoiceRequested
      ? "Anon zap provider invoice canary passed. The invoice was not logged or paid, and no event was published."
      : "Anon zap provider metadata canary passed. No invoice was requested, no event was published, and no payment was attempted."
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(formatAnonZapProviderCanaryFailure(error))
    process.exitCode = 1
  }
}
