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
import { Button, Input, Label } from "@conduit/ui"
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

  const [editingLud16, setEditingLud16] = useState(false)
  const [lud16Draft, setLud16Draft] = useState("")
  const [lud16Error, setLud16Error] = useState<string | null>(null)
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

  function startEditLud16() {
    setLud16Draft(profile?.lud16 ?? "")
    setEditingLud16(true)
  }

  async function saveLud16(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    const nextLud16 = lud16Draft.trim()
    if (nextLud16 && !isValidLud16Address(nextLud16)) {
      setLud16Error("Enter a Lightning Address like you@example.com.")
      return
    }
    setLud16Error(null)
    updateMutation.mutate(
      profileFormToUpdatePayload({
        ...profileToFormValues(profile),
        lud16: nextLud16,
      }),
      { onSuccess: () => setEditingLud16(false) }
    )
  }

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
              </div>

              {!complete && !profileQuery.isLoading && (
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
            </div>

            {profileQuery.isLoading ? (
              <p className="text-sm text-[var(--text-secondary)]">Loading...</p>
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
                              disabled={updateMutation.isPending}
                            >
                              {updateMutation.isPending ? "Saving..." : "Save"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingLud16(false)}
                            >
                              Cancel
                            </Button>
                          </div>
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
