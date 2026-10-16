const BRAINSTORM_TRUST_SIGNALS_URL =
  "https://api.brainstorm.world/user/trustSignals"
const HEX_PUBKEY = /^[0-9a-f]{64}$/

export function parseBrainstormVerification(
  value: unknown,
  expectedPubkey: string
): boolean {
  const invalid = () => new Error("Brainstorm returned an invalid verification")
  if (
    !value ||
    typeof value !== "object" ||
    !("code" in value) ||
    value.code !== 200 ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object" ||
    !("results" in value.data) ||
    !Array.isArray(value.data.results) ||
    value.data.results.length !== 1
  ) {
    throw invalid()
  }
  const result: unknown = value.data.results[0]
  if (
    !result ||
    typeof result !== "object" ||
    !("pubkey" in result) ||
    result.pubkey !== expectedPubkey ||
    !("verified" in result) ||
    typeof result.verified !== "boolean"
  ) {
    throw invalid()
  }

  // Only the positive verification signal is used. Scores, raw report counts
  // and the provider's flagged verdict do not affect the existing badge.
  return result.verified
}

export async function fetchBrainstormVerification(
  pubkey: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!HEX_PUBKEY.test(pubkey)) {
    throw new Error("Brainstorm verification lookup requires a hex pubkey")
  }
  const timeout = AbortSignal.timeout(30_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  requestSignal.throwIfAborted()
  const response = await fetch(BRAINSTORM_TRUST_SIGNALS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkeys: [pubkey] }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: requestSignal,
  })
  // Unlike ORE-02, trustSignals has no documented pending/retry contract.
  if (response.status !== 200) {
    throw new Error(
      `Brainstorm verification lookup failed (${response.status})`
    )
  }
  return parseBrainstormVerification(await response.json(), pubkey)
}
