import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

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
    left.id === right.id &&
    left.sig === right.sig &&
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

function hasVerifiedPublicEvent(event: SignedPublicNostrEvent): boolean {
  const retained = objectProofs.get(event)
  if (retained && sameSignedPublicEvent(retained, event)) return true
  const proof = proofs.get(signedPublicEventProofKey(event))
  return !!proof && sameSignedPublicEvent(proof.event, event)
}

/** Internal admission boundary: call only after successful cryptographic verification. */
function rememberVerifiedPublicEvent(event: SignedPublicNostrEvent): void {
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
  const snapshot = event
  objectProofs.set(event, snapshot)
  objectProofs.set(snapshot, snapshot)
  proofs.set(key, { event: snapshot, chars })
  proofChars += chars
}

function clearVerifiedPublicEvents(): void {
  proofs.clear()
  proofChars = 0
  objectProofs = new WeakMap()
}

declare const verifiedNostrEventBrand: unique symbol
export type VerifiedNostrEvent = Readonly<
  Omit<SignedPublicNostrEvent, "tags">
> & {
  readonly tags: readonly (readonly string[])[]
  readonly [verifiedNostrEventBrand]: true
}
let admitted = new WeakSet<object>()
export function isVerifiedNostrEvent(
  event: unknown
): event is VerifiedNostrEvent {
  return typeof event === "object" && event !== null && admitted.has(event)
}
function mint(event: SignedPublicNostrEvent): VerifiedNostrEvent {
  admitted.add(event)
  rememberVerifiedPublicEvent(event)
  return event as unknown as VerifiedNostrEvent
}
function abortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}
const MAX_PENDING_VERIFY_WORKER_BATCHES = 128
const MAX_PENDING_VERIFY_CHARS = 8 * 1024 * 1024
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

function isCanonicalSignedPublicNostrEvent(
  event: SignedPublicNostrEvent
): event is SignedPublicNostrEvent {
  return (
    HEX_64.test(event.id) &&
    HEX_64.test(event.pubkey) &&
    HEX_128.test(event.sig) &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    Number.isSafeInteger(event.kind) &&
    event.kind >= 0 &&
    event.kind <= 65_535 &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.every((value) => typeof value === "string")
    )
  )
}

type SchnorrItem = SignedPublicNostrEvent

function verifySchnorrSync(items: SchnorrItem[]): boolean[] {
  return items.map((item) => {
    if (hasVerifiedPublicEvent(item)) return true
    const valid = isValidSignedPublicNostrEvent(item)
    if (valid) rememberVerifiedPublicEvent(item)
    return valid
  })
}

