import { useLayoutEffect, useRef, useState } from "react"
import type { useOrdinarySettings } from "@conduit/core"
import { bindAccountTheme } from "../theme/runtime"

/** UI-only binding; the app supplies the account controller and owns I/O. */
export function OrdinarySettingsAppearance({
  settings,
}: {
  settings: ReturnType<typeof useOrdinarySettings>
}) {
  const current = useRef(settings)
  useLayoutEffect(() => {
    current.current = settings
  })
  const [error, setError] = useState(false)
  const theme = settings.privateDocument.settings.appearance?.theme ?? "system"
  const language = settings.privateDocument.settings.display?.language
  useLayoutEffect(() => {
    if (!settings.ready) return
    let active = true
    const unbind = bindAccountTheme(theme, (preference) => {
      void current.current
        .changePrivate([{ path: "appearance.theme", value: preference }])
        .then(
          () => {
            if (active) setError(false)
          },
          () => {
            if (active) setError(true)
          }
        )
    })
    return () => {
      active = false
      unbind()
    }
  }, [settings.scope, settings.ready, theme])
  useLayoutEffect(() => {
    if (!settings.ready || !language) return
    const before = document.documentElement.lang
    document.documentElement.lang = language
    return () => {
      document.documentElement.lang = before
    }
  }, [settings.ready, settings.scope, language])
  return error ? (
    <p role="status" className="p-3 text-sm text-[var(--warning-text)]">
      Appearance could not be saved. Open Preferences to review your signer or
      connection.
    </p>
  ) : null
}
