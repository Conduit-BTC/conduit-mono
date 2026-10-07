/** Public NIP-44 is v2. An unpublished version never becomes an implicit default. */
export const PRIVATE_MESSAGE_WRITE_ENCRYPTION_VERSION = 2 as const
export function selectPrivateMessageEncryptionVersion(input: {
  signerVersions: readonly number[]
  recipientVersions: readonly number[]
  publicV3Contract: boolean
}): 2 | 3 | null {
  if (
    input.publicV3Contract &&
    input.signerVersions.includes(3) &&
    input.recipientVersions.includes(3)
  )
    return 3
  return input.signerVersions.includes(2) && input.recipientVersions.includes(2)
    ? 2
    : null
}
