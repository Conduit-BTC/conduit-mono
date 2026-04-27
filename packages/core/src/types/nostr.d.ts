interface Nip07Nostr {
  getPublicKey(): Promise<string>
  getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>
  signEvent(event: {
    kind: number
    content: string
    tags: string[][]
    created_at: number
  }): Promise<{
    id: string
    pubkey: string
    sig: string
    kind: number
    content: string
    tags: string[][]
    created_at: number
  }>
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
}

interface Window {
  nostr?: Nip07Nostr
}
