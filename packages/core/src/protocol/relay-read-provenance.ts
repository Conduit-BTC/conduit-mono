// Provenance is local evidence, never a field supplied on the wire. Object
// identity also prevents proof-cache hits from borrowing previous-read sources.
const eventSourceRelayUrls = new WeakMap<object, string[]>()

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)))
}

export function attachEventSourceRelayUrl(
  event: object,
  relayUrl: string
): void {
  eventSourceRelayUrls.set(
    event,
    uniqueRelayUrls([...(eventSourceRelayUrls.get(event) ?? []), relayUrl])
  )
}

export function getEventSourceRelayUrls(event: object): string[] {
  return [...(eventSourceRelayUrls.get(event) ?? [])]
}

export function mergeEventSourceRelayUrls(
  target: object,
  source: object
): void {
  for (const relayUrl of getEventSourceRelayUrls(source)) {
    attachEventSourceRelayUrl(target, relayUrl)
  }
}
