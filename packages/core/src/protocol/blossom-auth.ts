import type { SignedNostrEvent } from "./nostr-event-signer"
export function encodeBlossomAuthorizationHeader(
  event: SignedNostrEvent,
  encoding: "bud11" | "legacy" = "bud11"
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  return `Nostr ${encoding === "legacy" ? base64 : base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")}`
}
