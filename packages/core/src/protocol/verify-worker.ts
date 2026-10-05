// Bind canonical event bytes to their id and verify Schnorr off the UI thread.
// The reader and product parser reuse only exact, immutable verified proofs.
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

type VerifyItem = SignedPublicNostrEvent
type VerifyRequest = { reqId: number; items: VerifyItem[] }

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null
  postMessage: (message: { reqId: number; valid: boolean[] }) => void
}

ctx.onmessage = (event) => {
  const { reqId, items } = event.data
  const valid = items.map((item) => {
    try {
      return isValidSignedPublicNostrEvent(item)
    } catch {
      return false
    }
  })
  ctx.postMessage({ reqId, valid })
}
