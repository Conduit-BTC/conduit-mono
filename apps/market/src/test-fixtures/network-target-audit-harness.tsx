import { createRoot } from "react-dom/client"

import {
  fetchLnurlPayMetadataFromUrl,
  fetchSignedEventsFanoutDetailed,
  normalizePublicRelayHints,
} from "@conduit/core"
import { ProductCard } from "@conduit/ui"

export interface NetworkTargetAuditCase {
  id: string
  url: string
}

export interface NetworkTargetAuditResult {
  fetchStatuses: Array<{
    id: string
    status: "fulfilled" | "rejected"
  }>
  acceptedRelayUrls: string[]
  relayStatuses: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
  }>
}

export function mountNetworkTargetAuditHarness(
  container: HTMLElement,
  mediaTargets: readonly NetworkTargetAuditCase[]
): () => void {
  const root = createRoot(container)
  root.render(
    <div data-testid="network-target-audit-root">
      {mediaTargets.map((target) => (
        <div key={target.id} data-testid={`media-${target.id}`}>
          <ProductCard
            title={`Network target ${target.id}`}
            merchantName="Network target auditor"
            images={[{ url: target.url, alt: target.id }]}
            primaryPrice="1 sat"
            imageLoading="eager"
          />
        </div>
      ))}
    </div>
  )
  return () => root.unmount()
}

export async function runNetworkTargetAudit(input: {
  fetchTargets: readonly NetworkTargetAuditCase[]
  relayTargets: readonly string[]
}): Promise<NetworkTargetAuditResult> {
  const fetchStatuses = await Promise.all(
    input.fetchTargets.map(async (target) => {
      try {
        await fetchLnurlPayMetadataFromUrl(target.url, { timeoutMs: 1_000 })
        return { id: target.id, status: "fulfilled" as const }
      } catch {
        return { id: target.id, status: "rejected" as const }
      }
    })
  )

  const acceptedRelayUrls = normalizePublicRelayHints(input.relayTargets)
  const relayRead = await fetchSignedEventsFanoutDetailed(
    { kinds: [1], limit: 1 },
    {
      relayUrls: acceptedRelayUrls,
      connectTimeoutMs: 1_000,
      fetchTimeoutMs: 1_000,
      skipHealthFilter: true,
      reuseRelayConnections: false,
    }
  )

  return {
    fetchStatuses,
    acceptedRelayUrls,
    relayStatuses: relayRead.relays.map(({ relayUrl, status }) => ({
      relayUrl,
      status,
    })),
  }
}
