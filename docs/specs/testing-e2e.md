# Automated Testing Specification

## Goal

Add deterministic automated coverage for the Market + Merchant + Relay core loop without blocking MVP delivery velocity.

## Scope

### In scope (initial)

- Local relay lifecycle for tests (`start`, `seed`, `stop`)
- Merchant product CRUD smoke coverage
- Buyer flow smoke coverage:
  - product discovery
  - add to cart
  - checkout order send
  - merchant order visibility

### Out of scope (initial)

- Browser-extension signer UX automation (NIP-07 popup interactions)
- Full visual regression
- Payment rail integration E2E (real Lightning/stablecoin/card settlement)

## Test Layers

### Unit

- Protocol parsing and serialization utilities
- Product dedupe and deletion semantics
- Cart grouping and totals

### Integration

- Route-level behavior for Market checkout and Merchant product management
- Query/mutation success and error handling for critical flows

### E2E (smoke)

- One happy-path flow across apps against local relay:
  - merchant publishes listing
  - market displays listing
  - buyer places order
  - merchant sees incoming order

## Environment Strategy

### Local developer run

- Relay: local `nostr-rs-relay` container
- Apps: local Market + Merchant dev servers
- Signers: deterministic local test keys (no browser extension required)

### CI run

- Same deterministic local relay + seeded test keys
- Keep first CI suite small and reliable (single happy-path smoke)
- Expand coverage after stability is proven

## Commands (planned)

- `bun run test:e2e:local` - run local end-to-end smoke suite
- `bun run test:e2e:ci` - CI-targeted smoke suite

## Exit Criteria (v0)

- Green automated smoke for:
  - Merchant product CRUD (publish/edit/delete)
  - Market order path to merchant inbox
- Failures produce actionable logs and artifacts
- Included in implementation verification checklist
