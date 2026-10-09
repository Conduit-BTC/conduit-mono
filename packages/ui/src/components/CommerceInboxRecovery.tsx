import { useState } from "react"
import {
  commerceMessageSearchText,
  type CommerceInboxSnapshot,
  type DecodedCommerceMessage,
  type AccountInboxSendResult,
} from "@conduit/core"
import { Button } from "./Button"
import { SearchInput } from "./SearchInput"
import { Input } from "./Input"
import { MessageComposer } from "./MessageComposer"
import { PrivateSendNotice } from "./PrivateSendNotice"

const transportLabel = (
  transport: "nip17" | "nip04_incoming" | "nip04_outgoing"
) =>
  transport === "nip17"
    ? "Encrypted"
    : transport === "nip04_outgoing"
      ? "Legacy sent"
      : "Legacy received"

export interface CommerceInboxRecoveryProps {
  snapshot: CommerceInboxSnapshot | null
  loadOlder?: () => Promise<unknown>
  retry?: () => Promise<unknown>
  retrySends?: () => Promise<unknown>
  reply?: (
    record: DecodedCommerceMessage,
    content: string
  ) => Promise<void | AccountInboxSendResult>
  associate?: (record: DecodedCommerceMessage, orderId: string) => Promise<void>
}
/** Account-local evidence only. Associations never authorize commerce actions. */
export function CommerceInboxRecovery({
  snapshot,
  loadOlder,
  retry,
  retrySends,
  reply,
  associate,
}: CommerceInboxRecoveryProps) {
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [orderId, setOrderId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [replyOutcome, setReplyOutcome] =
    useState<AccountInboxSendResult | null>(null)
  if (!snapshot) return null
  const records = snapshot.externalRecords.filter((record) =>
    commerceMessageSearchText(record)
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())
  )
  const states = snapshot.diagnostics.states
  const retryable =
    (states.permission_declined ?? 0) +
    (states.retryable_failure ?? 0) +
    (states.provider_unavailable ?? 0)
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(false)
    try {
      await action()
      setText("")
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label="Inbox history and recovery"
      className="space-y-3 rounded-xl border border-[var(--border)] p-4 xl:shrink-0"
    >
      <details className="text-sm text-[var(--text-secondary)]">
        <summary className="min-h-11 cursor-pointer py-2">
          Read and recovery evidence
        </summary>
        <p>
          Encrypted messages: {snapshot.diagnostics.received} retained · Legacy
          messages: {snapshot.diagnostics.legacyReceived} retained
        </p>
        {(["nip17", "nip04"] as const).map((transport) => {
          const counts = snapshot.diagnostics.transportStates[transport]
          return (
            <p key={transport}>
              {transport === "nip17" ? "Encrypted" : "Legacy"}:{" "}
              {counts.opened ?? 0} opened · {counts.invalid_envelope ?? 0}{" "}
              invalid envelopes · {counts.unsupported ?? 0} unsupported ·{" "}
              {(counts.permission_declined ?? 0) +
                (counts.provider_unavailable ?? 0) +
                (counts.retryable_failure ?? 0)}{" "}
              awaiting recovery
            </p>
          )
        })}
        <ul className="space-y-2 break-all pt-2">
          {snapshot.diagnostics.sources.map((source) => (
            <li key={`${source.sourceIndex}:${source.transport}`}>
              {snapshot.sourceRelays.find(
                (relay) => relay.sourceIndex === source.sourceIndex
              )?.relayUrl ?? `Source ${source.sourceIndex}`}{" "}
              · {transportLabel(source.transport)} · {source.coverage} ·{" "}
              {source.authentication.replaceAll("_", " ")} · {source.received}{" "}
              observed ·{" "}
              <time dateTime={new Date(source.observedAt).toISOString()}>
                {new Date(source.observedAt).toLocaleString()}
              </time>
            </li>
          ))}
          {snapshot.diagnostics.historyRanges.map((range) => (
            <li key={`history:${range.sourceIndex}:${range.transport}`}>
              History ·{" "}
              {snapshot.sourceRelays.find(
                (relay) => relay.sourceIndex === range.sourceIndex
              )?.relayUrl ?? `Source ${range.sourceIndex}`}{" "}
              · {transportLabel(range.transport)} ·{" "}
              {range.status.replaceAll("_", " ")} · {range.observedCount}{" "}
              observed ·{" "}
              <time dateTime={new Date(range.observedAt).toISOString()}>
                {new Date(range.observedAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <p
          role="status"
          className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]"
        >
          {snapshot.pending ? "Opening saved messages… " : ""}
          {snapshot.diagnostics.received} retained messages ·{" "}
          {snapshot.diagnostics.coverage} recent read
          {retryable > 0 ? ` · ${retryable} waiting for recovery` : ""}
          {snapshot.diagnostics.storageUnavailable
            ? " · Local storage unavailable"
            : ""}
        </p>
        {loadOlder ? (
          <Button
            className="min-h-11"
            variant="outline"
            disabled={busy}
            onClick={() => void act(loadOlder)}
          >
            Load older messages
          </Button>
        ) : null}
        {retry && retryable > 0 ? (
          <Button
            className="min-h-11"
            variant="outline"
            disabled={busy}
            onClick={() => void act(retry)}
          >
            Retry opening
          </Button>
        ) : null}
        {retrySends && snapshot.diagnostics.outgoingPending > 0 ? (
          <Button
            className="min-h-11"
            variant="outline"
            disabled={busy}
            onClick={() => void act(retrySends)}
          >
            Retry saved sends ({snapshot.diagnostics.outgoingPending})
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-error">
          Recovery is incomplete. Saved records are available for another
          attempt.
        </p>
      ) : null}
      {snapshot.externalRecords.length > 0 ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            External commerce records ({snapshot.externalRecords.length})
          </summary>
          <div className="space-y-3 pt-3">
            <SearchInput
              aria-label="Search external commerce records"
              placeholder="Search order, listing, type or payment reference"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {records.map((record) =>
                record.category === "commerce" ? (
                  <article
                    key={record.provenance.rumorId}
                    className="space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm"
                  >
                    <p className="font-medium">
                      {record.fields.messageType ?? "Unknown commerce type"} ·{" "}
                      {record.protocol === "open_markets"
                        ? "Open Markets"
                        : "Conduit"}{" "}
                      · {record.status}
                    </p>
                    <p className="break-all">
                      Order: {record.fields.orderId ?? "Unknown"}
                      {record.fields.amountSats !== undefined
                        ? ` · Declared amount: ${record.fields.amountSats} sats`
                        : ""}
                      {record.fields.status
                        ? ` · Status: ${record.fields.status}`
                        : ""}
                    </p>
                    {record.text ? (
                      <p className="break-words whitespace-pre-wrap">
                        {record.text.slice(0, 4000)}
                      </p>
                    ) : null}
                    <p className="text-xs text-[var(--text-muted)]">
                      These fields are message evidence. Payment and fulfillment
                      still require their usual verification.
                    </p>
                    {record.association ? (
                      <p>Locally associated with {record.association}</p>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => {
                        setSelected(
                          selected === record.provenance.rumorId
                            ? null
                            : record.provenance.rumorId
                        )
                        setText("")
                        setReplyOutcome(null)
                        setOrderId(record.association ?? "")
                      }}
                    >
                      Inspect and reply
                    </Button>
                    {selected === record.provenance.rumorId ? (
                      <div className="space-y-3">
                        <p className="break-all text-xs">
                          Authenticated author: {record.provenance.authorPubkey}
                          <br />
                          Event: {record.provenance.rumorId}
                          <br />
                          Time:{" "}
                          {record.provenance.createdAt === undefined
                            ? "Unknown"
                            : new Date(
                                record.provenance.createdAt * 1000
                              ).toLocaleString()}
                        </p>
                        {associate ? (
                          <div className="flex flex-wrap gap-2">
                            <Input
                              aria-label="Local order association"
                              className="min-w-0 flex-1"
                              value={orderId}
                              onChange={(event) =>
                                setOrderId(event.target.value)
                              }
                              placeholder="Existing order id"
                            />
                            <Button
                              variant="outline"
                              disabled={busy || !orderId.trim()}
                              onClick={() =>
                                void act(() => associate(record, orderId))
                              }
                            >
                              Associate locally
                            </Button>
                          </div>
                        ) : null}
                        {reply ? (
                          <MessageComposer
                            value={text}
                            onChange={setText}
                            onSend={() => {
                              setReplyOutcome(null)
                              void act(async () => {
                                const outcome = await reply(record, text)
                                setReplyOutcome(outcome ?? null)
                              })
                            }}
                            sending={busy}
                            placeholder="Reply to the authenticated author"
                          />
                        ) : null}
                        <PrivateSendNotice
                          outcome={replyOutcome}
                          label="Reply"
                        />
                      </div>
                    ) : null}
                  </article>
                ) : null
              )}
              {records.length === 0 ? (
                <p>No matching saved commerce records.</p>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  )
}
