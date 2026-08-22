import "fake-indexeddb/auto"

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools"

import {
  disconnectNdk,
  getNdk,
  RemoteSignerError,
  restoreRemoteSigner,
  type RemoteBunkerSigner,
} from "@conduit/core"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
} from "../packages/core/src/protocol/protected-read-authorization"

import {
  buildGuestCheckoutOrderRumor,
  formatGuestCheckoutOrderSmokeFailure,
  getGuestCheckoutOrderSmokeNip46PolicySnapshot,
  getGuestCheckoutOrderSmokeFailureEvidence,
  isPublicNip46RelayUrlMetadata,
  parseGuestCheckoutOrderSmokeConfig,
  runGuestCheckoutOrderSmoke as runGuestCheckoutOrderSmokeImpl,
  type GuestCheckoutOrderSmokeDependencies,
  type GuestCheckoutOrderSmokeMerchantSigner,
} from "../scripts/smoke/guest_checkout_order_runner"
import {
  buildGuestCheckoutOrderSmokeArtifact,
  containsProhibitedGuestCheckoutOrderSmokeEvidence,
  GUEST_CHECKOUT_ORDER_SMOKE_PROHIBITED_PATTERN_SIGNATURES,
  NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
  parseGuestCheckoutOrderSmokeArtifact,
  serializeGuestCheckoutOrderSmokeArtifact,
  UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
} from "../scripts/smoke/guest_checkout_order_evidence"
import {
  applyGuestCheckoutOrderSmokeCleanupOutcome,
  parseGuestCheckoutOrderSmokeEvidenceContext,
} from "../scripts/smoke/guest_checkout_order"
import type { ReadyCheckoutPricing } from "../apps/market/src/lib/checkout-order"
import { CHECKOUT_QUOTE_MAX_AGE_MS } from "../apps/market/src/lib/checkout-payment"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const REMOTE_SIGNER_SECRET = generateSecretKey()
const REMOTE_SIGNER_PUBKEY = getPublicKey(REMOTE_SIGNER_SECRET)
const NIP46_CLIENT_SECRET = generateSecretKey()
const GUEST_SIGNER = new NDKPrivateKeySigner(generateSecretKey())
const NIP46_SESSION_NOW_MS = Date.now()

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function merchantNip46Session(
  overrides: Partial<{
    createdAt: number
    updatedAt: number
  }> = {}
) {
  return {
    version: 1,
    type: "nip46",
    clientKeyId: "00000000-0000-4000-8000-000000000001",
    remoteSignerPubkey: REMOTE_SIGNER_PUBKEY,
    relayUrls: ["wss://relay.example"],
    userPubkey: MERCHANT_PUBKEY,
    createdAt: NIP46_SESSION_NOW_MS,
    updatedAt: NIP46_SESSION_NOW_MS,
    ...overrides,
  } as const
}

function merchantSignerConnection(): GuestCheckoutOrderSmokeMerchantSigner {
  return {
    signer: new NDKPrivateKeySigner(MERCHANT_SECRET),
    invalidate: () => undefined,
    close: async () => undefined,
  }
}

function smokeDependencies(
  dependencies: GuestCheckoutOrderSmokeDependencies
): GuestCheckoutOrderSmokeDependencies {
  type PublishOrder = NonNullable<
    GuestCheckoutOrderSmokeDependencies["publishOrder"]
  >
  const publishOrder = dependencies.publishOrder
  const declaredPublishOrder: PublishOrder | undefined = publishOrder
    ? async (...args: Parameters<PublishOrder>) => ({
        deliveryRoute: "declared_inbox",
        ...(await publishOrder(...args)),
      })
    : undefined
  return {
    connectMerchantSigner: async () => merchantSignerConnection(),
    ...dependencies,
    ...(declaredPublishOrder ? { publishOrder: declaredPublishOrder } : {}),
  }
}

function runGuestCheckoutOrderSmoke(
  config: ReturnType<typeof parseGuestCheckoutOrderSmokeConfig>,
  dependencies: GuestCheckoutOrderSmokeDependencies = {}
) {
  return runGuestCheckoutOrderSmokeImpl(config, smokeDependencies(dependencies))
}

function guestCheckoutOrderSmokeConfigIsRejected(
  env: Record<string, string | undefined>,
  now?: () => number
): boolean {
  try {
    parseGuestCheckoutOrderSmokeConfig(env, now)
    return false
  } catch {
    return true
  }
}

