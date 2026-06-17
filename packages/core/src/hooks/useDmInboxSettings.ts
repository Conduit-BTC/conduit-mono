import { useCallback, useEffect, useMemo, useState } from "react"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import {
  getDmRelayList,
  ingestDmRelayListEvent,
  serializeDmRelayListTags,
  type DmRelayList,
} from "../protocol/dm-relay-list"
import { EVENT_KINDS } from "../protocol/kinds"
import { getNdk } from "../protocol/ndk"
import { publishWithPlanner } from "../protocol/relay-publish"

export interface UseDmInboxSettingsOptions {
  pubkey?: string | null
  enabled?: boolean
}

export interface UseDmInboxSettingsResult {
  relayUrls: string[]
  defaultRelayUrls: string[]
  publishedAt: number | null
  isLoading: boolean
  isPublishing: boolean
  publishError: string | null
  publishDefaultInbox: () => Promise<void>
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unable to publish encrypted order inbox"
}

export function useDmInboxSettings(
  options: UseDmInboxSettingsOptions = {}
): UseDmInboxSettingsResult {
  const pubkey = options.pubkey?.trim() || null
  const enabled = options.enabled ?? true
  const defaultRelayUrls = useMemo(
    () => [...config.dmInboxDefaultRelayUrls],
    []
  )
  const [dmRelayList, setDmRelayList] = useState<DmRelayList | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !pubkey) {
      setDmRelayList(null)
      setIsLoading(false)
      return
    }

    const targetPubkey = pubkey
    let cancelled = false
    async function loadDmRelayList(): Promise<void> {
      setIsLoading(true)
      try {
        const cached = await getDmRelayList(targetPubkey, { cacheOnly: true })
        if (!cancelled && cached) setDmRelayList(cached)

        const fresh = await getDmRelayList(targetPubkey, { skipCache: true })
        if (!cancelled && fresh) setDmRelayList(fresh)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadDmRelayList()

    return () => {
      cancelled = true
    }
  }, [enabled, pubkey])

  const publishDefaultInbox = useCallback(async (): Promise<void> => {
    setPublishError(null)
    setIsPublishing(true)

    try {
      if (!pubkey) {
        throw new Error("Connect a signer before publishing an order inbox")
      }
      if (defaultRelayUrls.length === 0) {
        throw new Error(
          "No default encrypted order inbox relays are configured"
        )
      }

      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Signer not connected")

      const user = await ndk.signer.user()
      if (user.pubkey !== pubkey) {
        throw new Error("Active signer does not match this order inbox")
      }

      const event = new NDKEvent(ndk)
      event.kind = EVENT_KINDS.DM_RELAY_LIST
      event.created_at = Math.floor(Date.now() / 1000)
      event.content = ""
      event.tags = serializeDmRelayListTags(defaultRelayUrls)

      await event.sign(ndk.signer)
      if (!event.sig?.trim()) {
        throw new Error("Signer did not return a signature")
      }

      await publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: pubkey,
        skipHealthFilter: true,
      })

      const next = await ingestDmRelayListEvent({
        pubkey,
        tags: event.tags,
        created_at: event.created_at,
      })
      setDmRelayList(next)
    } catch (error) {
      const message = getErrorMessage(error)
      setPublishError(message)
      throw error
    } finally {
      setIsPublishing(false)
    }
  }, [defaultRelayUrls, pubkey])

  return {
    relayUrls: dmRelayList?.relayUrls ?? [],
    defaultRelayUrls,
    publishedAt: dmRelayList?.eventCreatedAt ?? null,
    isLoading,
    isPublishing,
    publishError,
    publishDefaultInbox,
  }
}
