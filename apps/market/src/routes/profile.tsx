import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  formatNpub,
  pubkeyToNpub,
  useAuth,
  useProfile,
  useUpdateProfile,
  type Profile,
  type ProfileFormValues,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Input,
  Label,
  SignedActionStatus,
  Textarea,
} from "@conduit/ui"
import { Check, Copy, Globe, PencilLine, UserRound, Zap } from "lucide-react"
import { requireAuth } from "../lib/auth"
import { RichProfileText } from "../components/RichProfileText"

export const Route = createFileRoute("/profile")({
  beforeLoad: () => {
    requireAuth()
  },
  component: ProfilePage,
})

const EMPTY_FORM: ProfileFormValues = {
  name: "",
  displayName: "",
  about: "",
  picture: "",
  banner: "",
  nip05: "",
  lud16: "",
  website: "",
}

function profileToForm(profile: Profile | null | undefined): ProfileFormValues {
  if (!profile) return EMPTY_FORM
  return {
    name: profile.name ?? "",
    displayName: profile.displayName ?? "",
    about: profile.about ?? "",
    picture: profile.picture ?? "",
    banner: profile.banner ?? "",
    nip05: profile.nip05 ?? "",
    lud16: profile.lud16 ?? "",
    website: profile.website ?? "",
  }
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
        {label}
      </div>
      <RichProfileText
        text={value}
        className={`mt-2 text-sm text-[var(--text-primary)] ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  )
}

function ProfilePage() {
  const { pubkey } = useAuth()
  const profileQuery = useProfile(pubkey)
  const updateMutation = useUpdateProfile("market")
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState<ProfileFormValues>(EMPTY_FORM)
  const [profileSaveSucceeded, setProfileSaveSucceeded] = useState(false)

  useEffect(() => {
    if (!profileQuery.data) return
    setForm(profileToForm(profileQuery.data))
  }, [profileQuery.data])

  const displayName =
    profileQuery.data?.displayName?.trim() ||
    profileQuery.data?.name?.trim() ||
    "Your profile"
  const shortPubkey = useMemo(() => formatNpub(pubkey ?? "", 8), [pubkey])
  const fallbackLetter = (displayName?.[0] ?? pubkey?.[0] ?? "?").toUpperCase()
  const savedProfileForm = useMemo(
    () => profileToForm(profileQuery.data),
    [profileQuery.data]
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

  function resetForm(): void {
    setEditing(false)
    setProfileSaveSucceeded(false)
    if (!profileQuery.data) {
      setForm(EMPTY_FORM)
      return
    }
    setForm(profileToForm(profileQuery.data))
  }

  async function copyPubkey(): Promise<void> {
    if (!pubkey) return
    try {
      await navigator.clipboard.writeText(pubkeyToNpub(pubkey))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // no-op
    }
  }

  function handleSave(event: React.FormEvent): void {
    event.preventDefault()
    if (!hasProfileChanges || updateMutation.isPending) return
    setProfileSaveSucceeded(false)
    updateMutation.mutate(
      {
        name: form.name || undefined,
        displayName: form.displayName || undefined,
        about: form.about || undefined,
        picture: form.picture || undefined,
        banner: form.banner || undefined,
        nip05: form.nip05 || undefined,
        lud16: form.lud16 || undefined,
        website: form.website || undefined,
      },
      {
        onSuccess: () => {
          setProfileSaveSucceeded(true)
          setEditing(false)
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Profile
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-[var(--text-secondary)]">
          Manage the Nostr identity buyers and merchants will see across
          Conduit.
        </p>
      </div>

      {profileQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">
          Loading profile…
        </div>
      )}

      {!!profileQuery.error && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load profile:{" "}
          {profileQuery.error instanceof Error
            ? profileQuery.error.message
            : "Unknown error"}
        </div>
      )}

      {!profileQuery.isLoading && (
        <>
          <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <Avatar className="h-20 w-20 shrink-0 border border-[var(--border)]">
                  <AvatarImage
                    src={profileQuery.data?.picture}
                    alt={displayName}
                  />
                  <AvatarFallback className="bg-[var(--surface-elevated)] text-xl text-[var(--text-primary)]">
                    {fallbackLetter}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Your identity
                  </div>
                  <h2 className="mt-2 truncate text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
                    {displayName}
                  </h2>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {profileQuery.data?.nip05 ? (
                      <Badge
                        variant="outline"
                        className="border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]"
                      >
                        {profileQuery.data.nip05}
                      </Badge>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void copyPubkey()}
                      className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <span className="font-mono">{shortPubkey}</span>
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-start gap-2 lg:items-end">
                {editing ? (
                  <>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        variant="outline"
                        className="h-11 px-4 text-sm"
                        onClick={resetForm}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        form="market-profile-form"
                        className="h-11 px-4 text-sm"
                        disabled={
                          updateMutation.isPending || !hasProfileChanges
                        }
                      >
                        {updateMutation.isPending
                          ? "Waiting for signer…"
                          : "Save changes"}
                      </Button>
                    </div>
                    <SignedActionStatus
                      state={profileSaveStatus}
                      dirtyMessage="Save changes to publish your buyer profile."
                      awaitingSignatureMessage="Confirm the profile update in your signer. It will show as saved after relay publish finishes."
                      successMessage="Profile signed and saved."
                      errorMessage={
                        updateMutation.error instanceof Error
                          ? updateMutation.error.message
                          : "Failed to update profile"
                      }
                      className="lg:justify-end"
                    />
                  </>
                ) : (
                  <>
                    <Button
                      className="h-11 px-4 text-sm"
                      onClick={() => {
                        setEditing(true)
                        setProfileSaveSucceeded(false)
                      }}
                    >
                      <PencilLine className="h-4 w-4" />
                      Edit profile
                    </Button>
                    {profileSaveSucceeded && (
                      <SignedActionStatus
                        state="success"
                        successMessage="Profile signed and saved."
                        className="lg:justify-end"
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-6">
              {!editing ? (
                <div className="space-y-6">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      About
                    </div>
                    <RichProfileText
                      text={
                        profileQuery.data?.about?.trim() ||
                        "Add a short note about yourself so merchants know who they are dealing with."
                      }
                      className="mt-3 text-sm leading-7 text-[var(--text-secondary)]"
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {profileQuery.data?.lud16 ? (
                      <Field
                        label="Lightning"
                        value={profileQuery.data.lud16}
                        mono
                      />
                    ) : (
                      <Field
                        label="Lightning"
                        value="No lightning address yet"
                      />
                    )}
                    {profileQuery.data?.website ? (
                      <Field
                        label="Website"
                        value={profileQuery.data.website}
                        mono
                      />
                    ) : (
                      <Field label="Website" value="No website added" />
                    )}
                  </div>
                </div>
              ) : (
                <form
                  id="market-profile-form"
                  className="grid gap-4 md:grid-cols-2"
                  onSubmit={handleSave}
                >
                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-name">Name</Label>
                    <Input
                      id="profile-name"
                      value={form.name}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          name: event.target.value,
                        }))
                      }
                      placeholder="satoshi"
                      maxLength={50}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-display-name">Display name</Label>
                    <Input
                      id="profile-display-name"
                      value={form.displayName}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          displayName: event.target.value,
                        }))
                      }
                      placeholder="Satoshi Nakamoto"
                      maxLength={100}
                    />
                  </div>

                  <div className="grid gap-1.5 md:col-span-2">
                    <Label htmlFor="profile-about">About</Label>
                    <Textarea
                      id="profile-about"
                      className="min-h-28 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
                      value={form.about}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          about: event.target.value,
                        }))
                      }
                      placeholder="A short bio"
                      maxLength={500}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-picture">Picture URL</Label>
                    <Input
                      id="profile-picture"
                      type="url"
                      value={form.picture}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          picture: event.target.value,
                        }))
                      }
                      placeholder="https://..."
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-banner">Banner URL</Label>
                    <Input
                      id="profile-banner"
                      type="url"
                      value={form.banner}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          banner: event.target.value,
                        }))
                      }
                      placeholder="https://..."
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-nip05">NIP-05</Label>
                    <Input
                      id="profile-nip05"
                      value={form.nip05}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          nip05: event.target.value,
                        }))
                      }
                      placeholder="_@your-domain.com"
                      maxLength={100}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="profile-lud16">Lightning address</Label>
                    <Input
                      id="profile-lud16"
                      value={form.lud16}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          lud16: event.target.value,
                        }))
                      }
                      placeholder="name@wallet-provider.com"
                      maxLength={100}
                    />
                  </div>

                  <div className="grid gap-1.5 md:col-span-2">
                    <Label htmlFor="profile-website">Website</Label>
                    <Input
                      id="profile-website"
                      type="url"
                      value={form.website}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          website: event.target.value,
                        }))
                      }
                      placeholder="https://..."
                    />
                  </div>

                  {updateMutation.error && (
                    <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error md:col-span-2">
                      {updateMutation.error instanceof Error
                        ? updateMutation.error.message
                        : "Failed to update profile"}
                    </div>
                  )}
                </form>
              )}
            </section>

            <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
              <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Profile details
                </div>
                <div className="mt-4 space-y-3">
                  <div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                    <UserRound className="mt-0.5 h-4 w-4 text-secondary-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Pubkey
                      </div>
                      <div className="mt-2 font-mono text-xs leading-6 text-[var(--text-secondary)] break-all">
                        {pubkey}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                    <Zap className="mt-0.5 h-4 w-4 text-secondary-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Lightning
                      </div>
                      <RichProfileText
                        text={
                          profileQuery.data?.lud16?.trim() ||
                          "Add a lightning address to make payments and identity easier to verify."
                        }
                        className="mt-2 text-sm text-[var(--text-secondary)]"
                      />
                    </div>
                  </div>

                  <div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                    <Globe className="mt-0.5 h-4 w-4 text-secondary-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Website
                      </div>
                      <RichProfileText
                        text={
                          profileQuery.data?.website?.trim() ||
                          "Add a website if you want merchants to recognize your broader presence."
                        }
                        className="mt-2 text-sm text-[var(--text-secondary)]"
                      />
                    </div>
                  </div>
                </div>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
