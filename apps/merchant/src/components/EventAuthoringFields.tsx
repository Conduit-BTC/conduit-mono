import { useRef, useState } from "react"
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react"
import { useProductImageUpload } from "@conduit/core"
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { getOrganizerEventTimezoneOptions } from "../lib/event-market-form"

export function EventTimezoneField({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Time zone</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose time zone" />
        </SelectTrigger>
        <SelectContent>
          {getOrganizerEventTimezoneOptions(value).map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function EventBannerField({
  id,
  value,
  title,
  scopeId,
  disabled = false,
  onChange,
  onBusyChange,
}: {
  id: string
  value: string
  title: string
  scopeId: string
  disabled?: boolean
  onChange: (url: string) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const upload = useProductImageUpload()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")
  const [phase, setPhase] = useState("")
  const [showUrl, setShowUrl] = useState(false)
  const [failedFile, setFailedFile] = useState<File | null>(null)
  async function uploadBanner(file: File) {
    const target = upload.target
    if (target.kind !== "configured" && target.kind !== "fallback") return
    setError("")
    setFailedFile(null)
    onBusyChange?.(true)
    try {
      const url = await upload.uploadFile({
        scopeId,
        itemId: `${scopeId}:banner`,
        file,
        target,
        onPhase: setPhase,
      })
      onChange(url)
    } catch (cause) {
      setFailedFile(file)
      setError(
        cause instanceof Error
          ? cause.message
          : "Banner upload failed. Retry this file or add its public URL."
      )
    } finally {
      setPhase("")
      onBusyChange?.(false)
      if (input.current) input.current.value = ""
    }
  }
  const canUpload =
    upload.target.kind === "configured" || upload.target.kind === "fallback"
  return (
    <div
      className="space-y-3"
      role="group"
      aria-label="Event banner (optional)"
    >
      <p className="text-sm font-medium text-[var(--text-primary)]">
        Event banner (optional)
      </p>
      {value ? (
        <img
          src={value}
          alt={`${title || "Event"} banner preview`}
          className="aspect-[3/1] w-full rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] object-contain"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={input}
          id={`${id}-file`}
          aria-label="Choose event banner file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled || upload.isBusy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void uploadBanner(file)
          }}
        />
        <Button
          type="button"
          disabled={disabled || upload.isBusy || !canUpload}
          onClick={() => input.current?.click()}
        >
          <ImagePlus className="size-4" aria-hidden="true" />
          {value ? "Replace banner" : "Add banner"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || upload.isBusy}
          aria-expanded={showUrl}
          aria-controls={`${id}-url-panel`}
          onClick={() => setShowUrl((current) => !current)}
        >
          Add by URL
        </Button>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || upload.isBusy}
            onClick={() => {
              onChange("")
              setError("")
              setFailedFile(null)
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Remove banner
          </Button>
        ) : null}
      </div>
      {showUrl ? (
        <div id={`${id}-url-panel`} className="space-y-1">
          <Label htmlFor={id}>Banner URL</Label>
          <Input
            id={id}
            type="url"
            value={value}
            disabled={disabled || upload.isBusy}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://…"
          />
        </div>
      ) : null}
      <p className="text-pretty text-xs text-[var(--text-muted)]">
        Choose a wide 3:1 image, such as 1800 by 600 px. Keep essential text and
        logos away from the outer edges. The full banner is shown without
        cropping.
      </p>
      <p className="text-pretty text-xs text-[var(--text-muted)]">
        {canUpload ? (
          upload.target.kind === "fallback" ? (
            <>
              Uploads use the public media fallback at{" "}
              <a
                className="underline"
                href="https://blossom.nostr.build/"
                target="_blank"
                rel="noreferrer"
              >
                nostr.build
              </a>
              . One banner can be uploaded per event. Review its{" "}
              <a
                className="underline"
                href="https://account.nostr.build/tos"
                target="_blank"
                rel="noreferrer"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                className="underline"
                href="https://account.nostr.build/privacy"
                target="_blank"
                rel="noreferrer"
              >
                Privacy Policy
              </a>
              .
            </>
          ) : (
            "Uploads use your configured media server."
          )
        ) : (
          <a href="/network" className="underline">
            Configure uploads in Network settings
          </a>
        )}
      </p>
      {phase ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Banner: {phase.replaceAll("_", " ")}
        </p>
      ) : null}
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
          {failedFile ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || upload.isBusy}
              onClick={() => void uploadBanner(failedFile)}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Retry banner upload
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
