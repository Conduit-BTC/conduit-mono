import {
  getAnonZapDraftTag,
  verifyAnonZapProviderAttestation,
  type AnonZapRequestDraft,
} from "@conduit/core/protocol/anon-zap"
import { buildAnonZapCheckoutContent } from "@conduit/core/protocol/anon-zap-checkout"
import {
  decodeLnurl,
  normalizeSafeLnurlPayRequestUrl,
} from "@conduit/core/protocol/lightning"
import { normalizePubkey } from "@conduit/core/utils"

import {
  authorizeCheckoutWithAnonSigner,
  signAuthorizedAnonZapCheckout,
} from "../../apps/market/src/lib/anon-zap-signer"

const AUTHORIZATION_TIMEOUT_MS = 20_000
const SIGNING_TIMEOUT_MS = 8_000
const ALLOWED_PATHS = new Set(["/api/anon-zap-authorize", "/api/anon-zap-sign"])

type AnonZapCanaryStage =
  "configuration" | "authorization" | "authorization_validation" | "signing"

class AnonZapCanaryFailure extends Error {
  override name = "AnonZapCanaryFailure"

  constructor(
    readonly stage: AnonZapCanaryStage,
    cause: unknown
  ) {
    super(`Anon zap canary failed at ${stage}.`, { cause })
  }
}

export type AnonZapCanaryConfig = {
  baseUrl: URL
  merchantPubkey: string
  productAddress: string
  signerPubkey: string
  expectedLnurl: string
  attestationPublicKeys: string
}

export type AnonZapCanaryDependencies = {
  fetchImpl?: typeof fetch
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function parseBaseUrl(raw: string): URL {
  const url = new URL(raw)
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("ANON_ZAP_CANARY_BASE_URL must be a safe HTTPS URL.")
  }
  return url
}

function parsePubkey(name: string): string {
  const pubkey = normalizePubkey(getRequiredEnv(name))
  if (!pubkey) throw new Error(`${name} must be a valid Nostr public key.`)
  return pubkey
}

export function getAnonZapCanaryConfigFromEnv(): AnonZapCanaryConfig {
  return {
    baseUrl: parseBaseUrl(getRequiredEnv("ANON_ZAP_CANARY_BASE_URL")),
    merchantPubkey: parsePubkey("ANON_ZAP_CANARY_MERCHANT_PUBKEY"),
    productAddress: getRequiredEnv("ANON_ZAP_CANARY_PRODUCT_ADDRESS"),
    signerPubkey: parsePubkey("ANON_ZAP_CANARY_SIGNER_PUBKEY"),
    expectedLnurl: getRequiredEnv("ANON_ZAP_CANARY_EXPECTED_LNURL"),
    attestationPublicKeys: getRequiredEnv(
      "ANON_ZAP_CANARY_ATTESTATION_PUBLIC_KEYS"
    ),
  }
}

export function createAnonZapCanaryFetch(
  baseUrl: URL,
  fetchImpl: typeof fetch
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const requestUrl = new URL(request.url)
    if (
      requestUrl.origin !== baseUrl.origin ||
      request.method !== "POST" ||
      requestUrl.search ||
      !ALLOWED_PATHS.has(requestUrl.pathname)
    ) {
      throw new Error("Anon zap canary attempted an unexpected network call.")
    }
    const headers = new Headers(request.headers)
    headers.set("origin", baseUrl.origin)
    return fetchImpl(new Request(request, { headers, redirect: "error" }))
  }
}

function normalizeSafeEncodedLnurl(raw: string): string | null {
  const decoded = decodeLnurl(raw)
  return decoded ? normalizeSafeLnurlPayRequestUrl(decoded) : null
}

function assertExpectedLnurl(
  draft: AnonZapRequestDraft,
  expectedLnurl: string
): void {
  const tag = getAnonZapDraftTag(draft, "lnurl")
  const expectedUrl = normalizeSafeEncodedLnurl(expectedLnurl)
  const actualUrl =
    tag?.length === 2 ? normalizeSafeEncodedLnurl(tag[1] ?? "") : null
  if (!expectedUrl || !actualUrl || actualUrl !== expectedUrl) {
    throw new Error("Anon zap authorization LNURL is invalid.")
  }
}

