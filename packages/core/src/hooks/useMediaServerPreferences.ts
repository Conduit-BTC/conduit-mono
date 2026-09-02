import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { useQuery } from "@tanstack/react-query"
import {
  addMediaServerPreference,
  loadMediaServerDraft,
  loadMediaServerPreferenceRecord,
  moveMediaServerPreference,
  parseBlossomServerListTags,
  publishMediaServerPreferences,
  readMediaServerPreferences,
  removeMediaServerPreference,
  retryMediaServerPreferencesPublish,
  sameOrderedMediaServerList,
  saveMediaServerDraft,
  toReviewedMediaServerEvidence,
  type MediaServerLookupCoverage,
  type MediaServerPreferenceResolution,
  type MediaServerPreferenceStatus,
  type MediaServerPublishOutcome,
  type MediaServerPublishResult,
} from "../protocol/media-server-preferences"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import { NostrSignerError } from "../protocol/nostr-event-signer"
import { subscribeRelaySettingsChanges } from "../protocol/relay-settings"

const MEDIA_SERVER_PREFERENCES_QUERY_KEY = "media-server-preferences"

export type MediaServerPreferenceViewStatus =
  "loading" | MediaServerPreferenceStatus

export type MediaServerPublishPhase =
  | "idle"
  | "checking"
  | "awaiting_signature"
  | "publishing"
  | "confirming"
  | "confirmed"
  | "partial"
  | "confirmation_pending"
  | "cancelled"
  | "error"

export interface MediaServerPreferencesView {
  status: MediaServerPreferenceViewStatus
  coverage: MediaServerLookupCoverage
  localServerUrls: string[]
  publishedServerUrls: string[]
  dirty: boolean
  stale: boolean
  retained: boolean
  sourceRelayCount: number
  publishedCreatedAt: number | null
  observedAt: number | null
  completeObservedAt: number | null
  lookupError: string | null
  isLoading: boolean
  isRefetching: boolean
  canPublish: boolean
  publishDisabledReason: string | null
  publishPhase: MediaServerPublishPhase
  publishMessage: string | null
  publishOutcome: MediaServerPublishOutcome | null
  acceptedRelayCount: number
  rejectedRelayCount: number
  timedOutRelayCount: number
  targetRelayCount: number
  retryAvailable: boolean
  pendingSignedListDiffers: boolean
}

export interface UseMediaServerPreferencesOptions {
  enabled?: boolean
  signer?: NDKSigner | null
  authMethod?: "nip07" | "nip46" | null
  authGeneration?: number
  relayScope?: string | null
}

export interface MediaServerDraftActionResult {
  ok: boolean
  error?: string
}

export interface UseMediaServerPreferencesResult {
  view: MediaServerPreferencesView
  addServer: (url: string) => MediaServerDraftActionResult
  removeServer: (url: string) => void
  moveServer: (fromIndex: number, toIndex: number) => void
  publish: () => Promise<void>
  retryPublish: () => Promise<void>
  refetch: () => void
}

interface DraftState {
  owner: string | null
  serverUrls: string[]
  baseServerUrls: string[]
  baseEventId: string | null
}

interface PublishState {
  owner: string | null
  phase: MediaServerPublishPhase
  message: string | null
  result: MediaServerPublishResult | null
}

const ACTIVE_PUBLISH_PHASES: readonly MediaServerPublishPhase[] = [
  "checking",
  "awaiting_signature",
  "publishing",
  "confirming",
]

function isPublishBusy(phase: MediaServerPublishPhase): boolean {
  return ACTIVE_PUBLISH_PHASES.includes(phase)
}

function emptyDraft(owner: string | null): DraftState {
  return {
    owner,
    serverUrls: [],
    baseServerUrls: [],
    baseEventId: null,
  }
}

function emptyPublishState(owner: string | null): PublishState {
  return { owner, phase: "idle", message: null, result: null }
}

function loadDraftState(owner: string | null): DraftState {
  if (!owner) return emptyDraft(null)
  const stored = loadMediaServerDraft(owner)
  return stored ? { owner, ...stored } : emptyDraft(owner)
}

