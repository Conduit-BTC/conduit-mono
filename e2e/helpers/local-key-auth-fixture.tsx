import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import {
  AuthProvider,
  useAuth,
} from "../../packages/core/src/context/AuthContext"

/** Use Vite's normal React imports so the fixture shares the app's dispatcher. */
export async function mountLocalAuthFixture() {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let auth: ReturnType<typeof useAuth>
  let ready!: () => void
  const initialized = new Promise<void>((resolve) => {
    ready = resolve
  })
  function Probe() {
    auth = useAuth()
    useEffect(() => {
      ready()
    }, [])
    return null
  }
  root.render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  )
  await initialized
  return {
    get auth() {
      return auth
    },
    dispose() {
      root.unmount()
      host.remove()
    },
  }
}
