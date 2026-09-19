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
  type MediaServerPreferenceResolution,
} from "../protocol/media-server-preferences"
import {
  getProductImageUploadErrorMessage,
  prepareProductImageFile,
  readLocalProductImageServerUrls,
  resolveProductImageUploadTarget,
  uploadPreparedProductImage,
  ProductImageUploadError,
  type PreparedProductImage,
  type ProductImageUploadPhase,
  type ProductImageUploadTarget,
  type VerifiedProductImageUpload,
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
  isFallbackClaimed: (scopeId: string) => boolean
  releaseFallbackClaim: (scopeId: string, itemId: string) => boolean
  clearFallbackClaim: (scopeId: string) => void
  moveFallbackClaim: (fromScopeId: string, toScopeId: string) => void
  uploadFile: (
    request: ProductImageUploadRequest
  ) => Promise<VerifiedProductImageUpload>
}

const PRODUCT_IMAGE_UPLOAD_AUTHORITY_QUERY_KEY =
  "product-image-upload-authority"
const PRODUCT_IMAGE_FALLBACK_CLAIM_PREFIX =
  "conduit:merchant:product_image_fallback:v1"

interface ProductImageUploadAuthoritySnapshot {
  generation: number
  owner: string | null
  signer: NDKSigner | null
  method: AuthMethod | null
  isGenerationCurrent: (generation: number) => boolean
}

interface FallbackUploadClaim {
  itemId: string
  consumed: boolean
}

function fallbackClaimMemoryKey(owner: string, scopeId: string): string {
  return `${owner}:${scopeId}`
}

function fallbackClaimStorageKey(owner: string, scopeId: string): string {
  return `${PRODUCT_IMAGE_FALLBACK_CLAIM_PREFIX}:${encodeURIComponent(owner)}:${encodeURIComponent(scopeId)}`
}

function hasStoredFallbackClaim(owner: string, scopeId: string): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(fallbackClaimStorageKey(owner, scopeId)) === "1"
    )
  } catch {
    return false
  }
}

function storeFallbackClaim(owner: string, scopeId: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(fallbackClaimStorageKey(owner, scopeId), "1")
    }
  } catch {
    // The in-memory claim remains authoritative for this editor lifecycle.
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
    queryFn: () => {
      const generation = auth.authGeneration
      return readMediaServerPreferences(owner!, {
        authenticatedPubkey: owner,
        shouldContinue: () =>
          authGenerationRef.current === generation &&
          auth.isAuthGenerationCurrent(generation),
      })
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  resolutionRef.current = query.data ?? null

  const localServerUrls = useMemo(
    () => (owner ? readLocalProductImageServerUrls(owner) : []),
    [lookupRevision, owner]
  )
  const target = resolveProductImageUploadTarget({
    owner,
    resolution: query.data,
    localServerUrls,
    signerAvailable,
  })
  const performUploadFile = useCallback(
    async (
      request: ProductImageUploadRequest,
      authority: ProductImageUploadAuthoritySnapshot
    ): Promise<VerifiedProductImageUpload> => {
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
        localServerUrls: readLocalProductImageServerUrls(activeOwner),
        signerAvailable: true,
      })
      if (!sameTarget(request.target, latestTarget)) {
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
      if (fallbackUpload) {
        const claimKey = fallbackClaimMemoryKey(activeOwner, request.scopeId)
        const claim = fallbackClaimsRef.current.get(claimKey)
        if (
          (claim && claim.itemId !== request.itemId) ||
          (!claim && hasStoredFallbackClaim(activeOwner, request.scopeId))
        ) {
          throw new ProductImageUploadError(
            "fallback_limit_reached",
            getProductImageUploadErrorMessage("fallback_limit_reached")
          )
        }
        fallbackClaimsRef.current.set(claimKey, {
          itemId: request.itemId,
          consumed: claim?.consumed ?? false,
        })
      }

      const result = await uploadPreparedProductImage({
        prepared,
        target: request.target,
        expectedPubkey: activeOwner,
        signer: createNdkNostrEventSigner(
          activeSigner,
          activeOwner,
          activeMethod
        ),
        shouldContinue: () =>
          authGenerationRef.current === generation &&
          isGenerationCurrent(generation),
        signal: request.signal,
        onPhase: (phase) => {
          if (fallbackUpload && phase === "uploading") {
            fallbackClaimsRef.current.set(
              fallbackClaimMemoryKey(activeOwner, request.scopeId),
              { itemId: request.itemId, consumed: true }
            )
            storeFallbackClaim(activeOwner, request.scopeId)
            setFallbackClaimRevision((revision) => revision + 1)
          }
          request.onPhase?.(phase)
        },
      })
      if (fallbackUpload) {
        fallbackClaimsRef.current.set(
          fallbackClaimMemoryKey(activeOwner, request.scopeId),
          { itemId: request.itemId, consumed: true }
        )
        storeFallbackClaim(activeOwner, request.scopeId)
        setFallbackClaimRevision((revision) => revision + 1)
      }
      return result
    },
    []
  )

  const uploadFile = useCallback(
    (
      request: ProductImageUploadRequest
    ): Promise<VerifiedProductImageUpload> => {
      const authority: ProductImageUploadAuthoritySnapshot = {
        generation: auth.authGeneration,
        owner,
        signer: auth.signer,
        method: auth.method,
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

  const isFallbackClaimed = useCallback(
    (scopeId: string): boolean =>
      !!owner &&
      (fallbackClaimsRef.current.has(fallbackClaimMemoryKey(owner, scopeId)) ||
        hasStoredFallbackClaim(owner, scopeId)),
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
      if (!owner || hasStoredFallbackClaim(owner, scopeId)) return false
      const claimKey = fallbackClaimMemoryKey(owner, scopeId)
      const claim = fallbackClaimsRef.current.get(claimKey)
      if (claim && (claim.itemId !== itemId || claim.consumed)) return false
      if (claim) fallbackClaimsRef.current.delete(claimKey)
      setFallbackClaimRevision((revision) => revision + 1)
      return true
    },
    [owner]
  )

  const moveFallbackClaim = useCallback(
    (fromScopeId: string, toScopeId: string): void => {
      if (!owner || fromScopeId === toScopeId) return
      const fromClaimKey = fallbackClaimMemoryKey(owner, fromScopeId)
      const toClaimKey = fallbackClaimMemoryKey(owner, toScopeId)
      const claim = fallbackClaimsRef.current.get(fromClaimKey)
      const stored = hasStoredFallbackClaim(owner, fromScopeId)
      if (!stored && !claim?.consumed) return
      fallbackClaimsRef.current.delete(fromClaimKey)
      if (claim?.consumed || stored) {
        fallbackClaimsRef.current.set(
          toClaimKey,
          claim?.consumed ? claim : { itemId: "persisted", consumed: true }
        )
      }
      removeStoredFallbackClaim(owner, fromScopeId)
      storeFallbackClaim(owner, toScopeId)
      setFallbackClaimRevision((revision) => revision + 1)
    },
    [owner]
  )

  return useMemo(
    () => ({
      target,
      isBusy: activeUploadCount > 0,
      isFallbackClaimed,
      releaseFallbackClaim,
      clearFallbackClaim,
      moveFallbackClaim,
      uploadFile,
    }),
    [
      activeUploadCount,
      clearFallbackClaim,
      isFallbackClaimed,
      moveFallbackClaim,
      releaseFallbackClaim,
      target,
      uploadFile,
    ]
  )
}
