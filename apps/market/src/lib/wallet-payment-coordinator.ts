import {
  classifyNwcPaymentError,
  config,
  getWalletNetworkFromLightningConfig,
  isWalletNetwork,
  resolveWalletPaymentInstance,
  type ConnectedWalletProvider,
  type NwcConnection,
  type PortableWalletProvider,
  type RegisteredWalletProvider,
  type WalletLifecycleStatus,
  type WalletNetwork,
  type WalletPayInvoiceInput,
  type WalletPayInvoiceResult,
  type WalletPaymentTarget,
  type WalletProviderId,
} from "@conduit/core"
import {
  closeBuyerNwcSession,
  getBuyerNwcSession,
  type NwcSessionPaymentResult,
  type NwcSessionSnapshot,
} from "./buyer-nwc-session"
import { getSparkWalletManager, payInvoiceWithSparkWallet } from "./spark-sdk"
import { getMarketWalletRegistry } from "./wallet-storage"

export class WalletProviderRegistry {
  readonly #providers = new Map<WalletProviderId, RegisteredWalletProvider>()

  constructor(providers: readonly RegisteredWalletProvider[] = []) {
    for (const provider of providers) {
      this.register(provider)
    }
  }

  register(provider: RegisteredWalletProvider): void {
    if (this.#providers.has(provider.providerId)) {
      throw new Error(
        `Wallet provider "${provider.providerId}" is already registered.`
      )
    }
    this.#providers.set(provider.providerId, provider)
  }

  get(providerId: WalletProviderId): RegisteredWalletProvider | null {
    return this.#providers.get(providerId) ?? null
  }
}

export class WalletPaymentCoordinator {
  readonly #isTargetEligible:
    ((target: WalletPaymentTarget) => Promise<boolean>) | null

  constructor(
    private readonly registry: WalletProviderRegistry,
    options: {
      isTargetEligible?: (target: WalletPaymentTarget) => Promise<boolean>
    } = {}
  ) {
    this.#isTargetEligible = options.isTargetEligible ?? null
  }

  async payInvoice(
    target: WalletPaymentTarget,
    input: WalletPayInvoiceInput
  ): Promise<WalletPayInvoiceResult> {
    if (this.#isTargetEligible) {
      let eligible: boolean
      try {
        eligible = await this.#isTargetEligible(target)
      } catch {
        return {
          status: "failed",
          phase: "before_publish",
          reason: "The selected wallet registration could not be verified.",
        }
      }
      if (!eligible) {
        return {
          status: "failed",
          phase: "before_publish",
          reason:
            "The selected wallet is no longer registered for payments on this device.",
        }
      }
    }

    const provider = this.registry.get(target.providerId)
    if (!provider?.payInvoice) {
      return {
        status: "failed",
        phase: "before_publish",
        reason: "The selected wallet provider is unavailable.",
      }
    }

    return provider.payInvoice(target.walletId, input)
  }
}

export type NwcPaymentReadiness =
  { ready: true } | { ready: false; reason: string }

export function getNwcPaymentReadiness(input: {
  snapshot: NwcSessionSnapshot
  walletNetwork: WalletNetwork
  configuredNetwork: WalletNetwork
}): NwcPaymentReadiness {
  if (input.walletNetwork !== input.configuredNetwork) {
    return {
      ready: false,
      reason: `This Connected Wallet uses ${input.walletNetwork}, but Market is using ${input.configuredNetwork}.`,
    }
  }

  const info = input.snapshot.info
  if (!info) {
    return {
      ready: false,
      reason:
        "Live Connected Wallet information is unavailable. Reconnect it before paying.",
    }
  }

  const liveNetwork = isWalletNetwork(info.network) ? info.network : null
  if (!liveNetwork) {
    return {
      ready: false,
      reason:
        "The Connected Wallet network could not be verified. Reconnect it before paying.",
    }
  }
  if (liveNetwork !== input.walletNetwork) {
    return {
      ready: false,
      reason: `This Connected Wallet uses ${liveNetwork}, but Market is using ${input.configuredNetwork}.`,
    }
  }
  if (!info.methods.includes("pay_invoice")) {
    return {
      ready: false,
      reason:
        "This Connected Wallet does not support outgoing payments via NWC.",
    }
  }
  if (input.snapshot.status !== "reachable") {
    return {
      ready: false,
      reason:
        "The Connected Wallet is not currently reachable. Reconnect it before paying.",
    }
  }

  return { ready: true }
}

function getNwcLifecycleStatus(
  snapshot: NwcSessionSnapshot
): WalletLifecycleStatus {
  if (snapshot.status === "reachable") {
    const configuredNetwork = getWalletNetworkFromLightningConfig(
      config.lightningNetwork
    )
    return getNwcPaymentReadiness({
      snapshot,
      walletNetwork: configuredNetwork,
      configuredNetwork,
    }).ready
      ? "ready"
      : "error"
  }
  if (snapshot.status === "warming") return "connecting"
  if (snapshot.status === "disconnected") return "registered"
  if (snapshot.status === "unreachable") return "unavailable"
  return "error"
}

