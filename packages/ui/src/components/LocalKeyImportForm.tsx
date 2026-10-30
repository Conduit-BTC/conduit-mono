import { Check, Clipboard, KeyRound } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "./Button"
import { Input } from "./Input"
import { clearLocalKeyClipboard } from "./local-key-clipboard"

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
  const clearAttempt = useRef(0)
  const clearing = useRef(false)
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasteStatus, setPasteStatus] = useState<"pasted" | "failed" | null>(
    null
  )
  const [clipboardStatus, setClipboardStatus] = useState<
    "cleared" | "failed" | null
  >(null)
  useEffect(() => {
    const element = input.current
    return () => {
      pasteAttempt.current?.abort()
      pasteAttempt.current = null
      clearAttempt.current += 1
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current)
      if (element) element.value = ""
    }
  }, [])
  useEffect(() => {
    if (disabled) {
      pasteAttempt.current?.abort()
      clearAttempt.current += 1
      setPasting(false)
    }
  }, [disabled])
  function cancelPaste() {
    pasteAttempt.current?.abort()
    pasteAttempt.current = null
    setPasting(false)
    setPasteStatus(null)
  }

  async function clearClipboard(element: HTMLInputElement) {
    const attempt = ++clearAttempt.current
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current)
    setClipboardStatus(null)
    // Never queue another write: a delayed cleanup could erase a later copy.
    if (clearing.current) {
      setClipboardStatus("failed")
      return
    }
    clearing.current = true
    const cleared = await clearLocalKeyClipboard(element)
    clearing.current = false
    // An issued browser write cannot be aborted; only its UI result can retire.
    if (
      clearAttempt.current === attempt &&
      element.isConnected &&
      !element.disabled
    ) {
      setPasteStatus(null)
      setClipboardStatus(cleared ? "cleared" : "failed")
      if (cleared) {
        clipboardTimer.current = setTimeout(() => {
          setClipboardStatus(null)
        }, 3_000)
      }
    }
  }

  async function paste() {
    if (!input.current || !onPaste || disabled || pending || pasting) return
    const element = input.current
    const attempt = new AbortController()
    pasteAttempt.current = attempt
    setPasting(true)
    setPasteStatus(null)
    clearAttempt.current += 1
    setClipboardStatus(null)
    try {
      const pasted = await onPaste(element, attempt.signal)
      if (
        !attempt.signal.aborted &&
        pasted &&
        element.isConnected &&
        !element.disabled
      ) {
        void clearClipboard(element)
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
        clearAttempt.current += 1
        setClipboardStatus((status) => (status === "failed" ? status : null))
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
          onInput={(event) => {
            cancelPaste()
            const native = event.nativeEvent
            if (
              native.isTrusted &&
              "inputType" in native &&
              native.inputType === "insertFromPaste"
            ) {
              void clearClipboard(event.currentTarget)
            }
          }}
          aria-describedby={`${id}-help ${id}-clipboard-help ${id}-clipboard-status`}
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
      <p
        id={`${id}-clipboard-help`}
        className="text-sm text-pretty text-[var(--text-secondary)]"
      >
        Pasting here also clears your clipboard when your browser allows it.
      </p>
      {pasteStatus === "failed" && (
        <p role="alert" className="text-sm text-error-text">
          Clipboard access was blocked or no text was found. Paste directly into
          the field instead.
        </p>
      )}
      <p
        id={`${id}-clipboard-status`}
        role="status"
        aria-atomic="true"
        className="text-sm text-pretty text-[var(--text-secondary)]"
      >
        {clipboardStatus === "cleared" && (
          <>
            <Check className="mr-1 inline size-4" aria-hidden="true" />
            Clipboard cleared.
          </>
        )}
        {clipboardStatus === "failed" &&
          "Couldn’t clear your clipboard. Clear it manually."}
        {!clipboardStatus && pasteStatus === "pasted" && (
          <span className="sr-only">Secret key pasted.</span>
        )}
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
