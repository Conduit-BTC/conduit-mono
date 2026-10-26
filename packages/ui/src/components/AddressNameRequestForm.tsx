import { useCallback, useEffect, useRef, useState } from "react"
import { ADDRESS_REQUEST_ACTION } from "@conduit/core/wallets/address-name-request"
import { requestEvidence } from "@conduit/core/wallets/address-request-record"
import type { AddressRequestView } from "@conduit/core/wallets/address-request-workflow"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type { BreezAddressState } from "@conduit/core/wallets/breez-lightning-address"
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

function requestStatus(
  view: AddressRequestView | undefined,
  loaded: boolean,
  available: boolean
) {
  const phase = view?.record.phase
  const activation = view?.activation
  const activationMessage =
    activation?.step === "approval"
      ? "Checking current approval…"
      : activation?.step === "registration"
        ? phase === "activating"
          ? "Checking whether registration completed. No additional registration will be sent while its outcome is uncertain."
          : "Checking wallet ownership before registration."
        : activation?.step === "public_lookup"
          ? "Registration confirmed. Public receiving lookup still needs verification before this address can be used."
          : activation?.step === "persistence"
            ? "Address verified. Saving it to your wallet still needs confirmation; your public profile is not updated yet."
            : activation?.step === "profile"
              ? "Address verified. Your public profile still needs confirmation."
              : undefined
  const reasonMessage =
    activation?.reason === "rate_limited"
      ? "The service is limiting lookups."
      : activation?.reason === "invalid_response"
        ? "The service returned invalid address information. Check again later."
        : activation?.reason === "identity_mismatch"
          ? "The returned address does not match this request. Reopen the correct wallet."
          : activation?.reason === "locked"
            ? "Open this wallet to continue."
            : activation?.reason === "invalid_api_key"
              ? "The service rejected authorization. Reconnect the approved account."
              : activation?.reason &&
                  !["registration_pending", "not_found"].includes(
                    activation.reason
                  )
                ? "Address verification is unavailable. Check the wallet and service before trying again."
                : ""
  const message = !loaded
    ? "Restoring your saved request…"
    : phase === "complete"
      ? "Your address is activated and your public profile is updated."
      : activationMessage
        ? activationMessage
        : phase === "registered"
          ? "Address activated. Finish updating your public profile."
          : phase === "activating"
            ? "Activation needs confirmation. Resume to check and finish."
            : phase === "approved"
              ? "Name approved. Activate it when you are ready."
              : phase === "declined"
                ? "Request declined. Your existing receiving address still works."
                : phase === "received"
                  ? "Pending approval. Your existing receiving address still works."
                  : phase === "pending"
                    ? view?.status === "not_received"
                      ? "No submission found. Retry the same saved request."
                      : "Submission is uncertain. Your saved request will be checked again."
                    : !available
                      ? "Name requests are temporarily unavailable."
                      : "Requests do not reserve or approve names."
  return { message, reasonMessage }
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
  onActivated(state: Extract<BreezAddressState, { status: "registered" }>): void
  siteKey?: string
}) {
  const [name, setName] = useState("")
  const [view, setView] = useState<AddressRequestView>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [token, setToken] = useState("")
  const [challengeRevision, setChallengeRevision] = useState(0)
  const generation = useRef(0)
  const operation = useRef<AbortController | undefined>(undefined)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const revision = ++generation.current
    let active = true
    setView(undefined)
    setName("")
    setError("")
    setPending(false)
    setToken("")
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
      generation.current = revision + 1
      operation.current?.abort()
      operation.current = undefined
    }
  }, [submit, walletId, ownerPubkey])
  const retryAt = view?.activation?.retryAt
  useEffect(() => {
    if (!retryAt) return
    setNow(Date.now())
    if (retryAt <= Date.now()) return
    const timer = window.setInterval(() => {
      const time = Date.now()
      setNow(time)
      if (time >= retryAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [retryAt])
  const onToken = useCallback((value: string) => setToken(value), [])
  const apply = (saved: AddressRequestView | undefined) => {
    setView(saved)
    if (saved) setName(requestEvidence(saved.record).desiredName)
    setLoaded(true)
  }
  const run = async (action: "submit" | "check" | "activate") => {
    if (operation.current) return
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
    const revision = generation.current
    const controller = new AbortController()
    operation.current = controller
    const current = () =>
      revision === generation.current && !controller.signal.aborted
    const update = (saved: AddressRequestView | undefined) => {
      if (!current()) return
      apply(saved)
      const address = saved?.activation?.address
      if (address?.publicLookup === "verified") onActivated(address)
    }
    try {
      update(
        action === "activate"
          ? await submit.activate(walletId, {
              signal: controller.signal,
              onProgress: update,
            })
          : action === "check"
            ? await submit.check(walletId)
            : await submit.submit(walletId, { desiredName: name, token })
      )
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error
            ? caught.message
            : "Progress is uncertain. Retry using this saved request."
        )
      // Recover any locally retained progress, including successful registration.
      const saved = current()
        ? await submit.load(walletId).catch(() => undefined) // Keep stronger visible progress on a failed read.
        : undefined
      if (current() && saved) {
        setView((previous) => ({
          ...saved,
          activation: previous?.activation,
        }))
      }
    } finally {
      if (revision === generation.current) {
        setPending(false)
        if (controller.signal.aborted)
          setView((previous) =>
            previous?.activation
              ? {
                  ...previous,
                  activation: { ...previous.activation, exhausted: true },
                }
              : previous
          )
        operation.current = undefined
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
  const activation = view?.activation
  const seconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
  const { message, reasonMessage } = requestStatus(
    view,
    loaded,
    !!siteKey && writesEnabled
  )
  return (
    <form
      className="grid min-w-0 gap-2"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        void run("submit")
      }}
    >
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
              pending || !loaded || !writesEnabled || !token || !name.trim()
            }
          >
            {view ? "Retry same request" : "Request name"}
          </Button>
        )}
      </div>
      {writesEnabled && (!view || retry) && siteKey && (
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
        {pending && !activation ? "Saving and checking your request…" : message}
      </p>
      {phase !== "complete" && activation && (
        <p className="text-sm" role="status">
          {reasonMessage}{" "}
          {pending && seconds > 0
            ? `Checking again in ${seconds}s.`
            : activation.exhausted
              ? `Automatic checks stopped. ${seconds > 0 ? `Try again in ${seconds}s.` : "Check again when you are ready."}`
              : ""}
        </p>
      )}
      {pending && retryAt && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => operation.current?.abort()}
        >
          Stop checking
        </Button>
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
          disabled={pending || !writesEnabled || seconds > 0}
          onClick={() => void run("activate")}
        >
          {phase === "registered"
            ? "Finish profile update"
            : phase === "activating"
              ? "Check activation"
              : "Activate and use address"}
        </Button>
      )}
    </form>
  )
}