export function formatAnonZapCanaryFailure(error: unknown): string {
  const stage =
    error instanceof AnonZapCanaryFailure ? error.stage : "configuration"
  return `Anon zap canary failed at ${stage}.`
}

function assertTagValues(
  draft: AnonZapRequestDraft,
  name: string,
  expected: readonly string[]
): void {
  const tag = getAnonZapDraftTag(draft, name)
  if (
    !tag ||
    tag.length !== expected.length + 1 ||
    !expected.every((value, index) => tag[index + 1] === value)
  ) {
    throw new Error(`Anon zap authorization ${name} tag is invalid.`)
  }
}

export async function runAnonZapAuthorizationCanary(
  config: AnonZapCanaryConfig,
  dependencies: AnonZapCanaryDependencies = {}
): Promise<{ status: "passed" }> {
  const fetchImpl = createAnonZapCanaryFetch(
    config.baseUrl,
    dependencies.fetchImpl ?? fetch
  )
  const signerUrl = new URL("/api/anon-zap-sign", config.baseUrl).href
  const merchantPubkey = normalizePubkey(config.merchantPubkey)
  const signerPubkey = normalizePubkey(config.signerPubkey)
  if (!merchantPubkey || !signerPubkey) {
    throw new Error("Anon zap canary public keys are invalid.")
  }

  const context = {
    merchantPubkey,
    items: [{ productAddress: config.productAddress, quantity: 1 }],
  }
  const options = {
    fetchImpl,
    config: {
      anonZapSignerUrl: signerUrl,
      anonZapSignerPubkey: signerPubkey,
    },
    authorizationTimeoutMs: AUTHORIZATION_TIMEOUT_MS,
    signingTimeoutMs: SIGNING_TIMEOUT_MS,
  }
  let authorization
  try {
    authorization = await authorizeCheckoutWithAnonSigner(context, options)
  } catch (error) {
    throw new AnonZapCanaryFailure("authorization", error)
  }

  try {
    if (authorization.draft.content !== buildAnonZapCheckoutContent(1)) {
      throw new Error("Anon zap authorization content is invalid.")
    }
    assertExpectedLnurl(authorization.draft, config.expectedLnurl)
    if (getAnonZapDraftTag(authorization.draft, "omf_provider")) {
      throw new Error("Anon zap authorization included provider authority.")
    }
    assertTagValues(authorization.draft, "relays", authorization.relayUrls)
    if (
      verifyAnonZapProviderAttestation(
        authorization.draft,
        config.attestationPublicKeys
      ) !== "verified"
    ) {
      throw new Error("Anon zap checkout authorization attestation is invalid.")
    }
    if (
      authorization.pricing.items.length !== 1 ||
      authorization.pricing.items[0]?.productAddress !==
        config.productAddress ||
      authorization.pricing.items[0]?.quantity !== 1
    ) {
      throw new Error("Anon zap authorization pricing line is invalid.")
    }
    assertTagValues(authorization.draft, "amount", [
      String(authorization.pricing.totalMsats),
    ])
  } catch (error) {
    throw new AnonZapCanaryFailure("authorization_validation", error)
  }

  try {
    await signAuthorizedAnonZapCheckout(authorization, options)
  } catch (error) {
    throw new AnonZapCanaryFailure("signing", error)
  }
  return { status: "passed" }
}

async function main(): Promise<void> {
  let config: AnonZapCanaryConfig
  try {
    config = getAnonZapCanaryConfigFromEnv()
  } catch (error) {
    throw new AnonZapCanaryFailure("configuration", error)
  }
  await runAnonZapAuthorizationCanary(config)
  console.log(
    "Anon zap authorize/sign canary passed. No invoice was requested, no event was published, and no payment was attempted."
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(formatAnonZapCanaryFailure(error))
    process.exitCode = 1
  }
}
