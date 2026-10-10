import {
  BreezLightningAddressClient,
  type BreezAddressCheckpoint,
  type BreezAddressSigner,
  type BreezAddressState,
} from "@conduit/core"

export function getBreezAddressConfiguration(input: {
  enabled?: boolean
  apiKey?: string
  domain?: string
  network: string
}):
  | { status: "configured"; apiKey: string; domain: "conduit.cash" }
  | {
      status: "unavailable"
      reason: "unconfigured" | "unsupported_network" | "invalid_configuration"
    } {
  if (!input.enabled) return { status: "unavailable", reason: "unconfigured" }
  if (input.network !== "mainnet")
    return { status: "unavailable", reason: "unsupported_network" }
  if (!input.apiKey?.trim())
    return { status: "unavailable", reason: "unconfigured" }
  if (input.domain !== "conduit.cash")
    return { status: "unavailable", reason: "invalid_configuration" }
  return {
    status: "configured",
    apiKey: input.apiKey.trim(),
    domain: "conduit.cash",
  }
}

export function createSparkBreezAddressAccess(input: {
  network: string
  signer?: BreezAddressSigner
}) {
  const configuration = getBreezAddressConfiguration({
    network: input.network,
    enabled: import.meta.env?.VITE_BREEZ_LIGHTNING_ADDRESS_ENABLED === "true",
    // Intentionally browser-visible public-client credential, not a wallet secret.
    apiKey: import.meta.env?.VITE_BREEZ_SPARK_API_KEY,
    domain: import.meta.env?.VITE_BREEZ_LNURL_DOMAIN,
  })
  let client: BreezLightningAddressClient | null = null
  const run = async (register: boolean): Promise<BreezAddressState> => {
    if (configuration.status === "unavailable")
      return { status: "unavailable", reason: configuration.reason }
    if (!input.signer)
      return { status: "unavailable", reason: "identity_mismatch" }
    if (typeof navigator === "undefined" || !navigator.locks)
      return { status: "unavailable", reason: "coordination_unavailable" }
    client ??= new BreezLightningAddressClient({
      ...configuration,
      signer: input.signer,
      runExclusive: (scope, operation) =>
        navigator.locks.request(`conduit:breez-address:v1:${scope}`, operation),
      store: {
        async read(scope) {
          const raw = localStorage.getItem(`conduit:breez-address:v1:${scope}`)
          return raw ? (JSON.parse(raw) as BreezAddressCheckpoint) : null
        },
        async write(scope, value) {
          const key = `conduit:breez-address:v1:${scope}`
          if (value === null) localStorage.removeItem(key)
          else localStorage.setItem(key, JSON.stringify(value))
        },
      },
    })
    return register ? client.ensure() : client.lookup()
  }
  return {
    lookupBreezAddress: () => run(false),
    ensureBreezAddress: () => run(true),
  }
}
