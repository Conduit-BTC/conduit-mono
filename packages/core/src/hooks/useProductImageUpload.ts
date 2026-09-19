import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { useQuery } from "@tanstack/react-query"
import { useAuth, type AuthMethod } from "../context/AuthContext"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import {
  readMediaServerPreferences,
  toReviewedMediaServerEvidence,
  type MediaServerPreferenceResolution,
} from "../protocol/media-server-preferences"
import {
  getProductImageUploadErrorMessage,
  prepareProductImageFile,
  readLocalProductImageServerDraft,
  resolveProductImageUploadTarget,
  uploadPreparedProductImage,
  ProductImageUploadError,
  type PreparedProductImage,
  type ProductImageUploadPhase,
  type ProductImageUploadTarget,
} from "../protocol/product-image-upload"
import { subscribeRelaySettingsChanges } from "../protocol/relay-settings"

export interface ProductImageUploadRequest {
  scopeId: string
  itemId: string
  file: File
  target: Extract<ProductImageUploadTarget, { kind: "configured" | "fallback" }>
  signal?: AbortSignal
  onPhase?: (phase: ProductImageUploadPhase) => void
  onPrepared?: (prepared: PreparedProductImage) => void
}

export interface ProductImageUploadController {
  target: ProductImageUploadTarget
  isBusy: boolean
  getFallbackClaimState: (scopeId: string) => ProductImageFallbackClaimState
  releaseFallbackClaim: (scopeId: string, itemId: string) => boolean
  clearFallbackClaim: (scopeId: string) => void
  prepareFallbackClaimMove: (fromScopeId: string, toScopeId: string) => boolean
  commitFallbackClaimMove: (fromScopeId: string, toScopeId: string) => void
  cancelFallbackClaimMove: (fromScopeId: string, toScopeId: string) => void
  uploadFile: (request: ProductImageUploadRequest) => Promise<string>
}

export type ProductImageFallbackClaimState =
  "available" | "retry_same_hash" | "consumed"

const PRODUCT_IMAGE_UPLOAD_AUTHORITY_QUERY_KEY =
  "product-image-upload-authority"
const PRODUCT_IMAGE_FALLBACK_CLAIM_PREFIX =
  "conduit:merchant:product_image_fallback:v1"

interface ProductImageUploadAuthoritySnapshot {
  generation: number
  owner: string | null
  signer: NDKSigner | null
  method: AuthMethod | null
  reviewedMediaServerEvidenceKey: string | null
  isGenerationCurrent: (generation: number) => boolean
}

interface FallbackUploadClaim {
  itemId: string
  state: "reserved" | "retry_same_hash" | "consumed"
  sha256: string | null
}

interface PreparedFallbackClaimMove {
  claim: StoredFallbackUploadClaim
  destinationCreated: boolean
}

type StoredFallbackUploadClaim =
  | {
      version: 1
      state: "retry_same_hash"
      sha256: string
    }
  | {
      version: 1
      state: "consumed"
    }

const HEX_SHA256 = /^[0-9a-f]{64}$/

function parseStoredFallbackClaim(
  raw: string | null
): StoredFallbackUploadClaim | null {
  if (raw === "1") return { version: 1, state: "consumed" }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as {
      version?: unknown
      state?: unknown
      sha256?: unknown
    }
    if (value.version !== 1) return { version: 1, state: "consumed" }
    if (value.state === "consumed") {
      return { version: 1, state: "consumed" }
    }
    if (
      value.state === "retry_same_hash" &&
      typeof value.sha256 === "string" &&
      HEX_SHA256.test(value.sha256)
    ) {
      return {
        version: 1,
        state: "retry_same_hash",
        sha256: value.sha256,
      }
    }
  } catch {
    return { version: 1, state: "consumed" }
  }
  return { version: 1, state: "consumed" }
}

function fallbackClaimMemoryKey(owner: string, scopeId: string): string {
  return `${owner}:${scopeId}`
}

function fallbackClaimStorageKey(owner: string, scopeId: string): string {
  return `${PRODUCT_IMAGE_FALLBACK_CLAIM_PREFIX}:${encodeURIComponent(owner)}:${encodeURIComponent(scopeId)}`
}

function fallbackClaimMoveKey(
  owner: string,
  fromScopeId: string,
  toScopeId: string
): string {
  return `${owner}:${fromScopeId}:${toScopeId}`
}

