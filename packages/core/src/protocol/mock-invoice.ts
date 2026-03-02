/**
 * Mock Lightning invoice generator for testing.
 * Active when VITE_LIGHTNING_NETWORK=mock.
 *
 * Generates fake but structurally valid-looking BOLT11 strings
 * so the full order flow can be tested without a real wallet.
 */

import { isMockPayments } from "../config"

let mockCounter = 0

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function canMockInvoice(): boolean {
  return isMockPayments()
}

export function mockMakeInvoice(params: {
  amountSats: number
  memo?: string
}): { invoice: string; paymentHash: string } {
  mockCounter++
  const paymentHash = randomHex(32)
  // Fake BOLT11 — starts with lnbcrt (regtest prefix) so it's clearly not real
  const fakeInvoice = `lnbcrt${params.amountSats}n1p${randomHex(20)}mock${mockCounter}`
  return { invoice: fakeInvoice, paymentHash }
}
