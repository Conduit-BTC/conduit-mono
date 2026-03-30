# Hi-Fi Checklist

Feature-based hi-fi worklist for aligning Conduit's MVP and post-MVP UI with the Figma file `"Conduit High Fi - Website"` (`High Fi - WIP` page).

This is intentionally scoped to look-and-feel work. It is not a full QA, routing, or product-scope checklist.
Store Builder is out of scope for the March 12, 2026 MVP and is not tracked here.

References:
- `docs/specs/market.md`
- `docs/specs/merchant.md`
- `docs/plans/IMPLEMENTATION.md`

## MVP Hi-Fi Worklist (Target: 3/12/2026)

### Shared Foundations
- [x] Extract Figma design tokens into `packages/ui` (color, typography, spacing, radii, shadows)
- [x] Align shared shell patterns across Market and Merchant (header, nav, page chrome, section spacing, mobile nav)
- [x] Align core components used in MVP flows (buttons, inputs, selects, tabs, cards, badges, dialogs, sheets)
- [x] Align visible feedback states used in MVP flows (loading, empty, error, success)

### Auth and Signer Flows
- [x] Sign-in / signer-connect modal
- [x] Connecting / loading state
- [x] Failure / retry state
- [x] Authenticated account menu / profile dropdown
- [x] Signer-required gating UI in checkout, publishing, or settings

### Market Buyer Flow
- [x] Product discovery surfaces: home, products listing, search, filters, sorting, category/tag treatment, product cards
- [x] Product detail surfaces: gallery, price block, merchant summary, add-to-cart controls
- [x] Cart surfaces: grouped-by-merchant cart layout, quantity controls, totals, removal / empty-cart state
- [x] Checkout surfaces: shipping form, progress layout, validation, invoice state, QR/copy/timer UI, retry state, success state
- [x] Orders surfaces: order history, order cards/rows, and status treatment used in MVP
- [x] Messages surfaces used in MVP: merchant-thread inbox and post-checkout conversation views
- [x] Buyer profile surfaces: profile display and edit flows needed for MVP
- [x] Merchant storefront page (`/store/$pubkey`) and store identity surfaces

### Merchant Seller Flow
- [x] Dashboard surfaces: overview layout, summary cards, recent orders/activity modules, quick actions
- [x] Product list surfaces: list/table/cards, filters/search if present, empty state, action affordances
- [x] Product create/edit surfaces: Basic, Details, Images, and Shipping tabs plus validation and save/publish feedback
- [x] Orders surfaces: order list, order detail, item grouping, buyer summary, shipping info, payment state presentation
- [x] Invoice/payment surfaces: invoice generation UI, paid/unpaid indicators, payment confirmation actions, failure/retry states
- [x] Fulfillment surfaces: processing/shipped/completed/cancelled states, shipping/tracking UI used in MVP
- [x] Merchant profile/settings surfaces needed for MVP: profile, wallet/NWC, relays, and any settings entry points already in use

### Cross-Cutting MVP Polish
- [x] Toasts, confirmations, tabs, dropdowns, sheets, and popovers used in MVP flows match Figma intent
- [x] Spacing rhythm, typography hierarchy, and responsive behavior are consistent across Market and Merchant

## Post-MVP Hi-Fi Backlog

### Market Extensions
- [ ] Standalone messages inbox/thread experience beyond MVP order tracking
- [ ] Richer post-purchase status views and expanded order detail treatment
- [ ] Additional discovery/trust/social surfaces not required for MVP

### Merchant Extensions
- [ ] Dedicated messages inbox/thread UX if separated from orders
- [ ] Expanded settings information architecture
- [ ] Relay management page polish
- [ ] Shipping options management page polish
- [ ] Advanced dashboard reporting surfaces

### Platform Extensions
- [ ] Additional onboarding, motion, and non-blocking visual refinements

## Current Market Snapshot (March 16, 2026)

- Product browse is now the effective Market home and includes the hi-fi header/search shell, improved filter controls, responsive product grid, safer USD conversion display, and stronger cart CTA feedback.
- Product detail is in MVP demo shape: responsive gallery, merchant identity block with copy UX, price block, quantity/add-to-cart controls, details/tags, and related products.
- Cart now supports both multicart overview and single-store review, with merchant grouping, quantity controls, confirmations, related products, and a cleaner checkout handoff.
- Checkout now covers signer gating, shipping validation, payment-method selection, awaiting-signature/sending states, and a persistent submitted-order handoff.
- Storefront, orders, messages, and profile now have dedicated hi-fi passes for MVP/demo, with merchant-thread and order-tracking views wired from the buyer flow.
- The highest-priority remaining hi-fi work is Merchant, plus any final Market reply support or SEO/social polish that should ship separately.