function safePublishError(error: unknown): {
  phase: "cancelled" | "error"
  message: string
} {
  if (error instanceof NostrSignerError) {
    switch (error.code) {
      case "authorization_denied":
        return {
          phase: "cancelled",
          message:
            "Signing was cancelled. Your local media server edits were retained.",
        }
      case "authority_changed":
        return {
          phase: "error",
          message:
            "The signer account changed. Recheck the connected account before publishing.",
        }
      case "timeout":
        return {
          phase: "error",
          message:
            "The signer did not answer in time. Your local edits were retained.",
        }
      case "invalid_response":
        return {
          phase: "error",
          message:
            "The signer returned an invalid response. Nothing was published.",
        }
      case "unavailable":
      default:
        return {
          phase: "error",
          message:
            "The external signer is unavailable. Your local edits were retained.",
        }
    }
  }
  if (error instanceof Error && error.name === "MediaServerPreferencesError") {
    return { phase: "error", message: error.message }
  }
  return {
    phase: "error",
    message:
      "The media server preference update could not finish. Your local edits were retained.",
  }
}

function publishResultMessage(result: MediaServerPublishResult): string {
  switch (result.outcome) {
    case "confirmed":
      return "The ordered media server preference was confirmed by a fresh relay read-back."
    case "partial":
      return `The update was confirmed after ${result.acceptedRelayCount} of ${result.targetRelayCount} relay targets accepted it. Retry the exact signed event for the remaining targets.`
    case "confirmation_pending":
      return `The signed update was accepted by ${result.acceptedRelayCount} of ${result.targetRelayCount} relay targets, but fresh read-back is still pending.`
    case "rejected":
      return "Every planned relay rejected the exact signed update. Review relay access, then retry without signing again."
    case "failed":
      return "No planned relay confirmed acceptance. Retry the exact signed update; the signer will not be asked again."
  }
}

function phaseForResult(
  result: MediaServerPublishResult
): MediaServerPublishPhase {
  switch (result.outcome) {
    case "confirmed":
      return "confirmed"
    case "partial":
      return "partial"
    case "confirmation_pending":
      return "confirmation_pending"
    case "rejected":
    case "failed":
      return "error"
  }
}

function disabledReason(input: {
  enabled: boolean
  status: MediaServerPreferenceViewStatus
  coverage: MediaServerLookupCoverage
  dirty: boolean
  serverCount: number
  pending: boolean
  signerAvailable: boolean
  busy: boolean
}): string | null {
  if (!input.enabled) return "Connect an external signer to manage preferences."
  if (input.busy) return "The current preference action is still running."
  if (input.pending) {
    return "Retry the exact pending signed update before publishing a replacement."
  }
  if (input.status === "loading") {
    return "Wait for the bounded preference lookup to finish."
  }
  if (input.coverage === "unavailable") {
    return "Retry the preference lookup before replacing published evidence."
  }
  if (input.serverCount === 0) {
    return "Add at least one media server before publishing."
  }
  if (!input.dirty)
    return "The local order already matches the last observed event."
  if (!input.signerAvailable)
    return "Reconnect the external signer before publishing."
  return null
}

