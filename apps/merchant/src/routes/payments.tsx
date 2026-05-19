import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, Zap } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
  fetchLnurlPayMetadata,
  isValidLud16Address,
  useAuth,
  useProfile,
  useUpdateProfile,
} from "@conduit/core"
import { Button, Input, Label, SignedActionStatus } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import {
  profileFormToUpdatePayload,
  profileToFormValues,
} from "../lib/profileForm"
import { isPaymentsComplete } from "../lib/readiness"

export const Route = createFileRoute("/payments")({
  beforeLoad: () => {
    requireAuth()
  },
  component: PaymentsPage,
})

function PaymentsPage() {
  const { pubkey } = useAuth()
  const profileQuery = useProfile(pubkey)
  const updateMutation = useUpdateProfile("merchant")

  const profile = profileQuery.data
  const complete = isPaymentsComplete(profile)
  const lud16 = profile?.lud16?.trim() ?? ""
  const isSavingLud16 = updateMutation.isPending
  const isLoadingProfile =
    profileQuery.isLoading ||
    (profileQuery.isPlaceholderData && profileQuery.isFetching)
  const isRefreshingProfile =
    profileQuery.isFetching && !isLoadingProfile && !isSavingLud16

  const [editingLud16, setEditingLud16] = useState(false)
  const [lud16Draft, setLud16Draft] = useState("")
  const [lud16Error, setLud16Error] = useState<string | null>(null)
  const [lud16SaveSucceeded, setLud16SaveSucceeded] = useState(false)
  const [addressCheck, setAddressCheck] = useState<
    | { status: "idle" }
    | { status: "checking" }
    | { status: "invalid" }
    | { status: "lnurl_ready" }
    | { status: "zap_supported" }
    | { status: "unverified"; message: string }
  >({ status: "idle" })

  useEffect(() => {
    if (!lud16) {
      setAddressCheck({ status: "idle" })
      return
    }

    if (!isValidLud16Address(lud16)) {
      setAddressCheck({ status: "invalid" })
      return
    }

    let cancelled = false
    setAddressCheck({ status: "checking" })

    fetchLnurlPayMetadata(lud16)
      .then((metadata) => {
        if (cancelled) return
        setAddressCheck({
          status: metadata.allowsNostr ? "zap_supported" : "lnurl_ready",
        })
      })
      .catch((error) => {
        if (cancelled) return
        setAddressCheck({
          status: "unverified",
          message:
            error instanceof Error
              ? error.message
              : "Could not verify this Lightning Address.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [lud16])

  const hasLud16Changes = lud16Draft.trim() !== lud16
  const lud16SaveStatus = isSavingLud16
    ? "awaiting_signature"
    : updateMutation.error
      ? "error"
      : hasLud16Changes
        ? "dirty"
        : lud16SaveSucceeded
          ? "success"
          : "idle"

  function startEditLud16() {
    setLud16Draft(profile?.lud16 ?? "")
    setLud16SaveSucceeded(false)
    setEditingLud16(true)
  }

  async function saveLud16(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || isSavingLud16) return
    const nextLud16 = lud16Draft.trim()
    if (nextLud16 && !isValidLud16Address(nextLud16)) {
      setLud16Error("Enter a Lightning Address like you@example.com.")
      return
    }
    setLud16Error(null)
    if (!hasLud16Changes) return
    setLud16SaveSucceeded(false)
    try {
      await updateMutation.mutateAsync(
        profileFormToUpdatePayload({
          ...profileToFormValues(profile),
          lud16: nextLud16,
        })
      )
      setLud16SaveSucceeded(true)
      setEditingLud16(false)
      void profileQuery.refetch()
    } catch {
      // The mutation error is rendered below the input.
    }
  }

  function cancelEditLud16() {
    if (isSavingLud16) return
    setEditingLud16(false)
    setLud16Draft(profile?.lud16 ?? "")
    setLud16Error(null)
    setLud16SaveSucceeded(false)
  }

  function getBusyStatus() {
    if (isSavingLud16) {
      return {
        title: "Waiting for signer",
        message:
          "Confirm the Lightning Address update. It will show as saved after relay publish finishes.",
      }
    }
    if (isRefreshingProfile) {
      return {
        title: "Refreshing payment profile",
        message: "Checking the latest profile state from your relays.",
      }
    }
    return null
  }

  const busyStatus = getBusyStatus()

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_40%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            {/* Page header */}
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                  Setup
                </div>
                <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Payments
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
                  Configure where buyers send Lightning payments.
                </p>
                {!editingLud16 && lud16SaveSucceeded && (
                  <SignedActionStatus
                    state="success"
                    successMessage="Lightning Address signed and saved."
                    className="mt-3"
                  />
                )}
              </div>

              {!complete && !isLoadingProfile && (
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                  <p className="text-sm text-[var(--warning)]">
                    <span className="font-semibold">
                      Lightning Address required.
                    </span>{" "}
                    Add a valid Lightning Address so buyers can pay for orders.
                  </p>
                </div>
              )}

              {busyStatus && (
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_8%,transparent)] px-4 py-3.5">
                  <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--primary-500)]" />
                  <div className="text-sm leading-6">
                    <div className="font-semibold text-[var(--text-primary)]">
                      {busyStatus.title}
                    </div>
                    <p className="text-[var(--text-secondary)]">
                      {busyStatus.message}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {isLoadingProfile ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Loading payment profile
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {/* Lightning Address section */}
                <section className="space-y-4">
                  <div>
                    <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
                      PAYMENT METHOD
                    </div>
                    <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                      Where buyers send Lightning payments
                    </div>
                  </div>

                  <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <Zap className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
                        <span className="text-[1rem] font-semibold text-[var(--text-primary)]">
                          Lightning Address
                        </span>
                      </div>
                      {!editingLud16 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startEditLud16}
                          disabled={isSavingLud16}
                        >
                          {profile?.lud16 ? "Change" : "Add"}
                        </Button>
                      )}
                    </div>

                    <div className="mt-4">
                      {!editingLud16 ? (
                        profile?.lud16 ? (
                          <div className="space-y-4">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                              <span className="font-mono text-sm text-[var(--text-primary)]">
                                {profile.lud16}
                              </span>
                            </div>
                            <LightningAddressStatus check={addressCheck} />
                          </div>
                        ) : (
                          <p className="text-sm text-[var(--text-muted)]">
                            No Lightning Address set. Add one to receive
                            Lightning payments from buyers.
                          </p>
                        )
                      ) : (
                        <form onSubmit={saveLud16} className="space-y-3">
                          <div className="grid gap-1.5">
                            <Label htmlFor="lud16-input">
                              Lightning Address
                            </Label>
                            <Input
                              id="lud16-input"
                              value={lud16Draft}
                              onChange={(e) => setLud16Draft(e.target.value)}
                              placeholder="you@wallet-provider.com"
                              disabled={isSavingLud16}
                              autoFocus
                            />
                            <p className="text-xs text-[var(--text-muted)]">
                              e.g.{" "}
                              <span className="font-mono">
                                satoshi@strike.me
                              </span>{" "}
                              or{" "}
                              <span className="font-mono">you@getalby.com</span>
                            </p>
                          </div>
                          {updateMutation.error && (
                            <p className="text-sm text-error">
                              {updateMutation.error instanceof Error
                                ? updateMutation.error.message
                                : "Failed to save"}
                            </p>
                          )}
                          {lud16Error && (
                            <p className="text-sm text-error">{lud16Error}</p>
                          )}
                          <div className="flex items-center gap-2">
                            <Button
                              type="submit"
                              size="sm"
                              disabled={isSavingLud16 || !hasLud16Changes}
                            >
                              {isSavingLud16 ? (
                                <span className="inline-flex items-center gap-2">
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                  Waiting for signer
                                </span>
                              ) : (
                                "Save changes"
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={cancelEditLud16}
                              disabled={isSavingLud16}
                            >
                              Cancel
                            </Button>
                          </div>
                          <SignedActionStatus
                            state={lud16SaveStatus}
                            dirtyMessage="Save changes to publish your Lightning Address."
                            awaitingSignatureMessage="Confirm the Lightning Address update in your signer. It will show as saved after relay publish finishes."
                            successMessage="Lightning Address signed and saved."
                            errorMessage={
                              updateMutation.error instanceof Error
                                ? updateMutation.error.message
                                : "Failed to save Lightning Address"
                            }
                          />
                        </form>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function LightningAddressStatus({
  check,
}: {
  check:
    | { status: "idle" }
    | { status: "checking" }
    | { status: "invalid" }
    | { status: "lnurl_ready" }
    | { status: "zap_supported" }
    | { status: "unverified"; message: string }
}) {
  if (check.status === "idle") return null

  if (check.status === "checking") {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
        <div className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Checking Lightning Address
        </div>
      </div>
    )
  }

  if (check.status === "invalid") {
    return (
      <div className="rounded-xl border border-[var(--warning)]/50 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)]">
        <div className="flex items-center gap-2 font-semibold">
          <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
          Lightning Address needs review
        </div>
        <p className="mt-1 text-[var(--text-secondary)]">
          Use a valid Lightning Address such as you@example.com.
        </p>
      </div>
    )
  }

  if (check.status === "zap_supported") {
    return (
      <div className="rounded-xl border border-[var(--success)]/35 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)]">
        <div className="flex items-center gap-2 font-semibold">
          <Zap className="h-4 w-4 text-[var(--success)]" />
          Zap support detected
        </div>
        <p className="mt-1 text-[var(--text-secondary)]">
          Eligible orders can be paid directly to this Lightning Address.
          Conduit links the payment to the order so the merchant can review and
          fulfill it.
        </p>
      </div>
    )
  }

  if (check.status === "lnurl_ready") {
    return (
      <div className="rounded-xl border border-[var(--success)]/35 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)]">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
          Lightning Address ready
        </div>
        <p className="mt-1 text-[var(--text-secondary)]">
          This address resolves to a Lightning payment endpoint. Direct zap
          checkout needs NIP-57 support from the wallet provider.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[var(--warning)]/50 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)]">
      <div className="flex items-center gap-2 font-semibold">
        <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
        Lightning Address saved
      </div>
      <p className="mt-1 text-[var(--text-secondary)]">
        We could not verify the payment endpoint right now. Buyers can still use
        the order-first invoice flow until direct payment support is confirmed.
      </p>
    </div>
  )
}
