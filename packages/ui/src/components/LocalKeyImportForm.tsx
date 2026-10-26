import { useEffect, useId, useRef, useState } from "react"
import { Button } from "./Button"
import { Input } from "./Input"

/** Uncontrolled input: only core's local-key import boundary reads its value. */
export function LocalKeyImportForm({
  disabled,
  onImport,
}: {
  disabled: boolean
  onImport: (input: HTMLInputElement) => Promise<void> | void
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = input.current
    return () => {
      if (element) element.value = ""
    }
  }, [])

  return (
    <form
      className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
      data-ph-no-capture
      onSubmit={async (event) => {
        event.preventDefault()
        if (!input.current || disabled || pending) return
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
      <h3 className="text-balance text-base font-semibold">
        Sign in with nsec
      </h3>
      <label htmlFor={id} className="block text-sm font-medium">
        Existing Nostr secret key
      </label>
      <Input
        ref={input}
        id={id}
        type="password"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled || pending}
        aria-describedby={`${id}-help`}
        placeholder="nsec…"
      />
      <p
        id={`${id}-help`}
        className="text-pretty text-sm text-[var(--text-secondary)]"
      >
        Use an existing account you have backed up. Your key stays in this
        browser for automatic sign-in. This site can use it to sign for you.
        Sign out to remove it here. Keep your backup; Conduit cannot recover it.
        Other browsers, installed apps, Market and Merchant may need separate
        sign-ins.
      </p>
      {failed && (
        <p role="alert" className="text-sm text-error-text">
          Import failed. Check your key and this app’s storage permissions, then
          try again.
        </p>
      )}
      <Button type="submit" disabled={disabled || pending} className="w-full">
        {pending ? "Signing in…" : "Sign in with nsec"}
      </Button>
    </form>
  )
}
