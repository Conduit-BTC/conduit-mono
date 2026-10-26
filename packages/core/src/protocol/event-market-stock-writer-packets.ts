import { getEventHash } from "nostr-tools"
import {
  assertPrivateMessageFitsTransport,
  createPrivateMessageRumor,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import { isValidNostrPublicKey } from "./signed-event"

const SUBJECT = "conduit-event-stock-handover"
const MARKER = ["conduit", "event-stock-handover", "1"]
export const MAX_STOCK_WRITER_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_STOCK_WRITER_SNAPSHOT_ROWS = 2048
const PART_BYTES = 64 * 1024
const MAX_PARTS = 128
const HASH = /^[0-9a-f]{64}$/
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const exact = (value: object, keys: string[]) =>
  same(Object.keys(value).sort(), keys.sort())
function fail(): never {
  throw new Error("The complete stock-writer transfer bundle is required.")
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
function decode(value: string) {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    fail()
  }
  if (bytes.length > PART_BYTES || encode(bytes) !== value) fail()
  return bytes
}
interface Manifest {
  type: "writer_handover_manifest"
  version: 1
  organizerPubkey: string
  marketCoordinate: string
  targetDeviceId: string
  transferId: string
  payloadBytes: number
  parts: string[]
}
interface Part {
  type: "writer_handover_part"
  version: 1
  organizerPubkey: string
  marketCoordinate: string
  targetDeviceId: string
  transferId: string
  index: number
  total: number
  data: string
}
export type StockWriterPacket =
  | { type: "full"; rumor: PrivateMessageRumor }
  | { type: "manifest"; rumor: PrivateMessageRumor; payload: Manifest }
  | { type: "part"; rumor: PrivateMessageRumor; payload: Part }

function rumor(author: string, createdAt: number, content: string) {
  return createPrivateMessageRumor({
    kind: 14,
    pubkey: author,
    created_at: createdAt,
    tags: [["p", author], ["subject", SUBJECT], MARKER],
    content,
  })
}

/** Strict canonical packet codec; caller still authenticates the NIP-59 seal. */
export function parseStockWriterPacket(
  value: PrivateMessageRumor
): StockWriterPacket {
  if (
    value.kind !== 14 ||
    !isValidNostrPublicKey(value.pubkey) ||
    value.id !== getEventHash(value) ||
    !same(value.tags, [["p", value.pubkey], ["subject", SUBJECT], MARKER])
  )
    fail()
  let body: Manifest | Part | { type: "writer_handover" }
  try {
    body = JSON.parse(value.content)
  } catch {
    fail()
  }
  if (body?.type === "writer_handover") return { type: "full", rumor: value }
  if (
    !body ||
    !("version" in body) ||
    body.version !== 1 ||
    body.organizerPubkey !== value.pubkey ||
    typeof body.marketCoordinate !== "string" ||
    typeof body.targetDeviceId !== "string" ||
    !HASH.test(body.transferId)
  )
    fail()
  assertPrivateMessageFitsTransport(value)
  if (body.type === "writer_handover_manifest") {
    if (
      !exact(body, [
        "type",
        "version",
        "organizerPubkey",
        "marketCoordinate",
        "targetDeviceId",
        "transferId",
        "payloadBytes",
        "parts",
      ]) ||
      !Number.isSafeInteger(body.payloadBytes) ||
      body.payloadBytes <= 0 ||
      body.payloadBytes > MAX_STOCK_WRITER_SNAPSHOT_BYTES ||
      !Array.isArray(body.parts) ||
      body.parts.length < 2 ||
      body.parts.length > MAX_PARTS ||
      body.parts.length !== Math.ceil(body.payloadBytes / PART_BYTES) ||
      body.parts.some((id) => typeof id !== "string" || !HASH.test(id)) ||
      new Set(body.parts).size !== body.parts.length
    )
      fail()
    return { type: "manifest", rumor: value, payload: body }
  }
  if (
    body.type !== "writer_handover_part" ||
    !exact(body, [
      "type",
      "version",
      "organizerPubkey",
      "marketCoordinate",
      "targetDeviceId",
      "transferId",
      "index",
      "total",
      "data",
    ]) ||
    !Number.isInteger(body.index) ||
    !Number.isInteger(body.total) ||
    body.total < 2 ||
    body.total > MAX_PARTS ||
    body.index < 0 ||
    body.index >= body.total ||
    typeof body.data !== "string" ||
    !decode(body.data).length
  )
    fail()
  return { type: "part", rumor: value, payload: body }
}

/** All parts are built and individually transport-bounded before any freeze. */
export function buildStockWriterPackets(
  full: PrivateMessageRumor
): PrivateMessageRumor[] {
  const bytes = new TextEncoder().encode(full.content)
  if (bytes.length > MAX_STOCK_WRITER_SNAPSHOT_BYTES) fail()
  if (bytes.length <= PART_BYTES) {
    assertPrivateMessageFitsTransport(full)
    return [full]
  }
  const total = Math.ceil(bytes.length / PART_BYTES)
  const header = JSON.parse(full.content) as {
    marketCoordinate: string
    targetDeviceId: string
  }
  const parts = Array.from({ length: total }, (_, index) =>
    rumor(
      full.pubkey,
      full.created_at,
      JSON.stringify({
        type: "writer_handover_part",
        version: 1,
        organizerPubkey: full.pubkey,
        marketCoordinate: header.marketCoordinate,
        targetDeviceId: header.targetDeviceId,
        transferId: full.id,
        index,
        total,
        data: encode(bytes.slice(index * PART_BYTES, (index + 1) * PART_BYTES)),
      } satisfies Part)
    )
  )
  const root = rumor(
    full.pubkey,
    full.created_at,
    JSON.stringify({
      type: "writer_handover_manifest",
      version: 1,
      organizerPubkey: full.pubkey,
      marketCoordinate: header.marketCoordinate,
      targetDeviceId: header.targetDeviceId,
      transferId: full.id,
      payloadBytes: bytes.length,
      parts: parts.map((part) => part.id),
    } satisfies Manifest)
  )
  for (const packet of [root, ...parts]) parseStockWriterPacket(packet)
  return [root, ...parts]
}

/** Ordered hashes, exact bytes and author bind the entire unsliced snapshot. */
export function assembleStockWriterPackets(
  root: PrivateMessageRumor,
  supplied: readonly PrivateMessageRumor[]
): PrivateMessageRumor {
  const parsed = parseStockWriterPacket(root)
  if (parsed.type === "full") return root
  if (parsed.type !== "manifest" || supplied.length > MAX_PARTS * 2) fail()
  const parts = new Map<string, StockWriterPacket & { type: "part" }>()
  for (const candidate of supplied) {
    const part = parseStockWriterPacket(candidate)
    if (
      part.type !== "part" ||
      part.payload.transferId !== parsed.payload.transferId ||
      part.rumor.pubkey !== root.pubkey ||
      part.payload.marketCoordinate !== parsed.payload.marketCoordinate ||
      part.payload.targetDeviceId !== parsed.payload.targetDeviceId ||
      part.rumor.created_at !== root.created_at
    )
      fail()
    if (!parsed.payload.parts.includes(part.rumor.id)) fail()
    parts.set(part.rumor.id, part)
  }
  const joined = new Uint8Array(parsed.payload.payloadBytes)
  let offset = 0
  for (const [index, id] of parsed.payload.parts.entries()) {
    const part = parts.get(id)
    if (
      !part ||
      part.payload.index !== index ||
      part.payload.total !== parsed.payload.parts.length
    )
      fail()
    const bytes = decode(part.payload.data)
    if (
      (index < parsed.payload.parts.length - 1 &&
        bytes.length !== PART_BYTES) ||
      offset + bytes.length > joined.length
    )
      fail()
    joined.set(bytes, offset)
    offset += bytes.length
  }
  if (offset !== joined.length) fail()
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(joined)
  } catch {
    fail()
  }
  const full = rumor(root.pubkey, root.created_at, content)
  if (full.id !== parsed.payload.transferId) fail()
  const header = JSON.parse(content) as {
    marketCoordinate: string
    targetDeviceId: string
  }
  if (
    header.marketCoordinate !== parsed.payload.marketCoordinate ||
    header.targetDeviceId !== parsed.payload.targetDeviceId
  )
    fail()
  return full
}
