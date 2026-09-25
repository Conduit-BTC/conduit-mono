import { ArrowLeft, Bitcoin, Pause, Play } from "lucide-react"
import { useRef, useState, useSyncExternalStore } from "react"

import { Button } from "./Button"
import "../styles/not-found.css"

const videoUrl = new URL("../assets/not-found/space-loop.mp4", import.meta.url)
  .href
const posterUrl = new URL(
  "../assets/not-found/space-poster.jpg",
  import.meta.url
).href
const motionQuery = "(prefers-reduced-motion: reduce)"

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

function motionAllowed() {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean }
    }
  ).connection
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
  const videoRef = useRef<HTMLVideoElement>(null)
  const allowMotion = useSyncExternalStore(
    subscribeMotion,
    motionAllowed,
    () => false
  )
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  async function togglePlayback() {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    try {
      await video.play()
    } catch {
      // Autoplay and power-saving policies can reject playback. Keep the poster.
      setPlaying(false)
    }
  }

  return (
    <section className="network-not-found" aria-labelledby="not-found-title">
      <img className="network-not-found__media" src={posterUrl} alt="" />
      {allowMotion && !failed && (
        <video
          ref={videoRef}
          className="network-not-found__media"
          src={videoUrl}
          poster={posterUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onPlaying={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setFailed(true)}
        />
      )}
      <div className="network-not-found__shade" />
      <div className="network-not-found__coin" aria-hidden="true">
        <Bitcoin strokeWidth={1.25} />
      </div>
      <div className="network-not-found__content">
        <p className="network-not-found__code">404 / OUT OF ORBIT</p>
        <h1 id="not-found-title">You have left the network.</h1>
        <p className="network-not-found__description">
          This page is lost in space. Your next connection is closer than you
          think.
        </p>
        <Button size="lg" asChild>
          <a href={backTo}>
            <ArrowLeft size={18} aria-hidden="true" />
            {backLabel}
          </a>
        </Button>
      </div>
      {allowMotion && !failed && (
        <Button
          className="network-not-found__playback"
          variant="outline"
          onClick={() => void togglePlayback()}
          aria-label={
            playing ? "Pause background video" : "Play background video"
          }
        >
          {playing ? (
            <Pause size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
          <span>{playing ? "Pause" : "Play"}</span>
        </Button>
      )}
    </section>
  )
}
