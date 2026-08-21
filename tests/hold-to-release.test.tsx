import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { HoldToReleaseButton } from "@conduit/ui"

const source = readFileSync(
  new URL(
    "../packages/ui/src/components/HoldToReleaseButton.tsx",
    import.meta.url
  ),
  "utf8"
)

describe("HoldToReleaseButton", () => {
  it("renders an accessible idle hold control", () => {
    const html = renderToStaticMarkup(
      <HoldToReleaseButton onHoldComplete={() => undefined}>
        Zap out
      </HoldToReleaseButton>
    )

    expect(html).toContain('data-hold-state="idle"')
    expect(html).toContain("Hold, then release to confirm")
    expect(html).toContain('role="status"')
  })

  it("supports release completion and all required cancellation paths", () => {
    expect(source).toContain('stateRef.current !== "charged"')
    expect(source).toContain("firedRef.current = true")
    expect(source).toContain("onPointerCancel={cancel}")
    expect(source).toContain("onPointerMove={handlePointerMove}")
    expect(source).toContain("releasedInside")
    expect(source).toContain("onLostPointerCapture")
    expect(source).toContain("onBlur={cancel}")
    expect(source).toContain('event.key === "Escape"')
    expect(source).toContain('document.addEventListener("visibilitychange"')
    expect(source).toContain('window.addEventListener("blur", cancel)')
    expect(source).toContain("if (!firedRef.current && haptics) vibrate(0)")
    expect(source).toContain("event.detail === 0")
    expect(source).toContain("activateAssistively()")
  })

  it("clears the native-activation latch on every cancellation path", () => {
    // `cancel()` owns the latch reset, so Escape, blur, visibility loss,
    // pointer cancellation, and disabled transitions cannot leave a stale
    // latch that discards the next assistive `detail: 0` activation.
    const cancelBody = source.slice(
      source.indexOf("const cancel = useCallback"),
      source.indexOf("const arm = useCallback")
    )
    expect(cancelBody).toContain("nativeActivationRef.current = false")
  })

  it("uses progressive browser haptics without requiring vibration support", () => {
    expect(source).toContain("!navigator.vibrate")
    expect(source).toContain("vibrate(8)")
    expect(source).toContain("vibrate(24)")
    expect(source).toContain("vibrate([12, 28, 30])")
    expect(source).toContain("vibrate(0)")
    expect(source).not.toContain("useEffect(() => cancel, [cancel])")
  })
})
