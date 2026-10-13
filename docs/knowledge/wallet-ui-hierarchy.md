# Shared Wallets UI

Market and Merchant compose `@conduit/ui`'s `Wallets` with their existing
controllers. This layout does not change wallet ownership, provider operations,
signer consent, recovery, payment review, default selection or public-profile
publication.

## Presentation boundaries

- Add wallet groups create, import and external connection. Keep each operation's
  existing capability and signer gates. Restore dialog focus to the menu's
  button, rather than its unmounted menu item.
- With multiple wallets, use the shared tabs primitive to choose the visible
  wallet. Keep inactive rows mounted so switching does not reset address reads
  or request state. Tab selection never changes payment or receiving defaults.
- Show the wallet name, balance and payment actions first. Unknown balances are
  unavailable, never zero. Keep configured display formatting intact.
- Local spending and receiving defaults remain distinct from the main choice
  published across apps. They stay in the wallet menu, together with recovery
  and ownership-aware removal. Rename is attached to the displayed name.
- The sync wheel invokes the existing explicit recovery retry. It can request
  encrypted backup as well as retry main-choice delivery; it is not a new
  automatic publication loop. Pending and conflicting evidence retain their
  consequences. Keep repair available when discovery produces no visible wallet.
- Recovery disclosure and authentication stay in the existing recovery dialog.
  Do not move recovery material into the everyday wallet card.

## Receiving address and name requests

The custom-name invitation belongs to its wallet's Lightning address area.
Hide it only after that wallet has a registered custom address with verified
public lookup. Keep address verification and activation uncertainty visible.

The address-request component owns request state outside its dialog content.
Closing and reopening the dialog must preserve the original request ID, name,
approval status and activation path. Keep the account/wallet React key and the
existing exact-request retry semantics. Clear challenge tokens on dialog changes
and do not imply cancellation while submission or activation is pending.

Setting the Nostr receiving address still uses the existing profile editor and
its signer/publication boundary. It does not select a spending wallet or replace
previously issued invoices.

Browser evidence uses disposable signer identities and controlled provider
responses. Mask account identifiers, addresses, balances and sensitive input
fields in visual artifacts. These checks do not establish funded provider,
public-relay or physical-device behavior.
