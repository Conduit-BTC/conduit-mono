import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  Cloud,
  CircleAlert,
  CircleCheck,
  LockKeyhole,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UnlockKeyhole,
} from "lucide-react"
import {
  DEFAULT_SHOPPER_PRESETS,
  SHIPPING_COUNTRIES,
  SHOPPER_PAYMENT_RAILS,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  shopperShippingPresetSchema,
  type ShopperDisplayCurrency,
  type ShopperPaymentRail,
  type ShopperPresetsValue,
  type ShopperShippingPreset,
} from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Combobox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Switch,
} from "@conduit/ui"
import { useShopperPresets } from "../hooks/useShopperPresets"
import { requireAuth } from "../lib/auth"
import {
  SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS,
  getShopperPreferencesSaveBlockers,
} from "../lib/shopper-preferences-validation"
import type { ShopperPresetsUnlockPolicy } from "../lib/shopper-presets-store"

export const Route = createFileRoute("/preferences")({
  beforeLoad: () => {
    requireAuth()
  },
  component: PreferencesPage,
})

const COUNTRY_OPTIONS = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
  meta: country.code,
  searchText: `${country.code} ${country.name}`,
}))

const PAYMENT_RAIL_LABELS: Record<ShopperPaymentRail, string> = {
  automatic: "Best available",
  nwc: "Nostr Wallet Connect",
  webln: "Browser wallet (WebLN)",
  manual: "External wallet",
}

const EMPTY_SHIPPING_PRESET: ShopperShippingPreset = {
  recipientName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateOrRegion: "",
  postalCode: "",
  country: "US",
  email: "",
  phone: "",
}

function syncStatus(state: ReturnType<typeof useShopperPresets>["syncState"]) {
  switch (state) {
    case "synced":
      return { label: "Encrypted on relays", variant: "success" as const }
    case "ready":
      return { label: "Relay ready", variant: "success" as const }
    case "syncing":
      return { label: "Syncing", variant: "info" as const }
    case "unavailable":
      return { label: "Relay sync unavailable", variant: "warning" as const }
    case "error":
      return { label: "Relay sync failed", variant: "error" as const }
    default:
      return { label: "Connecting", variant: "info" as const }
  }
}

