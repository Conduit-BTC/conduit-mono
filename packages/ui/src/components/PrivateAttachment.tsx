import { useState } from "react"
import {
  downloadAndDecryptPrivateFile,
  type ParsedDirectMessage,
} from "@conduit/core"
import { Button } from "./Button"

/** No remote fetch occurs until the reader explicitly requests the attachment. */
export function PrivateAttachment({
  file,
}: {
  file: NonNullable<ParsedDirectMessage["file"]>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const download = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (
        file.algorithm !== "aes-gcm" ||
        !file.key ||
        !file.nonce ||
        !file.encryptedSha256
      )
        throw new Error("Unsupported attachment")
      const bytes = await downloadAndDecryptPrivateFile(
        file.url,
        {
          algorithm: "aes-gcm",
          key: file.key,
          nonce: file.nonce,
          encryptedSha256: file.encryptedSha256,
          originalSha256: file.originalSha256,
          encryptedSize:
            file.size === undefined ? undefined : Number(file.size),
        },
        (url) =>
          fetch(url, {
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          })
      )
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" })
      )
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "attachment"
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        className="min-h-11"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? "Opening encrypted file…" : "Download encrypted file"}
      </Button>
      {failed ? (
        <p role="alert" className="text-sm text-error">
          The attachment could not be verified or downloaded.
        </p>
      ) : null}
    </div>
  )
}
