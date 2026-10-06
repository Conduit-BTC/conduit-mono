import { useCallback, useEffect, useMemo, useState } from "react"
import { liveQuery } from "dexie"
import { useAuth } from "../context/AuthContext"
import {
  getCommerceInbox,
  readRetainedCommerceInbox,
  type CommerceInboxSnapshot,
  type CommerceInbox,
} from "../protocol/commerce-inbox"
import { projectCommerceInbox } from "../protocol/commerce"

/** Own browser wakeups and subscription cleanup independently of React renders. */
function observeInbox(
  owner: CommerceInbox,
  sync: boolean,
  changed: (snapshot: CommerceInboxSnapshot) => void,
  failed: (error: unknown) => void
): () => void {
  let active = true
  const paint = () => {
    if (active) changed(owner.getSnapshot())
  }
  const unsubscribe = owner.subscribe(paint)
  const refresh = () => {
    void owner.syncRecent().catch((error: unknown) => {
      if (active) failed(error)
    })
  }
  void owner.initialize().then(
    () => {
      paint()
      if (sync) refresh()
    },
    (error: unknown) => {
      if (active) failed(error)
    }
  )
  const timer = sync ? setInterval(refresh, 30_000) : undefined
  const resume = () => {
    if (document.visibilityState !== "hidden") refresh()
  }
  window.addEventListener("online", resume)
  window.addEventListener("focus", resume)
  return () => {
    active = false
    unsubscribe()
    if (timer !== undefined) clearInterval(timer)
    window.removeEventListener("online", resume)
    window.removeEventListener("focus", resume)
  }
}

/** Incremental account-fenced view shared by Messages, Orders and recovery. */
export function useCommerceInbox(
  principal: string | null | undefined,
  enabled = true,
  sync = true
) {
  const { accountPubkey, authGeneration, isAccountIdentityCurrent } = useAuth()
  let owner: CommerceInbox | null = null
  let authorityError: unknown = null
  try {
    owner = principal && enabled ? getCommerceInbox(principal) : null
  } catch (error) {
    authorityError = error
  }
  const cacheScope = useMemo(
    () =>
      !owner && principal && accountPubkey === principal
        ? { principal, authGeneration }
        : null,
    [owner, principal, accountPubkey, authGeneration]
  )
  const [cached, setCached] = useState<{
    scope: NonNullable<typeof cacheScope>
    snapshot: CommerceInboxSnapshot | null
    error: unknown
    updatedAt: number
  } | null>(null)
  useEffect(() => {
    if (!cacheScope) return
    let active = true
    const isCurrent = () =>
      active && isAccountIdentityCurrent(cacheScope.principal)
    const subscription = liveQuery(() =>
      readRetainedCommerceInbox(cacheScope.principal, isCurrent)
    ).subscribe({
      next: (snapshot) => {
        if (isCurrent())
          setCached({
            scope: cacheScope,
            snapshot,
            error: null,
            updatedAt: Date.now(),
          })
      },
      error: (error: unknown) => {
        if (isCurrent())
          setCached({
            scope: cacheScope,
            snapshot: null,
            error,
            updatedAt: Date.now(),
          })
      },
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [cacheScope, isAccountIdentityCurrent])
  const [view, setView] = useState<{
    owner: CommerceInbox
    snapshot: CommerceInboxSnapshot
    updatedAt: number
  } | null>(null)
  const [failure, setFailure] = useState<{
    owner: CommerceInbox
    error: unknown
  } | null>(null)
  useEffect(() => {
    if (!owner) return
    return observeInbox(
      owner,
      sync,
      (snapshot) => setView({ owner, snapshot, updatedAt: Date.now() }),
      (error) => setFailure({ owner, error })
    )
  }, [owner, sync])
  const run = useCallback(
    async (action: "syncRecent" | "loadOlder" | "retryDecode") => {
      if (!owner) return
      try {
        await owner[action]()
        setFailure(null)
      } catch (error) {
        setFailure({ owner, error })
        throw error
      }
    },
    [owner]
  )
  const refetch = useCallback(() => run("syncRecent"), [run])
  const loadOlder = useCallback(() => run("loadOlder"), [run])
  const retry = useCallback(() => run("retryDecode"), [run])
  const retained =
    cacheScope &&
    cached?.scope === cacheScope &&
    isAccountIdentityCurrent(cacheScope.principal)
      ? cached
      : null
  const snapshot =
    owner && view && view.owner === owner
      ? view.snapshot
      : (retained?.snapshot ?? null)
  const projected = useMemo(
    () =>
      snapshot && principal ? projectCommerceInbox(snapshot, principal) : null,
    [snapshot, principal]
  )
  const common = {
    refetch,
    error:
      authorityError ??
      (owner && failure?.owner === owner
        ? failure.error
        : (retained?.error ?? null)),
    isRefetching: !!snapshot?.pending,
    isFetching: !!snapshot?.pending,
    isPaused: false,
    isLoading: enabled && !snapshot,
    isPending: enabled && !snapshot,
    dataUpdatedAt: owner ? (view?.updatedAt ?? 0) : (retained?.updatedAt ?? 0),
  }
  return {
    snapshot,
    loadOlder: owner ? loadOlder : undefined,
    retry: owner ? retry : undefined,
    attach: owner?.attach.bind(owner),
    retrySends: owner ? () => owner.retrySends() : undefined,
    reply: owner?.reply.bind(owner),
    associate: owner?.associate.bind(owner),
    buyer: { ...common, data: projected?.buyer },
    merchant: { ...common, data: projected?.merchant },
    direct: { ...common, data: projected?.direct },
  }
}
