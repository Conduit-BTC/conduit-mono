import { generateSecretKey } from "nostr-tools/pure"
import { nsecEncode } from "nostr-tools/nip19"

/** Browser-only disposable test equipment. Never return or record its secret. */
export function populateImportInput(input: HTMLInputElement): void {
  const secret = generateSecretKey()
  try {
    input.value = nsecEncode(secret)
  } finally {
    secret.fill(0)
  }
}
