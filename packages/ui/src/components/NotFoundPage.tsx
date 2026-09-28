import { ArrowLeft } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"

import { Button } from "./Button"
import "../styles/not-found.css"

const videoUrl = new URL("../assets/not-found/space-loop.mp4", import.meta.url)
  .href
const posterUrl = new URL(
  "../assets/not-found/space-poster.jpg",
  import.meta.url
).href
const motionQuery = "(prefers-reduced-motion: reduce)"
type NavigatorWithConnection = Navigator & {
  connection?: EventTarget & { saveData?: boolean }
}

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery)
  const connection = (navigator as NavigatorWithConnection).connection
  query.addEventListener("change", callback)
  connection?.addEventListener("change", callback)
  return () => {
    query.removeEventListener("change", callback)
    connection?.removeEventListener("change", callback)
  }
}

function motionAllowed() {
  const connection = (navigator as NavigatorWithConnection).connection
  return !window.matchMedia(motionQuery).matches && !connection?.saveData
}

interface NotFoundPageProps {
  backTo?: string
  backLabel?: string
}

export function NotFoundPage({
  backTo = "/",
  backLabel = "Go home",
}: NotFoundPageProps) {
  const allowMotion = useSyncExternalStore(
    subscribeMotion,
    motionAllowed,
    () => false
  )
  const [failed, setFailed] = useState(false)

  const [videoSource, setVideoSource] = useState<{
    url: string
    signal: AbortSignal
  } | null>(null)

  useEffect(() => {
    if (!allowMotion) return
    const controller = new AbortController()
    let objectUrl: string | undefined

    async function loadVideo() {
      try {
        // Pages lacks range responses. A local blob keeps WebKit looping reliably.
        const response = await fetch(videoUrl, { signal: controller.signal })
        if (!response.ok) throw new Error("Video unavailable")
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setVideoSource({ url: objectUrl, signal: controller.signal })
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }

    void loadVideo()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [allowMotion])

  const showVideo =
    allowMotion && !failed && videoSource && !videoSource.signal.aborted

  return (
    <section className="network-not-found" aria-labelledby="not-found-title">
      <img className="network-not-found__media" src={posterUrl} alt="" />
      {showVideo && (
        <video
          className="network-not-found__media"
          src={videoSource.url}
          poster={posterUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onError={() => setFailed(true)}
        />
      )}
      <div className="network-not-found__shade" />
      <div className="network-not-found__content">
        <p className="network-not-found__code">404 / OUT OF ORBIT</p>
        <h1 id="not-found-title">You have left the network.</h1>
        <p className="network-not-found__description">Let’s get you back.</p>
        <Button size="lg" asChild>
          <a href={backTo}>
            <ArrowLeft size={18} aria-hidden="true" />
            {backLabel}
          </a>
        </Button>
      </div>
    </section>
  )
}
