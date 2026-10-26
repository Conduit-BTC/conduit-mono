import {
  classifyNostrSignerError,
  type AccountSigner,
  type SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import {
  PRIVATE_SETTINGS_KIND,
  PUBLIC_SETTINGS_KIND,
  SettingsError,
  emptyPrivateSettings,
  emptyPublicSettings,
  type PrivateSettingsDocument,
  type PublicSettingsDocument,
} from "./documents"
import {
  rebaseSettings,
  changedSettingsUnits,
  type SettingsDraft,
  type SettingsDocument,
} from "./edits"
import {
  compareSettingsEvents,
  isSettingsEnvelope,
  readPrivateSettingsEvent,
  readPublicSettingsEvent,
  signPrivateSettingsDocument,
  signPublicSettingsDocument,
  isPublicSettingsBaseline,
} from "./events"
import {
  serializeSettingsWrite,
  type SettingsRow,
  type SettingsStore,
} from "./store"
import type { SettingsTransport, SettingsRead } from "./transport"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"

export interface SettingsSnapshot<D extends SettingsDocument> {
  document: D
  event?: SignedNostrEvent
  coverage: SettingsRead["coverage"]
  delivery?: SettingsRow["delivery"]
  problem?: SettingsError["code"]
  pendingDraft?: SettingsDraft<D>
  pendingEventId?: string
}
export class SettingsCoordinator {
  private stopped = false
  private refused = false
  private decoded = new Map<string, SettingsDocument>()
  private lastUsable = new Map<number, SettingsDocument>()
  constructor(
    readonly signer: AccountSigner,
    private store: SettingsStore,
    private transport: SettingsTransport,
    private current: () => boolean,
    private now = Date.now
  ) {}
  stop(): void {
    this.stopped = true
    this.decoded.clear()
    this.lastUsable.clear()
  }
  private active = () => !this.stopped && this.current()
  private check(): void {
    if (!this.active()) throw new SettingsError("session")
  }
  private async decode(
    event: SignedNostrEvent,
    priority: "foreground" | "background" = "background"
  ): Promise<SettingsDocument> {
    this.check()
    const cached = this.decoded.get(event.id)
    if (cached) return cached
    const value =
      event.kind === PRIVATE_SETTINGS_KIND
        ? await readPrivateSettingsEvent(
            event,
            this.signer,
            this.active,
            priority
          )
        : readPublicSettingsEvent(event, this.signer.pubkey)
    this.check()
    if (this.decoded.size >= 6)
      this.decoded.delete(this.decoded.keys().next().value!)
    this.decoded.set(event.id, value)
    return value
  }
  private async observe(
    kind: number
  ): Promise<{ row: SettingsRow; coverage: SettingsRead["coverage"] }> {
    this.check()
    const key = `${this.signer.pubkey}:${kind}`
    const row = await this.store.get(key)
    this.check()
    const validOuter = (e: SignedNostrEvent) =>
      e.pubkey === this.signer.pubkey &&
      e.kind === kind &&
      isValidSignedPublicNostrEvent(e)
    if (row.head && !validOuter(row.head)) throw new SettingsError("storage")
    let read: SettingsRead
    try {
      read = await this.transport.read(this.signer.pubkey, kind, this.active)
    } catch {
      this.check()
      read = { events: [], coverage: "unavailable" }
    }
    this.check()
    const head = [
      ...(row.head ? [row.head] : []),
      ...read.events.filter(validOuter),
    ].sort(compareSettingsEvents)[0]
    if (head && head.id !== row.head?.id) {
      const next = { ...row, head }
      await this.store.put(next, row.head?.id)
      this.check()
      return { row: next, coverage: read.coverage }
    }
    return { row, coverage: read.coverage }
  }
  private async load(
    kind: number
  ): Promise<SettingsSnapshot<SettingsDocument>> {
    const empty =
      kind === PRIVATE_SETTINGS_KIND
        ? emptyPrivateSettings()
        : emptyPublicSettings()
    let row: SettingsRow | undefined
    let coverage: SettingsRead["coverage"] = "unavailable"
    try {
      const observed = await this.observe(kind)
      row = observed.row
      coverage = observed.coverage
      if (!row.head) return { document: empty, coverage }
      if (this.refused && kind === PRIVATE_SETTINGS_KIND)
        throw new SettingsError("signer")
      const document = await this.decode(row.head)
      this.lastUsable.set(kind, document)
      if (row.usable?.id !== row.head!.id) {
        row = { ...row, usable: row.head }
        await this.store.put(row, row.head!.id)
        this.check()
      }
      let pendingDraft: SettingsDraft<SettingsDocument> | undefined
      if (row.pending && !this.refused) {
        if (row.pending.event.id !== row.head!.id) {
          const baseline = row.pending.baseline
            ? await this.decode(row.pending.baseline)
            : empty
          const candidate = await this.decode(row.pending.event)
          const changes = changedSettingsUnits(baseline, candidate)
          pendingDraft = { baseline, changes }
          try {
            rebaseSettings(pendingDraft, document, this.signer.pubkey)
            if (changes.length)
              return await this.save(
                kind,
                {
                  ...pendingDraft,
                  reviewedPendingEventId: row.pending.event.id,
                },
                false
              )
            row = { ...row, pending: undefined, delivery: "observed" }
          } catch (error) {
            if (
              !(error instanceof SettingsError) ||
              !["conflict", "invalid"].includes(error.code)
            )
              throw error
            row = { ...row, delivery: "conflict" }
          }
          await this.store.put(row, row.head!.id)
          this.check()
        } else if (!this.refused) row = await this.deliver(row)
      }
      return {
        document,
        event: row.head,
        coverage,
        delivery: row.delivery,
        pendingDraft,
        pendingEventId: row.pending?.event.id,
        ...(row.delivery === "conflict"
          ? { problem: "conflict" as const }
          : {}),
      }
    } catch (error) {
      this.check()
      if (classifyNostrSignerError(error).code === "authorization_denied")
        this.refused = true
      const problem = error instanceof SettingsError ? error.code : "signer"
      let document = this.lastUsable.get(kind) ?? empty
      if (row?.usable && row.usable.id !== row.head?.id && !this.refused) {
        try {
          document = await this.decode(row.usable)
        } catch {
          this.check()
        }
      }
      return {
        document,
        event: row?.usable,
        coverage,
        delivery: row?.delivery,
        problem,
      }
    }
  }
  readPrivate(): Promise<SettingsSnapshot<PrivateSettingsDocument>> {
    return serializeSettingsWrite(
      `${this.signer.pubkey}:${PRIVATE_SETTINGS_KIND}`,
      () => this.load(PRIVATE_SETTINGS_KIND)
    ) as Promise<SettingsSnapshot<PrivateSettingsDocument>>
  }
  readPublic(): Promise<SettingsSnapshot<PublicSettingsDocument>> {
    return serializeSettingsWrite(
      `${this.signer.pubkey}:${PUBLIC_SETTINGS_KIND}`,
      () => this.load(PUBLIC_SETTINGS_KIND)
    ) as Promise<SettingsSnapshot<PublicSettingsDocument>>
  }
  private async deliver(
    row: SettingsRow,
    foreground = false
  ): Promise<SettingsRow> {
    const pending = row.pending
    if (!pending || pending.event.id !== row.head?.id) return row
    this.check()
    try {
      const ack = await this.transport.publish(
        pending.event,
        this.active,
        foreground ? "foreground" : "background"
      )
      this.check()
      if (ack && row.delivery !== "acknowledged") {
        const acknowledged: SettingsRow = { ...row, delivery: "acknowledged" }
        await this.store.put(acknowledged, row.head?.id)
        this.check()
        row = acknowledged
      }
      const readback = await this.transport.read(
        this.signer.pubkey,
        pending.event.kind,
        this.active,
        pending.event.id
      )
      this.check()
      const observed = readback.events.some(
        (e) =>
          isSettingsEnvelope(e, this.signer.pubkey, pending.event.kind) &&
          e.id === pending.event.id
      )
      const next: SettingsRow = {
        ...row,
        delivery: observed
          ? "observed"
          : ack || row.delivery === "acknowledged"
            ? "acknowledged"
            : "local",
        ...(observed ? { pending: undefined } : {}),
      }
      await this.store.put(next, row.head?.id)
      this.check()
      return next
    } catch (error) {
      this.check()
      if (error instanceof SettingsError && error.code === "storage")
        throw error
      if (classifyNostrSignerError(error).code === "authorization_denied")
        this.refused = true
      return row
    }
  }
  private async save<D extends SettingsDocument>(
    kind: number,
    draft: SettingsDraft<D>,
    foreground = true
  ): Promise<SettingsSnapshot<D>> {
    this.check()
    const { row, coverage } = await this.observe(kind)
    if (
      row.pending &&
      row.pending.event.id !== row.head?.id &&
      draft.reviewedPendingEventId !== row.pending.event.id
    )
      throw new SettingsError("conflict")
    // Explicit foreground saves may request signer permission again.
    if (foreground) this.refused = false
    else if (this.refused) throw new SettingsError("signer")
    const current = (
      row.head
        ? await this.decode(row.head, foreground ? "foreground" : "background")
        : kind === PRIVATE_SETTINGS_KIND
          ? emptyPrivateSettings()
          : emptyPublicSettings()
    ) as D
    if (
      kind === PUBLIC_SETTINGS_KIND &&
      !isPublicSettingsBaseline(current as PublicSettingsDocument)
    )
      throw new SettingsError("invalid")
    const document = rebaseSettings(draft, current, this.signer.pubkey)
    const now = Math.floor(this.now() / 1000)
    const createdAt = Math.max(now, (row.head?.created_at ?? 0) + 1)
    if (createdAt > now + 60) throw new SettingsError("clock")
    this.check()
    let event: SignedNostrEvent
    try {
      if (kind === PRIVATE_SETTINGS_KIND)
        event = await signPrivateSettingsDocument(
          document as PrivateSettingsDocument,
          this.signer,
          createdAt,
          this.active,
          foreground ? "foreground" : "background"
        )
      else {
        event = await signPublicSettingsDocument(
          {
            baseline: current as PublicSettingsDocument,
            changes: draft.changes,
          },
          this.signer,
          createdAt,
          this.active,
          foreground ? "foreground" : "background"
        )
      }
    } catch (error) {
      if (classifyNostrSignerError(error).code === "authorization_denied")
        this.refused = true
      throw error
    }
    this.check()
    const staged: SettingsRow = {
      key: row.key,
      head: event,
      usable: event,
      pending: { event, baseline: row.head },
      delivery: "local",
    }
    await this.store.put(staged, row.head?.id)
    this.check()
    this.lastUsable.set(kind, document)
    const delivered = await this.deliver(staged, foreground)
    return { document, event, coverage, delivery: delivered.delivery }
  }
  publishPrivateSettings(
    draft: SettingsDraft<PrivateSettingsDocument>
  ): Promise<SettingsSnapshot<PrivateSettingsDocument>> {
    return serializeSettingsWrite(
      `${this.signer.pubkey}:${PRIVATE_SETTINGS_KIND}`,
      () => this.save(PRIVATE_SETTINGS_KIND, draft)
    )
  }
  publishPublicSettings(
    draft: SettingsDraft<PublicSettingsDocument>
  ): Promise<SettingsSnapshot<PublicSettingsDocument>> {
    return serializeSettingsWrite(
      `${this.signer.pubkey}:${PUBLIC_SETTINGS_KIND}`,
      () => this.save(PUBLIC_SETTINGS_KIND, draft)
    )
  }
}
