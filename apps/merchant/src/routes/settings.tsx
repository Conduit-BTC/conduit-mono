import { createFileRoute } from "@tanstack/react-router"
import { useRelaySettings, useNdkState } from "@conduit/core"
import { Badge, RelaySettingsPanel } from "@conduit/ui"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const ndk = useNdkState()
  const { visibleGroups, addRelay, removeRelay, updateRelay, resetToDefaults } = useRelaySettings("merchant")

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Settings</div>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Relay configuration
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
          Configure which relays your merchant portal uses to publish and read commerce events.
          Your merchant relay is the source of truth for your products and orders.
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

      <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-glass-inset)]">
        <RelaySettingsPanel
          groups={visibleGroups}
          onAddRelay={addRelay}
          onRemoveRelay={removeRelay}
          onUpdateRelay={updateRelay}
          onReset={resetToDefaults}
        />
      </section>

      {ndk.connectedRelays.length > 0 && (
        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-6">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Connected relays</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Currently active relay connections from the NDK pool.
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