function readStoredFallbackClaim(
  owner: string,
  scopeId: string
): StoredFallbackUploadClaim | null {
  try {
    if (typeof localStorage === "undefined") return null
    return parseStoredFallbackClaim(
      localStorage.getItem(fallbackClaimStorageKey(owner, scopeId))
    )
  } catch {
    return null
  }
}

function sameStoredFallbackClaim(
  left: StoredFallbackUploadClaim | null,
  right: StoredFallbackUploadClaim
): boolean {
  if (!left || left.state !== right.state) return false
  if (left.state === "consumed" && right.state === "consumed") return true
  return (
    left.state === "retry_same_hash" &&
    right.state === "retry_same_hash" &&
    left.sha256 === right.sha256
  )
}

function storeFallbackClaim(
  owner: string,
  scopeId: string,
  claim: StoredFallbackUploadClaim
): boolean {
  try {
    if (typeof localStorage === "undefined") return false
    if (
      sameStoredFallbackClaim(readStoredFallbackClaim(owner, scopeId), claim)
    ) {
      return true
    }
    localStorage.setItem(
      fallbackClaimStorageKey(owner, scopeId),
      JSON.stringify(claim)
    )
    return sameStoredFallbackClaim(
      readStoredFallbackClaim(owner, scopeId),
      claim
    )
  } catch {
    return false
  }
}

function removeStoredFallbackClaim(owner: string, scopeId: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(fallbackClaimStorageKey(owner, scopeId))
    }
  } catch {
    // The in-memory claim can still be cleared for this editor lifecycle.
  }
}

function sameTarget(
  left: ProductImageUploadTarget,
  right: ProductImageUploadTarget
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "configured" && right.kind === "configured") {
    return left.serverUrl === right.serverUrl
  }
  if (left.kind === "fallback" && right.kind === "fallback") return true
  if (left.kind === "pending" && right.kind === "pending") {
    return left.reason === right.reason
  }
  if (left.kind === "unavailable" && right.kind === "unavailable") {
    return left.reason === right.reason
  }
  return false
}

function reviewedMediaServerEvidenceKey(
  resolution: MediaServerPreferenceResolution | null
): string | null {
  if (!resolution) return null
  const reviewed = toReviewedMediaServerEvidence(resolution)
  return `${reviewed.frontierEventId ?? "none"}:${reviewed.publishedEventId ?? "none"}`
}

