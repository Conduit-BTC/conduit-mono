import { rebaseSettings, type SettingsDraft } from "./edits"
import type {
  AccountSigner,
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import {
  PRIVATE_SETTINGS_ID,
  PRIVATE_SETTINGS_KIND,
  PUBLIC_SETTINGS_ID,
  PUBLIC_SETTINGS_KIND,
  SettingsError,
  parsePrivateSettingsDocument,
  parsePublicSettingsDocument,
  type PrivateSettingsDocument,
  type PublicSettingsDocument,
} from "./documents"

export function compareSettingsEvents(
  a: SignedNostrEvent,
  b: SignedNostrEvent
): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id)
}
export function isSettingsEnvelope(
  event: SignedNostrEvent,
  owner: string,
  kind: number
): boolean {
  return (
    event.pubkey === owner &&
    event.kind === kind &&
    event.content.length <= 44000 &&
    isValidSignedPublicNostrEvent(event) &&
    event.tags.length === 1 &&
    event.tags[0]?.length === 2 &&
    event.tags[0][0] === "d" &&
    event.tags[0][1] ===
      (kind === PRIVATE_SETTINGS_KIND
        ? PRIVATE_SETTINGS_ID
        : PUBLIC_SETTINGS_ID)
  )
}
export function assertNip44SettingsCiphertext(content: string): void {
  try {
    if (
      content.length < 132 ||
      content.length > 44000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
    )
      throw new Error()
    const bytes = atob(content)
    if (
      bytes.charCodeAt(0) !== 2 ||
      bytes.length < 99 ||
      btoa(bytes) !== content
    )
      throw new Error()
  } catch {
    throw new SettingsError("invalid")
  }
}
export async function readPrivateSettingsEvent(
  event: SignedNostrEvent,
  signer: AccountSigner,
  active: () => boolean,
  priority: "foreground" | "background" = "background"
): Promise<PrivateSettingsDocument> {
  if (
    !active() ||
    !isSettingsEnvelope(event, signer.pubkey, PRIVATE_SETTINGS_KIND)
  )
    throw new SettingsError("invalid")
  assertNip44SettingsCiphertext(event.content)
  const text = await signer.decryptNip44(signer.pubkey, event.content, {
    priority,
  })
  if (!active()) throw new SettingsError("session")
  return parsePrivateSettingsDocument(text)
}
const publicBaselines = new WeakMap<object, string>()
export function readPublicSettingsEvent(
  event: SignedNostrEvent,
  owner: string
): PublicSettingsDocument {
  if (!isSettingsEnvelope(event, owner, PUBLIC_SETTINGS_KIND))
    throw new SettingsError("invalid")
  const document = parsePublicSettingsDocument(event.content, owner)
  publicBaselines.set(document, JSON.stringify(document))
  return document
}
export function isPublicSettingsBaseline(
  document: PublicSettingsDocument
): boolean {
  return (
    publicBaselines.get(document) === JSON.stringify(document) ||
    (document.format === PUBLIC_SETTINGS_ID &&
      document.version === 1 &&
      Object.keys(document).length === 3 &&
      Object.keys(document.settings).length === 0)
  )
}
async function signExact(
  signer: AccountSigner,
  draft: UnsignedNostrEvent,
  active: () => boolean,
  priority: "foreground" | "background" = "foreground"
): Promise<SignedNostrEvent> {
  if (!active()) throw new SettingsError("session")
  const event = await signer.signEvent(structuredClone(draft), { priority })
  if (!active()) throw new SettingsError("session")
  if (
    !isSettingsEnvelope(event, signer.pubkey, draft.kind) ||
    event.content !== draft.content ||
    event.created_at !== draft.created_at ||
    JSON.stringify(event.tags) !== JSON.stringify(draft.tags)
  )
    throw new SettingsError("invalid")
  return event
}
export async function signPrivateSettingsDocument(
  document: PrivateSettingsDocument,
  signer: AccountSigner,
  createdAt: number,
  active: () => boolean,
  priority: "foreground" | "background" = "foreground"
): Promise<SignedNostrEvent> {
  const content = JSON.stringify(parsePrivateSettingsDocument(document))
  if (!active()) throw new SettingsError("session")
  const encrypted = await signer.encryptNip44(signer.pubkey, content, {
    priority,
  })
  if (!active()) throw new SettingsError("session")
  assertNip44SettingsCiphertext(encrypted)
  return signExact(
    signer,
    {
      kind: PRIVATE_SETTINGS_KIND,
      pubkey: signer.pubkey,
      created_at: createdAt,
      tags: [["d", PRIVATE_SETTINGS_ID]],
      content: encrypted,
    },
    active,
    priority
  )
}
export async function signPublicSettingsDocument(
  draft: SettingsDraft<PublicSettingsDocument>,
  signer: AccountSigner,
  createdAt: number,
  active: () => boolean,
  priority: "foreground" | "background" = "foreground"
): Promise<SignedNostrEvent> {
  if (!isPublicSettingsBaseline(draft.baseline))
    throw new SettingsError("invalid")
  const document = rebaseSettings(draft, draft.baseline, signer.pubkey)
  const content = JSON.stringify(
    parsePublicSettingsDocument(document, signer.pubkey)
  )
  return signExact(
    signer,
    {
      kind: PUBLIC_SETTINGS_KIND,
      pubkey: signer.pubkey,
      created_at: createdAt,
      tags: [["d", PUBLIC_SETTINGS_ID]],
      content,
    },
    active,
    priority
  )
}
