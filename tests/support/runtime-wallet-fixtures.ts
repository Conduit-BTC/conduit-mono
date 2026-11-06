import { generateMnemonic } from "../../apps/market/node_modules/@scure/bip39/index.js"
import { wordlist } from "../../apps/market/node_modules/@scure/bip39/wordlists/english.js"

/** Generate once per fixture and reuse across its account/reopen assertions. */
export function createRuntimeMnemonic(): string {
  return generateMnemonic(wordlist)
}
