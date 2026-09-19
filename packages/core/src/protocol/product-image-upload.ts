import type { EventTemplate } from "nostr-tools"
import {
  computeBlobSha256,
  createUploadAuth,
  encodeAuthorizationHeader,
  getHashFromURL,
  type BlobDescriptor,
} from "nostr-tools/nipb7"
import { normalizePublicHttpsUrl } from "../network-target-safety"
import {
  loadMediaServerDraft,
  normalizeBlossomServerRoot,
  type MediaServerPreferenceResolution,
} from "./media-server-preferences"
import {
  NostrSignerError,
  type NostrEventSigner,
  type SignedNostrEvent,
} from "./nostr-event-signer"

export const PRODUCT_IMAGE_FALLBACK_SERVER = "https://blossom.nostr.build"
export const PRODUCT_IMAGE_UPLOAD_AUTH_TTL_SECONDS = 5 * 60
export const PRODUCT_IMAGE_SIGNER_TIMEOUT_MS = 60_000
export const PRODUCT_IMAGE_UPLOAD_TIMEOUT_MS = 45_000
export const PRODUCT_IMAGE_VERIFY_TIMEOUT_MS = 30_000
export const MAX_PRODUCT_IMAGE_INPUT_BYTES = 25 * 1024 * 1024
export const MAX_PRODUCT_IMAGE_INPUT_DIMENSION = 8_192
export const MAX_PRODUCT_IMAGE_DECODED_PIXELS = 40_000_000
export const MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION = 4_096
export const MAX_PRODUCT_IMAGE_OUTPUT_PIXELS = 16_000_000
export const MAX_PRODUCT_IMAGE_OUTPUT_BYTES = 8 * 1024 * 1024

const SUPPORTED_PRODUCT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])
const HEX_SHA256 = /^[0-9a-f]{64}$/
const MAX_DESCRIPTOR_BYTES = 64 * 1024

export type ProductImageUploadTarget =
  | {
      kind: "configured"
      serverUrl: string
      maxFileUploads: 12
    }
  | {
      kind: "fallback"
      serverUrl: typeof PRODUCT_IMAGE_FALLBACK_SERVER
      maxFileUploads: 1
    }
  | {
      kind: "pending"
      reason: "loading" | "lookup_incomplete"
    }
  | {
      kind: "unavailable"
      reason: "disconnected" | "malformed_preferences" | "no_signer"
    }

export type ProductImageUploadPhase =
  "preparing" | "awaiting_signature" | "uploading" | "verifying" | "succeeded"

export type ProductImageUploadFailureCode =
  | "unsupported_type"
  | "input_too_large"
  | "dimensions_too_large"
  | "pixel_limit_exceeded"
  | "decode_failed"
  | "encode_failed"
  | "output_too_large"
  | "target_pending"
  | "target_unavailable"
  | "fallback_limit_reached"
  | "fallback_retry_mismatch"
  | "fallback_guard_unavailable"
  | "signer_rejected"
  | "signer_timeout"
  | "signer_unavailable"
  | "authority_changed"
  | "auth_invalid"
  | "payment_required"
  | "policy_rejected"
  | "size_rejected"
  | "type_rejected"
  | "rate_limited"
  | "upload_timeout"
  | "upload_failed"
  | "descriptor_invalid"
  | "resource_unavailable"
  | "integrity_failed"
  | "cancelled"

export type ProductImageUploadOutcome =
  "not_attempted" | "definitive_rejection" | "ambiguous" | "accepted_unverified"

export class ProductImageUploadError extends Error {
  constructor(
    readonly code: ProductImageUploadFailureCode,
    message: string,
    readonly uploadOutcome: ProductImageUploadOutcome = "not_attempted"
  ) {
    super(message)
    this.name = "ProductImageUploadError"
  }
}

export interface PreparedProductImage {
  blob: Blob
  sha256: string
  size: number
  mimeType: string
  width: number
  height: number
}

export interface ProductImageSourceMetadata {
  width: number
  height: number
  animated: boolean
}

export interface VerifiedProductImageUpload {
  url: string
  sha256: string
  size: number
  mimeType: string
  width: number
  height: number
  targetKind: "configured" | "fallback"
}

export interface PrepareProductImageDependencies {
  signal?: AbortSignal
  inspectMetadata?: (
    file: File,
    mimeType: string
  ) => Promise<ProductImageSourceMetadata>
  decodeAndEncode?: (
    file: File,
    mimeType: string,
    sourceMetadata: ProductImageSourceMetadata
  ) => Promise<{ blob: Blob; width: number; height: number }>
}

