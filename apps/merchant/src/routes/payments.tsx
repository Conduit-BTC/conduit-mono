import { useState } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, Zap } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
  formatPubkey,
  useAuth,
  useProfile,
  useUpdateProfile,
} from "@conduit/core"
import { Badge, Button, Input, Label } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { useNwcConnection } from "../hooks/useNwcConnection"
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
  const nwc = useNwcConnection()

  const profile = profileQuery.data
  const complete = isPaymentsComplete(profile)

  const [editingLud16, setEditingLud16] = useState(false)
  const [lud16Draft, setLud16Draft] = useState("")
  const [nwcDraft, setNwcDraft] = useState("")

  function startEditLud16() {
    setLud16Draft(profile?.lud16 ?? "")
    setEditingLud16(true)
  }

  async function saveLud16(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    updateMutation.mutate(
      profileFormToUpdatePayload({
        ...profileToFormValues(profile),
        lud16: lud16Draft.trim(),
      }),
      { onSuccess: () => setEditingLud16(false) }
    )
  }

  function connectNwc(e: React.FormEvent) {
    e.preventDefault()
    nwc.setUri(nwcDraft.trim())
    setNwcDraft("")
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
                  Configure how buyers pay you. A Lightning Address is required
                  to receive payments.
                </p>
              </div>

              {!complete && !profileQuery.isLoading && (
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                  <p className="text-sm text-[var(--warning)]">
                    <span className="font-semibold">
                      Lightning Address required.
                    </span>{" "}
                    Add a Lightning Address so buyers can pay for orders.
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

                  <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_8%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
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
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                            <span className="font-mono text-sm text-[var(--text-primary)]">
                              {profile.lud16}
                            </span>
                          </div>
                        ) : (
                          <p className="text-sm text-[var(--text-muted)]">
                            No Lightning Address set. Add one to receive
                            payments from buyers.
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

                {/* NWC section */}
                <section className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--secondary-500)]">
                        AUTOMATION
                      </div>
                      <Badge variant="outline">Optional</Badge>
                    </div>
                    <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                      Auto-generate invoices directly from orders
                    </div>
                  </div>

                  <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--secondary-500)_8%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
                    <div className="mb-1 text-[1rem] font-semibold text-[var(--text-primary)]">
                      Wallet Connect (NWC)
                    </div>
                    <p className="mb-5 text-sm text-[var(--text-secondary)]">
                      Connect a Lightning wallet via NIP-47 to generate invoices
                      with one click directly from the Orders page. Without NWC
                      you can still paste BOLT11 invoices manually.
                    </p>

                    {nwc.connection ? (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                          <span className="text-sm text-[var(--text-primary)]">
                            Connected to wallet{" "}
                            <span className="font-mono">
                              {formatPubkey(nwc.connection.walletPubkey, 8)}
                            </span>
                          </span>
                        </div>
                        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-xs text-[var(--text-secondary)] space-y-1">
                          <div>
                            Wallet pubkey:{" "}
                            <span className="font-mono text-[var(--text-primary)]">
                              {nwc.connection.walletPubkey}
                            </span>
                          </div>
                          <div>
                            Relay:{" "}
                            <span className="font-mono text-[var(--text-primary)]">
                              {nwc.connection.relays[0]}
                            </span>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={nwc.disconnect}
                        >
                          Disconnect wallet
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)] space-y-2">
                          <p className="font-medium text-[var(--text-primary)]">
                            How to connect:
                          </p>
                          <ol className="list-decimal list-inside space-y-1 text-xs">
                            <li>
                              Set up a Lightning wallet that supports NWC
                              (NIP-47)
                            </li>
                            <li>
                              Create a new connection with{" "}
                              <span className="font-medium text-[var(--text-primary)]">
                                make_invoice
                              </span>{" "}
                              permission
                            </li>
                            <li>
                              Copy the{" "}
                              <span className="font-mono">
                                nostr+walletconnect://
                              </span>{" "}
                              URI and paste below
                            </li>
                          </ol>
                          <div className="flex flex-wrap gap-2 pt-1">
                            {[
                              { label: "Alby", href: "https://getalby.com" },
                              {
                                label: "Mutiny",
                                href: "https://mutinywallet.com",
                              },
                              { label: "nwc.dev", href: "https://nwc.dev" },
                            ].map(({ label, href }) => (
                              <a
                                key={href}
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface-overlay)]"
                              >
                                {label}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ))}
                          </div>
                        </div>

                        <form onSubmit={connectNwc} className="space-y-3">
                          <div className="grid gap-1.5">
                            <Label htmlFor="nwc-uri-input">
                              NWC Connection URI
                            </Label>
                            <Input
                              id="nwc-uri-input"
                              value={nwcDraft}
                              onChange={(e) => setNwcDraft(e.target.value)}
                              placeholder="nostr+walletconnect://..."
                            />
                            {nwc.error && (
                              <p className="text-xs text-error">{nwc.error}</p>
                            )}
                          </div>
                          <Button
                            type="submit"
                            size="sm"
                            disabled={!nwcDraft.trim()}
                          >
                            Connect wallet
                          </Button>
                        </form>
                      </div>
                    )}
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