async function verifySchnorrChunked(
  items: SchnorrItem[],
  signal?: AbortSignal
): Promise<boolean[]> {
  const valid: boolean[] = []
  const chunkSize = 16
  for (let index = 0; index < items.length; index += chunkSize) {
    throwIfAborted(signal)
    valid.push(...verifySchnorrSync(items.slice(index, index + chunkSize)))
    if (index + chunkSize < items.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  throwIfAborted(signal)
  return valid
}

// Offload schnorr verification to a worker so the crypto never blocks the main
// thread. When Workers are unavailable (SSR/tests), verify in bounded chunks
// with cancellation points. Active worker failures reject their batches.
let verifyWorker: Worker | null | undefined
let verifyReqId = 0
const DEFAULT_VERIFY_WORKER_TIMEOUT_MS = 8_000
let verifyWorkerTimeoutMs = DEFAULT_VERIFY_WORKER_TIMEOUT_MS
type PendingVerifyBatch = {
  items: SchnorrItem[]
  resolve: (valid: boolean[]) => void
  reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  posted: boolean
  retries: number
  chars: number
  workerIndexes?: number[]
  signal?: AbortSignal
  onAbort?: () => void
}
const pendingVerify = new Map<number, PendingVerifyBatch>()
let verifyWorkerRestartScheduled = false
let pendingVerifyChars = 0

function clearPendingVerifyBatch(
  reqId: number
): PendingVerifyBatch | undefined {
  const pending = pendingVerify.get(reqId)
  if (!pending) return undefined

  pendingVerify.delete(reqId)
  pendingVerifyChars -= pending.chars
  clearTimeout(pending.timer)
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener("abort", pending.onAbort)
  }
  return pending
}

function resolvePendingVerifyBatch(reqId: number, valid: boolean[]): void {
  const pending = clearPendingVerifyBatch(reqId)
  if (!pending) return

  if (pending.signal?.aborted) {
    pending.reject(abortError())
    pumpVerifyQueue()
    return
  }
  const verdicts = pending.items.map((_, index) => {
    const workerIndex = pending.workerIndexes?.[index] ?? index
    return workerIndex === -1 || valid[workerIndex] === true
  })
  for (let index = 0; index < pending.items.length; index++) {
    if (verdicts[index]) rememberVerifiedPublicEvent(pending.items[index])
  }
  pending.resolve(verdicts)
  pumpVerifyQueue()
}

function rejectPendingVerifyBatch(reqId: number, reason: unknown): void {
  clearPendingVerifyBatch(reqId)?.reject(reason)
}

function recoverTimedOutVerifyBatch(reqId: number): void {
  const pending = pendingVerify.get(reqId)
  if (!pending) return
  clearTimeout(pending.timer)
  pending.timer = undefined
  pending.posted = false
  if (pending.retries++ >= 1) {
    // A persistently stalled worker must not impose its timeout on every
    // queued read in succession, or move the work onto the browser UI thread.
    if (verifyWorker) failVerifyWorker(verifyWorker)
    else
      for (const id of [...pendingVerify.keys()]) {
        rejectPendingVerifyBatch(
          id,
          new Error("Signature verification worker timed out.")
        )
      }
    return
  }
  scheduleVerifyWorkerRestart()
}

function scheduleVerifyWorkerRestart(): void {
  if (verifyWorkerRestartScheduled) return
  verifyWorkerRestartScheduled = true
  queueMicrotask(() => {
    verifyWorkerRestartScheduled = false
    const worker = verifyWorker
    verifyWorker = undefined
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      try {
        worker.terminate()
      } catch {
        /* already stopped */
      }
    }
    for (const [reqId, pending] of [...pendingVerify.entries()]) {
      clearTimeout(pending.timer)
      pending.timer = undefined
      pending.posted = false
      if (pending.signal?.aborted) rejectPendingVerifyBatch(reqId, abortError())
    }
    pumpVerifyQueue()
  })
}

function pumpVerifyQueue(): void {
  if (
    verifyWorkerRestartScheduled ||
    [...pendingVerify.values()].some((batch) => batch.posted)
  )
    return
  const first = pendingVerify.entries().next().value
  if (!first) return
  const [reqId, pending] = first
  if (pending.signal?.aborted) {
    rejectPendingVerifyBatch(reqId, abortError())
    pumpVerifyQueue()
    return
  }
  const worker = getVerifyWorker()
  if (!worker) {
    for (const id of [...pendingVerify.keys()])
      rejectPendingVerifyBatch(
        id,
        new Error("Signature verification worker is unavailable.")
      )
    return
  }
  const work: SchnorrItem[] = []
  const byProof = new Map<string, number>()
  pending.workerIndexes = pending.items.map((event) => {
    if (hasVerifiedPublicEvent(event)) return -1
    const key = signedPublicEventProofKey(event)
    const existing = byProof.get(key)
    if (existing !== undefined && sameSignedPublicEvent(work[existing], event))
      return existing
    const index = work.length
    byProof.set(key, index)
    work.push(event)
    return index
  })
  if (work.length === 0) {
    resolvePendingVerifyBatch(reqId, [])
    return
  }
  pending.posted = true
  try {
    worker.postMessage({ reqId, items: work })
    // The execution deadline excludes time waiting in our bounded queue and
    // synchronous structured cloning while posting the complete signed batch.
    if (pendingVerify.get(reqId) === pending && pending.posted) {
      pending.timer = setTimeout(
        () => recoverTimedOutVerifyBatch(reqId),
        verifyWorkerTimeoutMs
      )
    }
  } catch {
    failVerifyWorker(worker)
  }
}

