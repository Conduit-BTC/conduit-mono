/** Content-free local observations; no analytics transport or persistence. */
export type Nip17DeclarationClass =
  | "declared"
  | "distribution_pending"
  | "signed_empty"
  | "not_observed"
  | "lookup_partial"
  | "lookup_unavailable"
  | "malformed"
  | "unknown"
export type Nip17DeliveryRoute =
  "declared_inbox" | "compatibility_order" | "blocked" | "not_applicable"
export type Nip17AckOutcome =
  "unavailable" | "zero" | "partial" | "positive" | "not_applicable"
export type Nip17RepairOutcome =
  "discoverable" | "confirmation_pending" | "failed" | "not_applicable"
export type Nip17BlockReason =
  | "sender_not_ready"
  | "recipient_not_ready"
  | "recipient_relays_excluded"
  | "recipient_lookup_failed"
  | "recipient_declaration_distribution_pending"
  | "recipient_declaration_signed_empty"
  | "recipient_declaration_malformed"
  | "not_applicable"

export interface Nip17CompatibilityOutcome {
  action: "order_delivery" | "declaration_repair"
  declarationClass: Nip17DeclarationClass
  deliveryRoute: Nip17DeliveryRoute
  ackOutcome: Nip17AckOutcome
  repairOutcome: Nip17RepairOutcome
  blockReason: Nip17BlockReason
}
