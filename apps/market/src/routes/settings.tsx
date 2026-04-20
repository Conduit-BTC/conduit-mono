import { createFileRoute } from "@tanstack/react-router"
import { useRelaySettings, useNdkState } from "@conduit/core"
import { Badge, RelaySettingsPanel } from "@conduit/ui"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const ndk = useNdkState()
  const { visibleGroups, addRelay, removeRelay, updateRelay, resetToDefaults } = useRelaySettings("shopper")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
          Relay settings
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
          Configure which relays Conduit Market uses to discover products and communicate with merchants.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className="border-[var(--border)] bg-[var(--surface-elevated)]"
        >
          Relay {ndk.status}
        </Badge>
        {ndk.connectedRelays.length > 0 && (
          <Badge variant="outline">
            {ndk.connectedRelays.length} connected
          </Badge>
        )}
      </div>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <RelaySettingsPanel
          groups={visibleGroups}
          onAddRelay={addRelay}
          onRemoveRelay={removeRelay}
          onUpdateRelay={updateRelay}
          onReset={resetToDefaults}
        />
      </section>

      {ndk.connectedRelays.length > 0 && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Connected relays</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Currently active relay connections.
          </p>
          <ul className="mt-3 space-y-1.5">
            {ndk.connectedRelays.map((url) => (
              <li
                key={url}
                className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2"
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                <span className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
                  {url}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
