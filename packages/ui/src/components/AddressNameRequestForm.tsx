import { useCallback, useEffect, useRef, useState } from "react"
import { pubkeyToNpub, type BreezAddressState } from "@conduit/core"
import {
  ADDRESS_REQUEST_ACTION,
  type AddressNameRequestStatus,
} from "@conduit/core/wallets/address-name-request"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { Button, Input, Label, Textarea } from "../index"

interface ChallengeApi {
  render(node: HTMLElement, options: Record<string, unknown>): string
  remove(id: string): void
}
type ChallengeWindow = Window & { turnstile?: ChallengeApi }
let loading: Promise<ChallengeApi> | undefined
function loadChallenge(): Promise<ChallengeApi> {
  const existing = (window as ChallengeWindow).turnstile
  if (existing) return Promise.resolve(existing)
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    const fail = () => {
      clearTimeout(timeout)
      script.remove()
      loading = undefined
      reject(new Error("Security check unavailable."))
    }
    const timeout = setTimeout(fail, 20_000)
    script.onerror = fail
    script.onload = () => {
      clearTimeout(timeout)
      const api = (window as ChallengeWindow).turnstile
      if (api) resolve(api)
      else fail()
    }
    document.head.append(script)
  })
  return loading
}
function AddressChallenge({
  siteKey,
  onToken,
}: {
  siteKey: string
  onToken(token: string): void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    let api: ChallengeApi | undefined
    let widget: string | undefined
    const unavailable = () => {
      if (current) {
        onToken("")
        setFailed(true)
      }
    }
    void loadChallenge()
      .then((value) => {
        if (!current || !container.current) return
        api = value
        widget = api.render(container.current, {
          sitekey: siteKey,
          action: ADDRESS_REQUEST_ACTION,
          theme: "auto",
          size: "flexible",
          callback: (token: string) => {
            if (current) {
              setFailed(false)
              onToken(token)
            }
          },
          "expired-callback": unavailable,
          "error-callback": unavailable,
          "timeout-callback": unavailable,
        })
      })
      .catch(unavailable)
    return () => {
      current = false
      if (widget !== undefined) api?.remove(widget)
    }
  }, [siteKey, onToken, retry])
  return (
    <div>
      <div ref={container} />
      {failed && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry security check
        </Button>
      )}
    </div>
  )
}
function AddressRequestFields({
  walletId,
  ownerPubkey,
  name,
  note,
  disabled,
  onName,
  onNote,
}: {
  walletId: string
  ownerPubkey: string
  name: string
  note: string
  disabled: boolean
  onName(value: string): void
  onNote(value: string): void
}) {
  return (
    <>
      {" "}
      <div className="grid gap-1">
        <Label htmlFor={`address-request-name-${walletId}`}>Desired name</Label>
        <div className="flex min-w-0 items-center gap-2">
          <Input
            id={`address-request-name-${walletId}`}
            value={name}
            onChange={(event) => onName(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            maxLength={64}
            required
            disabled={disabled}
            aria-describedby={`address-request-status-${walletId}`}
          />
          <span className="shrink-0">@conduit.cash</span>
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`address-request-owner-${walletId}`}>
          Connected public identity
        </Label>
        <Input
          id={`address-request-owner-${walletId}`}
          value={pubkeyToNpub(ownerPubkey)}
          readOnly
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`address-request-note-${walletId}`}>
          Note for the review team (optional)
        </Label>
        <Textarea
          id={`address-request-note-${walletId}`}
          maxLength={1000}
          value={note}
          disabled={disabled}
          onChange={(event) => onNote(event.target.value)}
        />
      </div>
    </>
  )
}

