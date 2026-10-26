import { Clipboard, KeyRound } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "./Button"
import { Input } from "./Input"

/** Uncontrolled input: only core's local-key boundary reads import/clipboard text. */
export function LocalKeyImportForm({
  disabled,
  onImport,
  onPaste,
}: {
  disabled: boolean
  onImport: (input: HTMLInputElement) => Promise<void> | void
  onPaste?: (input: HTMLInputElement, signal: AbortSignal) => Promise<boolean>
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const pasteAttempt = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasteStatus, setPasteStatus] = useState<"pasted" | "failed" | null>(
    null
  )
  useEffect(() => {
    const element = input.current
    return () => {
      pasteAttempt.current?.abort()
      pasteAttempt.current = null
      if (element) element.value = ""
    }
  }, [])
  useEffect(() => {
    if (disabled) {
      pasteAttempt.current?.abort()
      setPasting(false)
    }
  }, [disabled])

  function cancelPaste() {
    pasteAttempt.current?.abort()
    pasteAttempt.current = null
    setPasting(false)
    setPasteStatus(null)
  }

  async function paste() {
    if (!input.current || !onPaste || disabled || pending || pasting) return
    const element = input.current
    const attempt = new AbortController()
    pasteAttempt.current = attempt
    setPasting(true)
    setPasteStatus(null)
    try {
      const pasted = await onPaste(element, attempt.signal)
      if (!attempt.signal.aborted && pasted) {
        setPasteStatus("pasted")
        element.focus()
      }
    } catch {
      if (!attempt.signal.aborted) {
        setPasteStatus("failed")
        element.focus()
      }
    } finally {
      if (pasteAttempt.current === attempt) {
        pasteAttempt.current = null
        setPasting(false)
      }
    }
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-primary-400 bg-primary-500/5 p-4"
      data-ph-no-capture
      onSubmit={async (event) => {
        event.preventDefault()
        if (!input.current || disabled || pending) return
        cancelPaste()
        setPending(true)
        setFailed(false)
        try {
          await onImport(input.current)
        } catch {
          setFailed(true)
        } finally {
          setPending(false)
        }
      }}
    >
      <h3 className="flex items-center gap-2 text-base font-semibold text-balance">
        <KeyRound
          className="size-5 shrink-0 text-primary-400"
          aria-hidden="true"
        />
        Sign in with Secret Key
      </h3>
      <label htmlFor={id} className="sr-only">
        Secret Key
      </label>
      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-dialog)] p-0.5">
        <Input
          ref={input}
          id={id}
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent shadow-none"
          disabled={disabled || pending}
          onInput={cancelPaste}
          aria-describedby={`${id}-help`}
          placeholder="Your secret key"
        />
        {onPaste && (
          <Button
            type="button"
            variant="muted"
            size="sm"
            className="min-h-11 shrink-0 gap-1.5 px-3"
            disabled={disabled || pending || pasting}
            onClick={() => void paste()}
            aria-label="Paste secret key from clipboard"
          >
            <Clipboard className="size-4" aria-hidden="true" />
            {pasting ? "Pasting…" : "Paste"}
          </Button>
        )}
      </div>
      <p
        id={`${id}-help`}
        className="text-sm text-pretty text-[var(--text-secondary)]"
      >
        Stay signed in. Your key stays in your browser, not on our servers.
      </p>
      {pasteStatus === "failed" && (
        <p role="alert" className="text-sm text-error-text">
          Clipboard access was blocked or no text was found. Paste directly into
          the field instead.
        </p>
      )}
      <p role="status" className="sr-only">
        {pasteStatus === "pasted" ? "Secret key pasted." : ""}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-error-text">
          Sign-in failed. Check your key and this app’s storage permissions,
          then try again.
        </p>
      )}
      <Button
        type="submit"
        disabled={disabled || pending || pasting}
        className="min-h-11 w-full"
      >
        {pending ? "Signing in…" : "Sign In"}
      </Button>
    </form>
  )
}
