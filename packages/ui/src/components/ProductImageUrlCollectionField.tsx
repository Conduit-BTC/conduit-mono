import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  MAX_PRODUCT_IMAGE_CANDIDATES,
  ProductImageUploadError,
  getProductImageUploadErrorMessage,
  normalizePublicMediaUrl,
  type ProductImage,
  type ProductImageUploadController,
  type ProductImageUploadPhase,
  type ProductImageUploadTarget,
} from "@conduit/core"
import { Badge } from "./Badge"
import { Button } from "./Button"
import { Input } from "./Input"
import { Label } from "./Label"
import { ProductImageFrame } from "./ProductImageFrame"

export interface ProductImageUrlCollectionFieldProps {
  id: string
  images: readonly ProductImage[]
  onChange: (images: ProductImage[]) => void
  previewTitle: string
  showRequiredError?: boolean
  upload?: ProductImageUploadController
  uploadScopeId?: string
  networkSettingsHref?: string
}

type UploadItemStatus =
  "queued" | ProductImageUploadPhase | "cancelled" | "failed"

interface UploadItem {
  id: string
  file: File
  target: Extract<ProductImageUploadTarget, { kind: "configured" | "fallback" }>
  desiredIndex: number
  previewUrl: string | null
  status: UploadItemStatus
  error: string | null
}

const UPLOAD_PROGRESS: Record<
  Exclude<UploadItemStatus, "cancelled" | "failed">,
  number
> = {
  queued: 5,
  preparing: 20,
  awaiting_signature: 45,
  uploading: 70,
  verifying: 90,
  succeeded: 100,
}

