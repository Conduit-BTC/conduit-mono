import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
  Zap,
} from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
  fetchLnurlPayMetadata,
  isValidLud16Address,
  parseNwcUri,
  useAuth,
  useProfile,
  useUpdateProfile,
} from "@conduit/core"
import {
  Button,
  Input,
  Label,
  SignedActionStatus,
  StatusPill,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import {
  profileFormToUpdatePayload,
  profileToFormValues,
} from "../lib/profileForm"
import { isPaymentsComplete } from "../lib/readiness"
import { useMerchantPaymentAutomation } from "../hooks/useMerchantPaymentAutomation"

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
                <h1 className="text-balance font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Payments
                </h1>
                <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
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

                <NwcAutomationSection />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function NwcAutomationSection() {
  const automation = useMerchantPaymentAutomation()
  const [uri, setUri] = useState("")
  const [inputError, setInputError] = useState<string | null>(null)
  const connected = !!automation.connection

  function connectWallet(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = uri.trim()
    if (!trimmed) {
      setInputError("Paste a Nostr Wallet Connect connection string.")
      return
    }
    try {
      parseNwcUri(trimmed)
    } catch {
      setInputError("Paste a valid Nostr Wallet Connect connection string.")
      return
    }
    automation.setUri(trimmed)
    setUri("")
    setInputError(null)
  }

  const status = automation.infoPending
    ? { variant: "info" as const, label: "Checking" }
    : automation.infoError
      ? { variant: "warning" as const, label: "Saved — unavailable" }
      : automation.addressStatus === "mismatch"
        ? { variant: "warning" as const, label: "Address mismatch" }
        : automation.canVerifyPayments
          ? { variant: "success" as const, label: "Verification ready" }
          : automation.canCreateInvoices
            ? { variant: "info" as const, label: "Invoice creation ready" }
            : connected
              ? { variant: "warning" as const, label: "Needs permission" }
              : { variant: "neutral" as const, label: "Not connected" }

  return (
    <section className="space-y-4">
      <div>
        <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
          AUTOMATIC PAYMENT VERIFICATION
        </div>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          Connect the wallet behind your Lightning Address. Conduit can check
          exact incoming invoices and confirm matching settled orders while the
          portal is open.
        </p>
      </div>

      <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Wallet className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
            <div>
              <div className="font-semibold text-[var(--text-primary)]">
                Nostr Wallet Connect
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                Optional · stored only in this browser
              </div>
            </div>
          </div>
          <StatusPill variant={status.variant}>{status.label}</StatusPill>
        </div>

        {!connected ? (
          <form onSubmit={connectWallet} className="mt-5 space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="merchant-nwc-uri">Connection string</Label>
              <Input
                id="merchant-nwc-uri"
                type="password"
                value={uri}
                onChange={(event) => {
                  setUri(event.target.value)
                  setInputError(null)
                }}
                placeholder="nostr+walletconnect://..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={!!inputError}
                aria-describedby={
                  inputError || automation.connectionError
                    ? "merchant-nwc-help merchant-nwc-error"
                    : "merchant-nwc-help"
                }
              />
              <p
                id="merchant-nwc-help"
                className="text-xs leading-5 text-[var(--text-muted)]"
              >
                Use a connection with Create invoice and Lookup invoice
                permissions. The secret is never published or sent to buyers.
              </p>
              {(inputError || automation.connectionError) && (
                <p id="merchant-nwc-error" className="text-sm text-error">
                  {inputError ?? automation.connectionError}
                </p>
              )}
            </div>
            <Button type="submit" size="sm">
              Connect wallet
            </Button>
          </form>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <CapabilityCard
                ready={automation.canLookupInvoices}
                title="Verify payments"
                detail="Requires Lookup invoice permission"
              />
              <CapabilityCard
                ready={automation.canCreateInvoices}
                title="Create invoices"
                detail="Requires Create invoice permission"
              />
            </div>

            <NwcAddressStatus status={automation.addressStatus} />

            {automation.infoError && (
              <div className="rounded-xl border border-[var(--warning)]/50 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
                The connection is saved, but the wallet could not be reached.
                Automatic verification will resume after it reconnects.
              </div>
            )}

            <VerificationRunStatus
              run={automation.run}
              canVerify={automation.canVerifyPayments}
            />

            <p className="text-xs leading-5 text-[var(--text-muted)]">
              The wallet confirms settlement; your Nostr signer may still ask
              you to approve publishing the paid status to the order.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={automation.retry}
                disabled={
                  automation.infoPending || automation.run.status === "checking"
                }
              >
                {automation.infoPending ||
                automation.run.status === "checking" ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Check now
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={automation.disconnect}
              >
                Disconnect wallet
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function CapabilityCard({
  ready,
  title,
  detail,
}: {
  ready: boolean
  title: string
  detail: string
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        {ready ? (
          <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
        ) : (
          <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
        )}
        {title}
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{detail}</p>
    </div>
  )
}

function NwcAddressStatus({
  status,
}: {
  status: ReturnType<typeof useMerchantPaymentAutomation>["addressStatus"]
}) {
  const content = {
    match: {
      title: "Receiving address matches",
      body: "The wallet reports the same Lightning Address shown to buyers.",
      tone: "success",
    },
    mismatch: {
      title: "Receiving address does not match",
      body: "Automatic verification is off because this wallet reports a different Lightning Address.",
      tone: "warning",
    },
    unconfirmed: {
      title: "Address not reported by wallet",
      body: "Conduit verifies each exact order invoice directly. An address claim alone is never used to confirm payment.",
      tone: "neutral",
    },
    missing_profile: {
      title: "Add a Lightning Address first",
      body: "Automatic verification starts after buyers have a receiving address.",
      tone: "warning",
    },
  }[status]

  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-sm leading-6">
      <ShieldCheck
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          content.tone === "success"
            ? "text-[var(--success)]"
            : content.tone === "warning"
              ? "text-[var(--warning)]"
              : "text-[var(--text-muted)]"
        }`}
      />
      <div>
        <div className="font-semibold text-[var(--text-primary)]">
          {content.title}
        </div>
        <p className="text-[var(--text-secondary)]">{content.body}</p>
      </div>
    </div>
  )
}

function VerificationRunStatus({
  run,
  canVerify,
}: {
  run: ReturnType<typeof useMerchantPaymentAutomation>["run"]
  canVerify: boolean
}) {
  if (!canVerify || run.status === "idle") return null
  if (run.status === "checking") {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Checking reported payments…
      </p>
    )
  }
  if (run.status === "error") {
    return <p className="text-sm text-[var(--warning)]">{run.message}</p>
  }
  if (run.verified > 0) {
    return (
      <p className="text-sm text-[var(--success)]">
        Verified and advanced {run.verified} paid order
        {run.verified === 1 ? "" : "s"}.
      </p>
    )
  }
  if (run.checked > 0) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        No new settled payments matched. Reports stay in manual verification.
      </p>
    )
  }
  return null
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
