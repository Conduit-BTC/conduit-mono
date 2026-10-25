import { useAuth } from "../context/AuthContext"
import { getAccountSigner } from "../protocol/session-signer"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  PUBLIC_SETTINGS_KIND,
  emptyPublicSettings,
  SettingsError,
  type PublicSettingsDocument,
} from "../settings/documents"
import {
  compareSettingsEvents,
  readPublicSettingsEvent,
} from "../settings/events"
import { createSettingsTransport } from "../settings/transport"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
interface PublicView {
  document: PublicSettingsDocument
  head?: SignedNostrEvent
  problem?: string
}
/** Public discovery has no signer dependency and never opens private settings. */
export function usePublicOrdinarySettings(owner: string) {
  const client = useQueryClient()
  const { accountPubkey, authGeneration } = useAuth()
  const signer = getAccountSigner()
  const viewer = signer?.pubkey === accountPubkey ? signer : undefined
  const key = [
    "ordinary-storefront-settings",
    owner,
    accountPubkey,
    authGeneration,
  ]
  return useQuery({
    queryKey: key,
    enabled: /^[0-9a-f]{64}$/.test(owner),
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }): Promise<PublicView> => {
      const previous = client.getQueryData<PublicView>(key)
      const read = await createSettingsTransport(viewer).read(
        owner,
        PUBLIC_SETTINGS_KIND,
        () => !signal.aborted && (!viewer || getAccountSigner() === viewer)
      )
      const head = [
        ...(previous?.head ? [previous.head] : []),
        ...read.events.filter(
          (e) =>
            e.pubkey === owner &&
            e.kind === PUBLIC_SETTINGS_KIND &&
            isValidSignedPublicNostrEvent(e)
        ),
      ].sort(compareSettingsEvents)[0]
      if (!head)
        return { document: previous?.document ?? emptyPublicSettings() }
      try {
        return { document: readPublicSettingsEvent(head, owner), head }
      } catch (error) {
        return {
          document: previous?.document ?? emptyPublicSettings(),
          head,
          problem: error instanceof SettingsError ? error.code : "invalid",
        }
      }
    },
  })
}
