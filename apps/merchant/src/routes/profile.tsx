import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Store,
  UserRound,
} from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
  pubkeyToNpub,
  useAuth,
  useProfile,
  useUpdateProfile,
  type ProfileFormValues,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Input,
  Label,
  SignedActionStatus,
  StatusPill,
  Textarea,
  cn,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import {
  EMPTY_PROFILE_FORM,
  profileFormToUpdatePayload,
  profileToFormValues,
} from "../lib/profileForm"
import { isProfileComplete } from "../lib/readiness"

export const Route = createFileRoute("/profile")({
  beforeLoad: () => {
    requireAuth()
  },
  component: ProfilePage,
})

/** Fields the merchant must fill in for a complete profile */
const REQUIRED_FIELDS: (keyof ProfileFormValues)[] = [
  "displayName",
  "about",
  "picture",
]

function RequiredMark() {
  return (
    <span className="ml-0.5 text-[var(--warning)]" aria-hidden="true">
      *
    </span>
  )
}

function inferMarketOrigin(): string {
  if (typeof window === "undefined") return "https://conduit.market"

  const { hostname, protocol, port } = window.location
  const previewHostReplacements: [string, string][] = [
    [".conduit-merchant-33n.pages.dev", ".conduit-market-coo.pages.dev"],
    [".conduit-merchant-signet.pages.dev", ".conduit-market-signet.pages.dev"],
  ]

  for (const [merchantSuffix, marketSuffix] of previewHostReplacements) {
    if (hostname.endsWith(merchantSuffix)) {
      return `${protocol}//${hostname.slice(0, -merchantSuffix.length)}${marketSuffix}`
    }
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    const localMarketPort =
      port === "7001" ? "7000" : port === "5174" ? "5173" : ""
    if (localMarketPort) return `${protocol}//${hostname}:${localMarketPort}`
  }

  return "https://conduit.market"
}

function getStorefrontUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/store/${encodeURIComponent(pubkey)}`
}

function ProfilePage() {
  const { pubkey } = useAuth()
  const profileQuery = useProfile(pubkey)
  const updateMutation = useUpdateProfile("merchant")
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ProfileFormValues>(EMPTY_PROFILE_FORM)
  const [copiedPubkey, setCopiedPubkey] = useState(false)
  const [copiedStoreLink, setCopiedStoreLink] = useState(false)
  const [profileSaveSucceeded, setProfileSaveSucceeded] = useState(false)

  useEffect(() => {
    if (profileQuery.data) {
      setForm(profileToFormValues(profileQuery.data))
    }
  }, [profileQuery.data])

  const profileData = profileQuery.data
  const complete = isProfileComplete(profileData)
  const displayName = profileData?.displayName || profileData?.name
  const npub = pubkey ? pubkeyToNpub(pubkey) : ""
  const storefrontUrl = pubkey ? getStorefrontUrl(pubkey) : ""
  const savedProfileForm = useMemo(
    () => (profileData ? profileToFormValues(profileData) : EMPTY_PROFILE_FORM),
    [profileData]
  )
  const hasProfileChanges = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedProfileForm),
    [form, savedProfileForm]
  )
  const profileSaveStatus = updateMutation.isPending
    ? "awaiting_signature"
    : updateMutation.error
      ? "error"
      : hasProfileChanges
        ? "dirty"
        : profileSaveSucceeded
          ? "success"
          : "idle"

  useEffect(() => {
    if (hasProfileChanges) setProfileSaveSucceeded(false)
  }, [hasProfileChanges])

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!hasProfileChanges || updateMutation.isPending) return
    setProfileSaveSucceeded(false)
    updateMutation.mutate(profileFormToUpdatePayload(form), {
      onSuccess: () => {
        setProfileSaveSucceeded(true)
        setEditing(false)
      },
    })
  }

  async function copyNpub() {
    if (!npub) return
    try {
      await navigator.clipboard.writeText(npub)
      setCopiedPubkey(true)
      window.setTimeout(() => setCopiedPubkey(false), 1400)
    } catch {
      setCopiedPubkey(false)
    }
  }

  async function copyStorefrontLink() {
    if (!storefrontUrl) return
    try {
      await navigator.clipboard.writeText(storefrontUrl)
      setCopiedStoreLink(true)
      window.setTimeout(() => setCopiedStoreLink(false), 1400)
    } catch {
      setCopiedStoreLink(false)
    }
  }

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_40%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            {/* Page header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                  Setup
                </div>
                <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Store identity
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
                  Edit the merchant profile buyers see across Market and your
                  storefront surfaces.
                </p>
                {!editing && profileSaveSucceeded && (
                  <SignedActionStatus
                    state="success"
                    successMessage="Profile signed and saved."
                    className="mt-3"
                  />
                )}
              </div>
            </div>

            {/* Needs-completion banner */}
            {!complete && profileQuery.data && !editing && (
              <div className="flex items-start gap-3 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                <div className="text-sm text-[var(--warning)]">
                  <span className="font-semibold">
                    Profile needs completion.
                  </span>{" "}
                  Add a display name, photo, and bio so buyers can find and
                  trust your store.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:opacity-80"
                    onClick={() => setEditing(true)}
                  >
                    Edit profile
                  </button>
                </div>
              </div>
            )}

            {profileQuery.isLoading && (
              <div className="text-sm text-[var(--text-secondary)]">
                Loading profile...
              </div>
            )}

            {!!profileQuery.error && (
              <div className="rounded-2xl border border-[var(--destructive)]/30 bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] p-4 text-sm text-[var(--destructive)]">
                Failed to load profile:{" "}
                {profileQuery.error instanceof Error
                  ? profileQuery.error.message
                  : "Unknown error"}
              </div>
            )}

            {/* Profile view */}
            {!editing && profileQuery.data && (
              <section className="space-y-4">
                <div>
                  <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
                    IDENTITY
                  </div>
                  <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                    Your public merchant profile on Nostr
                  </div>
                </div>

                <div className="overflow-hidden rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] shadow-[var(--shadow-glass-inset)]">
                  {/* Banner */}
                  {profileData?.banner ? (
                    <div className="h-32 w-full overflow-hidden sm:h-44">
                      <img
                        src={profileData.banner}
                        alt=""
                        className="h-full w-full object-cover"
                        aria-hidden="true"
                      />
                    </div>
                  ) : (
                    <div className="h-16 w-full bg-gradient-to-r from-[var(--surface-elevated)] to-[var(--surface)]" />
                  )}

                  <div className="px-6 pb-6">
                    {/* Avatar + name row */}
                    <div className="relative -mt-8 flex flex-wrap items-center justify-between gap-3 sm:-mt-10">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-16 w-16 shrink-0 border-4 border-[var(--surface)] sm:h-20 sm:w-20">
                          <AvatarImage
                            src={profileData?.picture}
                            alt={displayName ?? "Profile"}
                          />
                          <AvatarFallback className="bg-[var(--avatar-bg)]">
                            <UserRound className="h-7 w-7 text-[var(--neutral-400)]" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="pt-8 sm:pt-10">
                          <div className="text-base font-semibold text-[var(--text-primary)]">
                            {displayName ?? "Anonymous"}
                          </div>
                          {profileData?.nip05 && (
                            <p className="text-sm text-[var(--text-secondary)]">
                              {profileData.nip05}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end pb-1">
                        {!complete && (
                          <StatusPill variant="warning">
                            Needs completion
                          </StatusPill>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(true)
                            setProfileSaveSucceeded(false)
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    </div>

                    {/* Profile fields */}
                    <div className="mt-5 space-y-3">
                      {profileData?.about && (
                        <div>
                          <div className="text-xs font-medium text-[var(--text-secondary)]">
                            About
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--text-primary)]">
                            {profileData.about}
                          </p>
                        </div>
                      )}
                      {profileData?.lud16 && (
                        <div>
                          <div className="text-xs font-medium text-[var(--text-secondary)]">
                            Lightning Address
                          </div>
                          <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                            {profileData.lud16}
                          </p>
                        </div>
                      )}
                      {profileData?.website && (
                        <div>
                          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                            <Link2 className="h-3.5 w-3.5" />
                            Website
                          </div>
                          <a
                            href={profileData.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 block text-sm text-[var(--accent)] underline-offset-2 hover:underline"
                          >
                            {profileData.website}
                          </a>
                        </div>
                      )}
                      {storefrontUrl && (
                        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                            <Store className="h-3.5 w-3.5" />
                            Conduit Store
                          </div>
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
                            <a
                              href={storefrontUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-[var(--accent)] underline-offset-2 hover:underline"
                            >
                              {storefrontUrl}
                            </a>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                aria-label={
                                  copiedStoreLink
                                    ? "Copied store link"
                                    : "Copy store link"
                                }
                                onClick={copyStorefrontLink}
                                className={[
                                  "inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
                                  copiedStoreLink
                                    ? "border-[var(--success)]/40 bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]"
                                    : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                                ].join(" ")}
                              >
                                {copiedStoreLink ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <a
                                href={storefrontUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="Open Conduit store"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] transition-colors hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </div>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                            Share this direct Market storefront link with buyers
                            even before relay discovery catches up.
                          </p>
                        </div>
                      )}
                      <div className="border-t border-[var(--border)] pt-4">
                        <div className="text-xs font-medium text-[var(--text-secondary)]">
                          Pubkey
                        </div>
                        <div className="mt-1 flex items-start gap-2">
                          <p className="break-all font-mono text-xs text-[var(--text-secondary)]">
                            {npub}
                          </p>
                          <button
                            type="button"
                            aria-label={copiedPubkey ? "Copied" : "Copy npub"}
                            onClick={copyNpub}
                            className={[
                              "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                              copiedPubkey
                                ? "border-[var(--success)]/40 bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]"
                                : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                            ].join(" ")}
                          >
                            {copiedPubkey ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Edit form */}
            {editing && (
              <section className="space-y-4">
                <div>
                  <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
                    IDENTITY
                  </div>
                  <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                    Fields marked{" "}
                    <span className="text-[var(--warning)]">*</span> are
                    required for a complete profile.
                  </div>
                </div>

                <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
                  <div className="flex items-center justify-between pb-4">
                    <span className="text-[1rem] font-semibold text-[var(--text-primary)]">
                      Edit Profile
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(false)
                        setProfileSaveSucceeded(false)
                        if (profileQuery.data) {
                          setForm(profileToFormValues(profileQuery.data))
                        }
                      }}
                    >
                      Cancel
                    </Button>
                  </div>

                  <form
                    className="grid gap-4 md:grid-cols-2"
                    onSubmit={handleSave}
                  >
                    {/* Display Name (required) */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-display-name">
                        Display Name
                        <RequiredMark />
                      </Label>
                      <Input
                        id="profile-display-name"
                        value={form.displayName}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            displayName: e.target.value,
                          }))
                        }
                        placeholder="Satoshi Nakamoto"
                        maxLength={100}
                        className={cn(
                          REQUIRED_FIELDS.includes("displayName") &&
                            !form.displayName
                            ? "border-[var(--warning)]/40 focus-visible:ring-[var(--warning)]/30"
                            : ""
                        )}
                      />
                    </div>

                    {/* Username / name */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-name">Username</Label>
                      <Input
                        id="profile-name"
                        value={form.name}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, name: e.target.value }))
                        }
                        placeholder="satoshi"
                        maxLength={50}
                      />
                    </div>

                    {/* About (required, full width) */}
                    <div className="grid gap-1.5 md:col-span-2">
                      <Label htmlFor="profile-about">
                        About
                        <RequiredMark />
                      </Label>
                      <Textarea
                        id="profile-about"
                        className={cn(
                          "min-h-24 ring-primary/20 transition",
                          REQUIRED_FIELDS.includes("about") && !form.about
                            ? "border-[var(--warning)]/40 focus:ring-[var(--warning)]/30"
                            : ""
                        )}
                        value={form.about}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            about: e.target.value,
                          }))
                        }
                        placeholder="Tell buyers about your store and what you sell"
                        maxLength={500}
                      />
                    </div>

                    {/* Picture URL (required) */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-picture">
                        Profile Picture URL
                        <RequiredMark />
                      </Label>
                      <Input
                        id="profile-picture"
                        type="url"
                        value={form.picture}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            picture: e.target.value,
                          }))
                        }
                        placeholder="https://..."
                        className={cn(
                          REQUIRED_FIELDS.includes("picture") && !form.picture
                            ? "border-[var(--warning)]/40 focus-visible:ring-[var(--warning)]/30"
                            : ""
                        )}
                      />
                    </div>

                    {/* Banner URL */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-banner">Banner Image URL</Label>
                      <Input
                        id="profile-banner"
                        type="url"
                        value={form.banner}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            banner: e.target.value,
                          }))
                        }
                        placeholder="https://..."
                      />
                    </div>

                    {/* NIP-05 */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-nip05">NIP-05 Identifier</Label>
                      <Input
                        id="profile-nip05"
                        value={form.nip05}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            nip05: e.target.value,
                          }))
                        }
                        placeholder="_@your-domain.com"
                        maxLength={100}
                      />
                    </div>

                    {/* Lightning Address */}
                    <div className="grid gap-1.5">
                      <Label htmlFor="profile-lud16">Lightning Address</Label>
                      <Input
                        id="profile-lud16"
                        value={form.lud16}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            lud16: e.target.value,
                          }))
                        }
                        placeholder="name@wallet-provider.com"
                        maxLength={100}
                      />
                    </div>

                    {/* Website */}
                    <div className="grid gap-1.5 md:col-span-2">
                      <Label htmlFor="profile-website">Website</Label>
                      <Input
                        id="profile-website"
                        type="url"
                        value={form.website}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            website: e.target.value,
                          }))
                        }
                        placeholder="https://..."
                      />
                    </div>

                    {/* Preview */}
                    {(form.picture || form.banner || form.displayName) && (
                      <div className="md:col-span-2">
                        <div className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
                          Preview
                        </div>
                        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                          {form.banner ? (
                            <div className="h-24 w-full overflow-hidden">
                              <img
                                src={form.banner}
                                alt=""
                                className="h-full w-full object-cover"
                                aria-hidden="true"
                              />
                            </div>
                          ) : (
                            <div className="h-12 bg-gradient-to-r from-[var(--surface-elevated)] to-[var(--surface)]" />
                          )}
                          <div className="-mt-6 flex items-end gap-3 px-4 pb-3">
                            <Avatar className="h-12 w-12 border-4 border-[var(--surface-elevated)]">
                              <AvatarImage
                                src={form.picture}
                                alt="Avatar preview"
                              />
                              <AvatarFallback className="bg-[var(--avatar-bg)]">
                                <UserRound className="h-5 w-5 text-[var(--neutral-400)]" />
                              </AvatarFallback>
                            </Avatar>
                            <div className="pb-0.5">
                              <div className="text-sm font-semibold text-[var(--text-primary)]">
                                {form.displayName ||
                                  form.name ||
                                  "Display name"}
                              </div>
                              {form.nip05 && (
                                <div className="text-xs text-[var(--text-muted)]">
                                  {form.nip05}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {updateMutation.error && (
                      <div className="md:col-span-2 rounded-2xl border border-[var(--destructive)]/30 bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] p-3 text-sm text-[var(--destructive)]">
                        {updateMutation.error instanceof Error
                          ? updateMutation.error.message
                          : "Failed to update profile"}
                      </div>
                    )}

                    <div className="flex flex-col items-start gap-3 md:col-span-2 md:flex-row md:items-center md:justify-end">
                      <SignedActionStatus
                        state={profileSaveStatus}
                        dirtyMessage="Save changes to publish your merchant profile."
                        awaitingSignatureMessage="Confirm the profile update in your signer. It will show as saved after relay publish finishes."
                        successMessage="Profile signed and saved."
                        errorMessage={
                          updateMutation.error instanceof Error
                            ? updateMutation.error.message
                            : "Failed to update profile"
                        }
                      />
                      <Button
                        type="submit"
                        disabled={
                          updateMutation.isPending || !hasProfileChanges
                        }
                      >
                        {updateMutation.isPending
                          ? "Waiting for signer..."
                          : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </div>
              </section>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