function getImageUrlError(
  value: string,
  index: number,
  images: readonly ProductImage[],
  showRequiredError: boolean
): string | null {
  const url = value.trim()
  if (!url) {
    if (!showRequiredError) return null
    return index === 0
      ? "Add a primary image URL."
      : "Add an image URL or remove this row."
  }
  if (!/^https:\/\//i.test(url)) return "Image URL must start with https://"
  if (!normalizePublicMediaUrl(url)) {
    return "Image URL must use a public network destination."
  }
  const normalizedUrl = normalizePublicMediaUrl(url)
  if (
    images.some(
      (image, imageIndex) =>
        imageIndex < index &&
        normalizePublicMediaUrl(image.url) === normalizedUrl
    )
  ) {
    return "Use each image URL only once."
  }
  return null
}

function uploadStatusLabel(status: UploadItemStatus): string {
  switch (status) {
    case "queued":
      return "Waiting to prepare"
    case "preparing":
      return "Preparing privately on this device"
    case "awaiting_signature":
      return "Waiting for upload authorization"
    case "uploading":
      return "Uploading prepared image"
    case "verifying":
      return "Verifying uploaded image"
    case "succeeded":
      return "Verified"
    case "cancelled":
      return "Cancelled"
    case "failed":
      return "Needs attention"
  }
}

function uploadFailureMessage(error: unknown): string {
  if (error instanceof ProductImageUploadError) return error.message
  return getProductImageUploadErrorMessage("upload_failed")
}

function isUploadTargetReady(
  target: ProductImageUploadTarget | undefined
): target is Extract<
  ProductImageUploadTarget,
  { kind: "configured" | "fallback" }
> {
  return target?.kind === "configured" || target?.kind === "fallback"
}

export function ProductImageUrlCollectionField({
  id,
  images,
  onChange,
  previewTitle,
  showRequiredError = false,
  upload,
  uploadScopeId = id,
  networkSettingsHref = "/network",
}: ProductImageUrlCollectionFieldProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null)
  const addUrlButtonRef = useRef<HTMLButtonElement | null>(null)
  const requiredErrorRef = useRef<HTMLParagraphElement | null>(null)
  const imagesRef = useRef<ProductImage[]>([...images])
  const itemsRef = useRef(new Map<string, UploadItem>())
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const objectUrlsRef = useRef(new Set<string>())
  const fallbackReleaseRef = useRef({
    release: upload?.releaseFallbackClaim,
    scopeId: uploadScopeId,
  })
  const disposedRef = useRef(false)
  const nextUploadIdRef = useRef(0)
  const [announcement, setAnnouncement] = useState("")
  const [urlEntryOpen, setUrlEntryOpen] = useState(false)
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([])
  const [fallbackUploadStarted, setFallbackUploadStarted] = useState(false)

  const rows =
    images.length > 0
      ? [...images]
      : urlEntryOpen || !upload
        ? [{ url: "" }]
        : []
  const occupiedSlots =
    rows.filter((image) => image.url.trim().length > 0).length +
    uploadItems.length
  const atLimit = occupiedSlots >= MAX_PRODUCT_IMAGE_CANDIDATES
  const previewImage = rows[0]
    ? { ...rows[0], url: rows[0].url.trim() }
    : undefined
  const uploadReady = isUploadTargetReady(upload?.target)
  const fallbackClaimState =
    upload?.target.kind === "fallback"
      ? upload.getFallbackClaimState(uploadScopeId)
      : "available"
  const fallbackBlocked =
    upload?.target.kind === "fallback" &&
    (fallbackUploadStarted || fallbackClaimState === "consumed")
  const canAddUrl =
    rows.length === 0 ||
    !!normalizePublicMediaUrl(rows.at(-1)?.url.trim() ?? "")
  const missingRequiredImage = showRequiredError && rows.length === 0
  const requiredErrorId = `${id}-required-error`

  useEffect(() => {
    imagesRef.current = [...images]
  }, [images])

  useEffect(() => {
    fallbackReleaseRef.current = {
      release: upload?.releaseFallbackClaim,
      scopeId: uploadScopeId,
    }
  }, [upload?.releaseFallbackClaim, uploadScopeId])

  useEffect(() => {
    if (!missingRequiredImage) return
    const frame = requestAnimationFrame(() => {
      const uploadButton = uploadButtonRef.current
      if (uploadButton && !uploadButton.disabled) {
        uploadButton.focus()
        return
      }
      const addUrlButton = addUrlButtonRef.current
      if (addUrlButton && !addUrlButton.disabled) {
        addUrlButton.focus()
        return
      }
      requiredErrorRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [missingRequiredImage])

  useEffect(() => {
    disposedRef.current = false
    const abortControllers = abortControllersRef.current
    const objectUrls = objectUrlsRef.current
    const items = itemsRef.current
    return () => {
      disposedRef.current = true
      for (const controller of abortControllers.values()) controller.abort()
      const { release, scopeId } = fallbackReleaseRef.current
      for (const itemId of items.keys()) {
        release?.(scopeId, itemId)
      }
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
    }
  }, [])

  function focusInput(index: number): void {
    requestAnimationFrame(() => inputRefs.current[index]?.focus())
  }

  function commitImages(next: ProductImage[]): void {
    if (disposedRef.current) return
    imagesRef.current = next
    onChange(next)
  }

  function updateUrl(index: number, url: string): void {
    const current = rows[index]
    const next = [...rows]
    next[index] = current?.url === url ? current : { ...current, url }
    commitImages(next)
  }

  function addUrl(): void {
    const next = rows.length > 0 ? [...rows, { url: "" }] : [{ url: "" }]
    setUrlEntryOpen(true)
    commitImages(next)
    setAnnouncement(
      next.length === 1
        ? "Opened primary image URL entry."
        : `Added image URL ${next.length}.`
    )
    focusInput(next.length - 1)
  }

  function removeImage(index: number): void {
    if (rows.length === 1) {
      commitImages([])
      setUrlEntryOpen(false)
      setAnnouncement("Cleared the primary image.")
      requestAnimationFrame(() => {
        if (upload && uploadReady) uploadButtonRef.current?.focus()
        else addUrlButtonRef.current?.focus()
      })
      return
    }
    const next = rows.filter((_, rowIndex) => rowIndex !== index)
    commitImages(next)
    setAnnouncement(
      index === 0
        ? "Removed the cover image. The next image is now the cover."
        : `Removed image ${index + 1}.`
    )
    focusInput(Math.max(0, index - 1))
  }

  function moveImage(index: number, direction: -1 | 1): void {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= rows.length) return
    const next = [...rows]
    const current = next[index]
    const target = next[targetIndex]
    if (!current || !target) return
    next[index] = target
    next[targetIndex] = current
    commitImages(next)
    setAnnouncement(
      targetIndex === 0
        ? `Image ${index + 1} is now the cover.`
        : `Moved image ${index + 1} to position ${targetIndex + 1}.`
    )
    focusInput(targetIndex)
  }

  function replaceUploadItem(
    itemId: string,
    update: (item: UploadItem) => UploadItem
  ): void {
    if (disposedRef.current) return
    const current = itemsRef.current.get(itemId)
    if (!current) return
    const next = update(current)
    itemsRef.current.set(itemId, next)
    setUploadItems(Array.from(itemsRef.current.values()))
  }

  function releaseObjectUrl(objectUrl: string | null): void {
    if (!objectUrl) return
    if (!objectUrlsRef.current.delete(objectUrl)) return
    URL.revokeObjectURL(objectUrl)
  }

  function removeUploadItem(itemId: string): void {
    abortControllersRef.current.get(itemId)?.abort()
    abortControllersRef.current.delete(itemId)
    const item = itemsRef.current.get(itemId)
    if (item) releaseObjectUrl(item.previewUrl)
    itemsRef.current.delete(itemId)
    if (upload?.releaseFallbackClaim(uploadScopeId, itemId)) {
      setFallbackUploadStarted(false)
    }
    setUploadItems(Array.from(itemsRef.current.values()))
    setAnnouncement("Removed unfinished image.")
  }

  async function runUpload(itemId: string): Promise<void> {
    const item = itemsRef.current.get(itemId)
    if (!item || item.status === "cancelled" || !upload) return
    const controller = new AbortController()
    abortControllersRef.current.set(itemId, controller)
    replaceUploadItem(itemId, (current) => ({
      ...current,
      status: "preparing",
      error: null,
    }))
    try {
      const verified = await upload.uploadFile({
        scopeId: uploadScopeId,
        itemId,
        file: item.file,
        target: item.target,
        signal: controller.signal,
        onPhase: (phase) => {
          replaceUploadItem(itemId, (current) => ({
            ...current,
            status: phase,
            error: null,
          }))
        },
        onPrepared: (prepared) => {
          if (disposedRef.current || controller.signal.aborted) return
          const preparedUrl = URL.createObjectURL(prepared.blob)
          objectUrlsRef.current.add(preparedUrl)
          replaceUploadItem(itemId, (current) => {
            releaseObjectUrl(current.previewUrl)
            return { ...current, previewUrl: preparedUrl }
          })
        },
      })
      const active = itemsRef.current.get(itemId)
      if (!active || disposedRef.current) return
      const next = [...imagesRef.current]
      const emptyIndex = next.findIndex((image) => !image.url.trim())
      const insertionIndex =
        emptyIndex >= 0
          ? emptyIndex
          : Math.min(active.desiredIndex, next.length)
      if (emptyIndex >= 0) next[emptyIndex] = { url: verified.url }
      else next.splice(insertionIndex, 0, { url: verified.url })
      commitImages(next)
      releaseObjectUrl(active.previewUrl)
      itemsRef.current.delete(itemId)
      setUploadItems(Array.from(itemsRef.current.values()))
      setAnnouncement(
        insertionIndex === 0
          ? "Verified image added as the cover."
          : `Verified image added at position ${insertionIndex + 1}.`
      )
    } catch (error) {
      if (disposedRef.current) return
      const cancelled =
        controller.signal.aborted ||
        (error instanceof ProductImageUploadError && error.code === "cancelled")
      replaceUploadItem(itemId, (current) => ({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        error: cancelled
          ? getProductImageUploadErrorMessage("cancelled")
          : uploadFailureMessage(error),
      }))
      setAnnouncement(
        cancelled
          ? "Image upload cancelled."
          : "Image upload needs attention. Earlier verified images were kept."
      )
    } finally {
      abortControllersRef.current.delete(itemId)
    }
  }

  function selectFiles(files: FileList | null): void {
    const selectedTarget = upload?.target
    if (!files || !isUploadTargetReady(selectedTarget)) return
    const currentImages = imagesRef.current
    const remaining =
      MAX_PRODUCT_IMAGE_CANDIDATES -
      currentImages.filter((image) => image.url.trim().length > 0).length -
      itemsRef.current.size
    const selected = Array.from(files)
    const allowedCount =
      selectedTarget.kind === "fallback"
        ? Math.min(1, remaining)
        : Math.min(selected.length, remaining)
    const accepted = selected.slice(0, allowedCount)
    if (accepted.length === 0) return
    if (selectedTarget.kind === "fallback") setFallbackUploadStarted(true)

    const firstEmptyRow = currentImages.findIndex((image) => !image.url.trim())
    const insertionBase =
      firstEmptyRow >= 0
        ? firstEmptyRow
        : currentImages.length + itemsRef.current.size
    const created = accepted.map((file, index): UploadItem => {
      nextUploadIdRef.current += 1
      const itemId = `${id}-upload-${nextUploadIdRef.current}`
      return {
        id: itemId,
        file,
        target: selectedTarget,
        desiredIndex: insertionBase + index,
        previewUrl: null,
        status: "queued",
        error: null,
      }
    })
    for (const item of created) itemsRef.current.set(item.id, item)
    setUploadItems(Array.from(itemsRef.current.values()))
    setAnnouncement(
      selected.length > accepted.length
        ? `Added ${accepted.length} image for sequential upload. The remaining selection exceeded this listing's current file-upload limit.`
        : created.length === 1
          ? "Added one image for sequential upload."
          : `Added ${created.length} images for sequential upload.`
    )
    for (const item of created) void runUpload(item.id)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function cancelUpload(itemId: string): void {
    const controller = abortControllersRef.current.get(itemId)
    if (controller) controller.abort()
    else {
      replaceUploadItem(itemId, (current) => ({
        ...current,
        status: "cancelled",
        error: getProductImageUploadErrorMessage("cancelled"),
      }))
    }
  }

  function retryUpload(itemId: string): void {
    replaceUploadItem(itemId, (current) => ({
      ...current,
      status: "queued",
      error: null,
    }))
    setAnnouncement("Retrying unfinished image.")
    void runUpload(itemId)
  }

  return (
    <fieldset
      className="grid gap-3"
      aria-invalid={missingRequiredImage || undefined}
      aria-describedby={missingRequiredImage ? requiredErrorId : undefined}
    >
      <legend className="text-sm font-medium text-[var(--text-primary)]">
        Product images
      </legend>

      <div className="grid gap-3">
        {rows.map((image, index) => {
          const inputId = `${id}-${index}`
          const errorId = `${inputId}-error`
          const error = getImageUrlError(
            image.url,
            index,
            rows,
            showRequiredError
          )
          return (
            <div
              key={`${id}-${index}`}
              className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Label htmlFor={inputId} className="truncate text-xs">
                    {index === 0
                      ? "Primary image URL"
                      : `Image ${index + 1} URL`}
                  </Label>
                  {index === 0 ? <Badge variant="outline">Cover</Badge> : null}
                </div>
                <div
                  className="flex shrink-0 items-center gap-1"
                  role="group"
                  aria-label={`Reorder image ${index + 1}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    disabled={index === 0}
                    aria-label={`Move image ${index + 1} up`}
                    onClick={() => moveImage(index, -1)}
                  >
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    disabled={index === rows.length - 1}
                    aria-label={`Move image ${index + 1} down`}
                    onClick={() => moveImage(index, 1)}
                  >
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 text-error"
                    aria-label={
                      rows.length === 1
                        ? "Clear primary image"
                        : `Remove image ${index + 1}`
                    }
                    onClick={() => removeImage(index)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <Input
                ref={(node) => {
                  inputRefs.current[index] = node
                }}
                id={inputId}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={image.url}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => updateUrl(index, event.target.value)}
              />
              {error ? (
                <p
                  id={errorId}
                  className="text-xs leading-5 text-error"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </div>
          )
        })}

        {uploadItems.map((item) => {
          const itemNumber = item.desiredIndex + 1
          const active = !["cancelled", "failed"].includes(item.status)
          const progress =
            item.status === "cancelled" || item.status === "failed"
              ? null
              : UPLOAD_PROGRESS[item.status]
          return (
            <div
              key={item.id}
              className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-[6rem_1fr_auto] sm:items-center"
              aria-busy={active}
            >
              {item.previewUrl ? (
                <img
                  src={item.previewUrl}
                  alt=""
                  className="aspect-[4/3] w-24 rounded-lg bg-[var(--surface-elevated)] object-cover"
                />
              ) : (
                <div
                  className="flex aspect-[4/3] w-24 items-center justify-center rounded-lg bg-[var(--surface-elevated)] text-[var(--text-muted)]"
                  aria-hidden="true"
                >
                  {active ? (
                    <Loader2 className="size-5 motion-safe:animate-spin" />
                  ) : (
                    <X className="size-5" />
                  )}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {uploadStatusLabel(item.status)}
                </p>
                {progress !== null ? (
                  <progress
                    className="mt-2 h-2 w-full accent-primary-500"
                    max={100}
                    value={progress}
                    aria-label={`Image ${itemNumber} upload progress`}
                  />
                ) : null}
                {item.error ? (
                  <p className="mt-2 text-xs leading-5 text-error" role="alert">
                    {item.error}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1 sm:justify-self-end">
                {active ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label={`Cancel image ${itemNumber} upload`}
                    onClick={() => cancelUpload(item.id)}
                  >
                    {item.status === "queued" ? (
                      <X className="size-4" aria-hidden="true" />
                    ) : (
                      <Loader2
                        className="size-4 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Retry image ${itemNumber} upload`}
                      onClick={() => retryUpload(item.id)}
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 text-error"
                      aria-label={`Remove unfinished image ${itemNumber}`}
                      onClick={() => removeUploadItem(item.id)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}

        {missingRequiredImage ? (
          <p
            ref={requiredErrorRef}
            id={requiredErrorId}
            className="text-xs leading-5 text-error"
            role="alert"
            tabIndex={-1}
          >
            Add a product image before publishing.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
        {upload ? (
          <>
            <Input
              ref={fileInputRef}
              id={`${id}-file`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple={upload.target.kind === "configured"}
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => selectFiles(event.target.files)}
            />
            <Button
              ref={uploadButtonRef}
              type="button"
              disabled={
                !uploadReady || atLimit || fallbackBlocked || upload.isBusy
              }
              aria-describedby={
                missingRequiredImage
                  ? `${id}-upload-help ${requiredErrorId}`
                  : `${id}-upload-help`
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add another image
            </Button>
          </>
        ) : null}
        <Button
          ref={addUrlButtonRef}
          type="button"
          variant={upload ? "ghost" : "outline"}
          className="min-h-11"
          disabled={atLimit || !canAddUrl}
          aria-describedby={missingRequiredImage ? requiredErrorId : undefined}
          onClick={addUrl}
        >
          <Plus className="size-4" aria-hidden="true" />
          {upload ? "Add by URL" : "Add another image"}
        </Button>
      </div>

      <p
        id={`${id}-upload-help`}
        className="text-pretty text-xs leading-5 text-[var(--text-muted)]"
      >
        {upload?.target.kind === "configured"
          ? `Prepared images upload one at a time through your first configured media server. Add up to ${MAX_PRODUCT_IMAGE_CANDIDATES}; the first image is the cover.`
          : upload?.target.kind === "fallback" &&
              fallbackClaimState === "retry_same_hash"
            ? "Choose the same image to retry the earlier fallback request. A different file will not be sent. Pasted image URLs remain available."
            : upload?.target.kind === "fallback"
              ? "The public fallback permits one file-backed image for this listing. Pasted image URLs do not count toward that guardrail."
              : upload?.target.kind === "pending"
                ? "Checking your media server settings. Add by URL remains available."
                : upload
                  ? "Connect a signer or repair Network settings to upload files. Add by URL remains available."
                  : `Add images one at a time, up to ${MAX_PRODUCT_IMAGE_CANDIDATES}. The first image is the cover.`}
      </p>

      {upload?.target.kind === "fallback" ? (
        <div className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          <p>
            No safe media server is configured. File upload will use{" "}
            <a
              href="https://nostr.build/"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--text-primary)] underline underline-offset-2"
            >
              nostr.build
            </a>{" "}
            as a third-party public operator through its{" "}
            <a
              href="https://blossom.nostr.build/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Blossom service
            </a>
            . Free public hosting may be limited, unavailable, moderated,
            removed, or subject to retention changes. Conduit does not guarantee
            uptime or permanence.
          </p>
          <p className="mt-2">
            Review nostr.build{" "}
            <a
              href="https://account.nostr.build/tos"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="https://account.nostr.build/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Privacy Policy
            </a>
            . For additional built-in uploads and dedicated hosting, compare{" "}
            <a
              href="https://account.nostr.build/plans"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              plans
            </a>{" "}
            and add the dedicated server root in{" "}
            <a
              href={networkSettingsHref}
              className="underline underline-offset-2"
            >
              Network settings
            </a>
            .
          </p>
        </div>
      ) : null}

      {showRequiredError && rows.length === 0 && uploadItems.length === 0 ? (
        <p className="text-xs leading-5 text-error" role="alert">
          Add at least one product image.
        </p>
      ) : null}

      <div className="grid gap-2">
        <div className="text-xs font-medium text-[var(--text-primary)]">
          Conduit Market card preview
        </div>
        <div className="max-w-sm overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <ProductImageFrame image={previewImage} title={previewTitle} />
        </div>
        <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
          Conduit Market cards use a centered 4:3 crop. The complete image
          appears on the product page. Other Nostr clients may display images
          differently.
        </p>
      </div>

      {occupiedSlots > MAX_PRODUCT_IMAGE_CANDIDATES ? (
        <p className="text-xs leading-5 text-error" role="alert">
          Use {MAX_PRODUCT_IMAGE_CANDIDATES} images or fewer.
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </fieldset>
  )
}
