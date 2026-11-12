# Product and shipping schema ownership

Product parsing and shipping quote verification share signed terms, but importing
the general schema barrel from those parsers creates a runtime cycle. The retained
public schema and shipping-policy exports remain compatibility surfaces.

- `protocol/product-schema.ts` owns product schemas, defaults, shipping adjustments
  and supplier-allocation shapes. Product and supplier-allocation parsers import
  this owner directly; `schemas/index.ts` reexports the same schema objects.
- `protocol/shipping-policy-model.ts` owns shipping table definitions, monetary
  precision, region normalization and canonical policy tag/draft helpers. Both
  product schemas and shipping transport can use it without importing the quote
  engine. Its schema primitives and owner validation helpers are internal exports,
  not additional exports of the existing `shipping-policy.ts` surface.
- `protocol/shipping-policy.ts` retains relay reads, publication, mutation guards,
  quote calculation and signed quote validation. It reexports the existing public
  policy model names so application callers keep their current imports.
- `protocol/shipping.ts` imports policy model values directly. Quote types can
  remain type-only imports from the policy implementation without a runtime edge.

The quote schema is deliberately not a standalone shape validator. Its refinement
reconstructs the quote from exact signed policy and product evidence, validates
price/weight/handling inputs and preserves historical quote compatibility.
Moving it into a leaf by dropping that work would weaken payment verification.

`tests/shipping-schema-composition.test.ts` characterizes the real signed listing,
policy, quote and schema path. It covers exact quote roundtrips, changed signed
bytes or amounts, action evidence refusal, legacy policy summary readback and
handling currency precision. These offline checks do not establish relay delivery
or live settlement. The extraction changes no tags, schema defaults, stored data,
payment authority or persistence behavior.
