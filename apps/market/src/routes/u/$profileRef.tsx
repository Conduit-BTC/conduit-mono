import { createFileRoute, Navigate } from "@tanstack/react-router"
import { validateIdentitySearch } from "../../lib/identitySearch"
import { resolveProfileReference } from "../../lib/profileRefs"

export const Route = createFileRoute("/u/$profileRef")({
  component: LegacyProfileRedirect,
  validateSearch: validateIdentitySearch,
})

function LegacyProfileRedirect() {
  const { profileRef } = Route.useParams()
  const search = Route.useSearch()
  if (!resolveProfileReference(profileRef)) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
          Identity not found
        </h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          This Nostr identity reference could not be resolved.
        </p>
      </section>
    )
  }
  return (
    <Navigate
      to="/$identityRef"
      params={{ identityRef: profileRef }}
      search={search}
      replace
    />
  )
}