export interface UploadPreparedProductImageDependencies {
  fetch?: typeof fetch
  now?: () => number
  signerTimeoutMs?: number
  uploadTimeoutMs?: number
  verifyTimeoutMs?: number
}

export interface UploadPreparedProductImageInput {
  prepared: PreparedProductImage
  target: Extract<ProductImageUploadTarget, { kind: "configured" | "fallback" }>
  expectedPubkey: string
  signer: NostrEventSigner
  shouldContinue?: () => boolean
  signal?: AbortSignal
  onPhase?: (phase: Exclude<ProductImageUploadPhase, "preparing">) => void
  dependencies?: UploadPreparedProductImageDependencies
}

function uploadError(
  code: ProductImageUploadFailureCode,
  message: string,
  outcome: ProductImageUploadOutcome = "not_attempted"
): ProductImageUploadError {
  return new ProductImageUploadError(code, message, outcome)
}

function normalizedMimeType(value: string | null | undefined): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

export function getProductImageUploadErrorMessage(
  code: ProductImageUploadFailureCode
): string {
  switch (code) {
    case "unsupported_type":
      return "Choose a JPEG, PNG, or WebP still image."
    case "input_too_large":
      return "That source image is too large to prepare safely."
    case "dimensions_too_large":
      return "That image has dimensions that are too large to prepare safely."
    case "pixel_limit_exceeded":
      return "That image contains too many pixels to prepare safely."
    case "decode_failed":
      return "Conduit could not read that image on this device."
    case "encode_failed":
      return "Conduit could not prepare a private local copy of that image."
    case "output_too_large":
      return "The prepared image is still too large to upload."
    case "target_pending":
      return "Wait for media server settings to finish loading."
    case "target_unavailable":
      return "Image upload is unavailable. Add an image URL or repair Network settings."
    case "fallback_limit_reached":
      return "The public fallback permits one file upload for this listing. Add more images by URL or configure a media server."
    case "fallback_retry_mismatch":
      return "Choose the same image you previously tried to upload. A different file cannot replace an upload with an unknown outcome."
    case "fallback_guard_unavailable":
      return "The public fallback could not preserve retry safety on this device. Add by URL or configure a media server."
    case "signer_rejected":
      return "The signer rejected the image upload authorization."
    case "signer_timeout":
      return "The signer did not answer the image upload authorization in time."
    case "signer_unavailable":
      return "Reconnect the external signer, then retry this image."
    case "authority_changed":
      return "The connected signer changed. Recheck the account, then retry."
    case "auth_invalid":
      return "The media server rejected the upload authorization."
    case "payment_required":
      return "This media server requires payment for the upload. No payment was made."
    case "policy_rejected":
      return "This media server rejected the image under its upload policy."
    case "size_rejected":
      return "This media server rejected the prepared image size."
    case "type_rejected":
      return "This media server rejected the prepared image type."
    case "rate_limited":
      return "This media server is rate limiting uploads. Retry later."
    case "upload_timeout":
      return "The upload timed out. Retry this image."
    case "upload_failed":
      return "The upload did not finish. Retry this image."
    case "descriptor_invalid":
      return "The media server returned an invalid image record."
    case "resource_unavailable":
      return "The uploaded image could not be retrieved for verification."
    case "integrity_failed":
      return "The uploaded image did not match the prepared local copy."
    case "cancelled":
      return "Image upload cancelled."
  }
}

