import { createUploadAuth } from "nostr-tools/nipb7"
import { normalizePublicHttpsUrl } from "../network-target-safety"
import {
  encryptPrivateFileBytes,
  buildPrivateFileRumor,
} from "./private-file-message"
import {
  readMediaServerPreferences,
  loadMediaServerDraft,
} from "./media-server-preferences"
import { resolveProductImageUploadTarget } from "./product-image-upload"
import { encodeBlossomAuthorizationHeader } from "./blossom-auth"
import { getAccountSigner } from "./session-signer"
import {
  assertProtectedReadAuthorization,
  getProtectedReadAuthorization,
} from "./protected-read-authorization"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import { sendAccountInboxRumor } from "./inbox-send"

/** The existing media preference owner selects the target. Only encrypted bytes leave the device. */
export async function sendPrivateAttachment(
  principal: string,
  recipients: string[],
  file: File,
  replyTo?: string
): Promise<void> {
  const authorization = getProtectedReadAuthorization(principal)
  const signer = getAccountSigner()
  if (!authorization || !signer || signer.pubkey !== principal)
    throw new Error("Reconnect your signer to attach a file")
  const assertCurrent = () =>
    assertProtectedReadAuthorization(authorization, principal)
  const encrypted = await encryptPrivateFileBytes(
    new Uint8Array(await file.arrayBuffer())
  )
  assertCurrent()
  const resolution = await readMediaServerPreferences(principal)
  assertCurrent()
  const target = resolveProductImageUploadTarget({
    owner: principal,
    signerAvailable: true,
    resolution,
    localDraft: loadMediaServerDraft(principal),
  })
  if (target.kind !== "configured" && target.kind !== "fallback")
    throw new Error("Configure a usable media server in Network")
  const server = target.serverUrl
  const auth = await createUploadAuth(
    async (event) => await signer.signEvent({ ...event, pubkey: principal }),
    encrypted.envelope.encryptedSha256,
    {
      servers: server,
      expiration: Math.floor(Date.now() / 1000) + 300,
      message: "Authorize one encrypted attachment upload",
    }
  )
  assertCurrent()
  const one = (name: string) => {
    const tags = auth.tags.filter((tag) => tag[0] === name)
    return tags.length === 1 ? tags[0]?.[1] : undefined
  }
  const expiration = Number(one("expiration"))
  if (
    !isValidSignedPublicNostrEvent(auth) ||
    auth.pubkey !== principal ||
    auth.kind !== 24242 ||
    one("t") !== "upload" ||
    one("x") !== encrypted.envelope.encryptedSha256 ||
    one("server") !== new URL(server).hostname ||
    !Number.isSafeInteger(expiration) ||
    expiration <= Math.floor(Date.now() / 1000) ||
    expiration > Math.floor(Date.now() / 1000) + 300
  )
    throw new Error("Invalid upload authorization")
  const response = await fetch(`${server}/upload`, {
    method: "PUT",
    body: new Blob([new Uint8Array(encrypted.ciphertext)], {
      type: "application/octet-stream",
    }),
    headers: {
      Authorization: encodeBlossomAuthorizationHeader(auth),
      "Content-Type": "application/octet-stream",
      "X-SHA-256": encrypted.envelope.encryptedSha256,
    },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  })
  assertCurrent()
  if (
    !response.ok ||
    Number(response.headers.get("content-length") ?? 0) > 16_384
  )
    throw new Error("Encrypted attachment upload failed")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing upload descriptor")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 16_384) {
        await reader.cancel()
        throw new Error("Invalid upload descriptor")
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  const descriptor = JSON.parse(text) as {
    url?: string
    sha256?: string
    size?: number
  }
  const url = normalizePublicHttpsUrl(descriptor.url)
  if (
    !url ||
    new URL(url).origin !== new URL(server).origin ||
    descriptor.sha256 !== encrypted.envelope.encryptedSha256 ||
    descriptor.size !== encrypted.envelope.encryptedSize
  )
    throw new Error("Upload descriptor does not match encrypted attachment")
  const wire = buildPrivateFileRumor({
    recipientPubkeys: recipients,
    url,
    mimeType: file.type || "application/octet-stream",
    envelope: encrypted.envelope,
    replyTo,
  })
  await sendAccountInboxRumor({ principal, recipients, ...wire })
}
