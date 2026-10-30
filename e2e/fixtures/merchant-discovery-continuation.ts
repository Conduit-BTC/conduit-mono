type Candidate = {
  orderId: string
  initialBuyerPubkey: string
  checkoutId: string
  planDigest: string
  wrapId: string
  schemaVersion: 3
  takeoverAt: number
  preparedAt: number
}

type FixtureInput = {
  principalPubkey: string
  candidate: Candidate
}

type FixtureState = FixtureInput & {
  discoveryPages: number[]
  observationCalls: number
  advancementCalls: number
}

let fixture: FixtureState | null = null

function current(): FixtureState {
  if (!fixture) {
    throw new Error("Merchant continuation fixture is not configured.")
  }
  return fixture
}

function page(
  candidates: readonly Candidate[],
  history: { hasMore: boolean; pageStatus: "advanced" | "source_eose" }
) {
  return {
    candidates: candidates.map((candidate) => ({ ...candidate })),
    coverage: "partial" as const,
    declarationState: "declared" as const,
    malformedCount: 0,
    decryptFailureCount: 0,
    conflictCount: 0,
    history: {
      ...history,
      retentionLimitReached: false,
    },
  }
}

function assertExactCandidate(principalPubkey: string, value: unknown): void {
  const state = current()
  if (
    principalPubkey !== state.principalPubkey ||
    typeof value !== "object" ||
    value === null ||
    !("orderId" in value) ||
    !("planDigest" in value) ||
    value.orderId !== state.candidate.orderId ||
    value.planDigest !== state.candidate.planDigest
  ) {
    throw new Error("Merchant continuation fixture candidate changed.")
  }
}

export function configureMerchantDiscoveryContinuationFixture(
  input: FixtureInput
): void {
  fixture = {
    ...input,
    candidate: { ...input.candidate },
    discoveryPages: [],
    observationCalls: 0,
    advancementCalls: 0,
  }
}

export function merchantDiscoveryContinuationSnapshot() {
  const state = current()
  return {
    discoverySessions: state.discoveryPages.length,
    discoveryPages: [...state.discoveryPages],
    observationCalls: state.observationCalls,
    advancementCalls: state.advancementCalls,
  }
}

export async function createMerchantCheckoutSparkRecoveryDiscovery(
  principalPubkey: string
) {
  const state = current()
  if (principalPubkey !== state.principalPubkey) {
    throw new Error("Merchant continuation fixture principal changed.")
  }
  const session = state.discoveryPages.length
  state.discoveryPages.push(0)

  return {
    async nextPage() {
      const pageNumber = (state.discoveryPages[session] ?? 0) + 1
      state.discoveryPages[session] = pageNumber
      if (session === 0) {
        return page([state.candidate], {
          hasMore: false,
          pageStatus: "source_eose",
        })
      }
      if (pageNumber === 1) {
        return page([], { hasMore: true, pageStatus: "advanced" })
      }
      return page([state.candidate], {
        hasMore: false,
        pageStatus: "source_eose",
      })
    },
    restartScan() {},
    dispose() {},
  }
}

export async function reconcileMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: unknown
): Promise<"pending"> {
  assertExactCandidate(principalPubkey, candidate)
  current().observationCalls += 1
  return "pending"
}

export async function advanceMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: unknown
): Promise<"verified"> {
  assertExactCandidate(principalPubkey, candidate)
  current().advancementCalls += 1
  return "verified"
}