export function resolveProductImageUploadTarget(input: {
  owner: string | null
  resolution?: MediaServerPreferenceResolution | null
  localServerUrls?: readonly string[]
  signerAvailable: boolean
}): ProductImageUploadTarget {
  if (!input.owner) {
    return { kind: "unavailable", reason: "disconnected" }
  }
  if (!input.signerAvailable) {
    return { kind: "unavailable", reason: "no_signer" }
  }

  const localServer = input.localServerUrls
    ?.map(normalizeBlossomServerRoot)
    .find((serverUrl): serverUrl is string => !!serverUrl)
  if (localServer) {
    return {
      kind: "configured",
      serverUrl: localServer,
      maxFileUploads: 12,
    }
  }

  const resolution = input.resolution
  if (!resolution) return { kind: "pending", reason: "loading" }

  const publishedServer = resolution.publishedServerUrls
    .map(normalizeBlossomServerRoot)
    .find((serverUrl): serverUrl is string => !!serverUrl)
  const retainedPublishedServerIsSupersededByEmpty = (() => {
    const frontier = resolution.frontier
    const published = resolution.publishedRevision
    if (frontier?.state !== "empty") return false
    if (!published) return true
    if (frontier.createdAt !== published.createdAt) {
      return frontier.createdAt > published.createdAt
    }
    return frontier.eventId.localeCompare(published.eventId) < 0
  })()
  if (
    publishedServer &&
    (resolution.status === "published" ||
      resolution.status === "lookup_partial" ||
      resolution.status === "lookup_unavailable" ||
      resolution.status === "malformed" ||
      (resolution.status === "not_observed" &&
        resolution.retained &&
        !retainedPublishedServerIsSupersededByEmpty))
  ) {
    return {
      kind: "configured",
      serverUrl: publishedServer,
      maxFileUploads: 12,
    }
  }

  if (
    resolution.coverage !== "complete" ||
    resolution.status === "lookup_partial" ||
    resolution.status === "lookup_unavailable"
  ) {
    return { kind: "pending", reason: "lookup_incomplete" }
  }
  if (resolution.status === "malformed") {
    return { kind: "unavailable", reason: "malformed_preferences" }
  }
  if (resolution.status === "not_observed" || resolution.status === "empty") {
    return {
      kind: "fallback",
      serverUrl: PRODUCT_IMAGE_FALLBACK_SERVER,
      maxFileUploads: 1,
    }
  }
  return { kind: "pending", reason: "lookup_incomplete" }
}

export function readLocalProductImageServerUrls(owner: string): string[] {
  return loadMediaServerDraft(owner)?.serverUrls ?? []
}

export function getPreparedProductImageDimensions(input: {
  width: number
  height: number
}): { width: number; height: number } {
  const { width, height } = input
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw uploadError(
      "decode_failed",
      getProductImageUploadErrorMessage("decode_failed")
    )
  }
  if (
    width > MAX_PRODUCT_IMAGE_INPUT_DIMENSION ||
    height > MAX_PRODUCT_IMAGE_INPUT_DIMENSION
  ) {
    throw uploadError(
      "dimensions_too_large",
      getProductImageUploadErrorMessage("dimensions_too_large")
    )
  }
  if (width * height > MAX_PRODUCT_IMAGE_DECODED_PIXELS) {
    throw uploadError(
      "pixel_limit_exceeded",
      getProductImageUploadErrorMessage("pixel_limit_exceeded")
    )
  }

  const scale = Math.min(
    1,
    MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION / width,
    MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION / height,
    Math.sqrt(MAX_PRODUCT_IMAGE_OUTPUT_PIXELS / (width * height))
  )
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || normalizedMimeType(blob.type) !== mimeType) {
          reject(
            uploadError(
              "encode_failed",
              getProductImageUploadErrorMessage("encode_failed")
            )
          )
          return
        }
        resolve(blob)
      },
      mimeType,
      mimeType === "image/png" ? undefined : 0.88
    )
  })
}

function invalidSourceImage(): never {
  throw uploadError(
    "decode_failed",
    getProductImageUploadErrorMessage("decode_failed")
  )
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string
): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 > bytes.byteLength) invalidSourceImage()
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function inspectPng(bytes: Uint8Array): ProductImageSourceMetadata {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (
    bytes.byteLength < 33 ||
    signature.some((value, index) => bytes[index] !== value) ||
    !matchesAscii(bytes, 12, "IHDR")
  ) {
    invalidSourceImage()
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  let animated = false
  let offset = 8
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset)
    const chunkEnd = offset + 12 + chunkLength
    if (chunkEnd > bytes.byteLength) invalidSourceImage()
    if (matchesAscii(bytes, offset + 4, "acTL")) animated = true
    offset = chunkEnd
  }
  if (offset !== bytes.byteLength) invalidSourceImage()
  return { width, height, animated }
}

function inspectJpeg(bytes: Uint8Array): ProductImageSourceMetadata {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    invalidSourceImage()
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) break
    const marker = bytes[offset]!
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) invalidSourceImage()
    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      invalidSourceImage()
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame) {
      if (segmentLength < 7) invalidSourceImage()
      return {
        width: view.getUint16(offset + 5),
        height: view.getUint16(offset + 3),
        animated: false,
      }
    }
    offset += segmentLength
  }
  invalidSourceImage()
}

