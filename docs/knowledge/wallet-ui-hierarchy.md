# Shared Wallets UI

Market and Merchant compose `@conduit/ui`'s `Wallets` with their existing
controllers. This layout does not change wallet ownership, provider operations,
signer consent, recovery, payment review, default selection or public-profile
publication.

## Presentation boundaries

- Add wallet groups create, import and external connection. Keep each operation's
  existing capability and signer gates. Restore dialog focus to the menu's
  button, rather than its unmounted menu item.
- Stack all wallet cards in one list, including connected NWC wallets. Each
  card stays mounted and retains its request state. Viewing the list never
  changes spending, receiving, main-wallet or public-profile choices.
- NWC cards show balances and receiving addresses when the connection shares
  them, and retain existing checkout/default workflows. Missing balance
  permission says "Balance not shared"; it never means a zero balance.
  Standalone Spark send/history controls remain specific to that provider.
- Show the wallet name, balance and payment actions first. Unknown balances are
  unavailable, never zero. Keep configured display formatting intact.
- Local spending and receiving defaults remain distinct from the main choice
  published across apps. They stay in the wallet menu, together with recovery
  and ownership-aware removal. Rename is attached to the displayed name.
- The card's neutral wheel refreshes its balance. Balances also refresh on
  entry, every 30 seconds while visible/online, and on foreground/online return.
  Coalesce in-flight reads and suppress rapid foreground bursts. Never open a
  locked Spark wallet, invoke account signing, publish recovery or retry a
  payment as part of a balance read. Ignore obsolete owner/session results.
- Named encrypted recovery retry lives in the recovery dialog. Preserve pending
  and conflicting evidence and keep repair available when discovery produces no
  visible wallet. NWC credentials retain their existing device-local storage;
  encrypted cross-app NWC sync is a separate follow-up.
- Recovery disclosure and authentication stay in the existing recovery dialog.
  Do not move recovery material into the everyday wallet card.

## Receiving address and name requests

Keep the custom-name request form directly in its wallet's Lightning address
area. The desired-name field and Request name action stay inline within the
stacked card, including narrow layouts. Preserve verified receiving-address
state alongside request approval and activation uncertainty.

Keep the account/wallet React key, original request identity and frozen
in-flight payload when the card rerenders. Pending submission or activation
must disable duplicate actions. Balance refresh must not reset request progress.
The durable request workflow owns reload and cross-device recovery; the layout
must keep its saved status and resume actions visible.

Put the short Nostr receiving row immediately below its associated wallet card.
Show "In use" only when the confirmed profile address matches that wallet.
Saving/importing returns to the list; profile review is explicit through the row or Edit.
Setting the address still opens the existing guarded profile editor; it does not
select a spending wallet or replace previously issued invoices. One aligned
profile summary offers Edit for arbitrary external addresses; avoid repeating the
same current address in a permanent input.

Browser evidence uses disposable signer identities and controlled provider
responses. Mask account identifiers, addresses, balances and sensitive input
fields in visual artifacts. These checks do not establish funded provider,
public-relay or physical-device behavior.
