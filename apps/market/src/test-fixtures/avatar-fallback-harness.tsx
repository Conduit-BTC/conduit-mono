import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ConversationProfilePicture } from "../components/ConversationProfilePicture"

export function mountAvatarFallbackHarness(
  container: HTMLElement,
  src: string
): () => void {
  function AvatarFallbackProbe() {
    const [loadingStatus, setLoadingStatus] = useState("idle")

    return (
      <div data-testid="avatar-fallback-frame" className="h-12 w-12">
        <ConversationProfilePicture
          src={src}
          alt="Broken avatar"
          onLoadingStatusChange={setLoadingStatus}
        />
        <output data-testid="avatar-loading-status">{loadingStatus}</output>
      </div>
    )
  }

  const root = createRoot(container)
  root.render(<AvatarFallbackProbe />)
  return () => root.unmount()
}