function getNwcFailureResult(
  result: Exclude<NwcSessionPaymentResult, { status: "paid" }>,
  connection: NwcConnection
): WalletPayInvoiceResult {
  const diagnostic = classifyNwcPaymentError(result.reason, connection)
  if (result.status === "published_timeout") {
    return {
      status: "ambiguous",
      reason: result.reason,
      diagnostics: [diagnostic],
    }
  }
  if (!diagnostic.safeManualFallback) {
    return {
      status: "ambiguous",
      reason: result.reason,
      diagnostics: [diagnostic],
    }
  }
  return {
    status: "failed",
    phase: result.phase,
    reason: result.reason,
    diagnostics: [diagnostic],
  }
}

async function payInvoiceWithNwcProvider(
  walletId: string,
  input: WalletPayInvoiceInput
): Promise<WalletPayInvoiceResult> {
  const session = getBuyerNwcSession(walletId)
  const connection = session.getSnapshot().connection
  if (!connection) {
    return {
      status: "failed",
      phase: "before_publish",
      reason: "The selected Connected Wallet is unavailable.",
    }
  }

  const configuredNetwork = getWalletNetworkFromLightningConfig(
    config.lightningNetwork
  )
  const readiness = getNwcPaymentReadiness({
    snapshot: session.getSnapshot(),
    walletNetwork: configuredNetwork,
    configuredNetwork,
  })
  if (!readiness.ready) {
    return {
      status: "failed",
      phase: "before_publish",
      reason: readiness.reason,
    }
  }

  try {
    const result = await session.payInvoice({
      invoice: input.invoice,
      amountMsats: input.amountMsats,
      timeoutMs: input.timeoutMs,
      appId: input.appId,
      metadata: input.metadata,
    })
    if (result.status === "paid") {
      return {
        status: "paid",
        preimage: result.preimage,
        paymentHash: result.paymentHash,
        feeMsats: result.feeMsats,
      }
    }
    return getNwcFailureResult(result, connection)
  } catch (error) {
    const diagnostic = classifyNwcPaymentError(error, connection)
    if (!diagnostic.safeManualFallback) {
      return {
        status: "ambiguous",
        reason: diagnostic.detail,
        diagnostics: [diagnostic],
      }
    }
    return {
      status: "failed",
      phase: "before_publish",
      reason: diagnostic.detail,
      diagnostics: [diagnostic],
    }
  }
}

async function payInvoiceWithSparkProvider(
  walletId: string,
  input: WalletPayInvoiceInput
): Promise<WalletPayInvoiceResult> {
  const result = await payInvoiceWithSparkWallet(walletId, {
    invoice: input.invoice,
    amountMsats: input.amountMsats,
    idempotencyKey: input.idempotencyKey,
    completionTimeoutSecs: Math.max(1, Math.floor(input.timeoutMs / 1_000)),
    approveFee: input.approveFee,
  })
  if (result.status === "paid") {
    return {
      status: "paid",
      preimage: result.preimage,
      paymentHash: result.paymentHash,
      feeMsats: result.feeMsats,
    }
  }
  if (result.status === "approval_declined") {
    return { status: "declined", reason: result.reason }
  }
  if (result.status === "ambiguous") {
    return { status: "ambiguous", reason: result.reason }
  }
  return {
    status: "failed",
    phase: "before_publish",
    reason: result.reason,
  }
}

const sparkWalletProvider: PortableWalletProvider = {
  providerId: "spark",
  kind: "portable",
  lifecycle: {
    getStatus(walletId) {
      const manager = getSparkWalletManager()
      if (!manager) return "unavailable"
      return manager.isOpen(walletId) ? "ready" : "locked"
    },
    async close(walletId) {
      await getSparkWalletManager()?.close(walletId)
    },
  },
  payInvoice: payInvoiceWithSparkProvider,
}

const nwcWalletProvider: ConnectedWalletProvider = {
  providerId: "nwc",
  kind: "connected",
  lifecycle: {
    getStatus(walletId) {
      return getNwcLifecycleStatus(getBuyerNwcSession(walletId).getSnapshot())
    },
    async close(walletId) {
      closeBuyerNwcSession(walletId)
    },
  },
  payInvoice: payInvoiceWithNwcProvider,
}

export const marketWalletProviderRegistry = new WalletProviderRegistry([
  sparkWalletProvider,
  nwcWalletProvider,
])

export const marketWalletPaymentCoordinator = new WalletPaymentCoordinator(
  marketWalletProviderRegistry,
  { isTargetEligible: isPersistedMarketPaymentTargetEligible }
)

async function isPersistedMarketPaymentTargetEligible(
  target: WalletPaymentTarget
): Promise<boolean> {
  const network = getWalletNetworkFromLightningConfig(config.lightningNetwork)
  return (
    resolveWalletPaymentInstance(await getMarketWalletRegistry().list(), {
      walletId: target.walletId,
      providerId: target.providerId,
      network,
    }) !== null
  )
}