function environment(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION: JSON.stringify(
      merchantNip46Session()
    ),
    GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX:
      bytesToHex(NIP46_CLIENT_SECRET),
    GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: MERCHANT_PUBKEY,
    GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${MERCHANT_PUBKEY}:fixture`,
    ...overrides,
  }
}

function pricing(): ReadyCheckoutPricing {
  return {
    status: "ok",
    itemSubtotalSats: 10,
    totalSats: 10,
    totalMsats: 10_000,
    shippingCost: {
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    },
    items: [
      {
        productId: `30402:${MERCHANT_PUBKEY}:fixture`,
        title: "Fixture product",
        format: "digital",
        quantity: 1,
        priceAtPurchase: 10,
        currency: "SATS",
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
    ],
    quote: {
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    },
    approximate: true,
  }
}

function identity(orderId = "smoke-order") {
  return {
    kind: "guest_ephemeral" as const,
    orderId,
    merchantPubkey: MERCHANT_PUBKEY,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    pubkey: GUEST_SIGNER.pubkey,
    signer: GUEST_SIGNER,
  }
}

function productRead(
  overrides: {
    source?: "commerce" | "public" | "local_cache"
    stale?: boolean
    degraded?: boolean
    capped?: boolean
    canonicalFreshness?: boolean
    addressId?: string
    product?: Record<string, unknown>
  } = {}
) {
  return {
    data: {
      addressId: overrides.addressId ?? `30402:${MERCHANT_PUBKEY}:fixture`,
      product: {
        pubkey: MERCHANT_PUBKEY,
        title: "Fixture product",
        price: 1,
        currency: "USD",
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        type: "simple",
        format: "digital",
        stock: 1,
        shippingCountryRules: [],
        shippingCountries: [],
        ...overrides.product,
      },
    },
    meta: {
      source: overrides.source ?? "commerce",
      stale: overrides.stale ?? false,
      degraded: overrides.degraded ?? false,
      capped: overrides.capped ?? false,
      capabilities: {
        sortModes: ["newest", "price_asc", "price_desc", "updated_at_desc"],
        textSearch: true,
        protectedSummaries: false,
        canonicalFreshness: overrides.canonicalFreshness ?? false,
        cursorPagination: false,
      },
      fetchedAt: 1_700_000_000_000,
    },
  } as never
}

function recoveredOrderRead(
  published: { content: string },
  meta: {
    source: "commerce" | "local_cache"
    stale: boolean
    degraded: boolean
    capped?: boolean
    inbox: {
      declarationState: "declared" | "lookup_unavailable"
      coverage: "complete" | "partial" | "unavailable"
      readSource: "declared" | "mixed" | "cache"
    }
  },
  transformPayload: (payload: Record<string, unknown>) => unknown = (payload) =>
    payload
) {
  const payload = transformPayload(JSON.parse(published.content))
  return {
    data: [
      {
        id: "smoke-order",
        orderId: "smoke-order",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: GUEST_SIGNER.pubkey,
        latestAt: 1_700_000_000_000,
        latestType: "order",
        status: null,
        totalSummary: "10 SATS",
        preview: "Order for 10 SATS",
        messageCount: 1,
        messages: [
          {
            id: "rumor-id",
            orderId: "smoke-order",
            type: "order",
            createdAt: 1_700_000_000,
            senderPubkey: GUEST_SIGNER.pubkey,
            recipientPubkey: MERCHANT_PUBKEY,
            rawContent: published.content,
            payload,
          },
        ],
      },
    ],
    meta: {
      plan: "protected_conversation_list",
      fetchedAt: 1_700_000_000_000,
      ...meta,
      capabilities: [],
    },
  } as never
}

describe("guest checkout order smoke", () => {
  afterEach(() => {
    __resetProtectedReadSigner()
    disconnectNdk()
  })

  it("validates that the protected signer owns the product fixture", () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    expect(config.merchantPubkey).toBe(MERCHANT_PUBKEY)
    expect(config.productAddress).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
  })

  it("accepts only current NIP-46 sessions within the rotation window", () => {
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
    const atBoundary = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION: JSON.stringify(
          merchantNip46Session({
            createdAt: NIP46_SESSION_NOW_MS - ninetyDaysMs,
          })
        ),
      }),
      () => NIP46_SESSION_NOW_MS
    )
    expect(atBoundary.merchantNip46Session.createdAt).toBe(
      NIP46_SESSION_NOW_MS - ninetyDaysMs
    )

    for (const session of [
      merchantNip46Session({
        createdAt: NIP46_SESSION_NOW_MS - ninetyDaysMs - 1,
      }),
      merchantNip46Session({
        createdAt: NIP46_SESSION_NOW_MS + 5 * 60 * 1_000 + 1,
        updatedAt: NIP46_SESSION_NOW_MS + 5 * 60 * 1_000 + 1,
      }),
      merchantNip46Session({
        createdAt: NIP46_SESSION_NOW_MS,
        updatedAt: NIP46_SESSION_NOW_MS - 1,
      }),
    ]) {
      expect(
        guestCheckoutOrderSmokeConfigIsRejected(
          environment({
            GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION:
              JSON.stringify(session),
          }),
          () => NIP46_SESSION_NOW_MS
        )
      ).toBe(true)
    }
  })

  it("locks the public NIP-46 session metadata policy", () => {
    const safeSession = merchantNip46Session()
    const policy = getGuestCheckoutOrderSmokeNip46PolicySnapshot()
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.sessionKeys)).toBe(true)
    expect(Object.isFrozen(policy.clientKeyIdPattern)).toBe(true)
    expect(policy).toEqual({
      maxSessionBytes: 8_192,
      sessionKeys: [
        "clientKeyId",
        "createdAt",
        "relayUrls",
        "remoteSignerPubkey",
        "type",
        "updatedAt",
        "userPubkey",
        "version",
      ],
      clientKeyIdPattern: {
        source:
          "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        flags: "",
      },
    })

    const unsafeSessions = [
      { ...safeSession, syntheticUnapprovedField: "synthetic marker" },
      { ...safeSession, clientKeyId: "not-a-session-id" },
      { ...safeSession, relayUrls: ["not-a-relay-url"] },
    ]

    for (const session of unsafeSessions) {
      expect(
        guestCheckoutOrderSmokeConfigIsRejected(
          environment({
            GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION:
              JSON.stringify(session),
          })
        )
      ).toBe(true)
    }

    const serializedSession = JSON.stringify(safeSession)
    for (const duplicateSession of [
      serializedSession.replace(
        '"relayUrls":',
        '"relayUrls":["synthetic-invalid"],"relayUrls":'
      ),
      serializedSession.replace(
        '"relayUrls":',
        '"relay\\u0055rls":["synthetic-invalid"],"relayUrls":'
      ),
    ]) {
      expect(
        guestCheckoutOrderSmokeConfigIsRejected(
          environment({
            GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION: duplicateSession,
          })
        )
      ).toBe(true)
    }
    expect(
      guestCheckoutOrderSmokeConfigIsRejected(
        environment({
          GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION:
            serializedSession.replace(
              "{",
              `{${" ".repeat(policy.maxSessionBytes)}`
            ),
        })
      )
    ).toBe(true)
  })

  it("allows only credential-free public relay URL metadata", () => {
    const publicMetadata = {
      protocol: "wss:",
      username: "",
      password: "",
      search: "",
      hash: "",
    }

    expect(isPublicNip46RelayUrlMetadata(publicMetadata)).toBe(true)
    expect(
      isPublicNip46RelayUrlMetadata({ ...publicMetadata, protocol: "https:" })
    ).toBe(false)
    for (const field of ["username", "password", "search", "hash"] as const) {
      expect(
        isPublicNip46RelayUrlMetadata({
          ...publicMetadata,
          [field]: "synthetic marker",
        })
      ).toBe(false)
    }
  })

  it("fails invalid dispatches and scopes every fixture value to the smoke step", async () => {
    const workflow = await Bun.file(
      ".github/workflows/guest-checkout-order-smoke.yml"
    ).text()
    const protectedJobStart = workflow.indexOf("create-and-recover-order:")
    const dispatchJob = workflow.slice(0, protectedJobStart)
    expect(workflow).toContain("timeout-minutes: 10")
    expect(workflow).toContain("expected_candidate_sha:")
    expect(workflow).toContain("description: Exact main commit SHA to test")
    expect(workflow).toContain("queue: max")
    expect(dispatchJob).toContain("validate-dispatch:")
    expect(dispatchJob).toContain('"$CONFIRM_ORDER_CREATION" != "true"')
    expect(dispatchJob).toContain('"$DISPATCH_REF" != "refs/heads/main"')
    expect(dispatchJob).toContain(
      "EXPECTED_CANDIDATE_SHA: ${{ inputs.expected_candidate_sha }}"
    )
    expect(dispatchJob).toContain(
      '"$EXPECTED_CANDIDATE_SHA" != "$CANDIDATE_SHA"'
    )
    expect(dispatchJob).toContain("^[0-9a-f]{40}$")
    const runMarker = "        run: |\n"
    const gateStart = dispatchJob.indexOf(runMarker)
    expect(gateStart).toBeGreaterThan(-1)
    const gateScript = dispatchJob
      .slice(gateStart + runMarker.length)
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n")
    for (const testCase of [
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        expectedSha: "a".repeat(40),
        exitCode: 0,
      },
      {
        confirmation: "false",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        expectedSha: "a".repeat(40),
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/feature",
        sha: "a".repeat(40),
        expectedSha: "a".repeat(40),
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "not-a-sha",
        expectedSha: "a".repeat(40),
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        expectedSha: "not-a-sha",
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        expectedSha: "b".repeat(40),
        exitCode: 1,
      },
    ]) {
      const gate = Bun.spawnSync({
        cmd: ["bash", "-euo", "pipefail", "-c", gateScript],
        env: {
          PATH: process.env.PATH ?? "",
          CONFIRM_ORDER_CREATION: testCase.confirmation,
          EXPECTED_CANDIDATE_SHA: testCase.expectedSha,
          DISPATCH_REF: testCase.ref,
          CANDIDATE_SHA: testCase.sha,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(gate.exitCode).toBe(testCase.exitCode)
    }
    expect(workflow).toContain("needs: validate-dispatch")
    expect(workflow).not.toContain("if: inputs.confirm_order_creation")
    expect(workflow).toContain("ref: ${{ github.sha }}")
    expect(workflow).toContain("fetch-depth: 1")
    expect(workflow).toContain("persist-credentials: false")
    expect(workflow).toContain('actual_sha="$(git rev-parse HEAD)"')
    const smokeStepStart = workflow.indexOf(
      "- name: Create and recover encrypted digital guest order"
    )
    const evidenceStepStart = workflow.indexOf(
      "- name: Validate redacted smoke evidence"
    )
    expect(smokeStepStart).toBeGreaterThan(-1)
    expect(evidenceStepStart).toBeGreaterThan(smokeStepStart)
    const setupSteps = workflow.slice(0, smokeStepStart)
    const smokeStep = workflow.slice(smokeStepStart, evidenceStepStart)
    const fixtureNames = [
      "GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY",
      "GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS",
      "GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS",
      "GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS",
      "GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION",
      "GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX",
    ]

    for (const name of fixtureNames) {
      expect(setupSteps).not.toContain(name)
      expect(smokeStep).toContain(name)
    }
    expect(workflow).not.toContain("GUEST_CHECKOUT_SMOKE_SHIPPING_")
    for (const name of [
      "GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA",
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID",
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT",
      "GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH",
    ]) {
      expect(setupSteps).not.toContain(name)
      expect(smokeStep).toContain(name)
    }
    expect(dispatchJob).not.toContain("GUEST_CHECKOUT_SMOKE_")
    expect(smokeStep).toContain(
      "${{ vars.GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS }}"
    )
    expect(smokeStep).toContain(
      "${{ vars.GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS }}"
    )
    expect(workflow).toContain("id: validate_evidence")
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("EXPECTED_SHA: ${{ github.sha }}")
    expect(workflow).toContain("EXPECTED_RUN_ID: ${{ github.run_id }}")
    expect(workflow).toContain(
      "EXPECTED_RUN_ATTEMPT: ${{ github.run_attempt }}"
    )
    expect(workflow).toContain(
      '"$EVIDENCE_PATH" "$EXPECTED_SHA" "$EXPECTED_RUN_ID"'
    )
    expect(workflow).toContain(
      "if: always() && steps.validate_evidence.outcome == 'success'"
    )
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    )
    expect(workflow).toContain("name: guest-checkout-order-evidence")
    expect(workflow).toContain(
      "path: ${{ runner.temp }}/guest-checkout-order-evidence.json"
    )
    expect(workflow).toContain("if-no-files-found: error")
    expect(workflow).toContain("retention-days: 7")

    const actionReferences = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)]
    expect(actionReferences.length).toBeGreaterThan(0)
    for (const reference of actionReferences) {
      expect(reference[1]).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("rejects signer and product ownership mismatches", () => {
    const otherMerchantPubkey = getPublicKey(generateSecretKey())
    const otherProductPubkey = getPublicKey(generateSecretKey())
    for (const overrides of [
      { GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: otherMerchantPubkey },
      {
        GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${otherProductPubkey}:fixture`,
      },
      {
        GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION: JSON.stringify({
          ...merchantNip46Session(),
          remoteSignerPubkey: MERCHANT_PUBKEY,
        }),
      },
      {
        GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX:
          bytesToHex(MERCHANT_SECRET),
      },
      {
        GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX:
          bytesToHex(REMOTE_SIGNER_SECRET),
      },
    ]) {
      expect(
        guestCheckoutOrderSmokeConfigIsRejected(environment(overrides))
      ).toBe(true)
    }
  })

  it("stops before product reads when the remote signer preflight fails", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    for (const testCase of [
      { code: "unavailable", status: "inconclusive" },
      { code: "rejected", status: "failed" },
    ] as const) {
      let productWasRead = false
      let published = false
      let invalidated = false
      let closed = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          connectMerchantSigner: async () => ({
            signer: new NDKPrivateKeySigner(MERCHANT_SECRET),
            invalidate: () => {
              invalidated = true
            },
            close: async () => {
              closed = true
            },
          }),
          preflightMerchantSigner: async () => {
            throw new RemoteSignerError(
              testCase.code,
              "Synthetic remote signer failure."
            )
          },
          getProduct: async () => {
            productWasRead = true
            return productRead()
          },
          publishOrder: async () => {
            published = true
            throw new Error("Order publication must not run.")
          },
        })
      } catch (error) {
        failure = error
      }

      expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
        status: testCase.status,
        stage: "merchant_signer",
        summary: `Guest checkout order smoke ${testCase.status} at merchant_signer.`,
      })
      expect(productWasRead).toBe(false)
      expect(published).toBe(false)
      expect(invalidated).toBe(true)
      expect(closed).toBe(true)
      expect(getNdk().signer).toBeUndefined()
    }
  })

  it("restores the protected client key without logging out the persistent session", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let invalidated = false
    let closed = false
    let loggedOut = false
    let loadedExpectedClientKey = false
    let rejectedUnknownClientKey = false
    let failure: unknown
    const signer = Object.assign(new NDKPrivateKeySigner(MERCHANT_SECRET), {
      invalidate: () => {
        invalidated = true
      },
    })

    try {
      await runGuestCheckoutOrderSmokeImpl(config, {
        restoreMerchantSigner: async (session, options) => {
          expect(
            JSON.stringify(session) ===
              JSON.stringify(config.merchantNip46Session)
          ).toBe(true)
          expect(options.signal?.aborted).toBe(false)
          loadedExpectedClientKey =
            (await options.keyVault?.load(session.clientKeyId)) ===
            config.merchantNip46ClientSecretKeyHex
          rejectedUnknownClientKey =
            (await options.keyVault?.load("unknown-client-key")) === null
          return {
            session,
            signer,
            bunkerSigner: {
              close: async () => {
                closed = true
              },
              logout: async () => {
                loggedOut = true
              },
            },
            clientPrivateKey: config.merchantNip46ClientSecretKeyHex,
            clientKeyAlreadyPersisted: true,
          } as never
        },
        preflightMerchantSigner: async () => {
          throw new RemoteSignerError(
            "unavailable",
            "Synthetic remote signer failure."
          )
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure).status).toBe(
      "inconclusive"
    )
    expect(loadedExpectedClientKey).toBe(true)
    expect(rejectedUnknownClientKey).toBe(true)
    expect(invalidated).toBe(true)
    expect(closed).toBe(true)
    expect(loggedOut).toBe(false)
  })

  it("runs real NIP-46 restore and preflight through an in-memory bunker transport", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const transportCalls: string[] = []
    let published: { content: string } | null = null
    let logoutCalls = 0
    const unexpectedMethod = async (): Promise<never> => {
      throw new Error("Unexpected in-memory bunker method.")
    }
    const bunkerSigner: RemoteBunkerSigner = {
      bp: {
        pubkey: REMOTE_SIGNER_PUBKEY,
        relays: [...config.merchantNip46Session.relayUrls],
        secret: null,
      },
      sendRequest: unexpectedMethod,
      ping: async () => {
        transportCalls.push("ping")
      },
      switchRelays: async () => {
        transportCalls.push("switch_relays")
        return false
      },
      getPublicKey: async () => {
        transportCalls.push("get_public_key")
        return MERCHANT_PUBKEY
      },
      signEvent: async (event) => {
        transportCalls.push(`sign_event:${event.kind}`)
        return finalizeEvent(event, MERCHANT_SECRET)
      },
      nip04Encrypt: unexpectedMethod,
      nip04Decrypt: unexpectedMethod,
      nip44Encrypt: unexpectedMethod,
      nip44Decrypt: async (senderPubkey, ciphertext) => {
        transportCalls.push("nip44_decrypt")
        const conversationKey = nip44.v2.utils.getConversationKey(
          MERCHANT_SECRET,
          senderPubkey
        )
        return nip44.v2.decrypt(ciphertext, conversationKey)
      },
      logout: async () => {
        logoutCalls += 1
      },
      close: async () => {
        transportCalls.push("close")
      },
    }

    const result = await runGuestCheckoutOrderSmokeImpl(config, {
      restoreMerchantSigner: (session, options) =>
        restoreRemoteSigner(session, {
          ...options,
          timeoutMs: 100,
          createBunkerSigner: (clientKey, pointer, params) => {
            transportCalls.push("create_transport")
            expect(
              bytesToHex(clientKey) === config.merchantNip46ClientSecretKeyHex
            ).toBe(true)
            expect(
              pointer.pubkey === REMOTE_SIGNER_PUBKEY &&
                JSON.stringify(pointer.relays) ===
                  JSON.stringify(config.merchantNip46Session.relayUrls) &&
                pointer.secret === null
            ).toBe(true)
            expect(params.onauth === options.onAuthUrl).toBe(true)
            return bunkerSigner
          },
        }),
      merchantSignerCloseTimeoutMs: 100,
      getProduct: async () => {
        transportCalls.push("product_read")
        return productRead()
      },
      getPricingRate: async () => ({
        rate: 100_000,
        fetchedAt: 1_700_000_000_000,
        source: "mempool",
        fiatUsdRates: {},
        fiatSource: "frankfurter",
      }),
      createOrderId: () => "smoke-order",
      createGuestIdentity: () => identity(),
      publishOrder: async (rumor) => {
        transportCalls.push("order_publish")
        published = rumor
        return {
          buyerSelfCopyError: null,
          localCacheError: null,
          deliveryRoute: "declared_inbox",
        }
      },
      getMerchantOrders: async () => {
        transportCalls.push("merchant_recovery")
        if (!published) throw new Error("Order was not published")
        return recoveredOrderRead(published, {
          source: "commerce",
          stale: false,
          degraded: false,
          inbox: {
            declarationState: "declared",
            coverage: "complete",
            readSource: "declared",
          },
        })
      },
      nowMs: () => 1_700_000_000_000,
      sleep: async () => undefined,
    })

    expect(result).toEqual({ status: "passed" })
    expect(transportCalls.slice(0, 6)).toEqual([
      "create_transport",
      "ping",
      "switch_relays",
      "get_public_key",
      "sign_event:22242",
      "nip44_decrypt",
    ])
    expect(transportCalls.indexOf("nip44_decrypt")).toBeLessThan(
      transportCalls.indexOf("product_read")
    )
    expect(
      transportCalls.filter((call) => call === "sign_event:22242")
    ).toHaveLength(1)
    expect(
      transportCalls.filter((call) => call === "nip44_decrypt")
    ).toHaveLength(1)
    expect(transportCalls.at(-1)).toBe("close")
    expect(logoutCalls).toBe(0)
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("treats interactive NIP-46 authorization as content-free inconclusive evidence", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const syntheticAuthorizationMarker = "synthetic authorization required"
    let failure: unknown
    let requestInteractiveAuthorization: (() => void) | undefined
    const signer = Object.assign(new NDKPrivateKeySigner(MERCHANT_SECRET), {
      invalidate: () => undefined,
    })

    try {
      await runGuestCheckoutOrderSmokeImpl(config, {
        restoreMerchantSigner: async (session, options) => {
          requestInteractiveAuthorization = () => {
            options.onAuthUrl?.(syntheticAuthorizationMarker)
            expect(options.signal?.aborted).toBe(true)
          }
          return {
            session,
            signer,
            bunkerSigner: { close: async () => undefined },
            clientPrivateKey: config.merchantNip46ClientSecretKeyHex,
            clientKeyAlreadyPersisted: true,
          } as never
        },
        preflightMerchantSigner: async () => {
          if (!requestInteractiveAuthorization) {
            throw new Error("Synthetic authorization callback is unavailable.")
          }
          requestInteractiveAuthorization()
          throw new RemoteSignerError(
            "rejected",
            "Synthetic interactive authorization request."
          )
        },
      })
    } catch (error) {
      failure = error
    }

    const evidence = getGuestCheckoutOrderSmokeFailureEvidence(failure)
    expect(evidence).toEqual({
      status: "inconclusive",
      stage: "merchant_signer",
      summary: "Guest checkout order smoke inconclusive at merchant_signer.",
    })
    expect(
      !JSON.stringify(evidence).includes(syntheticAuthorizationMarker)
    ).toBe(true)
  })

  it("bounds remote signer cleanup when close does not settle", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let failure: unknown
    const startedAt = Date.now()

    try {
      await runGuestCheckoutOrderSmoke(config, {
        connectMerchantSigner: async () => ({
          signer: new NDKPrivateKeySigner(MERCHANT_SECRET),
          invalidate: () => undefined,
          close: () => new Promise<void>(() => undefined),
        }),
        preflightMerchantSigner: async () => {
          throw new RemoteSignerError(
            "unavailable",
            "Synthetic remote signer failure."
          )
        },
        merchantSignerCloseTimeoutMs: 5,
      })
    } catch (error) {
      failure = error
    }

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "merchant_signer",
      summary: "Guest checkout order smoke inconclusive at merchant_signer.",
    })
  })

  it("fails an otherwise successful run when signer cleanup times out", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published: { content: string } | null = null
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        connectMerchantSigner: async () => ({
          signer: new NDKPrivateKeySigner(MERCHANT_SECRET),
          invalidate: () => undefined,
          close: () => new Promise<void>(() => undefined),
        }),
        preflightMerchantSigner: async () => undefined,
        merchantSignerCloseTimeoutMs: 5,
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(published, {
            source: "commerce",
            stale: false,
            degraded: false,
            inbox: {
              declarationState: "declared",
              coverage: "complete",
              readSource: "declared",
            },
          })
        },
        nowMs: () => 1_700_000_000_000,
        sleep: async () => undefined,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "merchant_signer",
      summary: "Guest checkout order smoke failed at merchant_signer.",
    })
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("builds a recognizable, schema-valid ephemeral guest order", () => {
    const rumor = buildGuestCheckoutOrderRumor({
      orderId: "smoke-order",
      identity: identity(),
      merchantPubkey: MERCHANT_PUBKEY,
      pricing: pricing(),
      rumorCreatedAt: 1_700_000_123_000,
    })
    const payload = JSON.parse(rumor.content)

    expect(rumor.kind).toBe(16)
    expect(rumor.created_at).toBe(1_700_000_123)
    expect(rumor.tags).toContainEqual(["type", "order"])
    expect(payload.createdAt).toBe(identity().createdAt)
    expect(payload.buyerIdentityKind).toBe("guest_ephemeral")
    expect(payload.guestContact.email).toEndWith(".invalid")
    expect(payload.note).toContain("do not fulfill")
    expect(payload.items[0].productId).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.items[0].format).toBe("digital")
    expect(payload.shippingCostStatus).toBe("not_required")
    expect(payload.shippingCostSats).toBe(0)
    expect(payload.items[0]).not.toHaveProperty("shippingCostSats")
    expect(payload.items[0]).not.toHaveProperty("sourceShippingCost")
    expect(payload).not.toHaveProperty("shippingAddress")
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
  })

  it("fails closed when the exact listing read falls back to cached product data", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            source: "local_cache",
            stale: true,
            degraded: true,
            canonicalFreshness: false,
          }),
        publishOrder: async () => {
          published = true
          throw new Error("Cached product data must not reach publication.")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "product_read",
      summary: "Guest checkout order smoke inconclusive at product_read.",
    })
    expect(published).toBe(false)
  })

  it("fails closed when the exact listing read has incomplete deletion coverage", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            degraded: true,
            canonicalFreshness: false,
          }),
        publishOrder: async () => {
          published = true
          throw new Error("Partial product data must not reach publication.")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke inconclusive at product_read."
    )
    expect(published).toBe(false)
  })

  it("revalidates exact product terms immediately before publication", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    for (const testCase of [
      {
        secondRead: productRead({
          product: {
            price: 2,
            sourcePrice: {
              amount: 2,
              currency: "USD",
              normalizedCurrency: "USD",
            },
          },
        }),
        status: "failed",
      },
      {
        secondRead: productRead({ product: { stock: 0 } }),
        status: "failed",
      },
      {
        secondRead: productRead({ degraded: true }),
        status: "inconclusive",
      },
      {
        secondRead: productRead({
          product: {
            specifications: [{ key: "color", value: "blue" }],
          },
        }),
        status: "failed",
      },
    ] as const) {
      let productReads = 0
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => {
            productReads += 1
            return productReads === 1 ? productRead() : testCase.secondRead
          },
          getPricingRate: async () => ({
            rate: 100_000,
            fetchedAt: 1_700_000_000_000,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }),
          createOrderId: () => "smoke-order",
          createGuestIdentity: () => identity(),
          publishOrder: async () => {
            published = true
            throw new Error("Changed product terms must not be published.")
          },
          nowMs: () => 1_700_000_000_000,
        })
      } catch (error) {
        failure = error
      }

      expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
        status: testCase.status,
        stage: "product_read",
        summary: `Guest checkout order smoke ${testCase.status} at product_read.`,
      })
      expect(productReads).toBe(2)
      expect(published).toBe(false)
    }
  })

  it("evaluates a delayed pricing quote with the post-fetch clock", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const quoteFetchedAt = 1_700_000_000_000
    let now = quoteFetchedAt
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => {
          now = quoteFetchedAt + CHECKOUT_QUOTE_MAX_AGE_MS + 1
          return {
            rate: 100_000,
            fetchedAt: quoteFetchedAt,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }
        },
        publishOrder: async () => {
          published = true
          throw new Error("A stale quote must not be published.")
        },
        nowMs: () => now,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "product_read",
      summary: "Guest checkout order smoke failed at product_read.",
    })
    expect(published).toBe(false)
  })

  it("rejects non-simple, physical, or shipping-bearing fixtures before pricing or publish", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const unsupportedReads = [
      productRead({ product: { type: "variable" } }),
      productRead({ product: { type: "variation" } }),
      productRead({
        addressId: `30402:${MERCHANT_PUBKEY}:projected-parent`,
        product: { type: "variable" },
      }),
      productRead({ product: { format: "physical" } }),
      productRead({ product: { shippingCostSats: 0 } }),
      productRead({
        product: {
          sourceShippingCost: {
            amount: 0,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
      }),
      productRead({ product: { shippingOptionId: "synthetic-option" } }),
      productRead({ product: { shippingOptionDTag: "synthetic-option" } }),
      productRead({ product: { shippingCountries: ["US"] } }),
      productRead({
        product: {
          shippingCountryRules: [
            {
              code: "US",
              name: "United States",
              restrictTo: [],
              exclude: [],
            },
          ],
        },
      }),
    ]

    for (const read of unsupportedReads) {
      let pricingRequested = false
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => read,
          getPricingRate: async () => {
            pricingRequested = true
            throw new Error("Unsupported fixtures must not request pricing.")
          },
          publishOrder: async () => {
            published = true
            throw new Error("Unsupported fixtures must not be published.")
          },
        })
      } catch (error) {
        failure = error
      }

      expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
        "Guest checkout order smoke failed at product_read."
      )
      expect(pricingRequested).toBe(false)
      expect(published).toBe(false)
    }
  })

  it("classifies order id and guest identity failures as order_build", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const constructionFailures = [
      {
        createOrderId: () => {
          throw new Error("Order id generation failed")
        },
      },
      {
        createGuestIdentity: () => {
          throw new Error("Guest identity generation failed")
        },
      },
    ]

    for (const constructionFailure of constructionFailures) {
      let failure: unknown
      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => productRead(),
          getPricingRate: async () => ({
            rate: 100_000,
            fetchedAt: 1_700_000_000_000,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }),
          nowMs: () => 1_700_000_000_000,
          ...constructionFailure,
        })
      } catch (error) {
        failure = error
      }

      expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
        "Guest checkout order smoke failed at order_build."
      )
    }
  })

  it("rejects compatibility delivery before merchant recovery", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let recoveryRequested = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async () =>
          ({
            buyerSelfCopyError: null,
            localCacheError: null,
            deliveryRoute: "compatibility_order",
          }) as never,
        getMerchantOrders: async () => {
          recoveryRequested = true
          throw new Error("Compatibility delivery must not reach recovery.")
        },
        nowMs: () => 1_700_000_000_000,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "order_publish",
      summary: "Guest checkout order smoke failed at order_publish.",
    })
    expect(recoveryRequested).toBe(false)
  })

  it("requires exact product and complete merchant inbox reads", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const productQueries: Array<{
      productId: string
      revalidateCanonical?: boolean
    }> = []
    let published:
      | Parameters<
          NonNullable<
            Parameters<typeof runGuestCheckoutOrderSmoke>[1]
          >["publishOrder"]
        >[0]
      | null = null
    let recoveryAuthorizationMethod: string | null = null
    let recoveryCalls = 0
    let productReads = 0
    let relayEvidence: unknown
    const signerLifecycle: string[] = []

    const result = await runGuestCheckoutOrderSmoke(config, {
      connectMerchantSigner: async () => {
        signerLifecycle.push("connect")
        return {
          signer: new NDKPrivateKeySigner(MERCHANT_SECRET),
          invalidate: () => signerLifecycle.push("invalidate"),
          close: async () => {
            signerLifecycle.push("close")
          },
        }
      },
      preflightMerchantSigner: async (signer) => {
        expect((await signer.user()).pubkey).toBe(MERCHANT_PUBKEY)
        signerLifecycle.push("preflight")
      },
      getProduct: async (query) => {
        signerLifecycle.push("product_read")
        productReads += 1
        productQueries.push(query)
        return productRead({
          product: {
            specifications: [
              { key: "color", value: "blue" },
              { key: "size", value: "small" },
            ],
          },
        })
      },
      getPricingRate: async () => ({
        rate: 100_000,
        fetchedAt: 1_700_000_000_000,
        source: "mempool",
        fiatUsdRates: {},
        fiatSource: "frankfurter",
      }),
      createOrderId: () => "smoke-order",
      createGuestIdentity: () => identity(),
      publishOrder: async (rumor) => {
        signerLifecycle.push("publish")
        published = rumor
        return {
          buyerSelfCopyError: null,
          localCacheError: null,
          deliveryRoute: "declared_inbox",
          orderRelayDelivery: {
            relayDelivery: [
              {
                relayUrl: "wss://acked.example",
                status: "acked",
                attemptCount: 1,
              },
              {
                relayUrl: "wss://retry.example",
                status: "timed_out",
                attemptCount: 2,
              },
            ],
          },
        } as never
      },
      onRelayEvidence: (evidence) => {
        relayEvidence = evidence
      },
      getMerchantOrders: async () => {
        recoveryCalls += 1
        recoveryAuthorizationMethod =
          getProtectedReadAuthorization(MERCHANT_PUBKEY)?.signer.authMethod ??
          null
        if (!published) throw new Error("Order was not published")
        const recoveryMeta: Parameters<typeof recoveredOrderRead>[1] = [
          {
            source: "local_cache",
            stale: true,
            degraded: true,
            inbox: {
              declarationState: "lookup_unavailable",
              coverage: "unavailable",
              readSource: "cache",
            },
          },
          {
            source: "commerce",
            stale: false,
            degraded: true,
            inbox: {
              declarationState: "declared",
              coverage: "partial",
              readSource: "mixed",
            },
          },
          {
            source: "commerce",
            stale: false,
            degraded: false,
            inbox: {
              declarationState: "declared",
              coverage: "complete",
              readSource: "declared",
            },
          },
        ][Math.min(recoveryCalls - 1, 2)]!
        return recoveredOrderRead(published, recoveryMeta)
      },
      nowMs: () => 1_700_000_000_000,
      sleep: async () => {},
    })

    expect(result).toEqual({ status: "passed" })
    expect(productQueries).toEqual(
      Array.from({ length: 2 }, () => ({
        productId: `30402:${MERCHANT_PUBKEY}:fixture`,
        revalidateCanonical: true,
      }))
    )
    expect(productReads).toBe(2)
    expect(relayEvidence).toEqual({
      relayAttemptCount: 3,
      relayAcknowledgementCount: 1,
      relayObservation: "available",
    })
    expect(JSON.stringify(relayEvidence)).not.toContain("relayUrl")
    expect(recoveryCalls).toBe(3)
    expect(published).not.toBeNull()
    const payload = JSON.parse(published!.content)
    expect(payload.items[0].priceAtPurchase).toBe(1_000)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.items[0].selectedSpecifications).toEqual([
      { key: "color", value: "blue" },
      { key: "size", value: "small" },
    ])
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
    expect(recoveryAuthorizationMethod).toBe("nip46")
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
    expect(signerLifecycle[0]).toBe("connect")
    expect(signerLifecycle[1]).toBe("preflight")
    expect(signerLifecycle.indexOf("preflight")).toBeLessThan(
      signerLifecycle.indexOf("product_read")
    )
    expect(signerLifecycle.indexOf("preflight")).toBeLessThan(
      signerLifecycle.indexOf("publish")
    )
    expect(signerLifecycle.slice(-2)).toEqual(["invalidate", "close"])
  })

  it("reports inconclusive when partial merchant inbox evidence exhausts", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "2",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let published: { content: string } | null = null
    let recoveryCalls = 0
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          recoveryCalls += 1
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(published, {
            source: "commerce",
            stale: false,
            degraded: true,
            inbox: {
              declarationState: "declared",
              coverage: "partial",
              readSource: "mixed",
            },
          })
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "merchant_recovery",
      summary: "Guest checkout order smoke inconclusive at merchant_recovery.",
    })
    expect(recoveryCalls).toBe(2)
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("reports inconclusive when capped merchant inbox evidence exhausts", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "2",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let published: { content: string } | null = null
    let recoveryCalls = 0
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          recoveryCalls += 1
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(published, {
            source: "commerce",
            stale: false,
            degraded: true,
            capped: true,
            inbox: {
              declarationState: "declared",
              coverage: "partial",
              readSource: "declared",
            },
          })
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "merchant_recovery",
      summary: "Guest checkout order smoke inconclusive at merchant_recovery.",
    })
    expect(recoveryCalls).toBe(2)
  })

  it("rejects a recovered order when its parsed payload drifts", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "1",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let published: { content: string } | null = null
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(
            published,
            {
              source: "commerce",
              stale: false,
              degraded: false,
              inbox: {
                declarationState: "declared",
                coverage: "complete",
                readSource: "declared",
              },
            },
            (payload) => ({
              ...payload,
              note: "Mutated after recovery.",
            })
          )
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at merchant_recovery."
    )
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("releases the protected merchant signer when recovery fails", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "1",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let failure: unknown
    let sawProtectedReadAuthorization = false

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async () => ({
          buyerSelfCopyError: null,
          localCacheError: null,
        }),
        getMerchantOrders: async () => {
          sawProtectedReadAuthorization ||=
            getProtectedReadAuthorization(MERCHANT_PUBKEY) !== null
          return {
            data: [],
            meta: {
              plan: "protected_conversation_list",
              source: "commerce",
              fetchedAt: now,
              stale: false,
              degraded: false,
              inbox: {
                declarationState: "declared",
                coverage: "complete",
                readSource: "declared",
              },
              capabilities: [],
            },
          } as never
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at merchant_recovery."
    )
    expect(sawProtectedReadAuthorization).toBe(true)
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("formats only a fixed failure stage without credential details", async () => {
    const invalidSessionInput = "synthetic-invalid-input"
    let error: unknown
    try {
      parseGuestCheckoutOrderSmokeConfig(
        environment({
          GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX:
            invalidSessionInput,
        })
      )
    } catch (caught) {
      error = caught
    }
    const formatted = formatGuestCheckoutOrderSmokeFailure(error)

    expect(formatted).toBe(
      "Guest checkout order smoke failed at configuration."
    )
    expect(!formatted.includes(invalidSessionInput)).toBe(true)
  })

  it("builds only fixed-schema, candidate-bound smoke evidence", () => {
    const artifacts = [
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "a".repeat(40),
        workflowRunId: "123",
        workflowRunAttempt: "1",
        outcome: { status: "passed", stage: "complete" },
        relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
        durationMs: 29_999,
      }),
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "b".repeat(40),
        workflowRunId: "124",
        workflowRunAttempt: "2",
        outcome: { status: "failed", stage: "order_publish" },
        relayEvidence: UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
        durationMs: 60_000,
      }),
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "c".repeat(40),
        workflowRunId: "125",
        workflowRunAttempt: "3",
        outcome: { status: "inconclusive", stage: "merchant_recovery" },
        relayEvidence: {
          relayAttemptCount: 3,
          relayAcknowledgementCount: 1,
          relayObservation: "available",
        },
        durationMs: 240_000,
      }),
    ]

    expect(artifacts.map((artifact) => artifact.status)).toEqual([
      "passed",
      "failed",
      "inconclusive",
    ])
    expect(artifacts.map((artifact) => artifact.failureCode)).toEqual([
      null,
      "failed_order_publish",
      "inconclusive_merchant_recovery",
    ])
    expect(artifacts.map((artifact) => artifact.durationBucket)).toEqual([
      "under_30_seconds",
      "60_to_119_seconds",
      "240_seconds_or_more",
    ])
    expect(
      artifacts.map((artifact) => artifact.signerFidelity.merchant)
    ).toEqual(Array.from({ length: 3 }, () => "external_nip46_remote_signer"))
    expect(artifacts[1]).toMatchObject({
      relayAttemptCount: null,
      relayAcknowledgementCount: null,
      relayObservation: "unavailable",
    })

    for (const artifact of artifacts) {
      const serialized = serializeGuestCheckoutOrderSmokeArtifact(artifact)
      expect(parseGuestCheckoutOrderSmokeArtifact(serialized)).toEqual(artifact)
      expect(serialized).not.toContain(MERCHANT_PUBKEY)
      expect(
        containsProhibitedGuestCheckoutOrderSmokeEvidence(serialized)
      ).toBe(false)
    }
  })

  it("validates evidence context before the smoke runner can start", () => {
    expect(() => parseGuestCheckoutOrderSmokeEvidenceContext({})).toThrow(
      "Smoke evidence configuration is unavailable."
    )
    expect(() =>
      parseGuestCheckoutOrderSmokeEvidenceContext({
        GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "a".repeat(40),
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "invalid",
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
        GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: "/workspace/evidence.json",
      })
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(
      parseGuestCheckoutOrderSmokeEvidenceContext({
        GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "a".repeat(40),
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "123",
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
        GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: "/workspace/evidence.json",
      })
    ).toEqual({
      candidateCommitSha: "a".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      evidencePath: "/workspace/evidence.json",
    })
  })

  it("converts a cleanup failure into failed evidence", () => {
    expect(
      applyGuestCheckoutOrderSmokeCleanupOutcome(
        { status: "passed", stage: "complete" },
        true
      )
    ).toEqual({ status: "failed", stage: "cleanup" })
    expect(
      applyGuestCheckoutOrderSmokeCleanupOutcome(
        { status: "inconclusive", stage: "product_read" },
        true
      )
    ).toEqual({ status: "inconclusive", stage: "product_read" })
  })

  it("locks the smoke evidence content policy", () => {
    expect(GUEST_CHECKOUT_ORDER_SMOKE_PROHIBITED_PATTERN_SIGNATURES).toEqual([
      { source: String.raw`\b[0-9a-f]{64}\b`, flags: "i" },
      {
        source: String.raw`\b(?:nsec|npub|nprofile|nevent|naddr|note)1[0-9a-z]{8,}\b`,
        flags: "i",
      },
      {
        source: String.raw`\b(?:nostr\+walletconnect|nwc):`,
        flags: "i",
      },
      {
        source: String.raw`\b(?:lnbc|lntb|lnbcrt)[0-9a-z]{8,}\b`,
        flags: "i",
      },
      { source: String.raw`(?:https?|wss?):\/\/`, flags: "i" },
      {
        source: String.raw`(?:bunker|nostrconnect):\/\/`,
        flags: "i",
      },
      { source: "@", flags: "" },
      { source: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`, flags: "" },
      {
        source: String.raw`\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b`,
        flags: "i",
      },
    ])
    expect(
      Object.isFrozen(GUEST_CHECKOUT_ORDER_SMOKE_PROHIBITED_PATTERN_SIGNATURES)
    ).toBe(true)
    for (const syntheticPattern of [
      /synthetic prohibited marker/g,
      /synthetic prohibited marker/y,
    ]) {
      expect(
        containsProhibitedGuestCheckoutOrderSmokeEvidence(
          "synthetic prohibited marker",
          [syntheticPattern]
        )
      ).toBe(true)
      expect(
        containsProhibitedGuestCheckoutOrderSmokeEvidence(
          "synthetic prohibited marker",
          [syntheticPattern]
        )
      ).toBe(true)
      expect(syntheticPattern.lastIndex).toBe(0)
    }
    expect(
      containsProhibitedGuestCheckoutOrderSmokeEvidence("allowed marker", [
        /synthetic prohibited marker/g,
      ])
    ).toBe(false)

    const artifact = buildGuestCheckoutOrderSmokeArtifact({
      candidateCommitSha: "d".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      outcome: { status: "passed", stage: "complete" },
      relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
      durationMs: 1,
    })
    const serialized = serializeGuestCheckoutOrderSmokeArtifact(artifact)
    const shadowed = serialized.replace(
      '  "artifactName": "guest-checkout-order-evidence"',
      [
        '  "artifactName": "synthetic shadow marker",',
        '  "artifactName": "guest-checkout-order-evidence"',
      ].join("\n")
    )
    expect(shadowed).toContain("synthetic shadow marker")
    expect(() => parseGuestCheckoutOrderSmokeArtifact(shadowed)).toThrow(
      "Guest checkout order smoke evidence is invalid."
    )
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(JSON.stringify(artifact))
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    const reorderedArtifact = Object.fromEntries(
      Object.entries(artifact).reverse()
    )
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(
        `${JSON.stringify(reorderedArtifact, null, 2)}\n`
      )
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(
        JSON.stringify({ ...artifact, unexpected: "unsafe" })
      )
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(
        JSON.stringify({ ...artifact, workflowRunId: 123 })
      )
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(() =>
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "e".repeat(40),
        workflowRunId: "0",
        workflowRunAttempt: "1",
        outcome: { status: "passed", stage: "complete" },
        relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
        durationMs: 1,
      })
    ).toThrow("Guest checkout order smoke evidence is invalid.")
  })

  it("writes redacted failed evidence before the smoke exits nonzero", async () => {
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), "conduit-guest-smoke-evidence-")
    )
    const evidencePath = join(evidenceDirectory, "evidence.json")
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "scripts/smoke/guest_checkout_order.ts"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "f".repeat(40),
          GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "123",
          GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
          GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: evidencePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr)).toBe(
        "Guest checkout order smoke failed at configuration.\n"
      )
      const artifact = parseGuestCheckoutOrderSmokeArtifact(
        await Bun.file(evidencePath).text()
      )
      expect(artifact).toMatchObject({
        status: "failed",
        stage: "configuration",
        failureCode: "failed_configuration",
        candidateCommitSha: "f".repeat(40),
        relayAttemptCount: 0,
        relayAcknowledgementCount: 0,
        relayObservation: "available",
      })

      const validEvidence = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/ci/validate_guest_checkout_order_evidence.ts",
          evidencePath,
          "f".repeat(40),
          "123",
          "1",
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(validEvidence.exitCode).toBe(0)

      const misboundEvidence = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/ci/validate_guest_checkout_order_evidence.ts",
          evidencePath,
          "0".repeat(40),
          "123",
          "1",
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(misboundEvidence.exitCode).toBe(1)
      expect(new TextDecoder().decode(misboundEvidence.stderr)).toBe(
        "Guest checkout order smoke evidence is invalid.\n"
      )
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  })

  it("fails evidence preflight before loading fixture configuration", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "scripts/smoke/guest_checkout_order.ts"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toBe(
      "Guest checkout order smoke failed at evidence_configuration.\n"
    )
  })
})
