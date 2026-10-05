import type { SignedPublicNostrEvent } from "./signed-event"

// Process-local cryptographic evidence, never persisted or inferred from a
// display cache. Bound both entries and retained signed text, evicting oldest
// proofs instead of clearing the entire cache during a large catalog read.
const MAX_PROOFS = 20_000
const MAX_PROOF_CHARS = 8 * 1024 * 1024
const proofs = new Map<
  string,
  { event: SignedPublicNostrEvent; chars: number }
>()
let proofChars = 0
// Retain provenance for admitted objects while they remain in use, even if the
// cross-object lookup cache evicts their bytes during a large progressive read.
let objectProofs = new WeakMap<object, SignedPublicNostrEvent>()

export function signedPublicEventProofKey(
  event: SignedPublicNostrEvent
): string {
  if (typeof event?.sig !== "string" || typeof event?.id !== "string") return ""
  return `${event.id.toLowerCase()}:${event.sig.toLowerCase()}`
}

export function sameSignedPublicEvent(
  left: SignedPublicNostrEvent,
  right: SignedPublicNostrEvent
): boolean {
  return (
    typeof right?.id === "string" &&
    typeof right.sig === "string" &&
    left.id.toLowerCase() === right.id.toLowerCase() &&
    left.sig.toLowerCase() === right.sig.toLowerCase() &&
    left.pubkey === right.pubkey &&
    left.created_at === right.created_at &&
    left.kind === right.kind &&
    left.content === right.content &&
    Array.isArray(right.tags) &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => {
      const other = right.tags[index]
      return (
        Array.isArray(other) &&
        tag.length === other.length &&
        tag.every((value, valueIndex) => value === other[valueIndex])
      )
    })
  )
}

export function snapshotSignedPublicEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  const tags = event.tags.map((tag) => [...tag])
  for (const tag of tags) Object.freeze(tag)
  Object.freeze(tags)
  return Object.freeze({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    content: event.content,
    sig: event.sig,
    tags,
  })
}

export function signedPublicEventChars(event: SignedPublicNostrEvent): number {
  return (
    320 +
    event.content.length +
    event.tags.reduce(
      (total, tag) =>
        total + tag.reduce((sum, value) => sum + value.length + 4, 2),
      0
    )
  )
}

export function hasVerifiedPublicEvent(event: SignedPublicNostrEvent): boolean {
  const retained = objectProofs.get(event)
  if (retained && sameSignedPublicEvent(retained, event)) return true
  const proof = proofs.get(signedPublicEventProofKey(event))
  return !!proof && sameSignedPublicEvent(proof.event, event)
}

/** Transfer admission only when both source and target match verified bytes. */
export function inheritVerifiedPublicEvent(
  target: SignedPublicNostrEvent,
  source: SignedPublicNostrEvent
): boolean {
  const proof =
    objectProofs.get(source) ??
    proofs.get(signedPublicEventProofKey(source))?.event
  if (
    !proof ||
    !sameSignedPublicEvent(proof, source) ||
    !sameSignedPublicEvent(proof, target)
  )
    return false
  objectProofs.set(target, proof)
  return true
}

/** Internal admission boundary: call only after successful cryptographic verification. */
export function rememberVerifiedPublicEvent(
  event: SignedPublicNostrEvent
): void {
  const key = signedPublicEventProofKey(event)
  const chars = signedPublicEventChars(event)
  if (chars > MAX_PROOF_CHARS) return
  const previous = proofs.get(key)
  if (previous && sameSignedPublicEvent(previous.event, event)) {
    objectProofs.set(event, previous.event)
    proofs.delete(key)
    proofs.set(key, previous)
    return
  }
  if (previous) {
    proofs.delete(key)
    proofChars -= previous.chars
  }
  while (proofs.size >= MAX_PROOFS || proofChars + chars > MAX_PROOF_CHARS) {
    const oldest = proofs.keys().next().value
    if (oldest === undefined) break
    proofChars -= proofs.get(oldest)!.chars
    proofs.delete(oldest)
  }
  const snapshot = snapshotSignedPublicEvent(event)
  objectProofs.set(event, snapshot)
  objectProofs.set(snapshot, snapshot)
  proofs.set(key, { event: snapshot, chars })
  proofChars += chars
}

export function clearVerifiedPublicEvents(): void {
  proofs.clear()
  proofChars = 0
  objectProofs = new WeakMap()
}