export function useMediaServerPreferences(
  owner: string | null | undefined,
  options: UseMediaServerPreferencesOptions = {}
): UseMediaServerPreferencesResult {
  const normalizedOwner = owner?.trim().toLowerCase() || null
  const enabled = !!normalizedOwner && (options.enabled ?? true)
  const authGenerationRef = useRef(options.authGeneration ?? 0)
  const [draft, setDraft] = useState<DraftState>(() =>
    loadDraftState(normalizedOwner)
  )
  const [publishState, setPublishState] = useState<PublishState>(() =>
    emptyPublishState(normalizedOwner)
  )
  const [lookupRevision, setLookupRevision] = useState(0)

  useEffect(() => {
    authGenerationRef.current = options.authGeneration ?? 0
  }, [options.authGeneration])

  useEffect(() => {
    setDraft(loadDraftState(normalizedOwner))
  }, [normalizedOwner])

  useEffect(() => {
    if (!draft.owner) return
    saveMediaServerDraft(draft.owner, {
      serverUrls: draft.serverUrls,
      baseServerUrls: draft.baseServerUrls,
      baseEventId: draft.baseEventId,
      updatedAt: Date.now(),
    })
  }, [draft])

  const queryKey = useMemo(
    () => [
      MEDIA_SERVER_PREFERENCES_QUERY_KEY,
      normalizedOwner ?? "none",
      lookupRevision,
    ],
    [lookupRevision, normalizedOwner]
  )
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: () => readMediaServerPreferences(normalizedOwner!),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  useEffect(() => {
    if (!enabled) return
    const relayScope = options.relayScope?.trim() || null
    return subscribeRelaySettingsChanges((changedScope) => {
      if (changedScope === relayScope) setLookupRevision((value) => value + 1)
    })
  }, [enabled, options.relayScope])

  useEffect(() => {
    const resolution = query.data
    if (!normalizedOwner || !resolution) return
    setDraft((current) => {
      const active =
        current.owner === normalizedOwner
          ? current
          : loadDraftState(normalizedOwner)
      const dirty = !sameOrderedMediaServerList(
        active.serverUrls,
        active.baseServerUrls
      )
      if (dirty) return active
      const next: DraftState = {
        owner: normalizedOwner,
        serverUrls: [...resolution.publishedServerUrls],
        baseServerUrls: [...resolution.publishedServerUrls],
        baseEventId: resolution.publishedRevision?.eventId ?? null,
      }
      return next
    })
  }, [normalizedOwner, query.data])

  const activeDraft =
    draft.owner === normalizedOwner ? draft : emptyDraft(normalizedOwner)
  const activePublishState =
    publishState.owner === normalizedOwner
      ? publishState
      : emptyPublishState(normalizedOwner)
  const resolution: MediaServerPreferenceResolution | undefined = query.data
  const dirty = !sameOrderedMediaServerList(
    activeDraft.serverUrls,
    activeDraft.baseServerUrls
  )
  const busy = isPublishBusy(activePublishState.phase)
  const pending =
    resolution?.pending ??
    (normalizedOwner
      ? (loadMediaServerPreferenceRecord(normalizedOwner).pending ?? null)
      : null)
  const publishDisabledReason = disabledReason({
    enabled,
    status: resolution?.status ?? "loading",
    coverage: resolution?.coverage ?? "unavailable",
    dirty,
    serverCount: activeDraft.serverUrls.length,
    pending: !!pending,
    signerAvailable: !!options.signer && !!options.authMethod,
    busy,
  })

  const persistDraft = useCallback(
    (nextServerUrls: string[]): void => {
      if (!normalizedOwner) return
      setDraft((current) => {
        const active =
          current.owner === normalizedOwner
            ? current
            : loadDraftState(normalizedOwner)
        const next: DraftState = {
          ...active,
          owner: normalizedOwner,
          serverUrls: nextServerUrls,
        }
        return next
      })
      setPublishState((current) => {
        const active =
          current.owner === normalizedOwner
            ? current
            : emptyPublishState(normalizedOwner)
        return isPublishBusy(active.phase)
          ? active
          : emptyPublishState(normalizedOwner)
      })
    },
    [normalizedOwner]
  )

  const setPublishPhaseForOwner = useCallback(
    (phase: MediaServerPublishPhase): void => {
      setPublishState((current) => ({
        ...(current.owner === normalizedOwner
          ? current
          : emptyPublishState(normalizedOwner)),
        phase,
      }))
    },
    [normalizedOwner]
  )

  const addServer = useCallback(
    (url: string): MediaServerDraftActionResult => {
      try {
        persistDraft(addMediaServerPreference(activeDraft.serverUrls, url))
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "That media server could not be added.",
        }
      }
    },
    [activeDraft.serverUrls, persistDraft]
  )

  const removeServer = useCallback(
    (url: string): void => {
      persistDraft(removeMediaServerPreference(activeDraft.serverUrls, url))
    },
    [activeDraft.serverUrls, persistDraft]
  )

  const moveServer = useCallback(
    (fromIndex: number, toIndex: number): void => {
      persistDraft(
        moveMediaServerPreference(activeDraft.serverUrls, fromIndex, toIndex)
      )
    },
    [activeDraft.serverUrls, persistDraft]
  )

  const applyResult = useCallback(
    (result: MediaServerPublishResult): void => {
      setPublishState({
        owner: normalizedOwner,
        phase: phaseForResult(result),
        message: publishResultMessage(result),
        result,
      })
      if (!normalizedOwner || !result.confirmed) return
      const parsed = parseBlossomServerListTags(result.signedEvent.tags)
      if (parsed.state !== "valid") return
      setDraft((current) => {
        const active =
          current.owner === normalizedOwner
            ? current
            : loadDraftState(normalizedOwner)
        const next: DraftState = {
          owner: normalizedOwner,
          serverUrls: [...active.serverUrls],
          baseServerUrls: [...parsed.serverUrls],
          baseEventId: result.signedEvent.id,
        }
        return next
      })
      setLookupRevision((value) => value + 1)
    },
    [normalizedOwner]
  )

  const publish = useCallback(async (): Promise<void> => {
    if (
      !normalizedOwner ||
      !resolution ||
      !options.signer ||
      !options.authMethod ||
      publishDisabledReason
    ) {
      setPublishState({
        owner: normalizedOwner,
        phase: "error",
        message:
          publishDisabledReason ??
          "The media server preference is not ready to publish.",
        result: null,
      })
      return
    }
    const generation = options.authGeneration ?? 0
    setPublishState({
      owner: normalizedOwner,
      phase: "checking",
      message: null,
      result: null,
    })
    try {
      let signerUser: { pubkey: string }
      try {
        signerUser = await options.signer.user()
      } catch {
        throw new NostrSignerError("unavailable")
      }
      if (signerUser.pubkey.trim().toLowerCase() !== normalizedOwner) {
        throw new NostrSignerError("authority_changed")
      }
      const signer = createNdkNostrEventSigner(
        options.signer,
        normalizedOwner,
        options.authMethod
      )
      const result = await publishMediaServerPreferences({
        owner: normalizedOwner,
        serverUrls: activeDraft.serverUrls,
        signer,
        reviewed: toReviewedMediaServerEvidence(resolution),
        dependencies: {
          shouldContinue: () => authGenerationRef.current === generation,
          onPhase: setPublishPhaseForOwner,
        },
      })
      applyResult(result)
    } catch (error) {
      const safe = safePublishError(error)
      setPublishState({
        owner: normalizedOwner,
        phase: safe.phase,
        message: safe.message,
        result: null,
      })
    }
  }, [
    activeDraft.serverUrls,
    applyResult,
    normalizedOwner,
    options.authGeneration,
    options.authMethod,
    options.signer,
    publishDisabledReason,
    resolution,
    setPublishPhaseForOwner,
  ])

  const retryPublish = useCallback(async (): Promise<void> => {
    if (!normalizedOwner || busy) return
    const generation = options.authGeneration ?? 0
    setPublishState({
      owner: normalizedOwner,
      phase: "publishing",
      message: null,
      result: null,
    })
    try {
      const result = await retryMediaServerPreferencesPublish({
        owner: normalizedOwner,
        dependencies: {
          shouldContinue: () => authGenerationRef.current === generation,
          onPhase: setPublishPhaseForOwner,
        },
      })
      applyResult(result)
    } catch (error) {
      const safe = safePublishError(error)
      setPublishState({
        owner: normalizedOwner,
        phase: safe.phase,
        message: safe.message,
        result: null,
      })
    }
  }, [
    applyResult,
    busy,
    normalizedOwner,
    options.authGeneration,
    setPublishPhaseForOwner,
  ])

  const view: MediaServerPreferencesView = {
    status: resolution?.status ?? "loading",
    coverage: resolution?.coverage ?? "unavailable",
    localServerUrls: [...activeDraft.serverUrls],
    publishedServerUrls: [...(resolution?.publishedServerUrls ?? [])],
    dirty,
    stale: resolution?.stale ?? false,
    retained: resolution?.retained ?? false,
    sourceRelayCount: resolution?.sourceRelayUrls.length ?? 0,
    publishedCreatedAt: resolution?.publishedRevision?.createdAt ?? null,
    observedAt: resolution?.observedAt ?? null,
    completeObservedAt: resolution?.completeObservedAt ?? null,
    lookupError:
      query.error && !resolution
        ? "The bounded media server preference lookup is unavailable."
        : null,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    canPublish: publishDisabledReason === null,
    publishDisabledReason,
    publishPhase: activePublishState.phase,
    publishMessage: activePublishState.message,
    publishOutcome: activePublishState.result?.outcome ?? null,
    acceptedRelayCount: activePublishState.result?.acceptedRelayCount ?? 0,
    rejectedRelayCount: activePublishState.result?.rejectedRelayCount ?? 0,
    timedOutRelayCount: activePublishState.result?.timedOutRelayCount ?? 0,
    targetRelayCount: activePublishState.result?.targetRelayCount ?? 0,
    retryAvailable: activePublishState.result?.retryAvailable ?? !!pending,
    pendingSignedListDiffers:
      !!pending &&
      !sameOrderedMediaServerList(activeDraft.serverUrls, pending.serverUrls),
  }

  return {
    view,
    addServer,
    removeServer,
    moveServer,
    publish,
    retryPublish,
    refetch: () => setLookupRevision((value) => value + 1),
  }
}