function inspectWebp(bytes: Uint8Array): ProductImageSourceMetadata {
  if (
    bytes.byteLength < 20 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    invalidSourceImage()
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riffSize = view.getUint32(4, true)
  if (riffSize + 8 > bytes.byteLength) invalidSourceImage()
  let width = 0
  let height = 0
  let animated = false
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunkSize = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    const chunkEnd = dataOffset + chunkSize
    if (chunkEnd > bytes.byteLength) invalidSourceImage()
    if (matchesAscii(bytes, offset, "VP8X")) {
      if (chunkSize < 10) invalidSourceImage()
      animated ||= (bytes[dataOffset]! & 0x02) !== 0
      width = readUint24LE(bytes, dataOffset + 4) + 1
      height = readUint24LE(bytes, dataOffset + 7) + 1
    } else if (matchesAscii(bytes, offset, "VP8 ") && !width) {
      if (
        chunkSize < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        invalidSourceImage()
      }
      width = view.getUint16(dataOffset + 6, true) & 0x3fff
      height = view.getUint16(dataOffset + 8, true) & 0x3fff
    } else if (matchesAscii(bytes, offset, "VP8L") && !width) {
      if (chunkSize < 5 || bytes[dataOffset] !== 0x2f) invalidSourceImage()
      const dimensions = view.getUint32(dataOffset + 1, true)
      width = (dimensions & 0x3fff) + 1
      height = ((dimensions >>> 14) & 0x3fff) + 1
    } else if (
      matchesAscii(bytes, offset, "ANIM") ||
      matchesAscii(bytes, offset, "ANMF")
    ) {
      animated = true
    }
    offset = chunkEnd + (chunkSize % 2)
  }
  if (!width || !height) invalidSourceImage()
  return { width, height, animated }
}

export function inspectProductImageBytes(
  bytes: Uint8Array,
  mimeType: string
): ProductImageSourceMetadata {
  const normalizedType = normalizedMimeType(mimeType)
  if (normalizedType === "image/png") return inspectPng(bytes)
  if (normalizedType === "image/jpeg") return inspectJpeg(bytes)
  if (normalizedType === "image/webp") return inspectWebp(bytes)
  invalidSourceImage()
}

async function inspectProductImageFile(
  file: File,
  mimeType: string
): Promise<ProductImageSourceMetadata> {
  return inspectProductImageBytes(
    new Uint8Array(await file.arrayBuffer()),
    mimeType
  )
}

async function decodeWithImageElement(file: File): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}> {
  if (typeof document === "undefined") {
    throw uploadError(
      "decode_failed",
      getProductImageUploadErrorMessage("decode_failed")
    )
  }
  const objectUrl = URL.createObjectURL(file)
  const image = document.createElement("img")
  image.decoding = "async"
  image.src = objectUrl
  try {
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    }
  } catch {
    URL.revokeObjectURL(objectUrl)
    throw uploadError(
      "decode_failed",
      getProductImageUploadErrorMessage("decode_failed")
    )
  }
}

async function decodeAndEncodeProductImage(
  file: File,
  mimeType: string,
  sourceMetadata: ProductImageSourceMetadata
): Promise<{ blob: Blob; width: number; height: number }> {
  if (typeof document === "undefined") {
    throw uploadError(
      "decode_failed",
      getProductImageUploadErrorMessage("decode_failed")
    )
  }
  let source: CanvasImageSource
  let sourceWidth: number
  let sourceHeight: number
  let cleanup = (): void => {}
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      })
      source = bitmap
      sourceWidth = bitmap.width
      sourceHeight = bitmap.height
      const matchesHeader =
        (bitmap.width === sourceMetadata.width &&
          bitmap.height === sourceMetadata.height) ||
        (bitmap.width === sourceMetadata.height &&
          bitmap.height === sourceMetadata.width)
      if (!matchesHeader) {
        bitmap.close()
        invalidSourceImage()
      }
      cleanup = () => bitmap.close()
    } catch {
      const decoded = await decodeWithImageElement(file)
      source = decoded.source
      sourceWidth = decoded.width
      sourceHeight = decoded.height
      cleanup = decoded.cleanup
    }
  } else {
    const decoded = await decodeWithImageElement(file)
    source = decoded.source
    sourceWidth = decoded.width
    sourceHeight = decoded.height
    cleanup = decoded.cleanup
  }

  try {
    const matchesHeader =
      (sourceWidth === sourceMetadata.width &&
        sourceHeight === sourceMetadata.height) ||
      (sourceWidth === sourceMetadata.height &&
        sourceHeight === sourceMetadata.width)
    if (!matchesHeader) invalidSourceImage()
    const output = getPreparedProductImageDimensions({
      width: sourceWidth,
      height: sourceHeight,
    })
    const canvas = document.createElement("canvas")
    canvas.width = output.width
    canvas.height = output.height
    const context = canvas.getContext("2d", {
      alpha: mimeType !== "image/jpeg",
    })
    if (!context) {
      throw uploadError(
        "encode_failed",
        getProductImageUploadErrorMessage("encode_failed")
      )
    }
    context.drawImage(source, 0, 0, output.width, output.height)
    return {
      blob: await canvasToBlob(canvas, mimeType),
      width: output.width,
      height: output.height,
    }
  } finally {
    cleanup()
  }
}

