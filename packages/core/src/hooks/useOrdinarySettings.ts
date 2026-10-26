import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useConduitSession } from "../context/ConduitSessionContext"
import { useAuth } from "../context/AuthContext"
import {
  getAccountSigner,
  subscribeToAccountSignerChanges,
} from "../protocol/session-signer"
import type { AccountSigner } from "../protocol/nostr-event-signer"
import { SettingsCoordinator } from "../settings/coordinator"
import { createSettingsStore } from "../settings/store"
import { createSettingsTransport } from "../settings/transport"
import {
  emptyPrivateSettings,
  emptyPublicSettings,
  SettingsError,
  type PrivateSettingsDocument,
  type PublicSettingsDocument,
} from "../settings/documents"
import type { SettingsChange, SettingsDraft } from "../settings/edits"
import { normalizeShopperPricePreference } from "../pricing"

const coordinators = new WeakMap<AccountSigner, SettingsCoordinator>()
const privateDefault = emptyPrivateSettings()
const publicDefault = emptyPublicSettings()
function coordinatorFor(signer: AccountSigner): SettingsCoordinator {
  let coordinator = coordinators.get(signer)
  if (!coordinator) {
    coordinator = new SettingsCoordinator(
      signer,
      createSettingsStore(),
      createSettingsTransport(signer),
      () => getAccountSigner() === signer
    )
    coordinators.set(signer, coordinator)
    const owned = coordinator
    const unsubscribe = subscribeToAccountSignerChanges(() => {
      if (getAccountSigner() !== signer) {
        owned.stop()
        coordinators.delete(signer)
        unsubscribe()
      }
    })
  }
  return coordinator
}
export function useOrdinarySettings({
  automatic = false,
}: { automatic?: boolean } = {}) {
  const { accountPubkey, authGeneration, signerReadiness } = useAuth()
  const client = useQueryClient()
  const session = useConduitSession()
  const signer = signerReadiness === "ready" ? getAccountSigner() : undefined
  const coordinator =
    session.relaySettingsReady && signer && signer.pubkey === accountPubkey
      ? coordinatorFor(signer)
      : null
  const scope = `${accountPubkey ?? "guest"}:${authGeneration}`
  const privateKey = useMemo(
    () => ["ordinary-private-settings", scope],
    [scope]
  )
  const publicKey = useMemo(() => ["ordinary-public-settings", scope], [scope])
  const privateQuery = useQuery({
    queryKey: privateKey,
    queryFn: () => coordinator!.readPrivate(),
    enabled: !!coordinator,
    staleTime: 30_000,
    refetchInterval: automatic ? 60_000 : false,
    refetchOnWindowFocus: automatic,
    retry: false,
    gcTime: 0,
  })
  const publicQuery = useQuery({
    queryKey: publicKey,
    queryFn: () => coordinator!.readPublic(),
    enabled: !!coordinator,
    staleTime: 30_000,
    refetchInterval: automatic ? 60_000 : false,
    refetchOnWindowFocus: automatic,
    retry: false,
    gcTime: 0,
  })
  const privateDocument = coordinator
    ? (privateQuery.data?.document ?? privateDefault)
    : privateDefault
  const publicDocument = coordinator
    ? (publicQuery.data?.document ?? publicDefault)
    : publicDefault
  async function savePrivate(draft: SettingsDraft<PrivateSettingsDocument>) {
    if (!coordinator || getAccountSigner() !== signer)
      throw new SettingsError("session")
    const result = await coordinator.publishPrivateSettings(draft)
    if (getAccountSigner() !== signer) throw new SettingsError("session")
    client.setQueryData(privateKey, result)
    return result
  }
  async function savePublic(draft: SettingsDraft<PublicSettingsDocument>) {
    if (!coordinator || getAccountSigner() !== signer)
      throw new SettingsError("session")
    const result = await coordinator.publishPublicSettings(draft)
    if (getAccountSigner() !== signer) throw new SettingsError("session")
    client.setQueryData(publicKey, result)
    return result
  }
  return {
    scope,
    owner: accountPubkey,
    ready: !!coordinator,
    privateDocument,
    publicDocument,
    privateQuery,
    publicQuery,
    savePrivate,
    savePublic,
    changePrivate: (changes: SettingsChange[]) =>
      savePrivate({ baseline: privateDocument, changes }),
  }
}
/** Mount once inside each app's auth/query boundary. Wallet restoration is independent. */
export function OrdinarySettingsSync(): null {
  const settings = useOrdinarySettings({ automatic: true })
  const client = useQueryClient()
  useEffect(
    () => () => {
      client.removeQueries({
        queryKey: ["ordinary-private-settings", settings.scope],
      })
      client.removeQueries({
        queryKey: ["ordinary-public-settings", settings.scope],
      })
    },
    [client, settings.scope]
  )
  return null
}
/** Shared read projection; no legacy preset reader, password or device override. */
export function useShoppingSettings() {
  const settings = useOrdinarySettings()
  const saved = settings.privateDocument.settings.shipping
  const shipping = saved?.defaultAddressId
    ? (saved.savedAddresses[saved.defaultAddressId] ?? null)
    : null
  return {
    presetOwnerPubkey: settings.ready ? settings.owner : null,
    preset: {
      shipping,
      preferredRail:
        settings.privateDocument.settings.payments?.preferredMethod ??
        "automatic",
      display: normalizeShopperPricePreference({
        ...settings.privateDocument.settings.display,
        currency:
          settings.privateDocument.settings.display?.currency === "BTC"
            ? "BITCOIN"
            : settings.privateDocument.settings.display?.currency,
      }),
    },
    discoveryDestination: shipping
      ? { country: shipping.country, postalCode: shipping.postalCode }
      : null,
  }
}