export function AddressNameRequestForm({
  walletId,
  ownerPubkey,
  submit,
  activate,
  siteKey = import.meta.env?.VITE_ADDRESS_REQUEST_TURNSTILE_SITE_KEY ?? "",
}: {
  walletId: string
  ownerPubkey: string
  submit: NonNullable<UseWalletsReturn["requestAddressName"]>
  activate(name: string): Promise<BreezAddressState>
  siteKey?: string
}) {
  const storageKey = `conduit:address-request:v1:${ownerPubkey}:${walletId}`
  const [name, setName] = useState("")
  const [note, setNote] = useState("")
  const [status, setStatus] = useState<AddressNameRequestStatus | null>(null)
  const [error, setError] = useState("")
  const [activationStatus, setActivationStatus] = useState("")
  const [pending, setPending] = useState(false)
  const [token, setToken] = useState("")
  const [challengeRevision, setChallengeRevision] = useState(0)
  const requestId = useRef<string | null>(null)
  const current = useRef(true)
  useEffect(() => {
    current.current = true
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(storageKey) ?? "null"
      ) as { requestId?: string; name?: string } | null
      if (saved?.requestId && saved.name) {
        requestId.current = saved.requestId
        setName(saved.name)
        setStatus("pending")
      }
    } catch {
      setError(
        "Saved request status is unavailable. Check your request before submitting again."
      )
    }
    return () => {
      current.current = false
    }
  }, [storageKey])
  const onToken = useCallback((value: string) => setToken(value), [])
  const run = async (check: boolean) => {
    if (pending) return
    const desiredName = name.trim().toLowerCase()
    if (
      !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(desiredName) ||
      desiredName.length < 3 ||
      desiredName.length > 64
    ) {
      setError(
        "Use 3–64 lowercase letters, numbers, dots, hyphens or underscores."
      )
      return
    }
    requestId.current ??= crypto.randomUUID()
    setName(desiredName)
    setPending(true)
    setError("")
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ requestId: requestId.current, name: desiredName })
      )
      const next = await submit(walletId, {
        requestId: requestId.current,
        desiredName,
        note,
        token,
        check,
      })
      if (current.current) setStatus(next)
    } catch {
      if (current.current)
        setError("Could not check the request. Retry with the same request.")
    } finally {
      if (current.current) {
        setPending(false)
        setToken("")
        setChallengeRevision((value) => value + 1)
      }
    }
  }
  const messages: Record<AddressNameRequestStatus, string> = {
    not_received:
      "No submission was found. Retry the same request to send it for review.",
    received:
      "Request received. It is awaiting manual review. Submission is not approval.",
    pending:
      "Submission is not confirmed. Check status before submitting again.",
    approved: "Name approved for this wallet. Activate it when you are ready.",
    declined:
      "This name request was declined. Your existing receiving address still works.",
    unavailable:
      "Requests are temporarily unavailable. Your wallet remains usable.",
  }
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border border-[var(--border)] p-3"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        void run(false)
      }}
    >
      <p className="text-pretty text-sm">
        Names are reviewed manually. Your connected identity and wallet sign the
        request. If approved, the name and its public identity binding are
        published.
      </p>
      <AddressRequestFields
        walletId={walletId}
        ownerPubkey={ownerPubkey}
        name={name}
        note={note}
        disabled={
          pending ||
          (status !== null &&
            status !== "unavailable" &&
            status !== "not_received")
        }
        onName={setName}
        onNote={setNote}
      />
      {(!status || status === "unavailable" || status === "not_received") &&
        siteKey && (
          <AddressChallenge
            key={challengeRevision}
            siteKey={siteKey}
            onToken={onToken}
          />
        )}
      {!siteKey && !status && (
        <p role="status" className="text-sm">
          Name requests are not enabled in this build yet.
        </p>
      )}
      <p
        role="status"
        aria-live="polite"
        id={`address-request-status-${walletId}`}
        className="text-pretty text-sm"
      >
        {pending
          ? "Checking your signed request…"
          : status
            ? messages[status]
            : "Submitting a request does not reserve or approve a name."}
      </p>
      {activationStatus && (
        <p role="status" className="text-sm">
          {activationStatus}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(!status || status === "unavailable" || status === "not_received") && (
          <Button
            size="sm"
            type="submit"
            disabled={pending || !token || !name.trim()}
          >
            Submit name request
          </Button>
        )}
        {status && (
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void run(true)}
          >
            Check request status
          </Button>
        )}
        {status === "approved" && (
          <Button
            size="sm"
            type="button"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              setError("")
              try {
                const result = await activate(name)
                if (current.current)
                  setActivationStatus(
                    result.status === "registered" && result.username === name
                      ? "Your approved address is ready."
                      : "Your existing address is preserved. Address activation needs attention."
                  )
              } catch {
                if (current.current)
                  setError(
                    "Address activation is pending. Retry on this wallet."
                  )
              } finally {
                if (current.current) setPending(false)
              }
            }}
          >
            Activate approved address
          </Button>
        )}
      </div>
    </form>
  )
}