export async function prepareProductImageFile(
  file: File,
  dependencies: PrepareProductImageDependencies = {}
): Promise<PreparedProductImage> {
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal)
  const waitForPreparation = <T>(promise: Promise<T>): Promise<T> =>
    dependencies.signal
      ? awaitWithSignal(promise, dependencies.signal, () =>
          abortError(dependencies.signal)
        )
      : promise
  const mimeType = normalizedMimeType(file.type)
  if (!SUPPORTED_PRODUCT_IMAGE_TYPES.has(mimeType)) {
    throw uploadError(
      "unsupported_type",
      getProductImageUploadErrorMessage("unsupported_type")
    )
  }
  if (file.size <= 0 || file.size > MAX_PRODUCT_IMAGE_INPUT_BYTES) {
    throw uploadError(
      "input_too_large",
      getProductImageUploadErrorMessage("input_too_large")
    )
  }

  let sourceMetadata: ProductImageSourceMetadata
  try {
    sourceMetadata = await waitForPreparation(
      (dependencies.inspectMetadata ?? inspectProductImageFile)(file, mimeType)
    )
  } catch (error) {
    if (error instanceof ProductImageUploadError) throw error
    throw uploadError(
      "decode_failed",
      getProductImageUploadErrorMessage("decode_failed")
    )
  }
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal)
  if (sourceMetadata.animated) {
    throw uploadError(
      "unsupported_type",
      getProductImageUploadErrorMessage("unsupported_type")
    )
  }
  getPreparedProductImageDimensions(sourceMetadata)
  let encoded: { blob: Blob; width: number; height: number }
  try {
    encoded = await waitForPreparation(
      (dependencies.decodeAndEncode ?? decodeAndEncodeProductImage)(
        file,
        mimeType,
        sourceMetadata
      )
    )
  } catch (error) {
    if (error instanceof ProductImageUploadError) throw error
    throw uploadError(
      "encode_failed",
      getProductImageUploadErrorMessage("encode_failed")
    )
  }
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal)
  const { blob, width, height } = encoded
  getPreparedProductImageDimensions({ width, height })
  if (
    blob.size <= 0 ||
    blob.size > MAX_PRODUCT_IMAGE_OUTPUT_BYTES ||
    normalizedMimeType(blob.type) !== mimeType
  ) {
    throw uploadError(
      blob.size > MAX_PRODUCT_IMAGE_OUTPUT_BYTES
        ? "output_too_large"
        : "encode_failed",
      getProductImageUploadErrorMessage(
        blob.size > MAX_PRODUCT_IMAGE_OUTPUT_BYTES
          ? "output_too_large"
          : "encode_failed"
      )
    )
  }
  const sha256 = (
    await waitForPreparation(computeBlobSha256(blob))
  ).toLowerCase()
  return {
    blob,
    sha256,
    size: blob.size,
    mimeType,
    width,
    height,
  }
}

function abortError(
  signal: AbortSignal | undefined,
  outcome: ProductImageUploadOutcome = "not_attempted"
): ProductImageUploadError {
  return uploadError(
    signal?.reason === "timeout" ? "upload_timeout" : "cancelled",
    getProductImageUploadErrorMessage(
      signal?.reason === "timeout" ? "upload_timeout" : "cancelled"
    ),
    outcome
  )
}

function createBoundedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutReason: "timeout" | "signer_timeout" = "timeout"
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener("abort", abortFromParent, { once: true })
  const timeout = setTimeout(() => controller.abort(timeoutReason), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parent?.removeEventListener("abort", abortFromParent)
    },
  }
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => ProductImageUploadError
): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort())
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(onAbort())
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
  })
}

function signerAbortError(signal: AbortSignal): ProductImageUploadError {
  const code: ProductImageUploadFailureCode =
    signal.reason === "signer_timeout" ? "signer_timeout" : "cancelled"
  return uploadError(code, getProductImageUploadErrorMessage(code))
}

function classifySignerFailure(error: unknown): ProductImageUploadError {
  if (error instanceof ProductImageUploadError) return error
  if (error instanceof NostrSignerError) {
    const code: ProductImageUploadFailureCode =
      error.code === "authorization_denied"
        ? "signer_rejected"
        : error.code === "timeout"
          ? "signer_timeout"
          : error.code === "authority_changed"
            ? "authority_changed"
            : "signer_unavailable"
    return uploadError(code, getProductImageUploadErrorMessage(code))
  }
  return uploadError(
    "signer_unavailable",
    getProductImageUploadErrorMessage("signer_unavailable")
  )
}

const DEFINITIVE_BUD_UPLOAD_REJECTION_STATUSES = new Set([
  400, 401, 402, 403, 409, 411, 413, 415, 429,
])

function classifyUploadResponse(status: number): ProductImageUploadError {
  const code: ProductImageUploadFailureCode =
    status === 401
      ? "auth_invalid"
      : status === 402
        ? "payment_required"
        : status === 403
          ? "policy_rejected"
          : status === 409
            ? "integrity_failed"
            : status === 413
              ? "size_rejected"
              : status === 415
                ? "type_rejected"
                : status === 429
                  ? "rate_limited"
                  : "upload_failed"
  return uploadError(
    code,
    getProductImageUploadErrorMessage(code),
    DEFINITIVE_BUD_UPLOAD_REJECTION_STATUSES.has(status)
      ? "definitive_rejection"
      : "ambiguous"
  )
}

function parseDescriptor(
  value: unknown,
  prepared: PreparedProductImage
): BlobDescriptor {
  if (!value || typeof value !== "object") {
    throw uploadError(
      "descriptor_invalid",
      getProductImageUploadErrorMessage("descriptor_invalid")
    )
  }
  const descriptor = value as Partial<BlobDescriptor>
  const url = normalizePublicHttpsUrl(descriptor.url)
  const sha256 = descriptor.sha256?.trim().toLowerCase() ?? ""
  const mimeType = normalizedMimeType(descriptor.type)
  if (
    !url ||
    !HEX_SHA256.test(sha256) ||
    sha256 !== prepared.sha256 ||
    getHashFromURL(url)?.toLowerCase() !== prepared.sha256 ||
    descriptor.size !== prepared.size ||
    mimeType !== prepared.mimeType ||
    !Number.isSafeInteger(descriptor.uploaded) ||
    (descriptor.uploaded ?? 0) <= 0
  ) {
    throw uploadError(
      "descriptor_invalid",
      getProductImageUploadErrorMessage("descriptor_invalid")
    )
  }
  const uploaded = descriptor.uploaded
  if (typeof uploaded !== "number") {
    throw uploadError(
      "descriptor_invalid",
      getProductImageUploadErrorMessage("descriptor_invalid")
    )
  }
  return {
    url,
    sha256,
    size: descriptor.size,
    type: mimeType,
    uploaded,
  }
}

function assertLiveAuthority(
  expectedPubkey: string,
  shouldContinue: (() => boolean) | undefined,
  outcome: ProductImageUploadOutcome = "not_attempted"
): void {
  if (!HEX_SHA256.test(expectedPubkey) || shouldContinue?.() === false) {
    throw uploadError(
      "authority_changed",
      getProductImageUploadErrorMessage("authority_changed"),
      outcome
    )
  }
}

