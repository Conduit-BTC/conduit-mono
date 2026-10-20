import { getEventHash } from "nostr-tools"
import type {
  PrivateMessageEvent,
  PrivateMessageRumor,
} from "./private-message-primitives"

/**
 * Match canonical machine authority without making optional NIP-89 attribution
 * depend on the receiving app's build configuration. Authenticate/hash the
 * original rumor; only one advisory client tag may differ or be absent.
 */
export function hasExactMachineRumorBindings(
  rumor: PrivateMessageEvent,
  canonical: PrivateMessageRumor
): boolean {
  try {
    const clients = rumor.tags.filter((tag) => tag[0] === "client")
    return (
      rumor.sig === undefined &&
      rumor.kind === canonical.kind &&
      rumor.pubkey === canonical.pubkey &&
      rumor.created_at === canonical.created_at &&
      rumor.id ===
        getEventHash({
          ...rumor,
          kind: rumor.kind!,
          created_at: rumor.created_at!,
        }) &&
      clients.length <= 1 &&
      clients.every(
        (tag) =>
          tag.length >= 2 &&
          tag.length <= 4 &&
          tag.every((part) => typeof part === "string" && part.length <= 512)
      ) &&
      JSON.stringify(rumor.tags.filter((tag) => tag[0] !== "client")) ===
        JSON.stringify(canonical.tags.filter((tag) => tag[0] !== "client")) &&
      rumor.content === canonical.content
    )
  } catch {
    return false
  }
}
