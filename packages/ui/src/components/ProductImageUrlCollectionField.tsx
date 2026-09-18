import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import {
  MAX_PRODUCT_IMAGE_CANDIDATES,
  normalizePublicMediaUrl,
  type ProductImage,
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

export function ProductImageUrlCollectionField({
  id,
  images,
  onChange,
  previewTitle,
  showRequiredError = false,
}: ProductImageUrlCollectionFieldProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  const [announcement, setAnnouncement] = useState("")
  const rows = images.length > 0 ? [...images] : [{ url: "" }]
  const atLimit = rows.length >= MAX_PRODUCT_IMAGE_CANDIDATES
  const lastRowReady = !!normalizePublicMediaUrl(rows.at(-1)?.url)

  function focusInput(index: number): void {
    requestAnimationFrame(() => inputRefs.current[index]?.focus())
  }

  function updateUrl(index: number, url: string): void {
    const current = rows[index]
    const next = [...rows]
    next[index] = current?.url === url ? current : { ...current, url }
    onChange(next)
  }

  function addImage(): void {
    const next = [...rows, { url: "" }]
    onChange(next)
    setAnnouncement(`Added image ${next.length}.`)
    focusInput(next.length - 1)
  }

  function removeImage(index: number): void {
    if (rows.length === 1) {
      onChange([])
      setAnnouncement("Cleared the primary image.")
      focusInput(0)
      return
    }
    const next = rows.filter((_, rowIndex) => rowIndex !== index)
    onChange(next)
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
    onChange(next)
    setAnnouncement(
      targetIndex === 0
        ? `Image ${index + 1} is now the cover.`
        : `Moved image ${index + 1} to position ${targetIndex + 1}.`
    )
    focusInput(targetIndex)
  }

  return (
    <fieldset className="grid gap-3">
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
      </div>

      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={atLimit || !lastRowReady}
        onClick={addImage}
      >
        <Plus className="size-4" aria-hidden="true" />
        Add another image
      </Button>
      <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
        Add images one at a time, up to {MAX_PRODUCT_IMAGE_CANDIDATES}. The
        first image is the cover.
      </p>

      <div className="grid gap-2">
        <div className="text-xs font-medium text-[var(--text-primary)]">
          Conduit Market card preview
        </div>
        <div className="max-w-sm overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <ProductImageFrame image={rows[0]} title={previewTitle} />
        </div>
        <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
          Conduit Market cards use a centered 4:3 crop. The complete image
          appears on the product page. Other Nostr clients may display images
          differently.
        </p>
      </div>

      {rows.length > MAX_PRODUCT_IMAGE_CANDIDATES ? (
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
