import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useQuery } from "@tanstack/react-query"
import type { AccountSigner } from "../protocol/nostr-event-signer"
import { useAuth, type AuthMethod } from "../context/AuthContext"
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
  uploadPreparedProductImageCopies,
  type ProductImageUploadResult,
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
  prepared?: PreparedProductImage
  previousResult?: ProductImageUploadResult
  onVerified?: (result: ProductImageUploadResult) => void
  target: Extract<ProductImageUploadTarget, { kind: "configured" | "fallback" }>
  signal?: AbortSignal
  onPhase?: (phase: ProductImageUploadPhase) => void
  onPrepared?: (prepared: PreparedProductImage) => void
}

export interface ProductImageUploadController {
  target: ProductImageUploadTarget
  isBusy: boolean
  uploadFile: (
    request: ProductImageUploadRequest
  ) => Promise<ProductImageUploadResult>
}

const PRODUCT_IMAGE_UPLOAD_AUTHORITY_QUERY_KEY =
  "product-image-upload-authority"
interface ProductImageUploadAuthoritySnapshot {
  generation: number
  owner: string | null
  signer: AccountSigner | null
  method: AuthMethod | null
  reviewedMediaServerEvidenceKey: string | null
  isGenerationCurrent: (generation: number) => boolean
}

function sameTarget(
  left: ProductImageUploadTarget,
  right: ProductImageUploadTarget
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "configured" && right.kind === "configured") {
    return (
      left.serverUrl === right.serverUrl &&
      (left.backupServerUrls ?? []).join("|") ===
        (right.backupServerUrls ?? []).join("|")
    )
  }
  if (left.kind === "fallback" && right.kind === "fallback") {
    return (
      left.serverUrl === right.serverUrl &&
      (left.backupServerUrls ?? []).join("|") ===
        (right.backupServerUrls ?? []).join("|")
    )
  }
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
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [lookupRevision, setLookupRevision] = useState(0)
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
    ): Promise<ProductImageUploadResult> => {
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
      const prepared =
        request.prepared ??
        (await prepareProductImageFile(request.file, {
          signal: request.signal,
        }))
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
      const uploadAuthorityIsCurrent = (): boolean => {
        if (
          authGenerationRef.current !== generation ||
          !isGenerationCurrent(generation)
        )
          return false
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
      return uploadPreparedProductImageCopies({
        prepared,
        target: request.target,
        expectedPubkey: activeOwner,
        signer: activeSigner,
        shouldContinue: uploadAuthorityIsCurrent,
        signal: request.signal,
        previousResult: request.previousResult,
        onVerified: request.onVerified,
        onPhase: request.onPhase,
      })
    },
    []
  )

  const uploadFile = useCallback(
    (request: ProductImageUploadRequest): Promise<ProductImageUploadResult> => {
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

  return useMemo(
    () => ({ target, isBusy: activeUploadCount > 0, uploadFile }),
    [activeUploadCount, target, uploadFile]
  )
}
