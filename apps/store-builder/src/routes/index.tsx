import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: BuilderPage,
})

function BuilderPage() {
  return (
    <div className="min-h-screen bg-[var(--background)] px-6 py-10 text-[var(--text-primary)]">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl flex-col justify-center">
        <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
          Conduit
        </div>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          Store Builder is not available yet
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
          Conduit currently supports Market and Merchant Portal. Store Builder
          is a reserved app shell and is not ready for use or support.
        </p>
      </div>
    </div>
  )
}