function cancelPendingVerifyBatch(reqId: number): void {
  const pending = clearPendingVerifyBatch(reqId)
  if (!pending) return
  pending.reject(abortError())
  // A Web Worker cannot remove an already-posted message from its queue.
  // Restarting clears stale crypto work; non-cancelled batches are re-posted.
  if (pending.posted) scheduleVerifyWorkerRestart()
  else pumpVerifyQueue()
}

function failVerifyWorker(worker: Worker): void {
  if (verifyWorker !== worker) return
  verifyWorker = null
  worker.onmessage = null
  worker.onerror = null
  try {
    worker.terminate()
  } catch {
    // ignore teardown errors
  }

  for (const reqId of [...pendingVerify.keys()]) {
    rejectPendingVerifyBatch(
      reqId,
      new Error("Signature verification worker failed.")
    )
  }
}

export function __setPublicEventVerifyTimeoutMsForTests(
  timeoutMs: number
): void {
  verifyWorkerTimeoutMs = Math.max(1, Math.floor(timeoutMs))
}

export function __resetPublicEventVerificationForTests(): void {
  if (verifyWorker) {
    verifyWorker.onmessage = null
    verifyWorker.onerror = null
    try {
      verifyWorker.terminate()
    } catch {
      // ignore teardown errors
    }
  }
  verifyWorker = undefined
  verifyWorkerRestartScheduled = false
  verifyWorkerTimeoutMs = DEFAULT_VERIFY_WORKER_TIMEOUT_MS
  for (const reqId of [...pendingVerify.keys()]) {
    clearPendingVerifyBatch(reqId)?.reject(abortError())
  }
  clearVerifiedPublicEvents()
  pendingVerifyChars = 0
  admitted = new WeakSet()
}

function getVerifyWorker(): Worker | null {
  if (verifyWorker !== undefined) return verifyWorker
  try {
    if (typeof Worker === "undefined") {
      verifyWorker = null
      return null
    }
    const worker = new Worker(new URL("./verify-worker.ts", import.meta.url), {
      type: "module",
    })
    worker.onmessage = (
      event: MessageEvent<{ reqId: number; valid: boolean[] }>
    ) => {
      if (verifyWorker !== worker) return
      const data = event.data
      const pending = data && pendingVerify.get(data.reqId)
      if (!pending) return
      const expected = Math.max(-1, ...(pending.workerIndexes ?? [])) + 1
      if (
        !pending.posted ||
        !Array.isArray(data.valid) ||
        data.valid.length !== expected ||
        data.valid.some((value) => typeof value !== "boolean")
      ) {
        failVerifyWorker(worker)
        return
      }
      resolvePendingVerifyBatch(event.data.reqId, event.data.valid)
    }
    worker.onerror = () => {
      failVerifyWorker(worker)
    }
    verifyWorker = worker
  } catch {
    verifyWorker = null
  }
  return verifyWorker
}

function verifySchnorrBatch(
  items: SchnorrItem[],
  signal?: AbortSignal
): Promise<boolean[]> {
  throwIfAborted(signal)
  if (items.length === 0) return Promise.resolve([])
  const worker = getVerifyWorker()
  if (!worker) {
    // SSR/test runtimes retain verification. Browser unavailability must never
    // shift catalog crypto onto its UI thread.
    if (typeof window === "undefined")
      return verifySchnorrChunked(items, signal)
    return Promise.reject(
      new Error("Signature verification worker is unavailable.")
    )
  }
  const immutableItems = items
  const chars = immutableItems.reduce(
    (sum, event) => sum + signedPublicEventChars(event),
    0
  )
  if (
    pendingVerify.size >= MAX_PENDING_VERIFY_WORKER_BATCHES ||
    pendingVerifyChars + chars > MAX_PENDING_VERIFY_CHARS
  ) {
    return Promise.reject(new Error("Signature verification queue is full."))
  }
  return new Promise((resolve, reject) => {
    const reqId = ++verifyReqId
    const pending: PendingVerifyBatch = {
      items: immutableItems,
      resolve,
      reject,
      signal,
      posted: false,
      retries: 0,
      chars,
    }
    if (signal) {
      pending.onAbort = () => cancelPendingVerifyBatch(reqId)
      signal.addEventListener("abort", pending.onAbort, { once: true })
    }
    pendingVerify.set(reqId, pending)
    pendingVerifyChars += chars
    pumpVerifyQueue()
  })
}

