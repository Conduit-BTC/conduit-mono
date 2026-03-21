import { useEffect, useState } from "react"
import { Link2 } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"

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

function ProfilePage() {
  const { pubkey } = useAuth()
  const profileQuery = useProfile(pubkey)
  const updateMutation = useUpdateProfile()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ProfileFormValues>(EMPTY_FORM)

  useEffect(() => {
    if (profileQuery.data) {
      setForm({
        name: profileQuery.data.name ?? "",
        displayName: profileQuery.data.displayName ?? "",
        about: profileQuery.data.about ?? "",
        picture: profileQuery.data.picture ?? "",
        banner: profileQuery.data.banner ?? "",
        nip05: profileQuery.data.nip05 ?? "",
        lud16: profileQuery.data.lud16 ?? "",
        website: profileQuery.data.website ?? "",
      })
    }
  }, [profileQuery.data])

  const displayName = profileQuery.data?.displayName || profileQuery.data?.name
  const fallbackLetter = (displayName?.[0] ?? pubkey?.[0] ?? "?").toUpperCase()

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
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
        onSuccess: () => setEditing(false),
      }
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Profile</div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">Store identity</h1>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
            Edit the merchant profile buyers see across Market and your storefront surfaces.
          </p>
        </div>
      </div>

      {profileQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">Loading profile...</div>
      )}

      {profileQuery.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load profile:{" "}
          {profileQuery.error instanceof Error ? profileQuery.error.message : "Unknown error"}
        </div>
      )}

      {!editing && profileQuery.data && (
        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <CardHeader className="flex-col gap-4 sm:flex-row sm:items-center">
            <Avatar className="h-16 w-16">
              <AvatarImage src={profileQuery.data.picture} alt={displayName ?? "Profile"} />
              <AvatarFallback className="text-lg">{fallbackLetter}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <CardTitle>{displayName ?? "Anonymous"}</CardTitle>
              {profileQuery.data.nip05 && (
                <p className="text-sm text-[var(--text-secondary)]">{profileQuery.data.nip05}</p>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {profileQuery.data.about && (
              <div>
                <div className="text-xs font-medium text-[var(--text-secondary)]">About</div>
                <p className="mt-1 text-sm text-[var(--text-primary)]">{profileQuery.data.about}</p>
              </div>
            )}
            {profileQuery.data.lud16 && (
              <div>
                <div className="text-xs font-medium text-[var(--text-secondary)]">Lightning Address</div>
                <p className="mt-1 text-sm font-mono text-[var(--text-primary)]">{profileQuery.data.lud16}</p>
              </div>
            )}
            {profileQuery.data.website && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                  <Link2 className="h-3.5 w-3.5" />
                  Website
                </div>
                <p className="mt-1 text-sm text-[var(--text-primary)]">{profileQuery.data.website}</p>
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-[var(--text-secondary)]">Pubkey</div>
              <p className="mt-1 text-xs font-mono text-[var(--text-secondary)] break-all">{pubkey}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {editing && (
        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Edit Profile</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(false)
                  if (profileQuery.data) {
                    setForm({
                      name: profileQuery.data.name ?? "",
                      displayName: profileQuery.data.displayName ?? "",
                      about: profileQuery.data.about ?? "",
                      picture: profileQuery.data.picture ?? "",
                      banner: profileQuery.data.banner ?? "",
                      nip05: profileQuery.data.nip05 ?? "",
                      lud16: profileQuery.data.lud16 ?? "",
                      website: profileQuery.data.website ?? "",
                    })
                  }
                }}
              >
                Cancel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSave}>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-name">Name</Label>
                <Input
                  id="profile-name"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="satoshi"
                  maxLength={50}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="profile-display-name">Display Name</Label>
                <Input
                  id="profile-display-name"
                  value={form.displayName}
                  onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                  placeholder="Satoshi Nakamoto"
                  maxLength={100}
                />
              </div>

              <div className="grid gap-1.5 md:col-span-2">
                <Label htmlFor="profile-about">About</Label>
                <textarea
                  id="profile-about"
                  className="min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none ring-primary/20 transition focus:ring-2"
                  value={form.about}
                  onChange={(e) => setForm((prev) => ({ ...prev, about: e.target.value }))}
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
                  onChange={(e) => setForm((prev) => ({ ...prev, picture: e.target.value }))}
                  placeholder="https://..."
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="profile-banner">Banner URL</Label>
                <Input
                  id="profile-banner"
                  type="url"
                  value={form.banner}
                  onChange={(e) => setForm((prev) => ({ ...prev, banner: e.target.value }))}
                  placeholder="https://..."
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="profile-nip05">NIP-05</Label>
                <Input
                  id="profile-nip05"
                  value={form.nip05}
                  onChange={(e) => setForm((prev) => ({ ...prev, nip05: e.target.value }))}
                  placeholder="_@your-domain.com"
                  maxLength={100}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="profile-lud16">Lightning Address</Label>
                <Input
                  id="profile-lud16"
                  value={form.lud16}
                  onChange={(e) => setForm((prev) => ({ ...prev, lud16: e.target.value }))}
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
                  onChange={(e) => setForm((prev) => ({ ...prev, website: e.target.value }))}
                  placeholder="https://..."
                />
              </div>

              {form.picture && (
                <div className="md:col-span-2">
                  <div className="text-xs font-medium text-[var(--text-secondary)] mb-2">Preview</div>
                  <Avatar className="h-20 w-20">
                    <AvatarImage src={form.picture} alt="Avatar preview" />
                    <AvatarFallback className="text-xl">{fallbackLetter}</AvatarFallback>
                  </Avatar>
                </div>
              )}

              {updateMutation.error && (
                <div className="md:col-span-2 rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
                  {updateMutation.error instanceof Error ? updateMutation.error.message : "Failed to update profile"}
                </div>
              )}

              <div className="md:col-span-2 flex items-center justify-end gap-2">
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? "Saving..." : "Save profile"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
