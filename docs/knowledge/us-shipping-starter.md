# US domestic shipping starter

Merchant can use the US starter to author ordinary USD destination/weight rules.
Market quotes the published, merchant-signed rules locally through the existing
[shipping-table workflow](merchant-shipping-tables.md). There is no carrier request
at checkout, preset identifier in the signed policy, or automatic update of old
policies or authorized orders.

## References and approximation

The versioned Merchant-only dataset records its review date, source effective
date, reference rate type, currency, exclusions and suggested bands. Sources were
read on October 1, 2026:

- [Public USPS ZIP-area lookup](https://postcalc.usps.com/DomesticZoneChart), effective October 1, 2026.
- [Retail Notice 123](https://pe.usps.com/TEXT/dmm300/Notice123.htm), effective July 12, 2026.
- [USPS price-change references](https://pe.usps.com/PriceChange/Index), including the October 4, 2026–January 17, 2027 seasonal retail Ground Advantage schedule.
- [Ground Advantage service guidance](https://www.usps.com/ship/ground-advantage.htm).

These are independently authored whole-dollar estimates, not a live postage
quote or an exact carrier rate table. Nearby groups cover referenced zones 1–4,
middle distance 5–6, and farther destinations 7–9. Each group's suggestion rounds
up the highest referenced seasonal retail charge for that weight band. The
seasonal envelope is also conservative before October 4. Commercial discounts,
packaging, dimensional weight, insurance and special-service fees are not modeled.
Review prices again after January 17, 2027; the editor warns about an older
reference without changing published terms.

Weight bands end at 8 oz, 1 lb, 2 lb and 5 lb. Canonical whole-gram limits round
down to 226, 453, 907 and 2267 g to avoid including a parcel above a carrier tier.
Merchants can change prices before applying and edit any resulting postal area.
Applying replaces only the domestic draft. Existing USD international prices and
free-shipping thresholds remain editable; a different international currency
requires review before applying USD suggestions.

## Coverage and maintenance

Origin and destination areas are derived from public lookup facts. Completely
covered two-digit areas use the highest suggested group within that area; this
can overestimate individual destinations. Three-digit coverage holes and Alaska
and Hawaii detail remain intact. Postal defaults and more-specific overrides
compress the result into existing table rules. Unsupported leaves remain absent; no national
fallback fills a gap. Alaska and Hawaii are included. Territories, APO/FPO/DPO
(including prefix 340), American Samoa ZIP 96799, unassigned areas and the unique
005 area are excluded. Baskets above 5 lb require merchant coordination. The
three-digit public lookup labels Hawaii's 967 area as `96700`; generation
normalizes that label to 967 and explicitly excludes 96799. Independent five-digit
checks include 94107→96701 (farther), 96813→96701 (nearby), and 99501→99701 (nearby).

The public origin chart for prefix 967 returned an error. Its explicitly named
authoring approximation uses farther prices everywhere outside Hawaii and nearby
prices within Hawaii. Individual ZIP-pair checks cover 96701→96813 and
96701→96720 (nearby), plus 96701→10001 and 96701→99501 (farther). The editor exposes
this conservative approximation before applying; it is not a hidden runtime
fallback. Review it when refreshing the dataset.

`scripts/data/generate-us-shipping-starter.ts` performs bounded build-time reads
of public reference areas, with no merchant or buyer inputs. It stops on changed
reference dates, unknown formats or new ordinary-US five-digit exceptions.
Temporary reference responses stay outside tracked files. Review source changes,
rerun generation, and verify every compiled area before committing a new dataset.
The generated file contains suggested area groups, not exact zone numbers or
carrier price rows. Origin ZIP input stays in the setup session; published area
prices can still reveal approximate origin geography.

## Packing and evidence

Packing is per product under the existing v2 policy contract. A 50 g per-item
allowance is a starting estimate for small ordinary parcels, not a universal
default. Synthetic checks cover one small item, two shirts and one book against
measured example packaging. Measure actual parcels near boundaries. The editor
shows named Ground Advantage warnings for length, dimensional volume, oversized
parcels and the service maximum; warnings do not change shipping charges.

Automated evidence covers origin/area compilation, excluded ZIPs, reference
ceilings, gram boundaries, editable drafts, signed publication and new-storage
recovery. Real cryptographic order round trips retain resolved signed rules and
stay below the existing relay-message cap. Physical parcel calibration, live
carrier quotes, public-relay convergence and external signer devices remain
maintainer-owned checks before release.