function UnlockPanel({
  presets,
  onReplace,
}: {
  presets: ReturnType<typeof useShopperPresets>
  onReplace: () => void
}) {
  const [password, setPassword] = useState("")
  const [policy, setPolicy] = useState<ShopperPresetsUnlockPolicy>(
    presets.unlockPolicy
  )
  const [message, setMessage] = useState<string | null>(null)
  const busy = presets.unlockState === "unlocking"
  const passwordCharacters = Array.from(password).length

  async function unlock(): Promise<void> {
    setMessage(null)
    const unlocked = await presets.unlock(password, policy)
    if (!unlocked)
      setMessage("The password is incorrect or the preset is invalid.")
    setPassword("")
  }

  return (
    <section>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
          Unlock shipping preset
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
          Enter the password that protects this relay-stored preset.
        </p>
      </div>
      <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] p-5 shadow-[var(--shadow-glass-inset)]">
        <div className="grid max-w-md gap-2">
          <Label htmlFor="preset-unlock-password">Password</Label>
          <Input
            id="preset-unlock-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            maxLength={256}
            className="h-11 rounded-xl"
            onChange={(event) => setPassword(event.target.value)}
          />
          <p
            className={`min-h-5 text-xs leading-5 text-[var(--text-muted)] ${passwordCharacters >= SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS ? "invisible" : ""}`}
            aria-hidden={
              passwordCharacters >= SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS
                ? "true"
                : undefined
            }
          >
            {passwordCharacters === 0
              ? "Required"
              : `Password must contain ${SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS} or more characters.`}
          </p>
        </div>
        <div className="mt-4">
          <UnlockPolicySelect
            value={policy}
            disabled={busy}
            onChange={setPolicy}
          />
        </div>
        {message && (
          <p className="mt-4 text-sm text-[var(--error)]" role="alert">
            {message}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            className="rounded-xl"
            disabled={busy || password.length < 8}
            onClick={() => void unlock()}
          >
            <UnlockKeyhole className="size-4" />
            Unlock
          </Button>
          <Button
            variant="outline"
            className="rounded-xl"
            disabled={busy}
            onClick={onReplace}
          >
            Replace forgotten preset
          </Button>
        </div>
      </div>
    </section>
  )
}

function UnlockPolicySelect({
  value,
  disabled,
  onChange,
}: {
  value: ShopperPresetsUnlockPolicy
  disabled: boolean
  onChange: (value: ShopperPresetsUnlockPolicy) => void
}) {
  return (
    <div className="grid max-w-md gap-2">
      <Label htmlFor="preset-unlock-policy">Unlock preference</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as ShopperPresetsUnlockPolicy)}
      >
        <SelectTrigger id="preset-unlock-policy" className="h-11 rounded-xl">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="device">Remember on this device</SelectItem>
          <SelectItem value="session">
            Remember until this session ends
          </SelectItem>
          <SelectItem value="always">Ask for the password each time</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function PreferencesPage() {
  const presets = useShopperPresets()
  const [draft, setDraft] = useState<ShopperPresetsValue>(presets.preset)
  const [shipping, setShipping] = useState<ShopperShippingPreset>(
    presets.preset.shipping ?? EMPTY_SHIPPING_PRESET
  )
  const [dirty, setDirty] = useState(false)
  const [resetMode, setResetMode] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [policy, setPolicy] = useState<ShopperPresetsUnlockPolicy>(
    presets.unlockPolicy
  )
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const draftIdentityRef = useRef(presets.identityPubkey)
  const currentIdentityRef = useRef(presets.identityPubkey)
  currentIdentityRef.current = presets.identityPubkey
  const status = syncStatus(presets.syncState)
  const busy = presets.syncState === "syncing"
  const locked =
    presets.hasRemotePreset &&
    (presets.unlockState === "locked" || presets.unlockState === "error")
  const countryLabel = useMemo(
    () =>
      SHIPPING_COUNTRIES.find((country) => country.code === shipping.country)
        ?.name ?? "Choose a country",
    [shipping.country]
  )
  const saveBlockers = useMemo(
    () =>
      getShopperPreferencesSaveBlockers({
        shipping,
        password,
        confirmPassword,
        identityConnected: !!presets.identityPubkey,
        relayState: presets.syncState,
      }),
    [
      confirmPassword,
      password,
      presets.identityPubkey,
      presets.syncState,
      shipping,
    ]
  )
  const passwordCharacters = Array.from(password).length
  const passwordHelperText =
    passwordCharacters > 0 &&
    passwordCharacters < SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS
      ? `Password must contain ${SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS} or more characters.`
      : undefined
  const confirmationHelperText =
    confirmPassword && password !== confirmPassword
      ? "Password confirmation must match."
      : undefined

  useEffect(() => {
    if (draftIdentityRef.current !== presets.identityPubkey) {
      draftIdentityRef.current = presets.identityPubkey
      setDraft(DEFAULT_SHOPPER_PRESETS)
      setShipping(EMPTY_SHIPPING_PRESET)
      setDirty(false)
      setResetMode(false)
      setResultMessage(null)
      setPassword("")
      setConfirmPassword("")
      return
    }
    if (dirty || presets.unlockState !== "unlocked") return
    setDraft(presets.preset)
    setShipping(presets.preset.shipping ?? EMPTY_SHIPPING_PRESET)
    setPolicy(presets.unlockPolicy)
  }, [
    dirty,
    presets.identityPubkey,
    presets.preset,
    presets.unlockPolicy,
    presets.unlockState,
  ])

  function updateShipping<K extends keyof ShopperShippingPreset>(
    field: K,
    value: ShopperShippingPreset[K]
  ): void {
    setShipping((current) => ({ ...current, [field]: value }))
    setDirty(true)
    setResultMessage(null)
  }

  async function save(): Promise<void> {
    if (password !== confirmPassword) {
      setResultMessage("The password confirmation does not match.")
      return
    }
    const parsed = shopperShippingPresetSchema.safeParse(shipping)
    if (!parsed.success) {
      setResultMessage("Complete the required shipping address fields.")
      return
    }
    const identity = presets.identityPubkey
    const value = { ...draft, shipping: parsed.data }
    const synced = await presets.save(value, password, policy)
    if (currentIdentityRef.current !== identity) return
    if (synced) {
      setDraft(value)
      setDirty(false)
      setResetMode(false)
      setPassword("")
      setConfirmPassword("")
    }
    setResultMessage(
      synced
        ? "Preset encrypted and saved on your relays."
        : "The preset could not be saved. Check relay access and try again."
    )
  }

  async function clear(): Promise<void> {
    const identity = presets.identityPubkey
    const synced = await presets.clear(password)
    if (currentIdentityRef.current !== identity) return
    if (synced) {
      setDraft(DEFAULT_SHOPPER_PRESETS)
      setShipping(EMPTY_SHIPPING_PRESET)
      setDirty(false)
      setPassword("")
      setConfirmPassword("")
    }
    setClearOpen(false)
    setResultMessage(
      synced
        ? "Preset replaced with an encrypted empty record."
        : "The preset could not be cleared."
    )
  }

  if (locked && !resetMode) {
    return (
      <PreferencesFrame status={status}>
        <UnlockPanel presets={presets} onReplace={() => setResetMode(true)} />
      </PreferencesFrame>
    )
  }

  return (
    <PreferencesFrame status={status}>
      <section>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
            Shipping address
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            Discovery uses only country and postal code. Checkout can prefill
            the complete address.
          </p>
        </div>
        <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="grid gap-4 sm:grid-cols-2">
            <PresetInput
              id="preset-recipient"
              label="Recipient name"
              required
              value={shipping.recipientName}
              autoComplete="name"
              onChange={(value) => updateShipping("recipientName", value)}
            />
            <div className="grid gap-2">
              <Label htmlFor="preset-country">Country</Label>
              <Combobox
                id="preset-country"
                value={shipping.country}
                selectedLabel={countryLabel}
                options={COUNTRY_OPTIONS}
                onValueChange={(value) => updateShipping("country", value)}
                placeholder="Choose a country"
                searchPlaceholder="Search countries"
                emptyText="No supported countries found."
                triggerClassName="h-11 rounded-xl bg-[var(--surface-elevated)]"
                contentClassName="rounded-xl border-[var(--border-overlay)] bg-[var(--surface-overlay)]"
              />
              <div className="min-h-5">
                <p
                  className={`text-xs leading-5 text-[var(--text-muted)] ${shipping.country.trim() ? "invisible" : ""}`}
                  aria-hidden={shipping.country.trim() ? "true" : undefined}
                >
                  Required
                </p>
              </div>
            </div>
            <PresetInput
              id="preset-address-line-1"
              label="Address line 1"
              required
              value={shipping.addressLine1}
              autoComplete="address-line1"
              onChange={(value) => updateShipping("addressLine1", value)}
            />
            <PresetInput
              id="preset-address-line-2"
              label="Address line 2 (optional)"
              value={shipping.addressLine2 ?? ""}
              autoComplete="address-line2"
              onChange={(value) => updateShipping("addressLine2", value)}
            />
            <PresetInput
              id="preset-city"
              label="City"
              required
              value={shipping.city}
              autoComplete="address-level2"
              onChange={(value) => updateShipping("city", value)}
            />
            <PresetInput
              id="preset-region"
              label="State / Province / Region"
              value={shipping.stateOrRegion ?? ""}
              autoComplete="address-level1"
              onChange={(value) => updateShipping("stateOrRegion", value)}
            />
            <PresetInput
              id="preset-postal-code"
              label="Postal / ZIP code"
              required
              value={shipping.postalCode}
              autoComplete="postal-code"
              onChange={(value) => updateShipping("postalCode", value)}
            />
            <PresetInput
              id="preset-email"
              label="Email (optional)"
              value={shipping.email ?? ""}
              type="email"
              autoComplete="email"
              onChange={(value) => updateShipping("email", value)}
            />
            <PresetInput
              id="preset-phone"
              label="Phone (optional)"
              value={shipping.phone ?? ""}
              type="tel"
              autoComplete="tel"
              onChange={(value) => updateShipping("phone", value)}
            />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
          Checkout defaults
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
          Choose the payment path and price display used by Market.
        </p>
        <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="grid gap-5 sm:grid-cols-2 sm:items-end">
            <div className="grid content-start gap-2">
              <Label htmlFor="preset-payment-rail">
                Preferred payment path
              </Label>
              <Select
                value={draft.preferredRail}
                onValueChange={(preferredRail) => {
                  setDraft({
                    ...draft,
                    preferredRail: preferredRail as ShopperPaymentRail,
                  })
                  setDirty(true)
                }}
              >
                <SelectTrigger
                  id="preset-payment-rail"
                  className="h-11 rounded-xl"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHOPPER_PAYMENT_RAILS.map((rail) => (
                    <SelectItem key={rail} value={rail}>
                      {PAYMENT_RAIL_LABELS[rail]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="preset-display-currency">Display currency</Label>
              <Select
                value={draft.display.currency}
                onValueChange={(currency) => {
                  setDraft({
                    ...draft,
                    display: {
                      ...draft.display,
                      currency: currency as ShopperDisplayCurrency,
                    },
                  })
                  setDirty(true)
                }}
              >
                <SelectTrigger
                  id="preset-display-currency"
                  className="h-11 rounded-xl"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_SHOPPER_DISPLAY_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>
                      {currency === "BITCOIN" ? "Bitcoin" : currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex h-11 items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 sm:col-span-2">
              <Label htmlFor="preset-sats-standard" className="cursor-pointer">
                Display Bitcoin amounts in sats
              </Label>
              <Switch
                id="preset-sats-standard"
                checked={draft.display.bitcoinUnit === "sats"}
                onCheckedChange={(enabled) => {
                  setDraft({
                    ...draft,
                    display: {
                      ...draft.display,
                      bitcoinUnit: enabled ? "sats" : "bitcoin",
                    },
                  })
                  setDirty(true)
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
          Encryption
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
          Protect this preset with a password that is separate from your signer.
        </p>
        <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex gap-3 text-sm text-[var(--text-secondary)]">
            <ShieldCheck
              className="mt-0.5 size-5 shrink-0 text-[var(--success)]"
              aria-hidden="true"
            />
            <p className="leading-6">
              Your client encrypts the preset before signing. The signer
              receives only ciphertext. Save this password in a password
              manager.
            </p>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <PresetInput
              id="preset-password"
              label="Encryption password"
              required
              value={password}
              type="password"
              autoComplete="new-password"
              helperText={passwordHelperText}
              helperRows={2}
              maxLength={256}
              onChange={setPassword}
            />
            <PresetInput
              id="preset-password-confirm"
              label="Confirm password"
              required
              value={confirmPassword}
              type="password"
              autoComplete="new-password"
              helperText={confirmationHelperText}
              helperRows={2}
              maxLength={256}
              onChange={setConfirmPassword}
            />
          </div>
          <div className="mt-4">
            <UnlockPolicySelect
              value={policy}
              disabled={busy}
              onChange={setPolicy}
            />
          </div>
        </div>
      </section>

      <div
        id="preferences-save-requirements"
        className="rounded-[1.5rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)]"
        aria-live="polite"
      >
        {saveBlockers.length === 0 ? (
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--success)]">
            <CircleCheck className="size-4" aria-hidden="true" />
            Ready to save
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <CircleAlert
                className="size-4 text-[var(--warning)]"
                aria-hidden="true"
              />
              {saveBlockers.length} save requirement
              {saveBlockers.length === 1 ? "" : "s"} remaining
            </div>
            <ul className="mt-3 space-y-1.5 text-sm leading-6 text-[var(--text-secondary)]">
              {saveBlockers.map((blocker) => (
                <li key={blocker.id}>- {blocker.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {resultMessage && (
        <div
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]"
          role="status"
        >
          {resultMessage}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-5">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl"
            disabled={busy}
            onClick={() => void presets.refresh()}
          >
            <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
            Refresh relays
          </Button>
          {presets.unlockState === "unlocked" && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={presets.lock}
              disabled={busy}
            >
              <LockKeyhole className="size-4" />
              Lock
            </Button>
          )}
          {presets.unlockState === "unlocked" && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => setClearOpen(true)}
              disabled={busy || password.length < 8}
            >
              <Trash2 className="size-4" />
              Clear
            </Button>
          )}
        </div>
        <Button
          className="h-11 rounded-2xl px-5"
          onClick={() => void save()}
          disabled={busy || saveBlockers.length > 0}
          aria-describedby="preferences-save-requirements"
        >
          {busy ? (
            <Cloud className="size-4 animate-pulse" />
          ) : (
            <Save className="size-4" />
          )}
          Save preferences
        </Button>
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear checkout preset?</AlertDialogTitle>
            <AlertDialogDescription>
              This publishes a newer encrypted empty preset. It does not recover
              or expose the old ciphertext.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void clear()}>
              Clear preset
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PreferencesFrame>
  )
}

function PreferencesFrame({
  status,
  children,
}: {
  status: ReturnType<typeof syncStatus>
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--secondary-500)_14%,transparent),transparent_35%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Preferences
                </h1>
                <p className="mt-4 max-w-xl text-base leading-7 text-[var(--text-secondary)]">
                  Save private checkout defaults and use them across sessions
                  and devices.
                </p>
              </div>
              <StatusPill
                variant={status.variant}
                role="status"
                aria-live="polite"
              >
                {status.label}
              </StatusPill>
            </header>
            {children}
          </div>
        </section>
      </div>
    </div>
  )
}

function PresetInput({
  id,
  label,
  value,
  type = "text",
  autoComplete,
  helperText,
  helperRows = 1,
  maxLength,
  required = false,
  onChange,
}: {
  id: string
  label: string
  value: string
  type?: "text" | "email" | "tel" | "password"
  autoComplete?: string
  helperText?: string
  helperRows?: 1 | 2
  maxLength?: number
  required?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required={required}
        className="h-11 rounded-xl"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className={helperRows === 2 ? "min-h-10" : "min-h-5"}>
        {helperText ? (
          <p className="text-xs leading-5 text-[var(--text-muted)]">
            {required && !value.trim() ? "Required" : helperText}
          </p>
        ) : required ? (
          <p
            className={`text-xs leading-5 text-[var(--text-muted)] ${value.trim() ? "invisible" : ""}`}
            aria-hidden={value.trim() ? "true" : undefined}
          >
            Required
          </p>
        ) : null}
      </div>
    </div>
  )
}
