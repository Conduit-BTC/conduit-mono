const BRAINSTORM_STATS_URL = "https://api.brainstorm.world/stats/pubkey"

const HEX_PUBKEY = /^[0-9a-f]{64}$/

export type BrainstormGlobalScore = {
  pubkey: string
  score: number
}

export function parseBrainstormGlobalScore(
  value: unknown,
  expectedPubkey: string
): BrainstormGlobalScore {
  if (
    !value ||
    typeof value !== "object" ||
    !("pubkey" in value) ||
    value.pubkey !== expectedPubkey ||
    !("rank" in value) ||
    typeof value.rank !== "number" ||
    !Number.isFinite(value.rank) ||
    value.rank < 0 ||
    value.rank > 1
  ) {
    throw new Error("Brainstorm returned an invalid global score")
  }

  return {
    pubkey: expectedPubkey,
    // ORE-02 currently returns raw GrapeRank influence (0–1). Brainstorm's
    // public profile presents the corresponding rounded 0–100 score.
    score: Math.round(value.rank * 100),
  }
}

export async function fetchBrainstormGlobalScore(
  pubkey: string,
  signal?: AbortSignal
): Promise<BrainstormGlobalScore> {
  if (!HEX_PUBKEY.test(pubkey)) {
    throw new Error("Brainstorm score lookup requires a hex pubkey")
  }

  const response = await fetch(BRAINSTORM_STATS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  })

  if (!response.ok) {
    throw new Error(`Brainstorm score lookup failed (${response.status})`)
  }

  return parseBrainstormGlobalScore(await response.json(), pubkey)
}
