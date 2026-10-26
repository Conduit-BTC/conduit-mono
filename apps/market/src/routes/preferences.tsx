import { createFileRoute } from "@tanstack/react-router"
import { useOrdinarySettings } from "@conduit/core"
import { OrdinarySettingsPanel } from "@conduit/ui"
export const Route = createFileRoute("/preferences")({
  component: PreferencesPage,
})
function PreferencesPage() {
  const settings = useOrdinarySettings()
  return <OrdinarySettingsPanel settings={settings} />
}
