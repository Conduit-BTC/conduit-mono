// Web Worker: batch schnorr signature verification off the main thread.
// The main thread does the cheap sha256 event-id check (needed for the
// verified-id cache and to bind content to id); this worker only runs the
// expensive schnorr.verify over already-id-checked (sig, id, pubkey) tuples.
import { schnorr } from "@noble/curves/secp256k1.js"
import { hexToBytes } from "@noble/curves/utils.js"

type VerifyItem = { sig: string; id: string; pubkey: string }
type VerifyRequest = { reqId: number; items: VerifyItem[] }

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null
  postMessage: (message: { reqId: number; valid: boolean[] }) => void
}

ctx.onmessage = (event) => {
  const { reqId, items } = event.data
  const valid = items.map((item) => {
    try {
      return schnorr.verify(
        hexToBytes(item.sig),
        hexToBytes(item.id),
        hexToBytes(item.pubkey)
      )
    } catch {
      return false
    }
  })
  ctx.postMessage({ reqId, valid })
}
