import type { ProtectedReadPresentationState } from "@conduit/core"

export function getDirectMessageSearchEmptyCopy(
  state: ProtectedReadPresentationState
): string {
  if (state === "pending") return "Loading conversations…"
  if (state === "complete") return "No conversations match your search."
  return "Inbox results are incomplete. Retry before relying on no matches."
}