export type PublicEventAdmission =
  | { status: "verified"; event: VerifiedNostrEvent }
  | { status: "invalid" }
  | { status: "unavailable" }
  | { status: "cancelled" }

/** Admit raw wire/storage data. Only this owner can mint a trusted snapshot. */
export async function admitPublicEvent(
  raw: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<PublicEventAdmission> {
  if (options.signal?.aborted) return { status: "cancelled" }
  if (isVerifiedNostrEvent(raw)) return { status: "verified", event: raw }
  let snapshot: SignedPublicNostrEvent
  try {
    if (!raw || typeof raw !== "object") return { status: "invalid" }
    // Copy first: getters/mutation cannot change bytes after shape validation.
    snapshot = snapshotSignedPublicEvent(raw as SignedPublicNostrEvent)
    if (!isCanonicalSignedPublicNostrEvent(snapshot))
      return { status: "invalid" }
  } catch {
    return { status: "invalid" }
  }
  if (signedPublicEventChars(snapshot) > MAX_PENDING_VERIFY_CHARS)
    return { status: "unavailable" }
  try {
    const valid =
      hasVerifiedPublicEvent(snapshot) ||
      (await verifySchnorrBatch([snapshot], options.signal))[0]
    if (options.signal?.aborted) return { status: "cancelled" }
    return valid
      ? { status: "verified", event: mint(snapshot) }
      : { status: "invalid" }
  } catch {
    return { status: options.signal?.aborted ? "cancelled" : "unavailable" }
  }
}

export class PublicEventVerificationUnavailableError extends Error {
  constructor(
    readonly events: VerifiedNostrEvent[],
    cause: unknown
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : "Public event verification unavailable",
      { cause }
    )
    this.name = "PublicEventVerificationUnavailableError"
  }
}

export interface VerifySignedPublicNostrEventsOptions {
  signal?: AbortSignal
  maxEvents?: number
}
export interface VerifySignedPublicNostrEventsResult {
  events: VerifiedNostrEvent[]
  truncated: boolean
}
export async function verifySignedEvents(
  events: readonly unknown[],
  options: VerifySignedPublicNostrEventsOptions = {}
): Promise<VerifySignedPublicNostrEventsResult> {
  throwIfAborted(options.signal)
  const requested = Math.floor(options.maxEvents ?? 512)
  const max = Number.isFinite(requested)
    ? Math.max(0, Math.min(512, requested))
    : 0
  // Snapshot every input before the first await, and batch worker messaging.
  const snapshots = events.slice(0, max).map((raw) => {
    if (isVerifiedNostrEvent(raw)) return raw
    try {
      const snapshot = snapshotSignedPublicEvent(raw as SignedPublicNostrEvent)
      return isCanonicalSignedPublicNostrEvent(snapshot) ? snapshot : null
    } catch {
      return null
    }
  })
  const candidates = snapshots.filter(
    (event): event is NonNullable<typeof event> => event !== null
  )
  const work = candidates.filter(
    (event) => !isVerifiedNostrEvent(event) && !hasVerifiedPublicEvent(event)
  ) as SignedPublicNostrEvent[]
  let valid: boolean[]
  try {
    valid = await verifySchnorrBatch(work, options.signal)
  } catch (error) {
    throwIfAborted(options.signal)
    throw new PublicEventVerificationUnavailableError(
      candidates.flatMap((event) =>
        isVerifiedNostrEvent(event)
          ? [event]
          : hasVerifiedPublicEvent(event)
            ? [mint(event)]
            : []
      ),
      error
    )
  }
  throwIfAborted(options.signal)
  const verdicts = new Map(work.map((event, index) => [event, valid[index]]))
  return {
    events: candidates.flatMap((event) => {
      if (isVerifiedNostrEvent(event)) return [event]
      if (hasVerifiedPublicEvent(event)) return [mint(event)]
      return verdicts.get(event) ? [mint(event)] : []
    }),
    truncated: events.length > max,
  }
}
