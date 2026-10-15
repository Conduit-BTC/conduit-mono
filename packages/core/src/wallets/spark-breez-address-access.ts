import {
  addressRequestHash,
  addressNameRequestMessage,
  type AddressNameRequest,
  type SignedAddressNameRequest,
} from "./address-name-request"
import { getAccountSigner } from "../protocol/session-signer"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
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
  | {
      status: "configured"
      apiKey: string
      domain: "conduit.cash" | "breez.tips"
    }
  | {
      status: "unavailable"
      reason: "unconfigured" | "unsupported_network" | "invalid_configuration"
    } {
  if (!input.enabled) return { status: "unavailable", reason: "unconfigured" }
  if (input.network !== "mainnet")
    return { status: "unavailable", reason: "unsupported_network" }
  if (!input.apiKey?.trim())
    return { status: "unavailable", reason: "unconfigured" }
  if (!["conduit.cash", "breez.tips"].includes(input.domain ?? ""))
    return { status: "unavailable", reason: "invalid_configuration" }
  return {
    status: "configured",
    apiKey: input.apiKey.trim(),
    domain: input.domain as "conduit.cash" | "breez.tips",
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
    domain: "breez.tips",
  })
  const clients = new Map<string, BreezLightningAddressClient>()
  const run = async (
    register: boolean,
    username?: string,
    domain = "breez.tips"
  ): Promise<BreezAddressState> => {
    if (configuration.status === "unavailable")
      return { status: "unavailable", reason: configuration.reason }
    if (!input.signer)
      return { status: "unavailable", reason: "identity_mismatch" }
    if (typeof navigator === "undefined" || !navigator.locks)
      return { status: "unavailable", reason: "coordination_unavailable" }
    if (!["conduit.cash", "breez.tips"].includes(domain))
      return { status: "unavailable", reason: "invalid_configuration" }
    let client = clients.get(domain)
    client ??= new BreezLightningAddressClient({
      ...configuration,
      domain,
      signer: input.signer,
      signAccountProof: async ({ url, method, body }) => {
        const signer = getAccountSigner()
        if (!signer) throw new Error("Connect the approved Nostr account.")
        const event = await signer.signEvent({
          kind: 27235,
          pubkey: signer.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["u", url],
            ["method", method],
            ["payload", addressRequestHash(body)],
          ],
        })
        if (getAccountSigner() !== signer || event.pubkey !== signer.pubkey)
          throw new Error("The approved Nostr account changed.")
        return `Nostr ${btoa(JSON.stringify(event))}`
      },
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
    clients.set(domain, client)
    return register
      ? client.ensure(username, {
          activateApprovedName:
            domain === "conduit.cash" && username !== undefined,
        })
      : client.lookup()
  }
  return {
    lookupBreezAddress: (domain?: string) => run(false, undefined, domain),
    ensureBreezAddress: (username?: string, domain?: string) =>
      run(true, username, domain),
    async signAddressNameRequest(
      value: Omit<AddressNameRequest, "sparkIdentity">
    ): Promise<SignedAddressNameRequest> {
      if (!input.signer || input.network !== "mainnet")
        throw new Error("Open your mainnet wallet first.")
      input.signer.assertActive()
      const request = {
        ...value,
        sparkIdentity: await input.signer.getIdentityPublicKey(),
      }
      const signature = await input.signer.signDigest(
        sha256(new TextEncoder().encode(addressNameRequestMessage(request)))
      )
      input.signer.assertActive()
      return { ...request, walletSignature: bytesToHex(signature) }
    },
  }
}
