import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight } from "lucide-react"
import { type BreezAddressState } from "@conduit/core"
import {
  ADDRESS_REQUEST_ACTION,
  type AddressNameRequestStatus,
} from "@conduit/core/wallets/address-name-request"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import {
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../index"

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
    script.defer = true
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      script.remove()
      loading = undefined
      reject(new Error("Security check unavailable."))
    }
    const timeout = window.setTimeout(fail, 20_000)
    script.onerror = fail
    script.onload = () => {
      if (settled) return
      window.clearTimeout(timeout)
      const api = (window as ChallengeWindow).turnstile
      if (api) {
        settled = true
        resolve(api)
      } else {
        fail()
      }
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
          size: "compact",
          appearance: "interaction-only",
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
    <div className="max-w-full">
      <div ref={container} className="w-[150px] max-w-full" />
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
  name,
  disabled,
  onName,
}: {
  walletId: string
  name: string
  disabled: boolean
  onName(value: string): void
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-72 items-center gap-2">
      <Input
        id={`address-request-name-${walletId}`}
        aria-label="Desired name"
        value={name}
        onChange={(event) => onName(event.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        maxLength={64}
        required
        disabled={disabled}
        aria-describedby={`address-request-status-${walletId}`}
        className="min-w-0 flex-1"
      />
      <span className="shrink-0">@conduit.cash</span>
    </div>
  )
}

export function AddressNameRequestForm({
  walletId,
  ownerPubkey,
  submit,
  activate,
  siteKey = import.meta.env?.VITE_ADDRESS_REQUEST_TURNSTILE_SITE_KEY ?? "",
  presentation = "inline",
  walletLabel,
}: {
  walletId: string
  ownerPubkey: string
  submit: NonNullable<UseWalletsReturn["requestAddressName"]>
  activate(name: string): Promise<BreezAddressState>
  siteKey?: string
  presentation?: "inline" | "dialog"
  walletLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const storageKey = `conduit:address-request:v1:${ownerPubkey}:${walletId}`
  const [name, setName] = useState("")
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
    setStatus("pending")
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ requestId: requestId.current, name: desiredName })
      )
      const next = await submit(walletId, {
        requestId: requestId.current,
        desiredName,
        note: "",
        token,
        check,
      })
      if (current.current) setStatus(next)
    } catch {
      if (current.current) {
        setStatus("pending")
        setError(
          "Submission status is uncertain. Check request status before retrying."
        )
      }
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
  const form = (
    <form
      className="grid min-w-0 gap-2"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        void run(false)
      }}
    >
      {presentation === "inline" && (
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          Get your own @conduit.cash address. Names require approval.
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AddressRequestFields
          walletId={walletId}
          name={name}
          disabled={pending || (status !== null && status !== "not_received")}
          onName={(value) => {
            if (
              status === "not_received" &&
              value.trim().toLowerCase() !== name.trim().toLowerCase()
            ) {
              requestId.current = null
              try {
                sessionStorage.removeItem(storageKey)
              } catch {
                setError(
                  "Saved request status is unavailable. Check your request before submitting again."
                )
              }
            }
            setName(value)
          }}
        />
        {(!status || status === "not_received") && (
          <Button
            size="sm"
            type="submit"
            disabled={pending || !token || !name.trim()}
          >
            Request name
          </Button>
        )}
      </div>
      {(!status || status === "not_received") && siteKey && (
        <AddressChallenge
          key={challengeRevision}
          siteKey={siteKey}
          onToken={onToken}
        />
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
            : !siteKey
              ? import.meta.env?.VITE_DEPLOYMENT_PROFILE === "production"
                ? "Name requests are temporarily unavailable."
                : "Preview: requests open after release."
              : "Requests do not reserve names."}
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
      {status && (
        <div className="flex flex-wrap gap-2">
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
      )}
    </form>
  )
  if (presentation === "inline") return form
  if (!siteKey && !status) {
    return (
      <p
        role="status"
        className="text-pretty text-sm text-[var(--warning-text)]"
      >
        {import.meta.env?.VITE_DEPLOYMENT_PROFILE === "production"
          ? "Name requests are temporarily unavailable."
          : "Preview: requests open after release."}
      </p>
    )
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setToken("")
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button className="w-full gap-2">
          {status ? (
            "View address request"
          ) : (
            <span>
              Get my <strong className="font-semibold">@conduit.cash</strong>{" "}
              address
            </span>
          )}
          <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Get my @conduit.cash address</DialogTitle>
          <DialogDescription>
            {walletLabel ? `${walletLabel}. ` : ""}Names require approval.
          </DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  )
}
