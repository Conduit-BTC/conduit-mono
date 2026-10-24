import { useCallback, useEffect, useRef, useState } from "react"
import {
  ADDRESS_REQUEST_ACTION,
  addressRequestAvailability,
  addressRequestFailureMessage,
} from "@conduit/core/wallets/address-name-request"
import { requestEvidence } from "@conduit/core/wallets/address-request-record"
import type { AddressRequestView } from "@conduit/core/wallets/address-request-workflow"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { Button, Input } from "../index"

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
          retry: "never",
          "refresh-expired": "manual",
          "refresh-timeout": "manual",
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
        <p role="alert" className="text-pretty text-sm">
          Security check unavailable or expired. Retry the check; if it keeps
          failing, open the current preview or production app.
        </p>
      )}
      {failed && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
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
  onActivated,
  siteKey = import.meta.env?.VITE_ADDRESS_REQUEST_TURNSTILE_SITE_KEY ?? "",
}: {
  walletId: string
  ownerPubkey: string
  submit: NonNullable<UseWalletsReturn["requestAddressName"]>
  onActivated(): Promise<void>
  siteKey?: string
}) {
  const [availability, setAvailability] =
    useState<Awaited<ReturnType<typeof addressRequestAvailability>>>()
  useEffect(() => {
    let active = true
    if (siteKey)
      void addressRequestAvailability(fetch).then((status) => {
        if (active) setAvailability(status)
      })
    return () => {
      active = false
    }
  }, [siteKey])
  const [name, setName] = useState("")
  const [view, setView] = useState<AddressRequestView>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [token, setToken] = useState("")
  const [challengeRevision, setChallengeRevision] = useState(0)
  const current = useRef(true)
  useEffect(() => {
    current.current = true
    let active = true
    setLoaded(false)
    void submit.load(walletId).then(
      (saved) => {
        if (!active) return
        setView(saved)
        setName(saved ? requestEvidence(saved.record).desiredName : "")
        setLoaded(true)
      },
      () => {
        if (active)
          setError(
            "Saved request could not be checked. Approve wallet access in your signer, then check again."
          )
      }
    )
    return () => {
      active = false
      current.current = false
    }
  }, [submit, walletId, ownerPubkey])
  const onToken = useCallback((value: string) => setToken(value), [])
  const apply = (saved: AddressRequestView | undefined) => {
    if (!current.current) return
    setView(saved)
    if (saved) setName(requestEvidence(saved.record).desiredName)
    setLoaded(true)
  }
  const run = async (action: "submit" | "check" | "activate") => {
    if (pending) return
    if (
      action === "submit" &&
      !view &&
      (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(name.trim().toLowerCase()) ||
        name.trim().length < 3 ||
        name.trim().length > 64)
    ) {
      setError(
        "Use 3–64 lowercase letters, numbers, dots, hyphens or underscores."
      )
      return
    }
    setPending(true)
    setError("")
    try {
      apply(
        action === "activate"
          ? await submit.activate(walletId)
          : action === "check"
            ? await submit.check(walletId)
            : await submit.submit(walletId, { desiredName: name, token })
      )
    } catch (caught) {
      if (current.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Progress is uncertain. Retry using this saved request."
        )
      // Recover any locally retained progress, including successful registration.
      try {
        apply(await submit.load(walletId))
      } catch {
        /* Keep the stronger visible checkpoint. */
      }
    } finally {
      if (action === "activate") {
        try {
          await onActivated()
        } catch {
          if (current.current)
            setError(
              "Address display could not refresh. Saved progress is retained."
            )
        }
      }
      if (current.current) {
        setPending(false)
        setToken("")
        setChallengeRevision((value) => value + 1)
      }
    }
  }
  const writesEnabled = submit.writesEnabled !== false
  const phase = view?.record.phase
  const unresolved = phase === "pending" || phase === "received"
  const retry =
    unresolved && (view?.status === "not_received" || phase === "pending")
  const failure =
    view?.status &&
    [
      "origin_forbidden",
      "preview_expired",
      "challenge_failed",
      "rate_limited",
      "invalid",
      "unavailable",
    ].includes(view.status)
      ? addressRequestFailureMessage(view.status)
      : undefined
  const readinessFailure =
    availability && availability !== "ready"
      ? addressRequestFailureMessage(availability)
      : undefined

  const message = !loaded
    ? "Restoring your saved request…"
    : phase === "complete"
      ? "Your address is activated and your public profile is updated."
      : phase === "registered"
        ? "Address activated. Finish updating your public profile."
        : phase === "activating"
          ? "Activation needs confirmation. Resume to check and finish."
          : phase === "approved"
            ? "Name approved. Activate it when you are ready."
            : phase === "declined"
              ? "Request declined. Your existing receiving address still works."
              : failure
                ? failure
                : phase === "received"
                  ? "Pending approval. Your existing receiving address still works."
                  : phase === "pending"
                    ? view?.status === "not_received"
                      ? "No submission found. Retry the same saved request."
                      : "Submission is uncertain. Your saved request will be checked again."
                    : !siteKey || !writesEnabled
                      ? "Name requests are temporarily unavailable."
                      : "Requests do not reserve or approve names."
  return (
    <form
      className="grid min-w-0 gap-2"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        void run("submit")
      }}
    >
      {import.meta.env?.VITE_RELEASE_CHANNEL === "preview" && (
        <p className="text-pretty text-sm">
          This preview creates real @conduit.cash name requests. Requests and
          activated addresses carry over to production with your encrypted
          wallet record. Approval is still required.
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AddressRequestFields
          walletId={walletId}
          name={name}
          disabled={pending || !loaded || !!view}
          onName={setName}
        />
        {(!view || retry) && (
          <Button
            size="sm"
            type="submit"
            disabled={
              pending ||
              !loaded ||
              availability !== "ready" ||
              !writesEnabled ||
              !token ||
              !name.trim()
            }
          >
            {view ? "Retry same request" : "Request name"}
          </Button>
        )}
      </div>
      {writesEnabled &&
        availability === "ready" &&
        (!view || retry) &&
        siteKey && (
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
        {pending ? "Saving and checking your request…" : message}
      </p>
      {readinessFailure && (
        <div>
          <p role="alert" className="text-pretty text-sm">
            {readinessFailure}
          </p>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setAvailability(undefined)
              void addressRequestAvailability(fetch).then((status) => {
                if (current.current) setAvailability(status)
              })
            }}
          >
            Check service availability
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {(unresolved || !loaded) && (
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void run("check")}
        >
          Check request status
        </Button>
      )}
      {phase && ["approved", "activating", "registered"].includes(phase) && (
        <Button
          size="sm"
          type="button"
          disabled={pending || !writesEnabled || availability !== "ready"}
          onClick={() => void run("activate")}
        >
          {phase === "registered"
            ? "Finish profile update"
            : "Activate and use address"}
        </Button>
      )}
    </form>
  )
}
