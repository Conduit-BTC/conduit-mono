import { afterEach, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { getEventHash } from "nostr-tools"
import { CommerceInboxRecovery } from "../packages/ui/src/components/CommerceInboxRecovery"
import {
  CommerceInbox,
  type CommerceInboxSnapshot,
} from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { buildCheckoutSparkOrganizerRecoveryRumor } from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import type { ConduitDB } from "@conduit/core/db"

const owners: CommerceInbox[] = []
const databases: ConduitDB[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

function snapshot(
  states: CommerceInboxSnapshot["diagnostics"]["states"]
): CommerceInboxSnapshot {
  return {
    sourceRelays: [],
    decryptFailures: [],
    legacyDecryptFailures: [],
    directMessages: [],
    orderMessages: [],
    externalRecords: [],
    unreadIds: new Set(),
    pending: false,
    diagnostics: {
      states,
      transportStates: { nip17: states, nip04: {} },
      sources: [],
      historyRanges: [],
      received: Object.values(states).reduce((sum, count) => sum + count, 0),
      legacyReceived: 0,
      observedAt: null,
      coverage: "partial",
      authentication: null,
      historyUnresolved: 0,
      outgoingPending: 0,
      clientSealMetadataAccepted: 0,
      storageUnavailable: false,
    },
  }
}

it("shows separate content-free machine, malformed and in-progress states instead of implying every retained record opened", () => {
  const markup = renderToStaticMarkup(
    <CommerceInboxRecovery
      snapshot={snapshot({
        opened: 18,
        machine: 5,
        malformed: 1,
        queued: 1,
        waiting_for_signer: 1,
        opening: 1,
      })}
      retry={async () => {}}
    />
  )
  expect(markup).toContain("27 retained")
  expect(markup).toContain("18 opened")
  expect(markup).toContain("5 machine records")
  expect(markup).toContain("1 malformed")
  expect(markup).toContain("1 queued")
  expect(markup).toContain("1 waiting for signer")
  expect(markup).toContain("1 opening")
  expect(markup).not.toContain("27 opened")
})

it("offers the existing explicit Retry opening action for malformed-only retained records without calling it automatically", () => {
  let attempts = 0
  const markup = renderToStaticMarkup(
    <CommerceInboxRecovery
      snapshot={snapshot({ malformed: 1 })}
      retry={async () => {
        attempts++
      }}
    />
  )
  expect(markup).toContain("1 waiting for recovery")
  expect(markup).toContain("Retry opening")
  expect(attempts).toBe(0)
  const source = readFileSync(
    new URL(
      "../packages/ui/src/components/CommerceInboxRecovery.tsx",
      import.meta.url
    ),
    "utf8"
  )
  expect(source.includes("onClick={() => void act(retry)}")).toBe(true)
  expect(source.includes("disabled={busy}")).toBe(true)
})

it("does not count valid machine records as ordinary conversations or failed opening attempts", () => {
  const markup = renderToStaticMarkup(
    <CommerceInboxRecovery
      snapshot={snapshot({ machine: 1 })}
      retry={async () => {}}
    />
  )
  expect(markup).toContain("1 machine records")
  expect(markup).toContain("0 opened")
  expect(markup).not.toContain("Retry opening")
  expect(markup).not.toContain("External commerce records")
  expect(markup).not.toContain("Inspect and reply")
})

it("does not turn queued or active decoding into an automatic retry loop", () => {
  const markup = renderToStaticMarkup(
    <CommerceInboxRecovery
      snapshot={snapshot({
        queued: 1,
        waiting_for_signer: 1,
        opening: 1,
      })}
      retry={async () => {
        throw new Error("Rendering must not retry")
      }}
    />
  )
  expect(markup).toContain("1 queued")
  expect(markup).toContain("1 waiting for signer")
  expect(markup).toContain("1 opening")
  expect(markup).not.toContain("Retry opening")
})

it("lets the existing explicit action recheck a failed machine initial without weakening validation or a revoked session", async () => {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  installProtectedReadSigner(
    f.organizerSigner,
    f.organizerPubkey,
    () => f.clock.active
  )
  const authorization = getProtectedReadAuthorization(f.organizerPubkey)!
  const inbox = new CommerceInbox(
    authorization,
    authorization.signer,
    new CommerceInboxStore(authorization, f.database)
  )
  owners.push(inbox)
  const valid = buildCheckoutSparkOrganizerRecoveryRumor(f.initial)
  const draft = {
    ...valid,
    content: JSON.stringify({ ...f.initial, schemaVersion: 999 }),
  }
  const rumor = { ...draft, id: getEventHash(draft) }
  const wrap = await wrapPrivateMessage(
    rumor,
    { pubkey: f.organizerPubkey },
    f.buyerSigner,
    { rumorKind: 16 }
  )
  await inbox.ingest(wrap)
  const failed = await inbox.waitForDecode()
  expect(failed.diagnostics.states.malformed).toBe(1)
  expect(failed.diagnostics.states.opened ?? 0).toBe(0)
  expect(failed.directMessages.length).toBe(0)
  expect(failed.orderMessages.length).toBe(0)
  expect(failed.externalRecords.length).toBe(0)
  const retry = () => inbox.retryDecode()
  expect(
    renderToStaticMarkup(
      <CommerceInboxRecovery snapshot={failed} retry={retry} />
    )
  ).toContain("Retry opening")
  const before = (await inbox.store.wrappers())[0]!.attempts
  const checked = await retry()
  expect((await inbox.store.wrappers())[0]!.attempts).toBe(before + 1)
  expect(checked.diagnostics.states.malformed).toBe(1)
  expect(checked.directMessages.length).toBe(0)
  expect(checked.externalRecords.length).toBe(0)
  f.clock.active = false
  await expect(retry()).rejects.toThrow()
})