async function readResponseBytesBounded(
  response: Response,
  maxBytes: number,
  failureCode: "descriptor_invalid" | "integrity_failed"
): Promise<Uint8Array> {
  if (!response.body) {
    throw uploadError(
      failureCode,
      getProductImageUploadErrorMessage(failureCode)
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw uploadError(
          failureCode,
          getProductImageUploadErrorMessage(failureCode)
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function uploadPreparedProductImage(
  input: UploadPreparedProductImageInput
): Promise<VerifiedProductImageUpload> {
  const fetchImpl = input.dependencies?.fetch ?? fetch
  const now = input.dependencies?.now ?? (() => Math.floor(Date.now() / 1_000))
  const expectedPubkey = input.expectedPubkey.trim().toLowerCase()
  const serverUrl = normalizeBlossomServerRoot(input.target.serverUrl)
  if (!serverUrl || serverUrl !== input.target.serverUrl) {
    throw uploadError(
      "target_unavailable",
      getProductImageUploadErrorMessage("target_unavailable")
    )
  }
  if (
    !HEX_SHA256.test(input.prepared.sha256) ||
    input.prepared.size !== input.prepared.blob.size ||
    normalizedMimeType(input.prepared.blob.type) !== input.prepared.mimeType ||
    input.prepared.size > MAX_PRODUCT_IMAGE_OUTPUT_BYTES
  ) {
    throw uploadError(
      "integrity_failed",
      getProductImageUploadErrorMessage("integrity_failed")
    )
  }
  if (input.signal?.aborted) throw abortError(input.signal)
  assertLiveAuthority(expectedPubkey, input.shouldContinue)

  input.onPhase?.("awaiting_signature")
  const signerSignal = createBoundedSignal(
    input.signal,
    input.dependencies?.signerTimeoutMs ?? PRODUCT_IMAGE_SIGNER_TIMEOUT_MS,
    "signer_timeout"
  )
  let authorization: SignedNostrEvent
  try {
    authorization = await awaitWithSignal(
      createUploadAuth(
        async (draft: EventTemplate) => {
          assertLiveAuthority(expectedPubkey, input.shouldContinue)
          const signed = await input.signer.signEvent({
            ...draft,
            pubkey: expectedPubkey,
            tags: draft.tags.map((tag) => [...tag]),
          })
          assertLiveAuthority(expectedPubkey, input.shouldContinue)
          return signed
        },
        input.prepared.sha256,
        {
          servers: serverUrl,
          expiration: now() + PRODUCT_IMAGE_UPLOAD_AUTH_TTL_SECONDS,
          message: "Authorize one prepared product image upload",
        }
      ),
      signerSignal.signal,
      () => signerAbortError(signerSignal.signal)
    )
  } catch (error) {
    if (signerSignal.signal.aborted) {
      throw signerAbortError(signerSignal.signal)
    }
    throw classifySignerFailure(error)
  } finally {
    signerSignal.cleanup()
  }

  const hostname = new URL(serverUrl).hostname.toLowerCase()
  const requiredTags = new Map(
    authorization.tags.map((tag) => [tag[0], tag[1]])
  )
  const expiration = Number(requiredTags.get("expiration"))
  if (
    authorization.kind !== 24242 ||
    authorization.pubkey !== expectedPubkey ||
    requiredTags.get("t") !== "upload" ||
    requiredTags.get("x") !== input.prepared.sha256 ||
    requiredTags.get("server") !== hostname ||
    !Number.isSafeInteger(expiration) ||
    expiration <= now() ||
    expiration > now() + PRODUCT_IMAGE_UPLOAD_AUTH_TTL_SECONDS
  ) {
    throw uploadError(
      "auth_invalid",
      getProductImageUploadErrorMessage("auth_invalid")
    )
  }

  assertLiveAuthority(expectedPubkey, input.shouldContinue)
  input.onPhase?.("uploading")
  const uploadSignal = createBoundedSignal(
    input.signal,
    input.dependencies?.uploadTimeoutMs ?? PRODUCT_IMAGE_UPLOAD_TIMEOUT_MS
  )
  let descriptorText: string
  let uploadAccepted = false
  try {
    const uploadResponse = await fetchImpl(`${serverUrl}/upload`, {
      method: "PUT",
      headers: {
        Authorization: encodeAuthorizationHeader(authorization),
        "Content-Type": input.prepared.mimeType,
        "X-SHA-256": input.prepared.sha256,
      },
      body: input.prepared.blob,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: uploadSignal.signal,
    })
    if (uploadResponse.status !== 200 && uploadResponse.status !== 201) {
      throw classifyUploadResponse(uploadResponse.status)
    }
    uploadAccepted = true
    const descriptorBytes = await readResponseBytesBounded(
      uploadResponse,
      MAX_DESCRIPTOR_BYTES,
      "descriptor_invalid"
    )
    descriptorText = new TextDecoder().decode(descriptorBytes)
  } catch (error) {
    if (error instanceof ProductImageUploadError) {
      throw uploadAccepted
        ? uploadError(error.code, error.message, "accepted_unverified")
        : error
    }
    if (uploadSignal.signal.aborted) {
      throw abortError(
        uploadSignal.signal,
        uploadAccepted ? "accepted_unverified" : "ambiguous"
      )
    }
    throw uploadError(
      "upload_failed",
      getProductImageUploadErrorMessage("upload_failed"),
      uploadAccepted ? "accepted_unverified" : "ambiguous"
    )
  } finally {
    uploadSignal.cleanup()
  }
  let descriptorValue: unknown
  try {
    descriptorValue = JSON.parse(descriptorText)
  } catch {
    throw uploadError(
      "descriptor_invalid",
      getProductImageUploadErrorMessage("descriptor_invalid"),
      "accepted_unverified"
    )
  }
  let descriptor: BlobDescriptor
  try {
    descriptor = parseDescriptor(descriptorValue, input.prepared)
  } catch (error) {
    if (error instanceof ProductImageUploadError) {
      throw uploadError(error.code, error.message, "accepted_unverified")
    }
    throw error
  }

  assertLiveAuthority(
    expectedPubkey,
    input.shouldContinue,
    "accepted_unverified"
  )
  input.onPhase?.("verifying")
  const verifySignal = createBoundedSignal(
    input.signal,
    input.dependencies?.verifyTimeoutMs ?? PRODUCT_IMAGE_VERIFY_TIMEOUT_MS
  )
  let verifiedBlob: Blob
  try {
    const resourceResponse = await fetchImpl(descriptor.url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: verifySignal.signal,
    })
    const finalUrl = normalizePublicHttpsUrl(
      resourceResponse.url || descriptor.url
    )
    if (
      !resourceResponse.ok ||
      !finalUrl ||
      getHashFromURL(finalUrl)?.toLowerCase() !== input.prepared.sha256 ||
      normalizedMimeType(resourceResponse.headers.get("content-type")) !==
        input.prepared.mimeType
    ) {
      throw uploadError(
        "resource_unavailable",
        getProductImageUploadErrorMessage("resource_unavailable")
      )
    }
    const declaredLength = Number(
      resourceResponse.headers.get("content-length")
    )
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      declaredLength !== input.prepared.size
    ) {
      throw uploadError(
        "integrity_failed",
        getProductImageUploadErrorMessage("integrity_failed")
      )
    }
    const verifiedBytes = await readResponseBytesBounded(
      resourceResponse,
      input.prepared.size,
      "integrity_failed"
    )
    const verifiedBuffer = new ArrayBuffer(verifiedBytes.byteLength)
    new Uint8Array(verifiedBuffer).set(verifiedBytes)
    verifiedBlob = new Blob([verifiedBuffer], { type: input.prepared.mimeType })
  } catch (error) {
    if (error instanceof ProductImageUploadError) {
      throw uploadError(error.code, error.message, "accepted_unverified")
    }
    if (verifySignal.signal.aborted) {
      throw abortError(verifySignal.signal, "accepted_unverified")
    }
    throw uploadError(
      "resource_unavailable",
      getProductImageUploadErrorMessage("resource_unavailable"),
      "accepted_unverified"
    )
  } finally {
    verifySignal.cleanup()
  }
  const verifiedSha256 = (
    input.signal
      ? await awaitWithSignal(
          computeBlobSha256(verifiedBlob),
          input.signal,
          () => abortError(input.signal, "accepted_unverified")
        )
      : await computeBlobSha256(verifiedBlob)
  ).toLowerCase()
  if (
    verifiedBlob.size !== input.prepared.size ||
    normalizedMimeType(verifiedBlob.type) !== input.prepared.mimeType ||
    verifiedSha256 !== input.prepared.sha256
  ) {
    throw uploadError(
      "integrity_failed",
      getProductImageUploadErrorMessage("integrity_failed"),
      "accepted_unverified"
    )
  }
  if (input.signal?.aborted) {
    throw abortError(input.signal, "accepted_unverified")
  }
  assertLiveAuthority(
    expectedPubkey,
    input.shouldContinue,
    "accepted_unverified"
  )
  input.onPhase?.("succeeded")
  return {
    url: descriptor.url,
    sha256: input.prepared.sha256,
    size: input.prepared.size,
    mimeType: input.prepared.mimeType,
    width: input.prepared.width,
    height: input.prepared.height,
    targetKind: input.target.kind,
  }
}
