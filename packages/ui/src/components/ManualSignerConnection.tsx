import { KeyRound, Link2, QrCode } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useId, type ReactNode, type Ref } from "react"
import { Button } from "./Button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs"
import { Textarea } from "./Textarea"

const primaryClassName = "h-12 w-full rounded-xl text-base font-semibold"
const tabClassName =
  "min-h-11 min-w-0 gap-1 rounded-lg px-1 text-xs whitespace-normal data-[state=active]:bg-primary-500 data-[state=active]:text-white sm:text-sm"

export function ManualSignerConnection({
  id,
  activeTab,
  onTabChange,
  nostrConnectUri,
  connectionUrlRef,
  startButton,
  copyButton,
  bunkerUri,
  onBunkerChange,
  onSubmitBunker,
  connectDisabled,
  connectPending,
  error,
  errorId,
}: {
  id: string
  activeTab: string
  onTabChange: (tab: string) => void
  nostrConnectUri?: string | null
  connectionUrlRef: Ref<HTMLTextAreaElement>
  startButton: ReactNode
  copyButton: ReactNode
  bunkerUri: string
  onBunkerChange: (uri: string) => void
  onSubmitBunker: () => Promise<void>
  connectDisabled: boolean
  connectPending: boolean
  error?: string | null
  errorId: string
}) {
  const bunkerHelpId = useId()
  return (
    <div
      id={id}
      className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
    >
      <p className="text-sm leading-6 text-[var(--text-secondary)]">
        Use another signer or connect from another device.
      </p>
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList
          className="grid h-auto w-full grid-cols-3 rounded-xl p-1"
          aria-label="Remote signer connection method"
        >
          <TabsTrigger value="qr" aria-label="QR code" className={tabClassName}>
            <QrCode className="h-4 w-4 shrink-0" aria-hidden="true" />
            Scan QR
          </TabsTrigger>
          <TabsTrigger
            value="url"
            aria-label="Connection URL"
            className={tabClassName}
          >
            <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Copy link
          </TabsTrigger>
          <TabsTrigger
            value="bunker"
            aria-label="Bunker URL"
            className={tabClassName}
          >
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
            Paste bunker
          </TabsTrigger>
        </TabsList>
        <TabsContent value="qr" className="min-w-0">
          {nostrConnectUri ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div
                role="img"
                aria-label="Nostr Connect connection QR code"
                className="rounded-lg bg-white p-3"
              >
                <QRCodeSVG
                  value={nostrConnectUri}
                  size={200}
                  level="M"
                  className="h-auto w-[min(200px,65vw)] max-w-full"
                />
              </div>
              <p className="text-sm leading-6 text-[var(--text-secondary)]">
                Scan with the signer app on your other device.
              </p>
            </div>
          ) : (
            startButton
          )}
        </TabsContent>
        <TabsContent value="url" className="min-w-0 space-y-3">
          {nostrConnectUri ? (
            <>
              <Textarea
                ref={connectionUrlRef}
                value={nostrConnectUri}
                readOnly
                aria-label="Nostr Connect connection URL"
                spellCheck={false}
                className="min-h-24 resize-none break-all font-mono"
              />
              {copyButton}
              <p className="text-sm leading-6 text-[var(--text-secondary)]">
                Paste this connection link into your signer app.
              </p>
            </>
          ) : (
            startButton
          )}
        </TabsContent>
        <TabsContent value="bunker" className="min-w-0 space-y-3">
          <p
            id={bunkerHelpId}
            className="text-sm leading-6 text-[var(--text-secondary)]"
          >
            Create a connection in your signer app, then paste its bunker link
            here.
          </p>
          <Textarea
            value={bunkerUri}
            onChange={(event) => onBunkerChange(event.target.value)}
            placeholder="bunker://..."
            aria-label="Remote signer bunker URL"
            aria-describedby={
              error ? `${bunkerHelpId} ${errorId}` : bunkerHelpId
            }
            aria-invalid={!!error}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={connectDisabled}
            className="min-h-20 resize-none break-all font-mono"
          />
          <Button
            type="button"
            onClick={() => void onSubmitBunker()}
            disabled={connectDisabled || !bunkerUri.trim()}
            className={primaryClassName}
          >
            {connectPending ? "Connecting…" : "Connect with bunker link"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  )
}