export function useProductImageUpload(): ProductImageUploadController {
  const auth = useAuth()
  const owner =
    auth.status === "connected"
      ? (auth.pubkey?.trim().toLowerCase() ?? null)
      : null
  const signerAvailable =
    auth.status === "connected" && !!auth.signer && !!auth.method && !!owner
  const authGenerationRef = useRef(auth.authGeneration)
  const resolutionRef = useRef<MediaServerPreferenceResolution | null>(null)
  const fallbackClaimsRef = useRef(new Map<string, FallbackUploadClaim>())
  const preparedFallbackMovesRef = useRef(
    new Map<string, PreparedFallbackClaimMove>()
  )
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [lookupRevision, setLookupRevision] = useState(0)
  const [, setFallbackClaimRevision] = useState(0)
  const [activeUploadCount, setActiveUploadCount] = useState(0)

  useLayoutEffect(() => {
    authGenerationRef.current = auth.authGeneration
  }, [auth.authGeneration])

  useEffect(() => {
    if (!owner) return
    return subscribeRelaySettingsChanges(() => {
      setLookupRevision((revision) => revision + 1)
    })
  }, [owner])

  const query = useQuery({
    queryKey: [
      PRODUCT_IMAGE_UPLOAD_AUTHORITY_QUERY_KEY,
      owner ?? "none",
      auth.authGeneration,
      lookupRevision,
    ],
    enabled: !!owner,
    queryFn: async () => {
      const generation = auth.authGeneration
      const resolution = await readMediaServerPreferences(owner!, {
        authenticatedPubkey: owner,
        shouldContinue: () =>
          authGenerationRef.current === generation &&
          auth.isAuthGenerationCurrent(generation),
      })
      if (
        authGenerationRef.current === generation &&
        auth.isAuthGenerationCurrent(generation)
      ) {
        resolutionRef.current = resolution
      }
      return resolution
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  useLayoutEffect(() => {
    resolutionRef.current = query.data ?? null
  }, [query.data])

  const localDraft = useMemo(
    () => (owner ? readLocalProductImageServerDraft(owner) : null),
    [lookupRevision, owner]
  )
  const target = resolveProductImageUploadTarget({
    owner,
    resolution: query.data,
    localDraft,
    signerAvailable,
  })
  const performUploadFile = useCallback(
    async (
      request: ProductImageUploadRequest,
      authority: ProductImageUploadAuthoritySnapshot
    ): Promise<string> => {
      const {
        generation,
        owner: activeOwner,
        signer: activeSigner,
        method: activeMethod,
        isGenerationCurrent,
      } = authority
      if (!activeOwner || !activeSigner || !activeMethod) {
        throw new ProductImageUploadError(
          "target_unavailable",
          getProductImageUploadErrorMessage("target_unavailable")
        )
      }
      if (request.signal?.aborted) {
        throw new ProductImageUploadError(
          "cancelled",
          getProductImageUploadErrorMessage("cancelled")
        )
      }
      if (
        authGenerationRef.current !== generation ||
        !isGenerationCurrent(generation)
      ) {
        throw new ProductImageUploadError(
          "authority_changed",
          getProductImageUploadErrorMessage("authority_changed")
        )
      }

      request.onPhase?.("preparing")
      const prepared = await prepareProductImageFile(request.file, {
        signal: request.signal,
      })
      request.onPrepared?.(prepared)

      const latestTarget = resolveProductImageUploadTarget({
        owner: activeOwner,
        resolution: resolutionRef.current,
        localDraft: readLocalProductImageServerDraft(activeOwner),
        signerAvailable: true,
      })
      if (
        !sameTarget(request.target, latestTarget) ||
        reviewedMediaServerEvidenceKey(resolutionRef.current) !==
          authority.reviewedMediaServerEvidenceKey
      ) {
        throw new ProductImageUploadError(
          "target_unavailable",
          getProductImageUploadErrorMessage("target_unavailable")
        )
      }
      if (request.signal?.aborted) {
        throw new ProductImageUploadError(
          "cancelled",
          getProductImageUploadErrorMessage("cancelled")
        )
      }
      if (
        authGenerationRef.current !== generation ||
        !isGenerationCurrent(generation)
      ) {
        throw new ProductImageUploadError(
          "authority_changed",
          getProductImageUploadErrorMessage("authority_changed")
        )
      }
      const fallbackUpload = request.target.kind === "fallback"
      const fallbackClaimKey = fallbackUpload
        ? fallbackClaimMemoryKey(activeOwner, request.scopeId)
        : null
      if (fallbackUpload) {
        const claim = fallbackClaimsRef.current.get(fallbackClaimKey!)
        const storedClaim = readStoredFallbackClaim(
          activeOwner,
          request.scopeId
        )
        if (claim && claim.itemId !== request.itemId) {
          throw new ProductImageUploadError(
            "fallback_limit_reached",
            getProductImageUploadErrorMessage("fallback_limit_reached")
          )
        }
        if (storedClaim?.state === "consumed" || claim?.state === "consumed") {
          throw new ProductImageUploadError(
            "fallback_limit_reached",
            getProductImageUploadErrorMessage("fallback_limit_reached")
          )
        }
        const retrySha256 =
          storedClaim?.state === "retry_same_hash"
            ? storedClaim.sha256
            : claim?.state === "retry_same_hash"
              ? claim.sha256
              : null
        if (retrySha256 && retrySha256 !== prepared.sha256) {
          throw new ProductImageUploadError(
            "fallback_retry_mismatch",
            getProductImageUploadErrorMessage("fallback_retry_mismatch")
          )
        }
        fallbackClaimsRef.current.set(fallbackClaimKey!, {
          itemId: request.itemId,
          state: retrySha256 ? "retry_same_hash" : "reserved",
          sha256: prepared.sha256,
        })
      }

      let result: string
      try {
        const uploadAuthorityIsCurrent = (): boolean => {
          if (
            authGenerationRef.current !== generation ||
            !isGenerationCurrent(generation)
          ) {
            return false
          }
          const currentResolution = resolutionRef.current
          const currentTarget = resolveProductImageUploadTarget({
            owner: activeOwner,
            resolution: currentResolution,
            localDraft: readLocalProductImageServerDraft(activeOwner),
            signerAvailable: true,
          })
          return (
            sameTarget(request.target, currentTarget) &&
            reviewedMediaServerEvidenceKey(currentResolution) ===
              authority.reviewedMediaServerEvidenceKey
          )
        }
        result = await uploadPreparedProductImage({
          prepared,
          target: request.target,
          expectedPubkey: activeOwner,
          signer: createNdkNostrEventSigner(
            activeSigner,
            activeOwner,
            activeMethod
          ),
          shouldContinue: uploadAuthorityIsCurrent,
          signal: request.signal,
          onPhase: (phase) => {
            if (fallbackUpload && phase === "uploading") {
              const retryClaim: StoredFallbackUploadClaim = {
                version: 1,
                state: "retry_same_hash",
                sha256: prepared.sha256,
              }
              if (
                !storeFallbackClaim(activeOwner, request.scopeId, retryClaim)
              ) {
                throw new ProductImageUploadError(
                  "fallback_guard_unavailable",
                  getProductImageUploadErrorMessage(
                    "fallback_guard_unavailable"
                  )
                )
              }
              fallbackClaimsRef.current.set(fallbackClaimKey!, {
                itemId: request.itemId,
                state: "retry_same_hash",
                sha256: prepared.sha256,
              })
              setFallbackClaimRevision((revision) => revision + 1)
            }
            request.onPhase?.(phase)
          },
        })
      } catch (error) {
        if (
          fallbackUpload &&
          error instanceof ProductImageUploadError &&
          error.uploadOutcome === "definitive_rejection"
        ) {
          fallbackClaimsRef.current.delete(fallbackClaimKey!)
          removeStoredFallbackClaim(activeOwner, request.scopeId)
          setFallbackClaimRevision((revision) => revision + 1)
        }
        throw error
      }
      if (fallbackUpload) {
        fallbackClaimsRef.current.set(fallbackClaimKey!, {
          itemId: request.itemId,
          state: "consumed",
          sha256: prepared.sha256,
        })
        storeFallbackClaim(activeOwner, request.scopeId, {
          version: 1,
          state: "consumed",
        })
        setFallbackClaimRevision((revision) => revision + 1)
      }
      return result
    },
    []
  )

  const uploadFile = useCallback(
    (request: ProductImageUploadRequest): Promise<string> => {
      const authority: ProductImageUploadAuthoritySnapshot = {
        generation: auth.authGeneration,
        owner,
        signer: auth.signer,
        method: auth.method,
        reviewedMediaServerEvidenceKey: reviewedMediaServerEvidenceKey(
          resolutionRef.current
        ),
        isGenerationCurrent: auth.isAuthGenerationCurrent,
      }
      setActiveUploadCount((count) => count + 1)
      const result = uploadQueueRef.current.then(() =>
        performUploadFile(request, authority)
      )
      uploadQueueRef.current = result.then(
        () => undefined,
        () => undefined
      )
      return result.finally(() => {
        setActiveUploadCount((count) => Math.max(0, count - 1))
      })
    },
    [
      auth.authGeneration,
      auth.isAuthGenerationCurrent,
      auth.method,
      auth.signer,
      owner,
      performUploadFile,
    ]
  )

  const getFallbackClaimState = useCallback(
    (scopeId: string): ProductImageFallbackClaimState => {
      if (!owner) return "available"
      const claim = fallbackClaimsRef.current.get(
        fallbackClaimMemoryKey(owner, scopeId)
      )
      const storedClaim = readStoredFallbackClaim(owner, scopeId)
      if (claim?.state === "consumed" || storedClaim?.state === "consumed") {
        return "consumed"
      }
      if (
        claim?.state === "retry_same_hash" ||
        storedClaim?.state === "retry_same_hash"
      ) {
        return "retry_same_hash"
      }
      return "available"
    },
    [owner]
  )

  const clearFallbackClaim = useCallback(
    (scopeId: string): void => {
      if (owner) {
        fallbackClaimsRef.current.delete(fallbackClaimMemoryKey(owner, scopeId))
      }
      if (owner) removeStoredFallbackClaim(owner, scopeId)
      setFallbackClaimRevision((revision) => revision + 1)
    },
    [owner]
  )

  const releaseFallbackClaim = useCallback(
    (scopeId: string, itemId: string): boolean => {
      if (!owner) return false
      const claimKey = fallbackClaimMemoryKey(owner, scopeId)
      const claim = fallbackClaimsRef.current.get(claimKey)
      const storedClaim = readStoredFallbackClaim(owner, scopeId)
      if (claim && claim.itemId !== itemId) return false
      if (claim?.state === "consumed" || storedClaim?.state === "consumed") {
        return false
      }
      if (claim) fallbackClaimsRef.current.delete(claimKey)
      setFallbackClaimRevision((revision) => revision + 1)
      return true
    },
    [owner]
  )

  const prepareFallbackClaimMove = useCallback(
    (fromScopeId: string, toScopeId: string): boolean => {
      if (!owner || fromScopeId === toScopeId) return false
      const fromClaimKey = fallbackClaimMemoryKey(owner, fromScopeId)
      const toClaimKey = fallbackClaimMemoryKey(owner, toScopeId)
      const moveKey = fallbackClaimMoveKey(owner, fromScopeId, toScopeId)
      if (preparedFallbackMovesRef.current.has(moveKey)) return true
      const claim = fallbackClaimsRef.current.get(fromClaimKey)
      const storedClaim = readStoredFallbackClaim(owner, fromScopeId)
      const durableClaim: StoredFallbackUploadClaim | null =
        claim?.state === "consumed" || storedClaim?.state === "consumed"
          ? { version: 1, state: "consumed" }
          : (storedClaim ??
            (claim?.state === "retry_same_hash" && claim.sha256
              ? {
                  version: 1,
                  state: "retry_same_hash",
                  sha256: claim.sha256,
                }
              : null))
      if (!durableClaim) return false
      const existingDestination = readStoredFallbackClaim(owner, toScopeId)
      if (
        existingDestination &&
        !sameStoredFallbackClaim(existingDestination, durableClaim)
      ) {
        throw new ProductImageUploadError(
          "fallback_guard_unavailable",
          getProductImageUploadErrorMessage("fallback_guard_unavailable")
        )
      }
      fallbackClaimsRef.current.set(toClaimKey, {
        itemId: claim?.itemId ?? "persisted",
        state: durableClaim.state,
        sha256:
          durableClaim.state === "retry_same_hash" ? durableClaim.sha256 : null,
      })
      const destinationCreated = !existingDestination
      if (!storeFallbackClaim(owner, toScopeId, durableClaim)) {
        fallbackClaimsRef.current.delete(toClaimKey)
        if (destinationCreated) removeStoredFallbackClaim(owner, toScopeId)
        setFallbackClaimRevision((revision) => revision + 1)
        throw new ProductImageUploadError(
          "fallback_guard_unavailable",
          getProductImageUploadErrorMessage("fallback_guard_unavailable")
        )
      }
      preparedFallbackMovesRef.current.set(moveKey, {
        claim: durableClaim,
        destinationCreated,
      })
      setFallbackClaimRevision((revision) => revision + 1)
      return true
    },
    [owner]
  )

  const commitFallbackClaimMove = useCallback(
    (fromScopeId: string, toScopeId: string): void => {
      if (!owner) return
      const moveKey = fallbackClaimMoveKey(owner, fromScopeId, toScopeId)
      if (!preparedFallbackMovesRef.current.delete(moveKey)) return
      fallbackClaimsRef.current.delete(
        fallbackClaimMemoryKey(owner, fromScopeId)
      )
      removeStoredFallbackClaim(owner, fromScopeId)
      setFallbackClaimRevision((revision) => revision + 1)
    },
    [owner]
  )

  const cancelFallbackClaimMove = useCallback(
    (fromScopeId: string, toScopeId: string): void => {
      if (!owner) return
      const moveKey = fallbackClaimMoveKey(owner, fromScopeId, toScopeId)
      const prepared = preparedFallbackMovesRef.current.get(moveKey)
      if (!prepared) return
      preparedFallbackMovesRef.current.delete(moveKey)
      fallbackClaimsRef.current.delete(fallbackClaimMemoryKey(owner, toScopeId))
      if (
        prepared.destinationCreated &&
        sameStoredFallbackClaim(
          readStoredFallbackClaim(owner, toScopeId),
          prepared.claim
        )
      ) {
        removeStoredFallbackClaim(owner, toScopeId)
      }
      setFallbackClaimRevision((revision) => revision + 1)
    },
    [owner]
  )

  return useMemo(
    () => ({
      target,
      isBusy: activeUploadCount > 0,
      getFallbackClaimState,
      releaseFallbackClaim,
      clearFallbackClaim,
      prepareFallbackClaimMove,
      commitFallbackClaimMove,
      cancelFallbackClaimMove,
      uploadFile,
    }),
    [
      activeUploadCount,
      cancelFallbackClaimMove,
      clearFallbackClaim,
      commitFallbackClaimMove,
      getFallbackClaimState,
      prepareFallbackClaimMove,
      releaseFallbackClaim,
      target,
      uploadFile,
    ]
  )
}
